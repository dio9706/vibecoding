/**
 * 应用自持的会话消息存储（per convId 的 AI SDK ModelMessage 数组 + 滚动摘要）。
 * 仅非 Claude provider（openai-compat 等，resume=false，无 Claude JSONL session）使用；
 * Claude 会话历史仍由 Claude Code 的 JSONL/resume 维护，不经这里。
 *
 * 形状 v2（T7）：`{ [convId]: { v:2, messages: Message[], summary: { text, covered, at, model } | null } }`。
 *  - `summary.covered` = 摘要覆盖的前 N 条消息：模型视角 = 摘要 + `messages.slice(covered)`；
 *  - **原文保留**：消息只追加；仅当超过 `MAX_STORED`（磁盘 backstop）时才从头部丢，且丢到
 *    「新头部不是 tool 结果」的安全边界（旧实现的无脑 200 截断会在 tool 序列中间切开 → 可能 400）；
 *  - 读侧兼容 v1 数组（旧文件不迁移，首次写入时升级为 v2）；
 *  - 摘要与消息同文件同锁原子更新（backstop 裁剪时 `covered` 同锁平移，永不漂移）。
 *
 * 单文件 conv-messages.json = { [convId]: ... }，走 store/index.js 文件锁读改写。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'conv-messages.json';
/** 磁盘原文 backstop（T7）：压缩摘要保证模型视角不超限，这里只防 json 随会话无限膨胀 */
export const MAX_STORED = 1000;

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 归一单会话状态（纯函数）：v1 数组 → `{messages, summary:null}`；v2 对象取合法字段。
 * 摘要形状非法（缺 text / covered 越界）按「无摘要」处理——宁可多喂原文，不可喂坏切点。
 */
export function normalizeConvState(raw, { messageCount = null } = {}) {
  if (Array.isArray(raw)) return { messages: raw, summary: null };
  if (isPlainObject(raw) && Array.isArray(raw.messages)) {
    const s = raw.summary;
    let summary = null;
    if (isPlainObject(s) && typeof s.text === 'string' && s.text.trim()) {
      const limit = Number.isFinite(messageCount) ? messageCount : raw.messages.length;
      const covered = Math.max(0, Math.min(limit, Math.floor(Number(s.covered) || 0)));
      summary = { text: s.text, covered, at: Number(s.at) || 0, model: typeof s.model === 'string' ? s.model : '' };
    }
    return { messages: raw.messages, summary };
  }
  return { messages: [], summary: null };
}

/**
 * 磁盘裁剪（纯函数）：从头部丢到 max 条以内，且保证新头部不是 tool 结果。
 * 「结果缺调用」的头部序列发给兼容端点可能 400；tool-call 在头部是合法的（结果在后）。
 * @returns {{messages: Array, dropped: number}}
 */
export function trimForStorage(messages, max = MAX_STORED) {
  const list = Array.isArray(messages) ? messages : [];
  const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_STORED;
  if (list.length <= cap) return { messages: list, dropped: 0 };
  let k = list.length - cap;
  while (k < list.length - 1 && list[k]?.role === 'tool') k++; // 连孤儿结果一起丢，保住头部合法
  return { messages: list.slice(k), dropped: k };
}

/** 取某会话完整状态（v1 兼容归一）；无则空 */
export function getConvState(convId) {
  if (!convId) return { messages: [], summary: null };
  const store = readJson(FILE, {});
  return normalizeConvState(isPlainObject(store) ? store[convId] : null);
}

/** 取某会话的消息数组（兼容既有调用方；摘要不在此，视图构建见 run-openai.js） */
export function getMessages(convId) {
  return getConvState(convId).messages;
}

/** 取某会话的滚动摘要（无则 null） */
export function getSummary(convId) {
  return getConvState(convId).summary;
}

/** 追加消息并落盘（锁内），返回该会话裁剪后的最新消息数组 */
export function appendMessages(convId, msgs) {
  if (!convId || !Array.isArray(msgs) || msgs.length === 0) return getMessages(convId);
  let out = [];
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    const state = normalizeConvState(store[convId]);
    const merged = state.messages.concat(msgs);
    const { messages, dropped } = trimForStorage(merged, MAX_STORED);
    // backstop 裁掉了多少条，摘要覆盖数同锁平移：归零后摘要文本仍有效（它覆盖的都是更早内容）
    const summary = state.summary && dropped > 0 ? { ...state.summary, covered: Math.max(0, state.summary.covered - dropped) } : state.summary;
    store[convId] = { v: 2, messages, summary };
    out = messages;
    return store;
  });
  return out;
}

/**
 * 写入/覆盖滚动摘要（与消息同文件同锁原子）。covered 收敛到 [0, messages.length]；空文本视为清除失败不写。
 * @returns {{text,covered,at,model}|null} 落盘后的摘要
 */
export function setSummary(convId, { text, covered, at = Date.now(), model = '' } = {}) {
  if (!convId) return null;
  const t = String(text ?? '').trim();
  if (!t) return null;
  let saved = null;
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    const state = normalizeConvState(store[convId]);
    saved = {
      text: t,
      covered: Math.max(0, Math.min(state.messages.length, Math.floor(Number(covered) || 0))),
      at: Number(at) || Date.now(),
      model: typeof model === 'string' ? model : '',
    };
    store[convId] = { v: 2, messages: state.messages, summary: saved };
    return store;
  });
  return saved;
}

/** 清空某会话消息与摘要（无该会话则不写盘） */
export function clearMessages(convId) {
  if (!convId) return;
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    if (!(convId in store)) return undefined;
    delete store[convId];
    return store;
  });
}
