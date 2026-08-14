/**
 * 应用自持的会话消息存储（per convId 的 AI SDK ModelMessage 数组）。
 * 仅非 Claude provider（openai-compat 等，resume=false，无 Claude JSONL session）使用；
 * Claude 会话历史仍由 Claude Code 的 JSONL/resume 维护，不经这里。
 * 单文件 conv-messages.json = { [convId]: Message[] }，走 store/index.js 文件锁读改写。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'conv-messages.json';
/** 每会话保留最近 N 条（对齐 openai-compat 的 compaction=false，简单截断防膨胀） */
export const MAX_MESSAGES = 200;

/** 纯函数：合并 prev + msgs 并截断到最近 max 条。单测目标。 */
export function mergeMessages(prev, msgs, max = MAX_MESSAGES) {
  const base = Array.isArray(prev) ? prev : [];
  const add = Array.isArray(msgs) ? msgs : [];
  const next = base.concat(add);
  // 显式起点而非 slice(-max)：max=0 时 slice(-0)===slice(0) 会返回全量
  return next.length > max ? next.slice(next.length - max) : next;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 取某会话的消息数组（无则空数组） */
export function getMessages(convId) {
  if (!convId) return [];
  const store = readJson(FILE, {});
  return isPlainObject(store) && Array.isArray(store[convId]) ? store[convId] : [];
}

/** 追加消息并落盘（锁内），返回该会话截断后的最新数组 */
export function appendMessages(convId, msgs) {
  if (!convId || !Array.isArray(msgs) || msgs.length === 0) return getMessages(convId);
  let out = [];
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    store[convId] = mergeMessages(store[convId], msgs);
    out = store[convId];
    return store;
  });
  return out;
}

/** 清空某会话消息（无该会话则不写盘） */
export function clearMessages(convId) {
  if (!convId) return;
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    if (!(convId in store)) return undefined;
    delete store[convId];
    return store;
  });
}
