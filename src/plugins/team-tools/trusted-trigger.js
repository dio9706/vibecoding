/**
 * 可信提交人专属指令的共用纯函数 —— bug-patrol / status-report 共用。
 * 设计铁律（用户拍板）：指令只认「指定文案严格匹配」（去首尾空白后全等），
 * 绝不做模糊/前缀/LLM 识别 —— 宁可不触发，也不要把普通消息误认成指令。
 */

/**
 * 消息是否全等命中触发文案之一（去首尾空白，大小写敏感）。
 * @param {unknown} text
 * @param {string[]} triggers
 */
export function matchesExactTrigger(text, triggers) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return false;
  return (Array.isArray(triggers) ? triggers : []).includes(t);
}

/**
 * 是否可信提交人：设置页可信名单命中，或 role=owner（与 feedback 直通判定同口径）。
 * 名单由调用方经 resolveTrustedOpenIds 解析后传入（per-bot 设置优先、回退 env）。
 * @param {{ user?: { id?: string, role?: string } }} ctx
 * @param {string[]} trustedOpenIds
 */
export function isTrustedSubmitter(ctx, trustedOpenIds) {
  if (ctx?.user?.role === 'owner') return true;
  const id = ctx?.user?.id;
  return !!id && (Array.isArray(trustedOpenIds) ? trustedOpenIds : []).includes(id);
}
