/**
 * 备用 Token 轮换引擎。
 * 纯函数（pickActive / reduceRateLimit / recoverExpired）承载状态机，便于单测；
 * 有状态胶水（Task 3）读写 settings 存储并管理 switch-back 定时器。
 * active token 不落库，由 pickActive 实时计算 = 偏好最高的可用号
 * → “重置后切回原账号”自然涌现（主号恢复 healthy 即重新成为 active）。
 */

import { DEFAULT_PROVIDER_ID } from '../shared/provider-ids.js';

// —— 纯函数（单测目标）——

// —— 额度耗尽判定：备用 token 池存在但无任何可用（healthy/warning）号 = 全 exhausted。
//    空池返回 false：未配置备用池时走主账号登录，无法据此判断可用性，不做 fail-fast。
export function isPoolExhausted(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (list.length === 0) return false;
  return !list.some((t) => t && (t.status === 'healthy' || t.status === 'warning'));
}

/** 偏好最高的可用 token：healthy 优先 → 退 warning → 全 exhausted / 空池返回 null。列表顺序=偏好。
 *  providerId 给定时仅在该 provider 内选（缺字段的旧 token 视为 claude-agent）；省略则跨所有 provider（向后兼容）。 */
export function pickActive(tokens, providerId) {
  let list = Array.isArray(tokens) ? tokens : [];
  if (providerId != null) list = list.filter((t) => (t.providerId || DEFAULT_PROVIDER_ID) === providerId);
  return list.find((t) => t.status === 'healthy') || list.find((t) => t.status === 'warning') || null;
}

/**
 * 依据某 token 的限流事件推进状态机。纯函数：不改入参，返回新数组 + 可能的切换通知。
 * @param {Array} tokens
 * @param {string} tokenId 发起该 run 用的 token id（限流归因对象）
 * @param {{status:string,resetsAt?:number,rateLimitType?:string,utilization?:number}} info
 * @param {number} nowSec 当前 epoch 秒（显式传入，避免 Date.now 不确定性）
 * @returns {{tokens:Array, notice:(object|null)}}
 */
export function reduceRateLimit(tokens, tokenId, info, nowSec) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!info || typeof info.status !== 'string') return { tokens: list, notice: null };
  const idx = list.findIndex((t) => t.id === tokenId);
  if (idx < 0) return { tokens: list, notice: null };
  const pid = list[idx].providerId || DEFAULT_PROVIDER_ID; // switch 通知按被限流 token 所属 provider 计算
  const before = pickActive(list, pid);
  const t = { ...list[idx] };
  // 当前计费窗口结束时刻：与 resetsAt（被限流后何时解禁）语义不同，任何状态下都有意义，
  // 不随状态清空 —— 记忆库调度器靠它命中「重置前 30 分钟」窗口（spec §10）
  if (typeof info.resetsAt === 'number') t.windowResetsAt = info.resetsAt;
  if (info.status === 'allowed') {
    t.status = 'healthy';
    t.resetsAt = null;
    t.utilization = null;
    t.rateLimitType = null;
  } else if (info.status === 'allowed_warning') {
    t.status = 'warning';
    t.utilization = typeof info.utilization === 'number' ? info.utilization : t.utilization ?? null;
    t.resetsAt = info.resetsAt ?? t.resetsAt ?? null;
    t.rateLimitType = info.rateLimitType ?? t.rateLimitType ?? null;
  } else if (info.status === 'rejected') {
    t.status = 'exhausted';
    t.resetsAt = info.resetsAt ?? nowSec + 3600;
    t.rateLimitType = info.rateLimitType ?? t.rateLimitType ?? null;
  } else {
    return { tokens: list, notice: null };
  }
  t.updatedAt = new Date(nowSec * 1000).toISOString();
  const next = list.slice();
  next[idx] = t;
  const after = pickActive(next, pid);
  const notice =
    (before?.id || null) !== (after?.id || null)
      ? { kind: 'switch', from: before?.label || null, to: after?.label || null, at: nowSec }
      : null;
  return { tokens: next, notice };
}

/**
 * Switch-back：把已到重置时刻（resetsAt<=nowSec）的非 healthy token 恢复 healthy。
 * @returns {{tokens:Array, changed:boolean}}
 */
export function recoverExpired(tokens, nowSec) {
  const list = Array.isArray(tokens) ? tokens : [];
  let changed = false;
  const next = list.map((t) => {
    if (t.status !== 'healthy' && typeof t.resetsAt === 'number' && t.resetsAt <= nowSec) {
      changed = true;
      return { ...t, status: 'healthy', resetsAt: null, utilization: null, rateLimitType: null,
               windowResetsAt: t.windowResetsAt ?? null };
    }
    return t;
  });
  return { tokens: next, changed };
}

// —— 有状态胶水（读写 settings、switch-back 定时器、切换通知）——
import { getTokens as _getTokens, mutateTokens } from '../store/settings.js';

// 重新导出供外部使用
export { _getTokens as getTokens };

let _notice = null; // 最近一次切换通知（供前端消费）
const _timers = new Map(); // tokenId -> setTimeout（switch-back）

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 掩码 token：前 7 位 + … + 末 4 位；过短（≤11，两段会重叠）直接全掩码 */
export function maskToken(tok) {
  const s = String(tok || '');
  return s.length <= 11 ? '••••' : s.slice(0, 7) + '…' + s.slice(-4);
}

/** 当前该用哪个 token 起跑：返回 {id, token, label} 或 null（未配置/全 exhausted → 不注入 env） */
export function getActiveToken(providerId = DEFAULT_PROVIDER_ID) {
  const a = pickActive(_getTokens(), providerId);
  return a ? { id: a.id, token: a.token, label: a.label } : null;
}

