/** web 入口：run 相关路由 handler（启动 / 停止 / 决策 / 插话 / 模式 / 待续跑 / SSE 附加） */
import fs from 'node:fs';
import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';
import {
  createRun,
  getRun,
  subscribe,
  unsubscribe,
  sendTo,
  runPulse,
  runModel,
  failRun,
  abortRunById,
  resolveDecision,
  setRunMode,
  holdMsg,
  withdrawHeldMsg,
  flushHeldMsgs,
  cancelPendingAsks,
  findRunningRunByConv,
  enqueueFollowUp,
  cancelFollowUp,
  buildFollowUpItem,
  listFollowUps,
  listFollowUpStarts,
  findFollowUpStartByItem,
} from '../../store/runs.js';
import { getPending, removePendingByConv } from '../../store/pending-resume.js';
import { claimSubmission, bindSubmission, peekSubmission } from '../../store/submissions.js';
import { runIdsToAbortOnDismiss, isResumePlanned } from './run-claude.logic.js';
import { appendUserLog } from '../../store/user-log.js';
import { classifyTier } from './tier.js';
import { startClaudeRun } from './run-claude.js';
import { startOpenAiRun } from './run-openai.js';
import { sendJson } from './http-util.js';
import { normalizeMode, str } from './input.js';
import { withJsonBody } from './body.js';
import { logger } from '../../shared/logger.js';
import { compactSession } from '../../integrations/claude.js';

/** 提交幂等认领的保留时长（见 store/submissions.js；web 侧重试/降级重放的窗口远小于此） */
const REQUEST_ID_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 记一条用户输入原始日志（记忆库数据采集层，见 store/user-log.js）。
 *
 * **fail-closed：只认前端显式打的 `userTyped` 标记**。web 执行台的「起跑 / 插话」两个接口
 * 同时也是程序化发送的通道（chat.js 的 sendMessageProgrammatically 发自动开发/API 修正/
 * 准则更新提示词，sendMessageBackground 发复盘总结提示词），那些不是用户敲的字，
 * 混进来会直接污染提炼。让它们「什么都不做就自动不入库」，比反过来逐个打排除标记安全得多 ——
 * 将来新增的程序化发送路径不必知道有这么个日志存在。
 *
 * 服务端自行发起的任务压根不经过本文件：额度耗尽/孤儿恢复的「继续」（run-claude.js 的
 * doResume）与 bug-fix 提示词（requirement-ops.js）都是直调 startClaudeRun，天然被隔在外面。
 */
function logUserText({ data, text, kind, convId, session, cwd, model }) {
  if (data.userTyped !== true) return;
  appendUserLog({ text, source: 'web', kind, convId, sessionId: session, cwd, model });
}

/**
 * 同 conv 已有 run 在跑时，把一次 /start 提交路由进 busy inbox（T2-P4，spec §4.4）。
 * 这是「同会话永不并发两个 run」的入口闸：不再新起 run，按能力路由——
 *   steer（Claude）：消息进运行中 run 的持有区，本轮 result 时 flush；
 *   follow-up（openai）：排队，当前 run 终结后由 conv-inbox 排空起下一轮。
 * 响应给 `runId: running.id`（前端照常 attach 看流）＋ `queued:true`（前端把消息气泡标排队）。
 * 幂等：重试命中 `queue:<requestId>` 认领时按原排队项回放；已排空则回放新 run 的 id 供接流。
 */
