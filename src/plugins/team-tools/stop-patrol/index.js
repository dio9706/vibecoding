/**
 * feature: 停止 BUG 巡检（\10004，可信提交人专属）。
 *
 * 循环状态与泵都在 web 进程（见 bug-patrol/loop.js 文件头），这里只跨进程下发停止指令，
 * 沿用 create-session / feishu-relay 的 postToWeb 范式（3s 超时 + 非 JSON 响应不抛穿）。
 *
 * order 15 —— 必须 < claude-exec(20) 才能抢在「owner 全接」之前接走；
 * 排在 status-report(14) 之后、feishu-relay(16) 之前，与其它可信人指令挨在一起。
 */
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import { getMyFeishuOpenId } from '../../../store/settings.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../../shared/trusted-ids.js';
import { matchesExactTrigger } from '../trusted-trigger.js';
import { STOP_TRIGGERS } from './logic.js';

/** 与 create-session / feishu-relay 的跨进程调用保持一致 */
const TIMEOUT_MS = 3000;

async function postStop() {
  const url = `http://127.0.0.1:${config.web.port}/api/patrol/stop`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true, wasActive: data.wasActive };
  } catch (e) {
    logger.warn('stop-patrol', '调用 web 路由失败', { err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再试' };
  }
}

function isTrusted(ctx) {
  return isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId()));
}

export default {
  name: 'stop-patrol',
  // any + match 自带可信门禁：非可信人发同样文案不命中，自然落常规流程（不暴露功能存在）
  permission: 'any',
  intents: [],
  // 全等比较在前，isTrusted 要读设置，别让每条消息都付这个成本
  match: (ctx) => matchesExactTrigger(ctx.text, STOP_TRIGGERS) && isTrusted(ctx),
  handle: async (ctx) => {
    const r = await postStop();
    if (!r.ok) return ctx.reply(`⚠️ ${r.error}`);
    if (!r.wasActive) return ctx.reply('当前没有正在运行的巡检。');
    logger.info('stop-patrol', '已下发停止指令', { openId: ctx.user.id });
    return ctx.reply('好的，已停止巡检。已经在修的问题会跑完，完成后给你一份最终汇报。');
  },
};
