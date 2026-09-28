/**
 * 同事 ↔ 机器人的对话流（colleague-messages.json）。
 *
 * 2.0 换锚点：形状从「按需求分组」变成**按人**分组：{ [colleagueId]: { agentSessionId, messages: [...], lastInboundAt } }。
 * 需求归属从「分组键」降级成消息上的 `reqId` **标签**（可选，agent 判不出就是 null）。
 *
 * 为什么换锚点：2.0 的对话锚在人身上（一个同事一条长期 thread，靠 SDK session 续跑），
 * agent 要能「记得他上周说过什么」，而旧结构下同一个人在三个需求里是三条互不相通的对话线。
 *
 * 迁移历史：换锚点之初，`getThread`/`appendMessage`/`markRead`/`markHandled` 四个旧签名
 * （按 `reqId × colleagueId` 定位）曾原样保留、内部适配新结构，让旧调用方一行不改——
 * 那批调用方在 P3 整体删除或改写后，前三个已随之删除，`markHandled` 顺手收窄成
 * `(colleagueId, msgId, opts)`（`msgId` 本就全局唯一，从不需要 `reqId` 定位）。
 *
 * 迁移：`colleague-messages.migration.js` 提供纯函数，读路径与写路径各接一次（见 readStore /
 * migrateInLock），旧数据（含 `_pending` 待归属缓冲）在第一次读到时原地转换、下次写盘落地。
 *
 * 并发：飞书进程写入站、web 进程写出站与已读——两个进程并发写同一文件，
 * 所有写操作必须经 store/index.js 的 updateJson（文件锁 + 原子写），不得裸读写。
 */
import { readJson, updateJson } from './index.js';
import { migrateColleagueMessages, migrateColleagueMessagesDetailed, isLegacyShape } from './colleague-messages.migration.js';
import { logger } from '../shared/logger.js';

const FILE = 'colleague-messages.json';
/** 每条会话保留最近 N 条，简单截断防膨胀（同 conv-messages 的做法） */
export const MAX_MESSAGES = 500;

const STATUSES = ['unread', 'read', 'handled'];
/** 处理者取值。与 STATUSES 并列：normalizeEntry 归一与 markHandled 守卫共用，两处各写一份会漂移 */
const HANDLED_BY = ['manual', 'ai'];

function genId() {
  return 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 条目归一。2.0 新增两个字段：
 * - `reqId`：agent 判定的需求归属**标签**（旧版是分组键）。判不出来就是 null，不是空串 ——
 *   空串会在 `getUnreadCounts` 的 `===` 比较里跟「真的属于某需求」混淆。
 * - `toolTrace`：这轮 agent 调了什么，审计用。入站消息**恒为 null**，不是空数组：
 *   前端拿空数组会渲染出一个空的轨迹区。
 *
 * dir 非法一律 fail-safe 到 'in'：把来信错记成去信，会让它在界面上靠右显示、且不计未读——
 * 等于静默丢一条同事的消息。
 */
export function normalizeEntry(e) {
  const o = isPlainObject(e) ? e : {};
  return {
    id: typeof o.id === 'string' && o.id ? o.id : genId(),
    dir: o.dir === 'out' ? 'out' : 'in',
    text: typeof o.text === 'string' ? o.text : '',
    files: Array.isArray(o.files)
      ? o.files.filter(isPlainObject).map((f) => ({
          name: typeof f.name === 'string' ? f.name : '',
          path: typeof f.path === 'string' ? f.path : '',
          kind: f.kind === 'image' ? 'image' : 'file',
        }))
      : [],
    at: typeof o.at === 'string' && o.at ? o.at : new Date().toISOString(),
    role: typeof o.role === 'string' ? o.role : '',
    reqId: typeof o.reqId === 'string' && o.reqId ? o.reqId : null,
    status: STATUSES.includes(o.status) ? o.status : 'unread',
    handledBy: HANDLED_BY.includes(o.handledBy) ? o.handledBy : null,
    handledNote: typeof o.handledNote === 'string' ? o.handledNote : '',
    toolTrace: Array.isArray(o.toolTrace) && o.toolTrace.length
      ? o.toolTrace.filter(isPlainObject).map((t) => ({
          name: typeof t.name === 'string' ? t.name : '',
          input: isPlainObject(t.input) ? t.input : {},
          brief: typeof t.brief === 'string' ? t.brief : '',
        }))
      : null,
  };
}

function emptyThread() {
  return { agentSessionId: null, messages: [], lastInboundAt: null };
}

function normalizeThread(raw) {
  if (!isPlainObject(raw)) return emptyThread();
  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeEntry) : [];
  return {
    agentSessionId: typeof raw.agentSessionId === 'string' && raw.agentSessionId ? raw.agentSessionId : null,
    messages: messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages,
    lastInboundAt: typeof raw.lastInboundAt === 'string' ? raw.lastInboundAt : null,
  };
}

/**
 * 读盘并**就地迁移**。
 *
 * 迁移放在读路径而不是启动时跑一次：两个进程都会读这个文件，谁先读到旧数据谁负责转换，
 * 不需要协调「谁来迁」。`isLegacyShape` 是纯判定，新形状下零成本。
 *
 * 只读不写：写回由下一次 `updateJson` 自然完成（那里本来就整份重写）。
 * 好处是读路径不需要拿锁；代价是旧数据在第一次写之前每次读都转一遍 —— 可接受。
 */