function queueIntoBusyConv(res, data, running, prompt, convId) {
  const caps = running.capabilities || {};
  if (!caps.steer && !caps.followUp) {
    // 两个能力都不支持：宁可拒绝也不并发（老 provider / 异常 run）；不消耗幂等键
    return sendJson(res, 200, { queued: false, error: '该会话已有任务在运行，当前任务不支持中途追加，请等它结束后再发送' });
  }
  const requestId = str(data.requestId);
  const claimKey = requestId ? 'queue:' + requestId : null;
  if (claimKey) {
    const claim = claimSubmission(claimKey, { ttlMs: REQUEST_ID_TTL_MS });
    if (claim.duplicate) {
      const ref = claim.entry?.ref || null;
      if (!ref) {
        // 受理中/死认领窗口（claim 与 bind 之间只有同步代码，正常不落）：拒绝重跑，消息不丢在服务端
        return sendJson(res, 200, { queued: false, duplicate: true, error: '该消息此前已受理但未完成排队，请重新发送' });
      }
      const started = findFollowUpStartByItem(ref);
      return sendJson(res, 200, {
        queued: true,
        duplicate: true,
        msgId: ref,
        mode: String(ref).startsWith('hm_') ? 'steer' : 'follow_up',
        runId: started ? started.runId : running.id,
      });
    }
  }
  const msgId = caps.steer
    ? holdMsg(running, prompt)
    : enqueueFollowUp(convId, buildFollowUpItem(running, { text: prompt, source: 'web' }));
  if (!msgId) {
    // 理论不可达（能力位已过闸）；保守拒绝，不静默吞消息
    return sendJson(res, 200, { queued: false, error: '消息排队失败，请稍后重试' });
  }
  if (claimKey) bindSubmission(claimKey, msgId);
  runPulse(running); // 喂看门狗：追加消息视为活动
  // 用户输入原始日志（记忆库数据采集层）：语义同 /send 的插话——跑到一半的追加都是「纠偏」信号
  logUserText({
    data,
    text: str(data.typedText) || prompt,
    kind: 'steer',
    convId,
    session: running.session_id,
    cwd: running.cwd,
    model: running.model,
  });
  return sendJson(res, 200, { queued: true, mode: caps.steer ? 'steer' : 'follow_up', msgId, runId: running.id });
}

/** 启动一次生成：创建服务端 run（独立于连接），返回 runId。关网页也不影响它继续跑。 */
export function handleRunStart(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, async (data) => {
    const prompt = str(data.prompt);
    const cwd = str(data.cwd);
    const session = str(data.session);
    let model = str(data.model);
    let effort = str(data.effort);
    // 白名单归一：该值原样落到 SDK permissionMode，透传等于把「免审批执行任意工具」
    // 的开关交给请求体。非法值 fail-closed 降级到 default（逐次询问）。详见 input.js。
    const mode = normalizeMode(data.mode);
    const convId = str(data.convId);
    const provider = str(data.provider) || DEFAULT_PROVIDER_ID;
    if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });
    if (cwd && !fs.existsSync(cwd)) return sendJson(res, 400, { error: `工作目录不存在：${cwd}` });
    const requestId = str(data.requestId);
    // 同会话永不并发（T2-P4 busy inbox）：该 conv 已有 run 在跑时不再新起 run，
    // 按能力路由进 inbox（steer / follow-up），响应 queued:true 由前端把消息标为排队。
    const running = convId ? findRunningRunByConv(convId) : null;
    if (running) {
      // 先前已受理过同一 requestId（start: 认领）→ 纯重试回放，不再进 inbox，避免消息被排队两次
      const late = requestId ? peekSubmission('start:' + requestId) : null;
      if (late) {
        return sendJson(
          res,
          200,
          late.ref
            ? { runId: late.ref, duplicate: true }
            : { runId: null, duplicate: true, error: '该消息此前已受理但未完成启动，请重新发送' },
        );
      }
      return queueIntoBusyConv(res, data, running, prompt, convId);
    }
    // 提交幂等（P1，见 store/submissions.js）：同一 requestId 的重复提交至多产生一个 run。
    // 命中已绑定认领 → 回放既有 runId（前端照常 attach：增量照收，已完成则收 done 重放）；
    // 命中未绑定的新认领 → 原处理可能仍在途（claim 与 bind 之间只有同步代码），拒绝重跑。
    // 注意顺序：先过参数校验再认领，校验失败的请求不消耗幂等键（客户端可原样重试）。
    const claimKey = requestId ? 'start:' + requestId : null;
    if (claimKey) {
      const claim = claimSubmission(claimKey, { ttlMs: REQUEST_ID_TTL_MS });
      if (claim.duplicate) {
        return sendJson(
          res,
          200,
          claim.entry?.ref
            ? { runId: claim.entry.ref, duplicate: true }
            : { runId: null, duplicate: true, error: '该消息此前已受理但未完成启动，请重新发送' },
        );
      }
    }
    logUserText({ data, text: str(data.typedText) || prompt, kind: 'send', convId, session, cwd, model });
    const run = createRun();
    if (claimKey) bindSubmission(claimKey, run.id);
    if (provider === 'openai-compat') {
      sendJson(res, 200, { runId: run.id, model });
      // credId 指明用**哪一条**凭证；缺省（老前端/老会话）由 startOpenAiRun 回退 pickActive
      const credId = str(data.credId);
      // startOpenAiRun 是 async：兜底 setup 阶段的同步/异步抛错 → failRun，避免未处理 rejection
      // mode 一并透传（T6）：openai 路径与 Claude 共用同一份工具策略规则表
      startOpenAiRun(run, { prompt, model, credId, cwd, convId, requestId, mode, effort }).catch((e) =>
        failRun(run, `自定义模型启动失败：${e?.message || String(e)}`),
      );
      return;
    }
    const auto = model === 'auto';
    run.capabilities.steer = true; // Claude 运行：插话走服务端持有缓冲（可撤回/立即生效）
    // 立即返回 runId：auto 判档（Haiku，最长 8s）异步进行，期间 run 已可停止、可插话
    //（插话进持有缓冲 heldMsgs，本轮 result 时统一 flush；判档结果经 model 事件补告前端）
    sendJson(res, 200, { runId: run.id, model: auto ? '' : model, effort: auto ? '' : effort });
    if (auto) {
      const tier = await classifyTier(prompt); // 内部自带超时/失败 → medium 兜底
      model = tier.model;
      effort = tier.effort;
    }
    if (run.status !== 'running') return; // 判档窗口内被手动停止
    if (auto) runModel(run, { model, effort });
    startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId, requestId });
  });
}

