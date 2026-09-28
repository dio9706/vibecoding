/**
 * 同事入站消息的共用层：名册判定 → 落盘 → 跨进程触发 web 跑 agent。
 *
 * **文本与附件两条链路必须共用本文件。** 文本走 dispatch feature，附件在
 * `entrypoints/feishu/index.js` 的 image/file 早期分支就被接走（到不了 dispatch）。
 * 各写一份判定的后果是「文字归对了需求、附件归错了」—— relay 时代已经踩过。
 *
 * 与上一代（`colleague-relay` 插件，已在 P3 下线）的归属判定 `resolveTargets` 相比，
 * 关键差别：**不再要求同事至少在一个开发期需求里**。换锚点后对话锚在人身上，没有需求
 * 也能聊（agent 会问清楚，或如实说不知道）；旧判定会让「同事随口问一句」掉回 feedback
 * 被当成新需求收走。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { getColleagues as realGetColleagues } from '../../store/colleagues.js';
import { appendTo as realAppendTo } from '../../store/colleague-messages.js';

/** 纯判定：这个 open_id 是名册里的同事吗。附件链路要先判再决定走哪条分支 */
export function isColleagueMessage(openId, colleagues) {
  if (!openId) return null;
  return (colleagues || []).find((c) => c.feishuOpenId === openId) || null;
}

/** 跨进程超时。与 create-session / bug-patrol / auto-notify 等既有范式同值 */
const TIMEOUT_MS = 3000;

/**
 * 跨进程直送 web 跑一轮 agent。
 *
 * fire-and-forget + 3s 超时 + **不重试**：重试会在「入队到收尾」的窗口里制造同 msgId
 * 的重复任务（上一代 `colleague-relay` 插件的 `auto-notify.js`（已随插件一并下线）
 * 踩过这个坑，原样沿用它的结论）。
 *
 * **必须看响应状态码**：web 侧在插件停用时回 409、参数不合法时回 400，不看的话这些
 * 失败在飞书侧完全静默，日志里一个字都没有。分级同 `auto-notify.js`：
 * 4xx 是「按规则不该处理」记 info，其余才 warn。
 */
async function realPostToWeb(body) {
  const url = `http://127.0.0.1:${config.web.port}/api/req/colleague-agent/turn`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // AbortSignal.timeout 比手写 AbortController + setTimeout + clearTimeout 少三行、
      // 也不会忘记清定时器。本仓 auto-notify.js 用的就是它。
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 202) return true;
    const data = await r.json().catch(() => ({}));
    const level = r.status === 400 || r.status === 409 ? 'info' : 'warn';
    logger[level]('colleague-agent', 'web 未受理本轮', {
      colleagueId: body.colleagueId,
      status: r.status,
      error: data.error,
    });
    return false;
  } catch (e) {
    logger.warn('colleague-agent', '跨进程触发失败（消息已落盘，不重试）', {
      colleagueId: body.colleagueId,
      err: e?.message || String(e),
    });
    return false;
  }
}

/**
 * 接管一条同事消息。
 *
 * @param {{openId:string, text?:string, files?:Array}} m
 * @param {object} [deps] 注入便于单测
 * @returns {Promise<boolean>} true = 已接管（调用方应 return，别再往下走）
 */
export async function relayToAgent(m, deps = {}) {
  const {
    getColleagues = realGetColleagues,
    appendTo = realAppendTo,
    postToWeb = realPostToWeb,
  } = deps;

  const colleague = isColleagueMessage(m?.openId, getColleagues());
  if (!colleague) {
    // 留痕：排查「同事发的消息怎么被当成新需求收了」时，这行是唯一线索
    logger.info('colleague-agent', '不接管，交回后续 feature', { openId: m?.openId, reason: '不在同事名册' });
    return false;
  }

  const saved = appendTo(colleague.id, {
    dir: 'in',
    text: m.text || '',
    role: colleague.role, // 发信当时的职位快照
    files: Array.isArray(m.files) ? m.files : [],
    reqId: null, // 归属由 agent 判，入站时不猜
  });

  // 这里的 try/catch 不是为了 realPostToWeb —— 它自己已经把网络错误与非 202 响应
  // 都吞掉并记了日志、只返回 boolean。留着是为了兜住**注入的桩**抛出的异常（单测有一条
  // 专门让桩 throw），以及将来万一有人把 postToWeb 换成会抛的实现。
  //
  // 所以 postToWeb 的返回值在这里**刻意不被消费**（连成功的 true 也不读）：本函数的返回值
  // 回答的是「这条消息归不归 agent 管」，而不是「这轮跑没跑成」。两者混为一谈，
  // 就会在 web 暂时不可达时把消息退回 feedback，变成一条消息两套处理。
  try {
    await postToWeb({
      colleagueId: colleague.id,
      text: m.text || '',
      msgId: saved?.id || null,
      files: Array.isArray(m.files) ? m.files : [],
    });
  } catch (e) {
    logger.warn('colleague-agent', '跨进程触发异常（消息已落盘，不重试）', {
      colleagueId: colleague.id,
      err: e?.message || String(e),
    });
  }
  // **无论 POST 成没成功都返回 true**：消息已经落盘，主机在 web 端看得到原文。
  // 退回 false 会让同一条消息接着被 feedback 当成新需求收走 —— 一条消息两套处理更糟。
  return true;
}
