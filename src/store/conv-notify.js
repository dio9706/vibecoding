/**
 * 会话飞书通知登记表 —— 哪些 web 会话开了「任务结束/失败推飞书」，以及飞书补充内容的收件箱。
 *
 * 为什么服务端必须存 session/cwd 快照：普通聊天会话的 session 权威副本只在前端 localStorage
 * （conv-store.js），服务端没有 convId→session 的长期映射。飞书侧要把补充内容 resume 回原会话，
 * 只能靠激活时前端上报的这份快照 —— 这也是本表存在的根本理由。
 *
 * 跨进程：web 写、飞书进程读（判断会话是否激活、文本兜底选目标会话），
 * 一律走 updateJson（<file>.lock 文件锁），不得裸 readJson→writeJson。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'conv-notify.json';

/** 收件箱上限：飞书补充是人工节奏，20 条足够；超限丢最旧，防异常刷爆文件 */
export const INBOX_MAX = 20;

export function getAll() {
  return readJson(FILE, {});
}

export function getEntry(convId) {
  if (!convId) return null;
  return getAll()[convId] || null;
}

/** 激活（幂等）：已存在则更新快照并保留 inbox 与 enabledAt */
export function enableConv({ convId, title, session, cwd, model, effort, mode }) {
  if (!convId) return null;
  return updateJson(FILE, {}, (cur) => {
    const prev = cur[convId] || {};
    cur[convId] = {
      convId,
      title: title || prev.title || '',
      session: session || prev.session || '',
      cwd: cwd || prev.cwd || '',
      model: model || prev.model || 'auto',
      effort: effort || prev.effort || 'medium',
      mode: mode || prev.mode || 'default',
      enabledAt: prev.enabledAt || new Date().toISOString(),
      lastNotifiedAt: prev.lastNotifiedAt || null,
      inbox: Array.isArray(prev.inbox) ? prev.inbox : [],
    };
    return cur;
  })[convId];
}

/** 取消激活：连带丢弃未认领的注入项（用户已明确不想要这条链路了） */
export function disableConv(convId) {
  if (!convId) return;
  updateJson(FILE, {}, (cur) => {
    if (!cur[convId]) return undefined; // 无变更，不写盘
    delete cur[convId];
    return cur;
  });
}

/** 局部更新快照字段；未登记会话是 no-op（不能凭空建条目，否则取消激活后又被 sync 复活） */
export function patchConv(convId, patch) {
  if (!convId) return null;
  const next = updateJson(FILE, {}, (cur) => {
    if (!cur[convId]) return undefined;
    cur[convId] = { ...cur[convId], ...patch, convId, inbox: cur[convId].inbox };
    return cur;
  });
  return next[convId] || null;
}

export function pushInjection(convId, item) {
  if (!convId) return null;
  const next = updateJson(FILE, {}, (cur) => {
    const e = cur[convId];
    if (!e) return undefined;
    e.inbox = [...(e.inbox || []), item].slice(-INBOX_MAX);
    return cur;
  });
  return next[convId] || null;
}

export function claimInjections(convId, ids) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  if (!convId || !set.size) return null;
  const next = updateJson(FILE, {}, (cur) => {
    const e = cur[convId];
    if (!e) return undefined;
    e.inbox = (e.inbox || []).filter((it) => !set.has(it.id));
    return cur;
  });
  return next[convId] || null;
}

/**
 * 按前 8 位短 ID 查找会话条目。
 * @param {string} shortId 前 8 位 ID（如 'a1b2c3d4'）
 * @returns {Object | null} 匹配的会话条目，或 null
 *
 * 冲突处理：若多个会话 convId 都以 shortId 开头，返回 enabledAt 最晚的那个（最近创建）。
 *
 * 例如：
 * findEntryByShortId('a1b2c3d4')
 * → { convId: 'a1b2c3d4-...', title: '...' }
 */
export function findEntryByShortId(shortId) {
  if (!shortId || typeof shortId !== 'string') return null;

  let best = null;
  for (const entry of Object.values(getAll())) {
    // 检查 convId 是否以 shortId 开头
    if (!entry.convId || !entry.convId.startsWith(shortId)) continue;

    // 冲突时选最近创建的（enabledAt 最晚）
    if (!best || (entry.enabledAt && best.enabledAt && entry.enabledAt > best.enabledAt)) {
      best = entry;
    }
  }
  return best;
}

/**
 * 文本兜底用：最近 maxAgeMs 内被通知过的那个会话。
 * 机器人重启丢了等待态时，用户直接发「补充内容 xxx」就落到这里。
 * @param {number} maxAgeMs 窗口
 * @param {number} [nowMs] 便于测试注入
 */
export function pickLatestNotified(maxAgeMs, nowMs = Date.now()) {
  let best = null;
  for (const e of Object.values(getAll())) {
    if (!e.lastNotifiedAt) continue;
    const t = Date.parse(e.lastNotifiedAt);
    if (Number.isNaN(t) || nowMs - t > maxAgeMs) continue;
    if (!best || t > Date.parse(best.lastNotifiedAt)) best = e;
  }
  return best;
}