/**
 * 供任意 runClaude 调用方接入 token 轮换：注入 active token 的 env + 限流归因回调。
 * 无可用备用号返回 {}（不注入 env = 用主账号登录）。
 * 用法：runClaude(prompt, { ...claudeAuthOpts(), ...其它 })
 */
export function claudeAuthOpts() {
  const a = getActiveToken();
  if (!a) return {};
  return {
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: a.token },
    onRateLimit: (info) => noteRateLimit(a.id, info),
  };
}

/** 记入一次限流事件（tokenId=发起 run 的号）；有变更才持久化，随后重排定时器 */
export function noteRateLimit(tokenId, info) {
  if (!tokenId || !info || !info.status) return;
  let notice = null;
  // 锁内读-改-写：web / feishu 两进程都会上报限流，不锁会互相覆盖 token 状态
  mutateTokens((cur) => {
    const r = reduceRateLimit(cur, tokenId, info, nowSec());
    notice = r.notice;
    return r.tokens === cur ? false : r.tokens; // 无变化不写盘（减少 feishu watch 抖动）
  });
  if (notice) _notice = notice;
  scheduleAllSwitchBacks();
}

/** 前端轮询数据：active + 掩码列表 + 待消费通知。
 *  active 按 provider 计算（默认 claude-agent），与 getActiveToken/getActiveTokenId 语义一致——
 *  避免 openai-compat 凭证排序靠前时被误报为 Claude 池的 active。
 *  展示层做一次瞬态到期检查：resetsAt 已过的 token 即刻显示为 healthy，
 *  无需等定时器触发（不写盘，写盘恢复仍由 doRecover 定时执行）。 */
export function getStatus(providerId = DEFAULT_PROVIDER_ID) {
  const raw = _getTokens();
  // 瞬态恢复：仅用于展示，不写盘——消除定时器 30s 缓冲期内的「已过期却仍显 exhausted」问题
  const { tokens } = recoverExpired(raw, nowSec());
  const a = pickActive(tokens, providerId);
  return {
    active: a ? { id: a.id, label: a.label } : null,
    tokens: tokens.map((t) => ({
      id: t.id,
      providerId: t.providerId || DEFAULT_PROVIDER_ID,
      label: t.label,
      status: t.status,
      resetsAt: t.resetsAt ?? null,
      utilization: t.utilization ?? null,
      masked: maskToken(t.token),
    })),
    notice: _notice,
  };
}

export function consumeNotice() {
  _notice = null;
}

/** 为所有非 healthy 且有 resetsAt 的 token 排 switch-back 定时器（幂等；跨重启在 web 入口调一次）。
 *  注：warning 若无 resetsAt 则不排定时器——它仍可用（pickActive 兜底），靠下一次 rate_limit(allowed) 事件清回 healthy。
 *
 *  关键区分：
 *  - resetsAt 已过（陈旧状态，进程重启前就该恢复）→ 批量静默恢复，不产生切换通知。
 *    避免服务启动时因清理历史 exhausted 状态而触发「已切换到账号 X」的误导性横幅。
 *  - resetsAt 尚未到（将来才到期）→ 排定时器，到期后 doRecover 正常产生切换通知。 */
export function scheduleAllSwitchBacks() {
  const now = nowSec();
  let hasAlreadyExpired = false;
  for (const t of _getTokens()) {
    if (t.status !== 'healthy' && typeof t.resetsAt === 'number') {
      const prev = _timers.get(t.id);
      if (prev) clearTimeout(prev);
      if (t.resetsAt <= now) {
        // 已过期：不排定时器，统一在循环结束后静默恢复（不发切换通知）
        _timers.delete(t.id);
        hasAlreadyExpired = true;
      } else {
        // 未来到期：排定时器，到点由 doRecover 处理（会发切换通知，属于真实切换）
        const delay = Math.min(t.resetsAt * 1000 - Date.now() + 30000, 2 ** 31 - 1);
        _timers.set(
          t.id,
          setTimeout(() => doRecover(), delay),
        );
      }
    }
  }
  // 一次性静默写盘：清理所有已过期 token 的 exhausted/warning 状态，不触发 _notice
  if (hasAlreadyExpired) {
    mutateTokens((cur) => {
      const r = recoverExpired(cur, now);
      return r.changed ? r.tokens : false;
    });
  }
}

/** 获取当前活跃 token 的 ID；无可用 token 返回 null */
export function getActiveTokenId(providerId = DEFAULT_PROVIDER_ID) {
  const a = pickActive(_getTokens(), providerId);
  return a ? a.id : null;
}

/** 按 ID 获取指定 token 对象；不存在返回 null */
export function getTokenById(id) {
  const tokens = _getTokens();
  return tokens.find((t) => t.id === id) || null;
}

/** 切换到指定的 token 作为活跃账号；验证 token 存在且可用 */
export function switchActiveToken(id) {
  const token = getTokenById(id);
  if (!token) {
    throw new Error('Token not found');
  }
  // 验证 token 可用（不是 exhausted）
  if (token.status === 'exhausted') {
    throw new Error('Token is exhausted and not available for switching');
  }
  // pickActive() 已经自动选择优先级最高的 token
  // 此函数只需验证该 token 存在且可用即可
  return true;
}

function doRecover() {
  let before = null;
  let after = null;
  mutateTokens((cur) => {
    before = pickActive(cur);
    const r = recoverExpired(cur, nowSec());
    if (!r.changed) return false;
    after = pickActive(r.tokens);
    return r.tokens;
  });
  if (after && (before?.id || null) !== (after?.id || null)) {
    _notice = { kind: 'switch', from: before?.label || null, to: after?.label || null, at: nowSec() }; // 切回通知（仅在 active 真的变了时）
  }
}
