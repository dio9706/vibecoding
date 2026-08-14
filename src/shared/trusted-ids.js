/**
 * 可信提交人名单解析 —— 纯函数，无副作用。
 *
 * 为什么放内核（shared/）而不是留在 team-tools/feedback/logic.js：
 * 会话回控（feishu-relay）与团队工具（team-tools）都要用它判断「谁能操作」，
 * 而插件之间禁止互相 import（同 card-actions.js 的处置：跨插件依赖会让
 * 「停用某插件」变成「另一个插件也一起挂掉」）。
 */

/**
 * 可信提交人名单出口：per-bot 设置（机器人编辑表单）优先，未配置（空/缺失/非数组）才回退 env。
 * 不做并集——否则设置页「清空」永远无法覆盖 env，用户改了没反应，语义不可预期。
 */
export function resolveTrustedOpenIds(bot, envList = []) {
  const fromBot = Array.isArray(bot?.trustedOpenIds) ? bot.trustedOpenIds.filter(Boolean) : [];
  return fromBot.length ? fromBot : (envList || []).filter(Boolean);
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
