/**
 * feature: 新建会话（\10003，可信提交人专属）。
 * 触发文案严格匹配（零 LLM）→ 调用 web 路由 POST /api/conv-notify/new
 * → 获取前 8 位 shortId → 回复用户会话 ID 和使用说明。
 *
 * order 13 排在 bug-patrol(12) 和 status-report(14) 之间，必须在 claude-exec(20) 之前。
 */
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import { getMyFeishuOpenId } from '../../../store/settings.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../../shared/trusted-ids.js';
import { matchesExactTrigger } from '../trusted-trigger.js';
import { CREATE_SESSION_TRIGGERS } from './logic.js';

/** 超时设置：与 feishu-relay 的 postInject 保持一致 */
const TIMEOUT_MS = 3000;

/**
 * 跨进程调用 web 路由创建新会话
 * @returns {{ ok: boolean, convId?: string, error?: string }}
 */
async function createNewSession() {
  const url = `http://127.0.0.1:${config.web.port}/api/conv-notify/new`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 非 JSON 响应不能让 .json() 抛穿
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true, convId: data.convId };
  } catch (e) {
    logger.warn('create-session', '调用 web 路由失败', { err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再试' };
  }
}

function isTrusted(ctx) {
  return isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId()));
}

export default {
  name: 'create-session',
  // any + match 自带可信门禁
  permission: 'any',
  intents: [],
  // 全等比较在前，isTrusted 要读设置，别让每条消息都付这个成本
  match: (ctx) => matchesExactTrigger(ctx.text, CREATE_SESSION_TRIGGERS) && isTrusted(ctx),
  handle: async (ctx) => {
    try {
      const result = await createNewSession();
      if (!result.ok) {
        logger.warn('create-session', '新建会话失败', { error: result.error });
        return ctx.reply(`⚠️ ${result.error}`);
      }

      // 获取前 8 位 shortId
      const convId = result.convId;
      const shortId = convId.slice(0, 8);

      logger.info('create-session', '新建会话成功', { convId, shortId });
      return ctx.reply(
        `✅ 已新建会话\n` +
        `会话ID：${shortId}\n` +
        `向我发送「会话 ${shortId} 你的内容」即可开始对话`
      );
    } catch (e) {
      logger.error('create-session', '新建会话异常', { err: e?.message || String(e) });
      return ctx.reply(`⚠️ 执行台无响应，请稍后再试`);
    }
  },
};
