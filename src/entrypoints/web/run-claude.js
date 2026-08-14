/** web 入口：Claude run 编排——启动 / 收尾 / 额度用尽续跑 / 孤儿恢复（settleRun 与 doResume 互相调用，须同文件） */
import { logger } from '../../shared/logger.js';
import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';
import * as providers from '../../providers/index.js';
import { appendEvent } from '../../store/event-log.js';
import {
  createRun,
  runSession,
  runPulse,
  runText,
  runActivity,
  runTodos,
  runRateLimit,
  runResult,
  finishRun,
  failRun,
  blockRun,
  askUser,
  nextReqId,
  setRunMode,
  flushHeldMsgs,
  consumeHeldMsgs,
} from '../../store/runs.js';
import {
  getPending,
  addPending,
  updatePending,
  removePending,
  shouldAbandonResume,
} from '../../store/pending-resume.js';
import {
  listActiveRuns,
  addActiveRun,
  patchActiveRun,
  removeActiveRun,
  removeActiveRuns,
  partitionActiveRuns,
  isPidAlive,
} from '../../store/active-runs.js';
import os from 'node:os';
import { getActiveToken, noteRateLimit } from '../../features/token-rotation.js';
import { summarizeTool, READONLY_TOOLS, parseDialog } from './tool-summary.js';
import { getUiPrefs } from '../../store/settings.js';

/** 别名映射：SDK 内部工具名 → 用户配置的逻辑工具名（前端 BUILTIN_TOOLS 的 id） */
const TOOL_DISABLE_ALIASES = {
  MultiEdit: 'Edit',     // MultiEdit 与 Edit 共用同一开关
  Agent: 'Task',         // Agent 与 Task 共用同一开关（SDK 0.3.210+ 改名）
  Glob: 'Grep',          // Glob/LS 归并到 Grep（文件搜索组）
  LS: 'Grep',
  NotebookRead: 'Read',  // NotebookRead 归并到 Read
};

