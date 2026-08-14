/**
 * 记忆库调度判定。纯函数：now / settings / tokens / activeRunCount 全部注入。
 *
 * 双窗口设计：
 *   ①窗口末尾 —— 距当前计费窗口重置 <30 分钟且额度正常，用本来要作废的额度，边际成本最低；
 *   ②凌晨窗口 —— 保底路径。若某天拿不到 windowResetsAt（SDK 未推限流事件），①自动失效，②仍可跑。
 *
 * token 语义与 src/features/token-rotation.js 对齐（就地复刻谓词，不 import 该文件——
 * 它在模块级 import 了 store/settings.js，会把 IO 依赖带进来，破坏本文件的纯函数可测性）：
 *   - warning（对应 SDK 的 allowed_warning）是「可用」状态而非耗尽，选号要退而取之（对齐 pickActive）；
 *   - 选号 / 耗尽判定都必须先按 providerId 过滤——getTokens() 返回的是跨 provider 混放的全量池，
 *     不过滤会拿到别的 provider（如 openai-compat）的号的窗口时刻/耗尽状态，来判断 claude-agent 该不该跑。
 */

import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';

export const WINDOW_END_LEAD_MS = 30 * 60 * 1000;

/** 'HH:MM' → 当天分钟数；非法返回 null */
export function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 当前分钟数是否落在 [start, end) —— 支持跨零点（22:00-02:00）。
 *  注意（M8）：start === end 时区间长度为 0，恒为 false —— 把起止配成同一个值不是「全天」，
 *  是「永不」。若想要「全天」应配 00:00-23:59（parseHm 不接受 24:00），这里不做隐式改写。 */
function inWindow(minutes, start, end) {
  if (start === null || end === null) return false;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** 就地复刻 token-rotation.js 的 pickActive：先按 providerId 过滤，再 healthy 优先、退而取 warning。
 *  缺 providerId 字段的旧 token 视为 DEFAULT_PROVIDER_ID，与 token-rotation.js 保持一致。 */
function pickActiveToken(tokens, providerId) {
  const list = (tokens || []).filter((t) => (t.providerId || DEFAULT_PROVIDER_ID) === providerId);
  return list.find((t) => t.status === 'healthy') || list.find((t) => t.status === 'warning') || null;
}

/** 就地复刻 token-rotation.js 的 isPoolExhausted，但先按 providerId 过滤：
 *  该 provider 下没有任何 healthy/warning 号才算耗尽；该 provider 无任何 token（空列表）不算耗尽——
 *  未配置该 provider 的备用池时不应 fail-fast 挡掉调度（对齐 isPoolExhausted 对空池的处理）。 */
function isProviderExhausted(tokens, providerId) {
  const list = (tokens || []).filter((t) => (t.providerId || DEFAULT_PROVIDER_ID) === providerId);
  if (list.length === 0) return false;
  return !list.some((t) => t.status === 'healthy' || t.status === 'warning');
}

/**
 * @param {{now:number, settings:object, tokens:Array, activeRunCount:number, lastExtractAt:number, providerId?:string}} ctx
 *   providerId 默认 DEFAULT_PROVIDER_ID（'claude-agent'）——提炼实际走 claudeAuthOpts() → pickActive(tokens,'claude-agent')，
 *   调度判断必须锁定同一个 provider，否则会拿混在同一个 token 池里的其它 provider（如 openai-compat）的号做判断（I1/I3）。
 * @returns {{run:boolean, reason:string, window:('window-end'|'night'|null)}}
 */
export function shouldRun({ now, settings, tokens, activeRunCount, lastExtractAt, providerId = DEFAULT_PROVIDER_ID }) {
  const s = settings || {};
  if (!s.enabled) return { run: false, reason: 'disabled', window: null };
  // 硬约束：绝不与用户的任务抢额度
  if (activeRunCount > 0) return { run: false, reason: 'busy', window: null };

  const minInterval = Math.max(0, Number(s.minIntervalHours) || 0) * 3600000;
  // M6：lastExtractAt 若为未来时刻（系统时钟回拨、或落盘坏值），now - lastExtractAt 为负；
  // 不clamp的话，在 minIntervalHours=0（不设冷却）时负数仍恒小于 0，会被永久判定为冷却中，功能静默死掉。
  const elapsed = Math.max(0, now - (lastExtractAt || 0));
  if (elapsed < minInterval) return { run: false, reason: 'cooldown', window: null };

  // I3：耗尽判定必须按 providerId 过滤，否则会被别的 provider 的健康号掩盖 claude-agent 侧的全耗尽——
  // 一旦误放行到 claudeAuthOpts()，该 provider 无可用号会返回 {}，退回主账号登录，无人值守地烧用户额度。
  if (isProviderExhausted(tokens, providerId)) {
    return { run: false, reason: 'exhausted', window: null };
  }

  // 窗口① —— 距重置 <30 分钟且仍在可用额度内。
  // I1：选号先按 providerId 过滤，不能拿其它 provider 的窗口重置时刻来判断这个 provider 该不该跑；
  // I2：healthy 优先、退而取 warning（与 pickActive 对齐）——warning 反而是最该抓紧窗口①的时刻。
  const active = pickActiveToken(tokens, providerId);
  const resetsAt = active && typeof active.windowResetsAt === 'number' ? active.windowResetsAt : null;
  if (resetsAt) {
    const left = resetsAt * 1000 - now;
    if (left > 0 && left < WINDOW_END_LEAD_MS) return { run: true, reason: 'window-end', window: 'window-end' };
  }

  // 窗口② —— 凌晨保底。
  // M7：getHours() 取的是进程本地时区。服务若跑在 UTC 容器而人在 +08 时区，nightStart/nightEnd
  // 按本地时间配的「凌晨」会与进程时区错位，长期不触发但报不出错，排查成本很高——部署时需确认进程时区。
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (inWindow(minutes, parseHm(s.nightStart), parseHm(s.nightEnd))) {
    return { run: true, reason: 'night', window: 'night' };
  }

  return { run: false, reason: 'out-of-window', window: null };
}
