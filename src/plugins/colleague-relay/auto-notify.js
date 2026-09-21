/**
 * 归属确定后通知 web 进程做四期自动处理（分类 + 起子会话）。
 *
 * fire-and-forget：消息已 appendMessage 落盘，web 不可达只是「这次不自动处理」，
 * 绝不能让飞书回执链路被它拖慢或打断。沿用 create-session / bug-patrol 的跨进程范式：
 * 3s 超时 + 非 JSON 不抛穿。**不重试**：路由是校验后立即 202，不该超时；重试会在
 * 「入队到收尾」的窗口里制造同 msgId 的重复任务（见 routes-requirements#handleColleagueAuto 注释）。
 *
 * role 在这里预判而不只靠 web 端 400：非后端同事每条消息都打一次注定被拒的请求，
 * 日志里全是噪音。web 端的 400 仍保留，那是防御。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

const TIMEOUT_MS = 3000;

/**
 * @param {{reqId: string, colleagueId: string, role: string, msgIds: string[]}} p
 * @returns {Promise<boolean>} 是否被 web 受理（202）。调用方通常不 await，返回值只给测试用
 */
export async function notifyAutoHandle({ reqId, colleagueId, role, msgIds } = {}) {
  const ids = (Array.isArray(msgIds) ? msgIds : []).filter((x) => typeof x === 'string' && x);
  if (role !== 'backend' || !reqId || !colleagueId || !ids.length) return false;
  const url = `http://127.0.0.1:${config.web.port}/api/req/colleague-messages/auto`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId, colleagueId, msgIds: ids }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 202) return true;
    const data = await r.json().catch(() => ({}));
    // 400（id 已处理 / 不属于线程 / 同事不存在）与 409（非开发期 —— 选卡回调是用户点卡时才 flush，需求可能已离开 dev）
    // 都是「按规则不该自动处理」，info 级；其它状态才 warn。error 字段一并带出，事后能翻
    const level = r.status === 400 || r.status === 409 ? 'info' : 'warn';
    logger[level]('colleague-relay', '自动处理未受理', { reqId, colleagueId, status: r.status, error: data.error });
    return false;
  } catch (e) {
    logger.warn('colleague-relay', '通知 web 自动处理失败（消息已落盘，不影响回执）', { reqId, err: e?.message || String(e) });
    return false;
  }
}