/** 用 run 注册表回调驱动 Claude（abortController 供看门狗/超时/手动停止中断） */
export function startClaudeRun(run, { prompt, cwd, addDirs, session, model, effort, mode, convId, resumePendingId, resumeAttempt = 0 }) {
  run.steerHold = true; // 续跑/孤儿恢复等所有 Claude 运行入口统一支持插话持有（handleRunStart 的提前置位覆盖判档窗口）
  run.convId = convId || run.convId || null;
  // 插话埋点（routes-run 的 /api/run/send）只拿得到 run 对象，起跑上下文挂上来供它取用。
  // model 在此已是 auto 判档后的实际取值，比请求体里的 'auto' 更有信息量。
  run.cwd = cwd || null;
  run.model = model || null;
  // 读取用户禁用的工具列表（起跑时快照，避免运行期并发读写竞争）
  const { disabledTools: rawDisabledTools } = getUiPrefs();
  const disabledToolsSet = new Set(Array.isArray(rawDisabledTools) ? rawDisabledTools : []);
  const effectiveMode = mode || 'default'; // default(询问) | acceptEdits | plan | bypassPermissions
  run.mode = effectiveMode; // 运行时可变（/api/run/set-mode 可中途放宽）
  run.startMode = effectiveMode; // 起跑模式：非「询问」起跑未装 ask 钩子，中途无法拦截
  // 补发判档窗口内缓冲的模式切换（setRunMode 在 startMode 赋值前调用会先缓冲到 _pendingMode）
  if (run._pendingMode && effectiveMode === 'default') {
    const targetMode = run._pendingMode;
    delete run._pendingMode;
    if (targetMode === 'acceptEdits' || targetMode === 'bypassPermissions') {
      setRunMode(run.id, targetMode);
    }
  } else if (run._pendingMode) {
    delete run._pendingMode; // 非询问起跑，缓冲的切换作废
  }
  let lastRate = null;
  const active = getActiveToken(); // {id, token, label} | null
  run._tokenId = active?.id || null; // 限流归因：记本次用的号
  const params = { session, cwd, model, effort, mode: effectiveMode, convId, resumePendingId, tokenId: run._tokenId, resumeAttempt };
  // 落盘镜像：进程重启后据此把孤儿 run 转「待续跑」自动续接（见启动回调的孤儿恢复）
  addActiveRun({
    runId: run.id,
    convId: run.convId,
    session_id: session || null, // 新会话此刻还没有 session，onInit 到达后回填
    cwd,
    model,
    effort,
    mode: effectiveMode,
    resumeAttempt, // 续跑代次：重启后孤儿恢复据此 +1 计次，达 MAX_RESUME_ATTEMPTS 熔断
    // 属主标记：多实例（PM2 web + Tauri 桌面版）共用同一个 APP_DATA_DIR，
    // 启动时据此区分「真孤儿」与「别的实例正在跑」，避免抢跑同一 session 重复烧额度。
    pid: process.pid,
    startedAt: Date.now(),
  });
  providers.get(DEFAULT_PROVIDER_ID).run(prompt, {
    cwd: cwd || undefined,
    ...(addDirs?.length ? { additionalDirectories: addDirs } : {}),
    ...(active ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: active.token } } : {}),
    permissionMode: effectiveMode,
    resume: session || undefined,
    includePartialMessages: true, // token 级流式，前端打字机更顺滑
    abortController: run.abortController,
    onInputHandle: (h) => {
      run._input = h; // 插话入口：/api/run/msg/* 经此注入/打断运行中的 query
    },
    settings: { autoCompactEnabled: true }, // 长会话自动压缩，抑制上下文膨胀 → 省额度
    supportedDialogKinds: [
      'refusal_fallback_prompt',
      'ask_user_question',
      'user_question',
      'question',
      'multiple_choice',
    ],
    toolConfig: { askUserQuestion: { previewFormat: 'html' } }, // 我们是 web 消费者
    // 「询问」模式必须强制走 canUseTool：用户全局 settings.json 把 Bash/Edit/Write 等整体 allow，
    // 而 allow 规则优先于 canUseTool（回调被架空、工具直接执行）。PreToolUse 钩子返回 ask
    // 把每次工具调用的裁决权交回 canUseTool（SDK 官方推荐做法）；只读工具仍在回调里自动放行。
    ...(effectiveMode === 'default'
      ? {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async () => ({
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
                  }),
                ],
              },
            ],
          },
        }
      : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    canUseTool: async (toolName, input) => {
      // 用户显式禁用的工具：任意模式下均拒绝执行（disabledTools 比权限模式优先级更高）
      const logicalName = TOOL_DISABLE_ALIASES[toolName] || toolName;
      if (disabledToolsSet.has(logicalName)) {
        return { behavior: 'deny', message: `工具「${toolName}」已被用户关闭，可在右下角模型选择器中重新开启` };
      }
      if (run.mode !== 'default') return { behavior: 'allow' }; // 已放宽（含中途放宽）→ 此处直接放行；非询问起跑的实际裁决在 SDK permissionMode
      if (READONLY_TOOLS.has(toolName)) return { behavior: 'allow' };
      const choice = await askUser(run, {
        reqId: nextReqId(run),
        kind: 'permission',
        title: `Claude 请求执行：${toolName}`,
        body: summarizeTool({ name: toolName, input }),
        options: [
          { id: 'allow', label: '允许' },
          { id: 'deny', label: '拒绝' },
        ],
        defaultChoice: 'deny',
      });
      return choice === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: '用户拒绝了该操作' };
    },
    onUserDialog: async (request) => {
      appendEvent({ type: 'dialog', dialogKind: request.dialogKind }); // 记录真实 kind，便于后续精确适配
      const parsed = parseDialog(request);
      if (!parsed) return { behavior: 'cancelled' };
      const choice = await askUser(run, {
        reqId: nextReqId(run),
        kind: 'dialog',
        title: parsed.title,
        body: parsed.body,
        options: parsed.options,
        defaultChoice: '__cancel__',
      });
      if (choice === '__cancel__') return { behavior: 'cancelled' };
      return { behavior: 'completed', result: parsed.toResult(choice) };
    },
    onInit: (info) => {
      runSession(run, info.session_id);
      patchActiveRun(run.id, { session_id: info.session_id }); // 回填续跑锚点
    },
    onPulse: () => runPulse(run),
    onText: (text) => runText(run, text),
    onActivity: (a) => {
      // TodoWrite → 任务清单面板；其它工具 → 活动转录；task_* 事件带预格式化 text（子代理进度）
      if (a.name === 'TodoWrite' && a.input && Array.isArray(a.input.todos)) {
        runTodos(run, a.input.todos);
      } else {
        runActivity(run, (a.sub ? '↳ ' : '') + (a.text || summarizeTool(a)));
      }
    },
    onRateLimit: (info) => {
      lastRate = info; // 记录最近限流状态，用于额度用尽判定
      if (run._tokenId) noteRateLimit(run._tokenId, info); // 更新 token 池 + 触发切换/定时器
      runRateLimit(run, {
        status: info.status,
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
      });
    },
    onResult: (info) => {
      // 排队消息在本轮 result 时统一进入任务：autoClose 之前同步 push，同一 run 续下一轮。
      // 额度用尽（rejected）不 flush——settleRun 会把持有消息打包进待续跑 prompt
      if (!lastRate || lastRate.status !== 'rejected') flushHeldMsgs(run);
      runResult(run, info);
    },
  }).done.then(
    // 必须用 .then(onOk, onErr) 的**双参**形式，不能写成 .then(...).catch(...)：
    // 链式写法里 .catch 挂在 .then 之后，会连 settleRun **自身**抛出的异常一起捕获
    // → 同一个 run 被结算两次。额度分支尤其致命：二次 addPending + 二次 doResume
    // 会让同一会话并发起两个续跑 run（重复烧额度、并发写同一工作目录）。
    () => settleRun(run, null, lastRate, params),
    (err) => settleRun(run, err, lastRate, params),
  );
}