/** 待续跑列表（前端轮询：展示等待横幅 + 发现续跑已开始去接流 + 熔断终结提示）。
 *  P4 起附 followUps：最近由 busy inbox 排空启动的新 run（{convId, runId, ids, at}），
 *  前端据此发现并接上新 run 的流、清除对应排队气泡——排空的 run 不属于待续跑表。 */
export function handleRunPending(res) {
  const pending = getPending().map((e) => ({
    convId: e.convId,
    resetsAt: e.resetsAt,
    status: e.status,
    runId: e.runId,
    attempts: e.attempts || 0,
    reason: e.reason || 'quota_exhausted', // 默认 quota_exhausted，向后兼容旧条目
  }));
  sendJson(res, 200, { pending, followUps: listFollowUpStarts() });
}

/** 前端失效清除 / 熔断消费 / 等待重试期间点停止后：按 convId 移除待续跑条目 */
export function handleRunPendingDismiss(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (convId) {
      // 已起跑的重试/续跑 run 必须一并中止：删条目只是让前端不再接流，进程还在烧额度、
      // 还在写工作目录。窄竞态——用户在 2 秒重试窗口的末尾点停止时 doResume 可能已经起跑了。
      const doomed = runIdsToAbortOnDismiss(getPending().filter((e) => e.convId === convId));
      for (const id of doomed) abortRunById(id, '已手动停止');
      removePendingByConv(convId);
    }
    sendJson(res, 200, { ok: !!convId });
  });
}

/** 手动停止某 run（用户点“停止”）：中断 SDK 查询并按「已停止」中性终结 */
export function handleRunAbort(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const ok = abortRunById(str(data.runId), '已手动停止');
    sendJson(res, 200, { ok });
  });
}

/** 用户提交交互决策（审批/选项）→ 解析对应 pending，续跑 */
export function handleRunDecision(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const ok = resolveDecision(str(data.runId), str(data.reqId), String(data.optionId ?? ''));
    sendJson(res, 200, { ok });
  });
}

/** 插话 / 排队（busy inbox，T2-P4）：按 run 的能力位路由——
 *  capabilities.steer → 消息进服务端持有缓冲（可撤回/立即生效），本轮 result 时统一进入任务；
 *  仅 capabilities.followUp → 排队（follow-up），当前 run 终结后由 conv-inbox 排空起下一轮。
 *  run 已结束 / 两个能力都没有 → ok:false，由前端降级为新一轮。 */
