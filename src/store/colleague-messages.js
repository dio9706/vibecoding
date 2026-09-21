/**
 * 同事 ↔ 机器人的需求对话流（colleague-messages.json）。
 *
 * 形状：{ [reqId]: { [colleagueId]: { messages: [], lastInboundAt } }, _pending: { [openId]: {...} } }
 *
 * 为什么消息条目上带 status/handledBy/role/files[].path，而不是只存聊天记录：
 * 四期要让 AI 按职位自动处理（产品调整需求 → /api/req/change；后端发接口文档 →
 * /api/req/apidoc），那两个接口要的正是「发信当时的职位」与「文件的落盘路径」。
 * 把这些留在三期的数据里，四期只需加一层分类器，不必改数据结构做迁移。
 *
 * 并发：飞书进程写入站、web 进程写出站与已读——两个进程并发写同一文件，
 * 所有写操作必须经 store/index.js 的 updateJson（文件锁 + 原子写），不得裸读写。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'colleague-messages.json';
/** 待归属缓冲的命名空间。下划线前缀与 reqId（r_ 前缀）天然不撞 */
const PENDING_KEY = '_pending';
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
 * 条目归一（纯函数）。dir 非法一律 fail-safe 到 'in'：
 * 把来信错记成去信，会让它在界面上靠右显示、且不计未读——等于静默丢一条同事的消息。
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
    status: STATUSES.includes(o.status) ? o.status : 'unread',
    handledBy: HANDLED_BY.includes(o.handledBy) ? o.handledBy : null,
    handledNote: typeof o.handledNote === 'string' ? o.handledNote : '',
  };
}

function emptyThread() {
  return { messages: [], lastInboundAt: null };
}

function normalizeThread(raw) {
  if (!isPlainObject(raw)) return emptyThread();
  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeEntry) : [];
  return {
    messages: messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages,
    lastInboundAt: typeof raw.lastInboundAt === 'string' ? raw.lastInboundAt : null,
  };
}

function readStore() {
  const s = readJson(FILE, {});
  return isPlainObject(s) ? s : {};
}

export function getThread(reqId, colleagueId) {
  if (!reqId || !colleagueId || reqId === PENDING_KEY) return emptyThread();
  return normalizeThread(readStore()?.[reqId]?.[colleagueId]);
}

/** 追加一条；dir='in' 时刷新 lastInboundAt（out 不刷——那是「最近来信时间」） */
export function appendMessage(reqId, colleagueId, entry) {
  if (!reqId || !colleagueId || reqId === PENDING_KEY) return null;
  const e = normalizeEntry(entry);
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : {};
    const t = normalizeThread(req[colleagueId]);
    t.messages.push(e);
    if (t.messages.length > MAX_MESSAGES) t.messages = t.messages.slice(t.messages.length - MAX_MESSAGES);
    if (e.dir === 'in') t.lastInboundAt = e.at;
    return { ...s, [reqId]: { ...req, [colleagueId]: t } };
  });
  return e;
}

/** 某需求下各同事的未读数（只数 in + unread）；无未读的同事不出现在结果里 */
export function getUnreadCounts(reqId) {
  if (!reqId || reqId === PENDING_KEY) return {};
  const req = readStore()[reqId];
  if (!isPlainObject(req)) return {};
  const out = {};
  for (const [cid, raw] of Object.entries(req)) {
    const n = normalizeThread(raw).messages.filter((m) => m.dir === 'in' && m.status === 'unread').length;
    if (n > 0) out[cid] = n;
  }
  return out;
}

export function markRead(reqId, colleagueId) {
  if (!reqId || !colleagueId || reqId === PENDING_KEY) return;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : null;
    if (!req || !req[colleagueId]) return undefined; // 未知会话：不写盘
    const t = normalizeThread(req[colleagueId]);
    let changed = false;
    t.messages = t.messages.map((m) => {
      if (m.dir === 'in' && m.status === 'unread') {
        changed = true;
        return { ...m, status: 'read' };
      }
      return m;
    });
    if (!changed) return undefined;
    return { ...s, [reqId]: { ...req, [colleagueId]: t } };
  });
}

/**
 * 标记单条消息已被处理（四期：AI 自动处理的落点）。
 *
 * 只写 handledBy / handledNote，**不动 status**：status 是「主机看没看过」，handledBy 是「谁处理了」，
 * 两个维度独立 —— AI 处理过的消息主机仍该看到红点，知道后端说过话。
 * 未知会话 / 未知 id 不写盘，返回 false。
 * @param {'manual'|'ai'} handledBy 处理者；其它值一律拒绝
 * @returns {boolean} 命中并写盘为 true
 */
export function markHandled(reqId, colleagueId, msgId, { handledBy, handledNote = '' } = {}) {
  if (!reqId || !colleagueId || !msgId || reqId === PENDING_KEY) return false;
  // 非法值不进锁、不写盘：否则「标记已处理」会把条目改回未处理（null）还返回 true，调用方据此误判成功
  if (!HANDLED_BY.includes(handledBy)) return false;
  let hit = false;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : null;
    if (!req || !req[colleagueId]) return undefined;
    const t = normalizeThread(req[colleagueId]);
    t.messages = t.messages.map((m) => {
      if (m.id !== msgId) return m;
      hit = true;
      return normalizeEntry({ ...m, handledBy, handledNote }); // 经 normalizeEntry 保持条目形状归一
    });
    if (!hit) return undefined;
    return { ...s, [reqId]: { ...req, [colleagueId]: t } };
  });
  return hit;
}