const resumeTimers = new Map(); // pending 条目 id -> setTimeout 句柄

// 续跑上限：允许极少数合理的意外重启自动续跑，同时对病态循环（Claude 自重启）快速熔断。
// 计次跨进程重启持久化：active-runs.resumeAttempt → pending.attempts 每轮 +1。
const MAX_RESUME_ATTEMPTS = 3;

/**
 * 续跑熔断：停止自动续跑并落 abandoned 标记（供前端消费一次终结提示后 dismiss）。
 * 有 entryId 走 updatePending（doResume 防御路径）；否则 addPending 新建标记（孤儿恢复路径）。
 */
function abandonResume({ convId, attempts, entryId, reason }) {
  logger.warn('web', '续跑熔断', { convId, attempts, reason });
  if (entryId) {
    updatePending(entryId, { status: 'abandoned', reason, attempts });
  } else {
    addPending({ convId, attempts, status: 'abandoned', reason, resetsAt: Math.floor(Date.now() / 1000) });
  }
}

/** 运行收尾：额度用尽 → 有备用号立即续跑，否则登记待续跑 + 排程 */
function settleRun(run, err, lastRate, params) {
  // 幂等闸门（纵深防御）：结算带副作用——addPending + doResume。重复执行会让同一会话
  // 并发起两个续跑 run。上面已改用 .then(onOk, onErr) 避免自身异常被二次捕获，
  // 这里再兜一道，防止将来新增的调用路径重蹈覆辙。
  if (run._settled) {
    logger.warn('web', 'settleRun 重复调用，已忽略', { runId: run.id });
    return;
  }
  run._settled = true;
  removeActiveRun(run.id); // run 已收尾（任何路径），不再是重启恢复对象
  const rejected = lastRate && lastRate.status === 'rejected'; // 额度耗尽
  const sid = run.session_id || params.session;
  if (rejected && sid && params.convId) {
    const resetsAt = (lastRate && lastRate.resetsAt) || Math.floor(Date.now() / 1000) + 3600;
    // 登记一条待续跑（撞墙号已在 onRateLimit 标记 exhausted）
    const heldTexts = consumeHeldMsgs(run).map((m) => m.text); // 排队消息随续跑带入（consumed 已广播）
    const entry = addPending({
      convId: params.convId,
      session_id: sid,
      cwd: params.cwd,
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      attempts: params.resumeAttempt || 0, // 继承当前续跑代次：跨额度事件保留重启计数（额度循环本身不递增，仅孤儿恢复 +1）
      prompt: heldTexts.length ? heldTexts.join('\n\n') : undefined,
      resetsAt,
    });
    const backup = getActiveToken(); // 重算：偏好最高的可用号
    if (backup && backup.id !== params.tokenId) {
      // 有健康/warning 备用 → 不等重置，立即续跑（doResume→startClaudeRun 会自动选用备用 token）
      blockRun(run, `⏳ 额度用尽，正在用备用账号「${backup.label || ''}」继续任务…`);
      doResume(entry.id);
    } else {
      // 无可用备用 → 沿用原有等待机制
      const when = new Date(resetsAt * 1000).toLocaleString('zh-CN', { hour12: false });
      scheduleResume(entry);
      blockRun(run, `⏳ 额度用尽，任务已登记：将于 ${when}（token 重置）后自动发送「继续」续跑。`);
    }
    return;
  }
  if (params.resumePendingId) removePending(params.resumePendingId); // 续跑正常收尾 → 清除登记
  // 需求系统任务收尾钩子：requirement-ops 在 run 上挂 onSettle，此处是唯一真正终结（非额度阻塞续跑）的汇聚点——
  // 上面 rejected 分支命中时已 return，那里的 run 还会经 doResume 生成新 run 续跑，任务逻辑上并未结束，
  // 因此故意不在那条路径触发本钩子（避免 busy 被提前清掉、串行闸被击穿）。
  // ok 用 is_error 而非仅凭 err 判断：SDK 未抛错但 result.is_error 为真时，对调用方而言仍是失败。
  if (typeof run.onSettle === 'function') {
    const ok = !err && !run.is_error;
    try {
      run.onSettle(ok, run);
    } catch (e) {
      logger.warn('web', 'onSettle 回调异常', { err: e?.message || String(e) });
    }
    run.onSettle = null;
  }
  if (err) failRun(run, `Agent SDK 执行失败：${err?.message || String(err)}`);
  else finishRun(run);
}