export function handleRunSend(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const text = str(data.text);
    if (!text) return sendJson(res, 400, { error: 'text 不能为空' });
    const run = getRun(str(data.runId));
    if (!run || run.status !== 'running') return sendJson(res, 200, { ok: false });
    const caps = run.capabilities || {};
    const intoCurrent = !!caps.steer; // 进当前 run
    const intoQueue = !intoCurrent && !!caps.followUp && !!run.convId; // 排队为下一轮
    if (!intoCurrent && !intoQueue) return sendJson(res, 200, { ok: false });
    // 提交幂等（P1）：同 requestId 的网络重试回放同一 msgId，不重复持有/排队。
    // 认领放在 run 存活检查之后：run 已结束时的重复提交应回 ok:false 让前端走降级新一轮，
    // 而不是回放一条这条 run 永远消费不了的插话。
    const requestId = str(data.requestId);
    const claimKey = requestId ? 'steer:' + requestId : null;
    if (claimKey) {
      const claim = claimSubmission(claimKey, { ttlMs: REQUEST_ID_TTL_MS });
      if (claim.duplicate) {
        const ref = claim.entry?.ref || null;
        return sendJson(
          res,
          200,
          ref
            ? { ok: true, msgId: ref, duplicate: true, mode: String(ref).startsWith('hm_') ? 'steer' : 'follow_up' }
            : { ok: false, duplicate: true },
        );
      }
    }
    const msgId = intoCurrent
      ? holdMsg(run, text)
      : enqueueFollowUp(run.convId, buildFollowUpItem(run, { text, source: 'web' }));
    if (!msgId) return sendJson(res, 200, { ok: false });
    if (claimKey) bindSubmission(claimKey, msgId);
    runPulse(run); // 喂看门狗：插话/排队视为活动
    // 必须记在「消息确实被持有」之后：上面 ok:false 的分支前端会降级成新起一轮（改走 /api/run/start），
    // 那条路径自己会记一条，这里若提前记就重了。
    // kind='steer' 是高价值信号：用户在 AI 跑到一半时打断，等于在说「它走偏了」。
    logUserText({ data, text, kind: 'steer', convId: run.convId, session: run.session_id, cwd: run.cwd, model: run.model });
    sendJson(res, 200, { ok: true, msgId, mode: intoCurrent ? 'steer' : 'follow_up' });
  });
}

/** 撤回一条尚未进入任务的插话/排队消息；已消费返回 ok:false（前端提示无法撤回）。
 *  steer 在 run.heldMsgs（仅运行中）；follow-up 在 conv inbox（conv 级，排空后不存在）。 */
export function handleRunMsgWithdraw(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const run = getRun(str(data.runId));
    const msgId = str(data.msgId);
    let ok = false;
    if (run) {
      if (run.status === 'running' && withdrawHeldMsg(run, msgId)) ok = true;
      if (!ok && run.convId && cancelFollowUp(run.convId, msgId)) ok = true;
    }
    sendJson(res, 200, { ok });
  });
}

/** 立即生效：全部持有消息按序 flush 进任务 + interrupt 打断当前轮，排队消息作为下一轮马上执行。
 *  先 flush 后打断：打断请求即使失败，消息已入流，最迟下一轮生效。
 *  follow-up 队列（openai）没有「中途插入」接口，无法立即生效——回 ok:false + mode 供前端给准话术。 */
export function handleRunMsgNow(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const run = getRun(str(data.runId));
    if (!run || run.status !== 'running') return sendJson(res, 200, { ok: false });
    if (!(run.capabilities || {}).steer) {
      return sendJson(res, 200, { ok: false, mode: (run.capabilities || {}).followUp ? 'follow_up' : undefined });
    }
    if (!run._input || typeof run._input.interrupt !== 'function') {
      return sendJson(res, 200, { ok: false }); // 含判档窗口（_input 未就绪）：消息继续持有，首轮 result 自动进入
    }
    if (!run.heldMsgs.length) return sendJson(res, 200, { ok: true }); // 与本轮自然 flush 重合：已进入任务，无需打断
    const flushed = flushHeldMsgs(run);
    if (!flushed.length) {
      // push 全部返回 false：输入流已关闭（autoClose 已触发），run 即将自然结束；
      // 消息仍在 heldMsgs，done 事件会将其标为 unsent；此处告知前端失败以触发提示。
      return sendJson(res, 200, { ok: false });
    }
    cancelPendingAsks(run); // 被打断轮的挂起审批按默认值作废，避免悬空
    run._input.interrupt().catch(() => {}); // 打断失败不致命（见上）
    runPulse(run); // 必须保留：cancelPendingAsks 退出 waiting 后不刷计时，靠这里防看门狗误杀
    sendJson(res, 200, { ok: true });
  });
}

