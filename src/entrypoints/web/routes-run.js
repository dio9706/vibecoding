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
} from '../../store/runs.js';
import { getPending, removePendingByConv } from '../../store/pending-resume.js';
import { appendUserLog } from '../../store/user-log.js';
import { classifyTier } from './tier.js';
import { startClaudeRun } from './run-claude.js';
import { startOpenAiRun } from './run-openai.js';
import { sendJson } from './http-util.js';
import { normalizeMode, str } from './input.js';
import { withJsonBody } from './body.js';

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
    logUserText({ data, text: str(data.typedText) || prompt, kind: 'send', convId, session, cwd, model });
    const run = createRun();
    if (provider === 'openai-compat') {
      sendJson(res, 200, { runId: run.id, model });
      // credId 指明用**哪一条**凭证；缺省（老前端/老会话）由 startOpenAiRun 回退 pickActive
      const credId = str(data.credId);
      // startOpenAiRun 是 async：兜底 setup 阶段的同步/异步抛错 → failRun，避免未处理 rejection
      startOpenAiRun(run, { prompt, model, credId, cwd, convId }).catch((e) =>
        failRun(run, `自定义模型启动失败：${e?.message || String(e)}`),
      );
      return;
    }
    const auto = model === 'auto';
    run.steerHold = true; // Claude 运行：插话走服务端持有缓冲（可撤回/立即生效）
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
    startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId });
  });
}

/** 待续跑列表（前端轮询：展示等待横幅 + 发现续跑已开始去接流 + 熔断终结提示） */
export function handleRunPending(res) {
  const pending = getPending().map((e) => ({
    convId: e.convId,
    resetsAt: e.resetsAt,
    status: e.status,
    runId: e.runId,
    attempts: e.attempts || 0,
    reason: e.reason || 'quota_exhausted', // 默认 quota_exhausted，向后兼容旧条目
  }));
  sendJson(res, 200, { pending });
}

/** 前端失效清除 / 熔断消费后：按 convId 移除待续跑条目 */
export function handleRunPendingDismiss(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (convId) removePendingByConv(convId);
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

/** 插话：消息进服务端持有缓冲（可撤回/立即生效），本轮 result 时统一进入任务。
 *  run 已结束 / 不支持持有（openai-compat）返回 ok:false，由前端降级为新一轮。 */
export function handleRunSend(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const text = str(data.text);
    if (!text) return sendJson(res, 400, { error: 'text 不能为空' });
    const run = getRun(str(data.runId));
    if (!run || run.status !== 'running' || !run.steerHold) return sendJson(res, 200, { ok: false });
    const msgId = holdMsg(run, text);
    runPulse(run); // 喂看门狗：插话视为活动
    // 必须记在「消息确实被持有」之后：上面 ok:false 的分支前端会降级成新起一轮（改走 /api/run/start），
    // 那条路径自己会记一条，这里若提前记就重了。
    // kind='steer' 是高价值信号：用户在 AI 跑到一半时打断，等于在说「它走偏了」。
    logUserText({ data, text, kind: 'steer', convId: run.convId, session: run.session_id, cwd: run.cwd, model: run.model });
    sendJson(res, 200, { ok: true, msgId });
  });
}

/** 撤回一条尚未进入任务的插话消息；已 flush 返回 ok:false（前端提示无法撤回） */
export function handleRunMsgWithdraw(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const run = getRun(str(data.runId));
    const ok = !!(run && run.status === 'running' && withdrawHeldMsg(run, str(data.msgId)));
    sendJson(res, 200, { ok });
  });
}

/** 立即生效：全部持有消息按序 flush 进任务 + interrupt 打断当前轮，排队消息作为下一轮马上执行。
 *  先 flush 后打断：打断请求即使失败，消息已入流，最迟下一轮生效。 */
export function handleRunMsgNow(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const run = getRun(str(data.runId));
    if (!run || run.status !== 'running' || !run._input || typeof run._input.interrupt !== 'function') {
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
    sendTo(res, 'error', { message: 'run 不存在或已过期' });
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
    held: (run.heldMsgs || []).map((m) => m.id), // 排队消息对账：前端据此还原/清除排队态
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