/** 到 token 重置时刻（+30s 缓冲）自动续跑 */
export function scheduleResume(entry) {
  const prev = resumeTimers.get(entry.id);
  if (prev) clearTimeout(prev);
  const delay = Math.min(Math.max(0, entry.resetsAt * 1000 - Date.now() + 30000), 2 ** 31 - 1);
  resumeTimers.set(
    entry.id,
    setTimeout(() => doResume(entry.id), delay),
  );
}

/** 执行一次续跑：新建 run 续接 session 并发送「继续」（超上限则熔断放弃） */
export function doResume(entryId) {
  resumeTimers.delete(entryId);
  const entry = getPending().find((e) => e.id === entryId);
  if (!entry || entry.status === 'done' || entry.status === 'abandoned') return;
  // 防御性熔断（正常由孤儿恢复先拦；这里防止手改/异常状态下的失控续跑）
  if (shouldAbandonResume(entry.attempts, MAX_RESUME_ATTEMPTS)) {
    abandonResume({
      convId: entry.convId,
      attempts: entry.attempts,
      entryId: entry.id,
      reason: `续跑代次 ${entry.attempts} 超过上限 ${MAX_RESUME_ATTEMPTS}`,
    });
    return;
  }
  const run = createRun();
  run.convId = entry.convId;
  updatePending(entry.id, { status: 'resuming', runId: run.id });
  startClaudeRun(run, {
    prompt: entry.prompt || '继续',
    cwd: entry.cwd,
    session: entry.session_id,
    model: entry.model,
    effort: entry.effort,
    mode: entry.mode,
    convId: entry.convId,
    resumePendingId: entry.id,
    resumeAttempt: entry.attempts, // 落盘镜像据此在下次重启 +1
  });
}

/** 进程启动时调用：孤儿 run 转待续跑 + 重排 pending 定时器（逻辑原样自 server.listen 回调提取） */
export function recoverPendingAndOrphans() {
  // 孤儿恢复：上次进程死亡（崩溃/pm2 重启）时仍在跑的 run → 转待续跑，自动发「继续」续接 session。
  // 无 session 锚点（判档窗口/首轮 init 前崩溃）的无法续接，只记日志。
  // 只回收「属主进程确认已死」的条目：多实例共用 APP_DATA_DIR 时，
  // 无条件整表清空会把另一个实例正在跑的 run 抢过来重复续跑（详见 active-runs.js）。
  const { orphans, foreign } = partitionActiveRuns(listActiveRuns(), {
    selfPid: process.pid,
    isPidAlive,
    bootTimeMs: Date.now() - os.uptime() * 1000,
  });
  if (foreign.length) {
    logger.info('web', '检测到其它实例正在运行的 run，跳过回收', {
      count: foreign.length,
      pids: [...new Set(foreign.map((e) => e.pid))],
    });
  }
  if (orphans.length) {
    removeActiveRuns(orphans.map((o) => o.runId));
    for (const o of orphans) {
      if (!o.session_id || !o.convId) {
        logger.warn('web', '孤儿 run 缺 session/convId，无法续跑', { runId: o.runId, convId: o.convId || null });
        continue;
      }
      const nextAttempt = (o.resumeAttempt || 0) + 1; // 本次孤儿续跑的代次
      if (shouldAbandonResume(nextAttempt, MAX_RESUME_ATTEMPTS)) {
        // 连续自重启/续跑达上限 → 熔断，不再续跑（破环根治）
        abandonResume({
          convId: o.convId,
          attempts: nextAttempt,
          reason: `连续 ${nextAttempt - 1} 次自动续跑仍中断，超过上限 ${MAX_RESUME_ATTEMPTS}`,
        });
        continue;
      }
      logger.info('web', '恢复因进程重启中断的任务', { runId: o.runId, convId: o.convId, attempt: nextAttempt });
      addPending({
        convId: o.convId,
        session_id: o.session_id,
        cwd: o.cwd,
        model: o.model,
        effort: o.effort,
        mode: o.mode,
        attempts: nextAttempt, // 续跑代次随孤儿链 +1
        reason: 'orphan_recovery', // 标记为进程重启孤儿恢复，非额度耗尽
        resetsAt: Math.floor(Date.now() / 1000), // 立即可续（scheduleResume 自带 +30s 缓冲）
      });
    }
  }
  // 恢复「额度用尽待续跑」的排程（跨重启；含上面刚转换的孤儿条目）
  // abandoned（熔断）与 done 均不重排：熔断条目仅供前端消费一次终结提示后 dismiss
  for (const e of getPending()) if (e.status !== 'done' && e.status !== 'abandoned') scheduleResume(e);
}
