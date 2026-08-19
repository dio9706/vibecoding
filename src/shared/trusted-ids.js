/**
 * 可信提交人名单解析 —— 纯函数，无副作用。
 *
 * 为什么放内核（shared/）而不是留在 team-tools/feedback/logic.js：
 * 会话回控（feishu-relay）与团队工具（team-tools）都要用它判断「谁能操作」，
 * 而插件之间禁止互相 import（同 card-actions.js 的处置：跨插件依赖会让
 * 「停用某插件」变成「另一个插件也一起挂掉」）。
 *
 * 调用方一律直接 import 本文件：feedback/logic.js、team-tools/trusted-trigger.js 里的同名导出
 * 只是向后兼容的再导出 shim，绕一层既掩盖真实来源，又把「插件停用」重新变成内核调用方的风险。
 */

/**
 * 可信提交人名单出口：取基础设置中「我的飞书 open_id」作为唯一可信提交人。
 * 单 open_id → 单元素数组；未填则返回空数组。
 *
 * 只认字符串：历史上本函数签名是 (bot, envList)，改签名后有 4 处调用点没跟着改，
 * 仍传 bot 对象进来 —— 返回 [对象] 让 includes(openIdStr) 永远 false，
 * 可信名单门禁**静默失效**（只剩 role==='owner' 兜着），排查成本极高。
 * 这里显式做类型闸：非字符串一律当未配置，宁可门禁关死也不要看起来在工作却没工作。
 */
export function resolveTrustedOpenIds(myFeishuOpenId) {
  const id = typeof myFeishuOpenId === 'string' ? myFeishuOpenId.trim() : '';
  return id ? [id] : [];
}

/**
 * 是否可信提交人：设置页可信名单命中，或 role=owner（与 feedback 直通判定同口径）。
 * 名单由调用方经 resolveTrustedOpenIds 解析后传入。
 *
 * 放内核（shared/）而不留在 team-tools/trusted-trigger.js：tracking-stats 是独立插件，
 * 而插件之间禁止互相 import（跨插件依赖会让「停用某插件」变成「另一个插件一起挂掉」）。
 * @param {{ user?: { id?: string, role?: string } }} ctx
 * @param {string[]} trustedOpenIds
 */
export function isTrustedSubmitter(ctx, trustedOpenIds) {
  if (ctx?.user?.role === 'owner') return true;
  const id = ctx?.user?.id;
  return !!id && (Array.isArray(trustedOpenIds) ? trustedOpenIds : []).includes(id);
}

/**
 * 「谁能操作我的私聊卡片」：本人（myFeishuOpenId）/ owner / 可信名单。
 * 原在 feishu-relay/logic.js —— 任务完成卡片（team-tools）要用同一把门禁尺子，
 * 而插件之间禁止互相 import，故一并上移内核（feishu-relay 侧原样再导出）。
 *
 * 名单一律走 Array.isArray 兜底（与 resolveTrustedOpenIds 同风格）：配置读坏了可能传进来
 * 对象或字符串这类 truthy 非数组值，`x || []` 拦不住，会在 .includes 上抛 TypeError 打穿门禁调用方。
 */
export function canOperateRelay(operatorOpenId, { myOpenId = '', ownerOpenIds = [], trustedOpenIds = [] } = {}) {
  if (!operatorOpenId) return false;
  const owners = Array.isArray(ownerOpenIds) ? ownerOpenIds : [];
  const trusted = Array.isArray(trustedOpenIds) ? trustedOpenIds : [];
  return operatorOpenId === myOpenId || owners.includes(operatorOpenId) || trusted.includes(operatorOpenId);
}