/** 删掉某需求名下所有同事会话（需求被物理移除时调用）。_pending 是另一命名空间，不受影响。 */
export function dropReqThreads(reqId) {
  if (!reqId || reqId === PENDING_KEY) return;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    if (!(reqId in s)) return undefined; // 本就没有：不写盘
    const { [reqId]: _dropped, ...rest } = s;
    return rest;
  });
}

// ---- 待归属缓冲（同事参与多个开发期需求，等他在卡片上选） ----

/** 累积而非覆盖：同事连发两条时，只留最后一条等于丢消息 */
export function addPending(openId, entry) {
  if (!openId) return;
  const e = normalizeEntry(entry);
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const p = isPlainObject(s[PENDING_KEY]) ? s[PENDING_KEY] : {};
    const cur = isPlainObject(p[openId]) ? p[openId] : { messages: [], askedAt: new Date().toISOString() };
    const messages = Array.isArray(cur.messages) ? cur.messages.map(normalizeEntry) : [];
    messages.push(e);
    return { ...s, [PENDING_KEY]: { ...p, [openId]: { messages, askedAt: cur.askedAt } } };
  });
}

export function getPending(openId) {
  if (!openId) return null;
  const p = readStore()[PENDING_KEY];
  const cur = isPlainObject(p) ? p[openId] : null;
  if (!isPlainObject(cur) || !Array.isArray(cur.messages) || !cur.messages.length) return null;
  return { messages: cur.messages.map(normalizeEntry), askedAt: cur.askedAt || null };
}

/**
 * 把待归属缓冲整体并入目标会话（纯函数，专供 `updateJson` 在**锁内**调用）。
 *
 * 为什么读缓冲这一步必须在锁内：`raw` 是 updateJson 从文件锁内读到的当前值。
 * 曾经的实现先在锁外 `getPending` 取快照、再在锁内 `delete` 掉整个缓冲 —— 飞书进程
 * 若在这个窗口里 `addPending` 了一条，那条会被连带删除却从未归入任何需求，
 * 等于静默吞掉一条同事的消息（`addPending` 的「累积而非覆盖」防的正是同一件事）。
 *
 * @returns {{next: object|undefined, count: number, ids: string[]}} next 为 undefined 表示无缓冲、放弃写盘
 */
export function applyPendingFlush(raw, openId, reqId, colleagueId) {
  const s = isPlainObject(raw) ? raw : {};
  const p = isPlainObject(s[PENDING_KEY]) ? s[PENDING_KEY] : null;
  const cur = p && isPlainObject(p[openId]) ? p[openId] : null;
  const pendingMsgs = cur && Array.isArray(cur.messages) ? cur.messages.map(normalizeEntry) : [];
  if (!pendingMsgs.length) return { next: undefined, count: 0, ids: [] };

  const req = isPlainObject(s[reqId]) ? s[reqId] : {};
  const t = normalizeThread(req[colleagueId]);
  for (const m of pendingMsgs) {
    t.messages.push(m);
    if (m.dir === 'in') t.lastInboundAt = m.at;
  }
  if (t.messages.length > MAX_MESSAGES) t.messages = t.messages.slice(t.messages.length - MAX_MESSAGES);
  const nextPending = { ...p };
  delete nextPending[openId];
  return {
    next: { ...s, [reqId]: { ...req, [colleagueId]: t }, [PENDING_KEY]: nextPending },
    count: pendingMsgs.length,
    ids: pendingMsgs.map((m) => m.id), // 四期：调用方据此触发自动处理
  };
}

/**
 * 把缓冲整体归入目标需求并清空。
 * 必须清空：不清的话同事再点一次卡片按钮，同一批消息会被重复归入。
 * @returns {{count: number, ids: string[]}} 归入条数与各条 id（四期自动处理要按 id 逐条判定）
 */
export function flushPending(openId, reqId, colleagueId) {
  if (!openId || !reqId || !colleagueId || reqId === PENDING_KEY) return { count: 0, ids: [] };
  let count = 0;
  let ids = [];
  updateJson(FILE, {}, (raw) => {
    const r = applyPendingFlush(raw, openId, reqId, colleagueId);
    count = r.count;
    ids = r.ids;
    return r.next;
  });
  return { count, ids };
}

/** 丢弃缓冲（目标需求已不在开发期等异常情况），避免 hasPending 永久为真把同事粘住 */
export function dropPending(openId) {
  if (!openId) return;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const p = isPlainObject(s[PENDING_KEY]) ? s[PENDING_KEY] : null;
    if (!p || !p[openId]) return undefined;
    const next = { ...p };
    delete next[openId];
    return { ...s, [PENDING_KEY]: next };
  });
}
