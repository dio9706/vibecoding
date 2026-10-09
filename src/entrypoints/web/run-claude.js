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
  retryRun,
  askUser,
  nextReqId,
  setRunMode,
  stopRun,
  flushHeldMsgs,
  consumeHeldMsgs,
  emitRunEvent,
  truncateForJournal,
} from '../../store/runs.js';
import {
  getPending,
  addPending,
  updatePending,
  removePending,
  shouldAbandonResume,
} from '../../store/pending-resume.js';
import { listRunIndex, removeRun, partitionRunIndex, isPidAlive, migrateLegacyActiveRuns } from '../../store/run-index.js';
import { readRunEvents } from '../../store/run-journal.js';
import {
  mirrorRunStart,
  mirrorRunPatch,
  mirrorRunRemove,
  appendStandaloneRunEvent,
} from './run-durability.js';
import { classifyInterrupted } from './run-reconcile.logic.js';
import { scheduleOpenAiOrphanResume } from './run-openai.js';
import os from 'node:os';
import { getActiveToken, noteRateLimit } from '../../capabilities/token-rotation.js';
import { summarizeTool, parseDialog } from './tool-summary.js';
import { createPolicyGate, resolveUnattendedPolicy, PRETOOL_ASK_HOOK } from '../../capabilities/tool-policy.js';
import { systemNotify } from '../../integrations/notify.js';
import { isRetryEligible, MAX_RESUME_ATTEMPTS } from './run-claude.logic.js';
import { getUiPrefs, getBuiltinMcp, getBuiltinSkills } from '../../store/settings.js';
import { resolveBuiltinMcp, toClaudeServerConfig } from '../../capabilities/builtin-mcp.js';
import { resolveSkillPlugins } from '../../capabilities/builtin-skills.js';

/** 别名映射：SDK 内部工具名 → 用户配置的逻辑工具名（前端 BUILTIN_TOOLS 的 id） */
const TOOL_DISABLE_ALIASES = {
  MultiEdit: 'Edit',     // MultiEdit 与 Edit 共用同一开关
  Agent: 'Task',         // Agent 与 Task 共用同一开关（SDK 0.3.210+ 改名）
  Glob: 'Grep',          // Glob/LS 归并到 Grep（文件搜索组）
  LS: 'Grep',
  NotebookRead: 'Read',  // NotebookRead 归并到 Read
};

/** 用 run 注册表回调驱动 Claude（abortController 供看门狗/超时/手动停止中断）。
 *  execPolicy/unattended（T6）：无人值守调用方（需求系统任务/colleague-dev/auto-dev）传入；
 *  按 bot.execPolicy 解析档位（默认 bypass=与改动前一致），策略门见 capabilities/tool-policy.js。 */