function readStore() {
  const s = readJson(FILE, {});
  if (!isPlainObject(s)) return {};
  return isLegacyShape(s) ? migrateColleagueMessages(s) : s;
}

/** 写路径的锁内迁移：必须在这里也做一次，否则旧结构会被新写入覆盖成半新半旧 */
function migrateInLock(raw) {
  const s = isPlainObject(raw) ? raw : {};
  if (!isLegacyShape(s)) return s;
  const { data, droppedPending } = migrateColleagueMessagesDetailed(s);
  logger.warn('colleague-messages', '已迁移到按人锚点', { droppedPending });
  return data;
}

// ================= 新锚点：按人读写（agent 链路用这些） =================

/** 读某人的整条线（跨需求）。agent 要的就是这个 —— 它得记得这个人上周说过什么 */
export function getColleagueThread(colleagueId) {
  if (!colleagueId) return emptyThread();
  return normalizeThread(readStore()[colleagueId]);
}

/** 按人追加一条；`entry.reqId` 是可选的归属标签；dir='in' 时刷新 lastInboundAt */
export function appendTo(colleagueId, entry) {
  if (!colleagueId) return null;
  const e = normalizeEntry(entry);
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    const t = normalizeThread(s[colleagueId]);
    t.messages.push(e);
    if (t.messages.length > MAX_MESSAGES) t.messages = t.messages.slice(t.messages.length - MAX_MESSAGES);
    if (e.dir === 'in') t.lastInboundAt = e.at;
    return { ...s, [colleagueId]: t };
  });
  return e;
}

/** @param {{reqId?: string}} [opts] 带 reqId 则只标该需求下的（别的需求红点要留着） */
export function markColleagueRead(colleagueId, opts = {}) {
  if (!colleagueId) return;
  const only = opts.reqId || null;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    if (!s[colleagueId]) return undefined;
    const t = normalizeThread(s[colleagueId]);
    let changed = false;
    t.messages = t.messages.map((m) => {
      if (m.dir === 'in' && m.status === 'unread' && (!only || m.reqId === only)) {
        changed = true;
        return { ...m, status: 'read' };
      }
      return m;
    });
    if (!changed) return undefined;
    return { ...s, [colleagueId]: t };
  });
}

/** 某需求下各同事的未读数 —— 现在按消息上的 reqId **标签**过滤（对外语义不变） */
export function getUnreadCounts(reqId) {
  if (!reqId) return {};
  const out = {};
  for (const [cid, raw] of Object.entries(readStore())) {
    const n = normalizeThread(raw).messages.filter(
      (m) => m.dir === 'in' && m.status === 'unread' && m.reqId === reqId,
    ).length;
    if (n > 0) out[cid] = n;
  }
  return out;
}

export function getUnreadTotals() {
  const out = {};
  for (const raw of Object.values(readStore())) {
    for (const m of normalizeThread(raw).messages) {
      // 无归属标签的消息不计入任何需求的红点 —— 它在「按人」的视图里看得到，
      // 但侧栏是按需求组织的，硬塞进某个需求是错的
      if (m.dir === 'in' && m.status === 'unread' && m.reqId) out[m.reqId] = (out[m.reqId] || 0) + 1;
    }
  }
  return out;
}

/** 标记某条消息的处理状态。不带 reqId：msgId 本就全局唯一，换锚点后不需要靠需求定位消息 */
export function markHandled(colleagueId, msgId, { handledBy, handledNote = '' } = {}) {
  if (!colleagueId || !msgId) return false;
  if (!HANDLED_BY.includes(handledBy)) return false;
  let hit = false;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    if (!s[colleagueId]) return undefined;
    const t = normalizeThread(s[colleagueId]);
    t.messages = t.messages.map((m) => {
      if (m.id !== msgId) return m;
      hit = true;
      return normalizeEntry({ ...m, handledBy, handledNote });
    });
    if (!hit) return undefined;
    return { ...s, [colleagueId]: t };
  });
  return hit;
}

/**
 * 需求被物理移除：摘掉**各人名下带该 reqId 标签的消息**，不再删整条线。
 * 换锚点后一条线属于人不属于需求，删线等于把同事的全部历史对话一起抹掉。
 */
export function dropReqThreads(reqId) {
  if (!reqId) return;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    let changed = false;
    const next = {};
    for (const [cid, raw2] of Object.entries(s)) {
      const t = normalizeThread(raw2);
      const kept = t.messages.filter((m) => m.reqId !== reqId);
      if (kept.length !== t.messages.length) changed = true;
      next[cid] = { ...t, messages: kept };
    }
    return changed ? next : undefined;
  });
}

// ---- agent thread 锚点 ----

export function getAgentSessionId(colleagueId) {
  if (!colleagueId) return null;
  return normalizeThread(readStore()[colleagueId]).agentSessionId;
}

/** agent 可能先起会话后落消息，所以对没有任何消息的人也要能写 */
export function setAgentSessionId(colleagueId, sessionId) {
  if (!colleagueId) return;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    const t = normalizeThread(s[colleagueId]);
    if (t.agentSessionId === (sessionId || null)) return undefined;
    return { ...s, [colleagueId]: { ...t, agentSessionId: sessionId || null } };
  });
}