/** 运行中切换权限模式（仅放宽）：「询问」起跑的 run 即时生效并自动放行挂起审批 */
export function handleRunSetMode(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    // 这里不走 normalizeMode：setRunMode 自带「仅放宽 + 非法目标不生效」的裁决，
    // 先归一成 default 反而会把非法值变成一个合法目标，改变语义（已有单测覆盖）。
    const applied = setRunMode(str(data.runId), str(data.mode));
    sendJson(res, 200, { applied });
  });
}

/** 附加到某 run 的 SSE 流：先重放已缓冲内容，再续推增量；断开只退订，不中断 run。 */
export function handleRunAttach(url, res) {
  const runId = (url.searchParams.get('runId') || '').trim();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const run = getRun(runId);
  if (!run) {
    // convId 缺失（老前端/异常调用）时给 null 而不是 false：前端把 null 当「未知」按现状静默
    // 等待。拿不到判据就谎报 false 会把真会续跑的任务提前终结，代价比多转一会儿圈大。
    const convId = (url.searchParams.get('convId') || '').trim();
    const resumePlanned = convId ? isResumePlanned(getPending(), convId) : null;
    sendTo(res, 'error', { message: 'run 不存在或已过期', resumePlanned });
    return res.end();
  }

  // 心跳保活：定期发注释帧穿透空闲超时；写失败即判连接已死并清理
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 15000);
  const cleanup = () => {
    clearInterval(ping);
    unsubscribe(run, res);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  // 重放服务端权威全文 + 会话 + 最近活动 + 状态（同步执行，与后续 fanout 不交错）
  sendTo(res, 'replay', {
    text: run.text,
    session_id: run.session_id,
    activity: run.lastActivity,
    activities: run.activities,
    todos: run.todos,
    model: run.modelInfo, // auto 判档结果（重连时恢复模型标签）

    ask: run.pending
      ? {
          reqId: run.pending.reqId,
          kind: run.pending.kind,
          title: run.pending.title,
          body: run.pending.body,
          options: run.pending.options,
        }
      : null,
    // 排队消息对账：前端据此还原/清除排队态。P4 起含 conv inbox 的 follow-up——
    // 它们同样「在服务端等着、可撤回」，漏掉会让重连时误清排队标记（撤回按钮消失）。
    held: [...(run.heldMsgs || []).map((m) => m.id), ...listFollowUps(run.convId).map((m) => m.id)],
    status: run.status,
  });
  if (run.status === 'running') {
    subscribe(run, res); // 继续接收增量
  } else {
    // 已结束：补发 done 并关闭
    sendTo(res, 'done', {
      result: run.result || run.text,
      is_error: run.is_error,
      subtype: run.subtype,
      ...(run.unsentIds && run.unsentIds.length ? { unsent: run.unsentIds } : {}), // 关页期间终结的 run，重连补发时恢复「未发送」标记
    });
    res.end();
  }
}

// ==== POST /api/conversation/compact ====
/**
 * 触发上下文压缩（Context Compact）。
 * 通过 Claude CLI 子进程对指定 session 发送 /compact 指令。
 * 返回 { success, newSessionId, inputTokensBefore, inputTokensAfter }。
 */
export function handleConvCompact(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, async (data) => {
    const convId = str(data.convId);
    const currentSessionId = str(data.currentSessionId);

    if (!convId || !currentSessionId) {
      sendJson(res, 400, { success: false, error: 'Missing convId or currentSessionId' });
      return;
    }

    try {
      const result = await compactSession(currentSessionId);
      sendJson(res, 200, { success: true, ...result });
    } catch (err) {
      logger.error('web', 'compact 接口异常', { convId, error: err.message });
      sendJson(res, 500, { success: false, error: err.message });
    }
  });
}
