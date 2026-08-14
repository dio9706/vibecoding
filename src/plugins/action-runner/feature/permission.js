/**
 * 动作执行权限判定（纯函数）。
 *
 * 背景：ActionConfig.permission 长期是**死字段**——设置页让管理员选 Guest/Owner 并落盘，
 * 但全仓无任何代码读取它，executeAction 直接跑脚本。结果是任意员工发一句含关键词的话
 * （关键词匹配还是全文 includes）就能触发破坏性脚本。此模块把该字段真正接上。
 *
 * 语义：permission 是「最低要求档位」而非「精确匹配」——
 * 这一点必须与 dispatch.js 的 `f.permission === ctx.user.role` 全等写法区分开，
 * 那种写法会让 permission:'guest' 的动作把 owner 反而挡在外面（权限语义颠倒）。
 */

/** 角色等级：数值越大权限越高。未知角色不在表内 → 一律判负。 */
const ROLE_RANK = { guest: 1, owner: 2 };

/** 权限档位要求的最低等级。'any' 等价于 guest 档（最低门槛）。 */
const REQUIRED_RANK = { any: 1, guest: 1, owner: 2 };

/**
 * 该角色能否执行此动作。
 * fail-closed：permission 缺失或取值非法时，收窄到 owner-only 而不是放行 ——
 * 缺字段的历史配置、手改坏的 action-configs.json 都不应该等于「对全组织开放」。
 *
 * @param {{permission?: string}|null|undefined} actionConfig
 * @param {string|undefined} role 'owner' | 'guest'
 * @returns {boolean}
 */
export function canRunAction(actionConfig, role) {
  if (!actionConfig || typeof actionConfig !== 'object') return false;
  const rank = ROLE_RANK[role];
  if (!rank) return false; // 未知角色不外推，直接拒绝
  const perm = actionConfig.permission;
  // 非法/缺失 → 按最高档要求（owner）处理
  const required = typeof perm === 'string' && perm in REQUIRED_RANK ? REQUIRED_RANK[perm] : ROLE_RANK.owner;
  return rank >= required;
}