export function startClaudeRun(run, { prompt, cwd, addDirs, session, model, effort, mode, convId, resumePendingId, resumeAttempt = 0, requestId, execPolicy = null, unattended = false }) {
  run.capabilities.steer = true; // 续跑/孤儿恢复等所有 Claude 运行入口统一支持插话持有（handleRunStart 的提前置位覆盖判档窗口）
  run.convId = convId || run.convId || null;
  // 插话埋点（routes-run 的 /api/run/send）只拿得到 run 对象，起跑上下文挂上来供它取用。
  // model 在此已是 auto 判档后的实际取值，比请求体里的 'auto' 更有信息量。
  run.cwd = cwd || null;
  run.model = model || null;
  run.provider = 'claude-agent'; // journal/索引的 provider 归属（openai 路径在各自入口设置）
  run.requestId = requestId || null; // 提交幂等键（journal 里与 submissions 认领对账）
  run.resumeAttempt = resumeAttempt || 0; // 续跑代次快照（settled 事件带出，供熔断排查）
  // 读取用户禁用的工具列表（起跑时快照，避免运行期并发读写竞争）
  const { disabledTools: rawDisabledTools } = getUiPrefs();
  const disabledToolsSet = new Set(Array.isArray(rawDisabledTools) ? rawDisabledTools : []);
  const effectiveMode = mode || 'default'; // default(询问) | acceptEdits | plan | bypassPermissions
  // 工具策略（T6）：无人值守按 bot.execPolicy 解析（bypass 档 = 与改动前完全一致）；
  // 交互路径档位即 mode（gate 运行时读 run.mode，支持 /api/run/set-mode 中途放宽）。
  const policy = unattended
    ? resolveUnattendedPolicy(execPolicy)
    : { execPolicy: null, unattended: false, policyLevel: effectiveMode, sdkMode: effectiveMode };
  const sdkMode = policy.sdkMode;
  run.mode = sdkMode; // 运行时可变（/api/run/set-mode 可中途放宽）
  run.startMode = sdkMode; // 起跑模式：非「询问」起跑未装 ask 钩子，中途无法拦截
  const policyGate = createPolicyGate({
    provider: 'claude-agent',
    level: unattended ? policy.policyLevel : () => run.mode || 'default',
    unattended: !!unattended,
    workspace: cwd,
    disabledTools: disabledToolsSet,
    alias: TOOL_DISABLE_ALIASES,
    onDeny: (info) => {
      emitRunEvent(run, 'policy_block', { tool: info.tool, klass: info.klass, ruleId: info.ruleId, reason: info.reason, count: info.count });
      logger.warn('web', '工具调用被策略拒绝', { runId: run.id, tool: info.tool, ruleId: info.ruleId, count: info.count });
    },
    onFuse: (info) => {
      // 无人值守计次熔断（T6 spec §4.2）：停 run + 系统通知；会话通知开启时另有卡片（settle 监听统一发）
      systemNotify(
        '无人值守任务被安全策略拦截',
        `会话 ${run.convId || run.id}：连续 ${info.count} 次被策略拒绝（最后：${info.last.tool}），已停止。可调高机器人执行档位（execPolicy）后重试。`,
      );
      stopRun(run, `连续 ${info.count} 次被安全策略拦截，已停止并通知管理员（最后：${info.last.tool}）`);
    },
  });
  // 补发判档窗口内缓冲的模式切换（setRunMode 在 startMode 赋值前调用会先缓冲到 _pendingMode）
  if (run._pendingMode && sdkMode === 'default') {
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
  const params = { session, cwd, model, effort, mode: sdkMode, convId, resumePendingId, tokenId: run._tokenId, resumeAttempt };
  // 事件流（P2 影子）：submitted 记本次运行的入口事实（只写不读，P5 对账起用）
  emitRunEvent(run, 'submitted', {
    provider: 'claude-agent',
    requestId: requestId || null,
    cwd: cwd || null,
    model: model || null,
    effort: effort || null,
    mode: sdkMode,
    execPolicy: policy.execPolicy,
    unattended: !!unattended,
    session: session || null,
    resumeAttempt: run.resumeAttempt,
  });
  // 落盘索引（P5 起唯一恢复来源）：进程重启后据此把孤儿 run 对账成「待续跑」自动续接
  mirrorRunStart({
    runId: run.id,
    convId: run.convId,
    provider: 'claude-agent',
    session_id: session || null, // 新会话此刻还没有 session，onInit 到达后回填
    cwd,
    model,
    effort,
    mode: sdkMode,
    requestId: requestId || null,
    prompt: prompt ? truncateForJournal(prompt) : null, // 截断存档：P3 续跑查 repo map 用
    resumeAttempt, // 续跑代次：重启后孤儿恢复据此 +1 计次，达 MAX_RESUME_ATTEMPTS 熔断
    // 属主标记：多实例（PM2 web + Tauri 桌面版）共用同一个 APP_DATA_DIR，
    // 启动时据此区分「真孤儿」与「别的实例正在跑」，避免抢跑同一 session 重复烧额度。
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    lastSeq: run._journalSeq || 0,
  });
  // 内置 MCP（context7 等；figma-devmode 为 http，仅本路径可用）。
  // 刻意只注入内置：用户自定义 MCP 是否进 Claude 路径是后续独立子项（避免存量行为突变）。
  const builtinMcp = resolveBuiltinMcp({ state: getBuiltinMcp(), provider: 'claude' });
  const mcpServers = builtinMcp.length
    ? Object.fromEntries(builtinMcp.map((e) => [e.builtinId, toClaudeServerConfig(e)]))
    : null;
  // 内置 Skills（superpowers）：启用且**已安装**（安装时拉取）才注入为本地 plugin，SDK 从插件加载 skills。
  // 停用了部分技能时，resolveSkillPlugins 指向按需物化的「启用视图」镜像——SDK 没有 per-skill 禁用项，
  // Options.skills 是 allowlist（传了会连带隐藏项目/用户级技能），镜像方案只动本插件目录。
  const plugins = resolveSkillPlugins({ state: getBuiltinSkills() });
  providers.get(DEFAULT_PROVIDER_ID).run(prompt, {
    cwd: cwd || undefined,
    ...(addDirs?.length ? { additionalDirectories: addDirs } : {}),
    ...(active ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: active.token } } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(plugins.length ? { plugins } : {}),
    permissionMode: sdkMode,
    resume: session || undefined,
    includePartialMessages: true, // token 级流式，前端打字机更顺滑
    abortController: run.abortController,
    onInputHandle: (h) => {
      run._input = h; // 插话入口：/api/run/msg/* 经此注入/打断运行中的 query
    },
    settings: { autoCompactEnabled: true, outputStyle: 'concise' }, // 长会话自动压缩省额度；简洁输出模式直给结果跳前言
    // 只声明查得到实据的 kind。CLI 把「未声明」当作「宿主渲染不了」并 fail closed
    //（sdk.d.ts:3369），所以多声明不会让 dialog 多发出来，只会让人误以为已经适配过。
    // 核查结论（SDK 0.3.210 bundle + claude.exe 字符串）：
    //   refusal_fallback_prompt —— SDK 3 处 / CLI 14 处，类型注释里明确举例
    //   ask_user_question       —— CLI 侧有完整提问闭环遥测（tengu_ask_user_question_*）
    //   user_question / question / multiple_choice —— 两侧均查无此物，已删
    supportedDialogKinds: ['refusal_fallback_prompt', 'ask_user_question'],
    toolConfig: { askUserQuestion: { previewFormat: 'html' } }, // 我们是 web 消费者
    systemPrompt: {
      type: 'custom',
      content: `当你遇到需要用户在多个选项间做出决策、选择、判断时，必须使用 AskUserQuestion 工具来提问，而不是在正文中直接列出选项等待用户手动打字回答。

AskUserQuestion 工具会呈现出格式良好的选择卡片，用户可以点击选项来快速完成决策，这是比在文本中列出「1. 2. 3.」更好的交互方式。`,
    },
    // 「询问」起跑必须强制走 canUseTool：用户全局 settings.json 把 Bash/Edit/Write 等整体 allow，
    // 而 allow 规则优先于 canUseTool（回调被架空、工具直接执行）。PreToolUse 钩子返回 ask
    // 把每次工具调用的裁决权交回 canUseTool（SDK 官方推荐做法）；裁决本身在策略门里（T6）。
    ...(sdkMode === 'default' ? { hooks: PRETOOL_ASK_HOOK } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    canUseTool: async (toolName, input) => {
      // 统一策略门（T6）：disabledTools/只读/区内写/越界/网络/危险命令都在规则表里裁决。
      // 无人值守下 gate 会把 ask 翻成 deny（并计次熔断）；交互路径 ask 走审批卡。
      const d = policyGate.decide(toolName, input);
      if (d.action === 'allow') return { behavior: 'allow' };
      if (d.action === 'deny') return { behavior: 'deny', message: d.reason };
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
      // payload 是 per-dialogKind 的不透明结构（UserDialogRequest.payload: Record<string, unknown>），
      // 静态拿不到形状，这条日志是唯一途径。走 logger 而不是 event-log：后者只留 3 天、封顶 1000 条，
      // 而每个 API 请求都记一条 access —— dialog 记录会被洪流挤干净（实测 1497 行日志全是 access，
      // type=dialog 一条不剩，这正是「dialogKind 待观测项」一直观测不到的原因）。
      logger.info('claude', 'onUserDialog', {
        dialogKind: request.dialogKind,
        payload: request.payload,
      });
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
      mirrorRunPatch(run.id, { session_id: info.session_id, updatedAt: Date.now() }); // 回填续跑锚点（双写）
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
  // 事件流（P2 影子）：provider run() 已启动。放在链式语句之后即可（onInit 是异步回调，不会早于本行）
  emitRunEvent(run, 'started', { pid: process.pid });
}

const resumeTimers = new Map(); // pending 条目 id -> setTimeout 句柄

// 续跑上限（MAX_RESUME_ATTEMPTS）与 openai 检查点续跑共用，定义收在 run-claude.logic.js。

// 异常结束后的重试延迟：给瞬态故障（进程崩溃/传输错误）一点恢复余地，又不让用户干等。
const RETRY_DELAY_MS = 2000;

/**
 * 续跑熔断：停止自动续跑并落 abandoned 标记（供前端消费一次终结提示后 dismiss）。
 * 有 entryId 走 updatePending（doResume 防御路径）；否则 addPending 新建标记（孤儿恢复路径）。
 */
function abandonResume({ convId, attempts, entryId, reason }) {
  logger.warn('web', '续跑熔断', { convId, attempts, reason });
  appendStandaloneRunEvent(convId, 'abandoned', { attempts, reason, entryId: entryId || null });
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
  mirrorRunRemove(run.id); // run 已收尾（任何路径），不再是重启恢复对象（active-runs 与影子索引同删）
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
  // ---- 异常自动重试：登记待续跑 + 2 秒后续接 session，取代「异常即标红终结」 ----
  // 与上面额度分支同构，且同样在 return 前**不触发 run.onSettle**：重试路径上任务逻辑没结束，
  // 提前回调会把需求系统任务的 busy 闸清掉、串行闸被击穿（见下方 onSettle 注释）。
  const hasError = !!err || !!run.is_error;
  const nextAttempt = (params.resumeAttempt || 0) + 1; // 代次 +1 递增，见下方 attempts 注释
  const eligible = isRetryEligible({
    hasError,
    status: run.status,
    subtype: run.subtype,
    sid,
    convId: params.convId,
  });
  if (eligible && !shouldAbandonResume(nextAttempt, MAX_RESUME_ATTEMPTS)) {
    const reason = err ? `Agent SDK 执行失败：${err?.message || String(err)}` : run.result || 'Claude 异常结束';
    const heldTexts = consumeHeldMsgs(run).map((m) => m.text); // 排队消息随重试带入，否则会被标「未发送」而丢掉
    const entry = addPending({
      convId: params.convId,
      session_id: sid,
      cwd: params.cwd,
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      // 代次 +1 递增（额度分支是继承不递增）：额度撞墙是外部资源限制、等重置必然有效；
      // 异常有病态循环风险必须计次。与孤儿恢复共享同一计数器 → 交替失败也绕不过上限。
      attempts: nextAttempt,
      reason: 'exception_retry',
      prompt: heldTexts.length ? heldTexts.join('\n\n') : undefined,
      resetsAt: Math.floor(Date.now() / 1000),
    });
    logger.warn('web', '异常结束，已排程自动重试', {
      runId: run.id,
      convId: params.convId,
      attempt: nextAttempt,
      watchdog: run.status === 'error', // true 说明看门狗已 failRun 广播过红字，下面的 retryRun 会 no-op
      reason,
    });
    // 看门狗/超时路径此刻 status 已是 'error'（failRun 广播完红字、SSE 也关了），retryRun 内部
    // 的 status 闸门会让它自动 no-op —— 那条路径的前端靠 done(is_error) 分支里的提前轮询接新 run。
    retryRun(
      run,
      `⚠️ ${reason}\n\n🔄 ${RETRY_DELAY_MS / 1000} 秒后自动重试（第 ${nextAttempt}/${MAX_RESUME_ATTEMPTS} 次）…`,
      RETRY_DELAY_MS,
    );
    scheduleRetry(entry, RETRY_DELAY_MS);
    return;
  }
  // 够格但超上限 → 落 abandoned 标记，让前端消费一次熔断提示后 dismiss；随后照旧走标红终结。
  // 有 resumePendingId 时走 updatePending 改状态（条目已存在），否则 addPending 新建。
  if (eligible) {
    abandonResume({
      convId: params.convId,
      attempts: nextAttempt,
      entryId: params.resumePendingId,
      reason: `连续 ${nextAttempt - 1} 次自动重试仍异常，超过上限 ${MAX_RESUME_ATTEMPTS}`,
    });
  }
  // 续跑正常收尾 → 清除登记。异常且够格的情况已由上面 abandonResume 落了 abandoned 标记，
  // 这里再 remove 会把它删掉，前端就永远看不到熔断提示了 —— 故加 !eligible 条件。
  if (params.resumePendingId && !eligible) removePending(params.resumePendingId);
  // 需求系统任务收尾钩子：requirement-ops 在 run 上挂 onSettle，此处是唯一真正终结（非续跑/重试）的汇聚点——
  // 上面 rejected（额度）与异常重试两个分支命中时都已 return，那里的 run 还会经 doResume 生成新 run
  // 接着跑，任务逻辑上并未结束，因此故意不在那两条路径触发本钩子（避免 busy 被提前清掉、串行闸被击穿）。
  // 代价是失败反馈最多延后 MAX_RESUME_ATTEMPTS 轮，期间该需求一直显示 busy —— 换来瞬态故障能自愈。
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

/** 异常结束后延迟重试（与 scheduleResume 的区别：固定短延迟，不看 token 重置时刻） */
function scheduleRetry(entry, delayMs) {
  const prev = resumeTimers.get(entry.id);
  if (prev) clearTimeout(prev);
  resumeTimers.set(
    entry.id,
    setTimeout(() => doResume(entry.id), delayMs),
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
  const priorRunId = entry.runId || null; // updatePending 会覆盖 runId，先留痕供 journal 追溯
  updatePending(entry.id, { status: 'resuming', runId: run.id });
  emitRunEvent(run, 'resumed', {
    fromRunId: priorRunId,
    attempt: entry.attempts || 0,
    reason: entry.reason || null,
    pendingId: entry.id,
  });
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

/**
 * 启动对账（P5，spec §4.5）：run-index 孤儿 → 读 journal 归类 → 续跑排程 / 熔断 / 摘除。
 *
 * 与 P5 前的主要差异：不再读 active-runs.json（升级存量由 migrateLegacyActiveRuns 一次性并入）；
 * Claude 与 openai 共用同一份索引与同一套 classifyInterrupted 判定，各自路由到自己的续跑入口。
 * 多实例守卫沿用 partitionRunIndex（属主进程存活且非自己的条目原样保留，防抢跑）。
 * @param {{scheduleOpenAi?: Function}} [deps] scheduleOpenAi 供测试注入（默认 openai 检查点续跑排程）
 */
export function reconcileRuns({ scheduleOpenAi = scheduleOpenAiOrphanResume } = {}) {
  // 升级迁移（幂等）：P5 前只写 active-runs 的存量条目先并入索引，避免升级首启丢孤儿
  try {
    migrateLegacyActiveRuns();
  } catch (e) {
    logger.warn('web', 'active-runs 存量迁移失败（跳过，继续对账）', { err: e?.message || String(e) });
  }
  const { orphans, foreign } = partitionRunIndex(listRunIndex(), {
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
  for (const entry of orphans) {
    const decision = classifyInterrupted(entry, readRunEvents(entry.runId), { maxAttempts: MAX_RESUME_ATTEMPTS });
    // 无论结局如何先摘旧条目（续跑/熔断都会写新记录）；失败时留待下次对账，journal settled 兜底
    try {
      removeRun(entry.runId);
    } catch (e) {
      logger.warn('web', '孤儿条目移除失败（继续处理）', { runId: entry.runId, err: e?.message || String(e) });
    }
    if (decision.action === 'discard') {
      logger.info('web', '中断 run 无需续跑，已摘除索引', {
        runId: entry.runId,
        convId: entry.convId || null,
        reason: decision.reason,
      });
      continue;
    }
    if (decision.action === 'abandon') {
      abandonResume({ convId: entry.convId, attempts: decision.attempt, reason: decision.reason });
      continue;
    }
    if (entry.provider === 'openai-compat') {
      logger.info('web', '恢复因进程重启中断的自定义模型任务（检查点续跑）', {
        runId: entry.runId,
        convId: entry.convId,
        attempt: decision.attempt,
      });
      scheduleOpenAi(entry, decision.attempt);
      continue;
    }
    logger.info('web', '恢复因进程重启中断的任务', {
      runId: entry.runId,
      convId: entry.convId,
      attempt: decision.attempt,
    });
    addPending({
      convId: entry.convId,
      session_id: entry.session_id,
      cwd: entry.cwd,
      model: entry.model,
      effort: entry.effort,
      mode: entry.mode,
      attempts: decision.attempt, // 续跑代次随孤儿链 +1
      reason: 'orphan_recovery', // 标记为进程重启孤儿恢复，非额度耗尽
      resetsAt: Math.floor(Date.now() / 1000), // 立即可续（scheduleResume 自带 +30s 缓冲）
    });
  }
}

/** 进程启动时调用：对账孤儿 run（Claude/openai 统一）+ 重排 pending 定时器（原 recoverPendingAndOrphans 职责）。
 * @param {{reconcile?: Function, schedule?: Function}} [deps] 测试注入（默认 reconcileRuns / scheduleResume）
 */
export function recoverPendingAndOrphans({ reconcile = reconcileRuns, schedule = scheduleResume } = {}) {
  reconcile();
  // 恢复「额度用尽待续跑」的排程（跨重启；含上面刚转换的孤儿条目）
  // abandoned（熔断）与 done 均不重排：熔断条目仅供前端消费一次终结提示后 dismiss
  for (const e of getPending()) if (e.status !== 'done' && e.status !== 'abandoned') schedule(e);
}
