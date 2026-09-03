/**
 * 记忆库持久化 v2 —— memory-bank.json 是会话分析结果的唯一真相源。
 *
 * v2 schema 说明：
 * - `sessions`  已分析的会话索引（两阶段采集结果）
 * - `memories`  最终提炼的记忆条目
 * - `lastExtractAt`    上次整体提炼的时间戳（ms）
 * - `lastSessionScanAt` 上次会话扫描的时间戳（ms）
 *
 * v1 兼容策略：读到 version !== 2 时返回空 v2 框架，迁移逻辑在 Task 4 实现。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'memory-bank.json';

export const EMPTY_BANK = {
  version: 2,
  lastExtractAt: 0,
  lastSessionScanAt: 0,
  sessions: [],   // 已分析的会话索引
  memories: [],   // 最终记忆
};

export function readBank() {
  const raw = readJson(FILE, EMPTY_BANK);
  const b = raw && typeof raw === 'object' ? raw : {};
  // v1 或未知版本：返回空 v2 框架（迁移逻辑留给 Task 4）
  if (b.version !== 2) return { ...EMPTY_BANK };
  return {
    version: 2,
    lastExtractAt: Number(b.lastExtractAt) || 0,
    lastSessionScanAt: Number(b.lastSessionScanAt) || 0,
    sessions: Array.isArray(b.sessions) ? b.sessions : [],
    memories: Array.isArray(b.memories) ? b.memories : [],
  };
}

/**
 * 整体覆写 bank。调用方需先读出最新值（readBank）再传入，
 * 否则并发写入会互相覆盖内容（此函数只保证写操作本身原子，不合并语义）。
 */
export function writeBank(bank) {
  return updateJson(FILE, EMPTY_BANK, () => ({
    version: 2,
    lastExtractAt: Number(bank.lastExtractAt) || 0,
    lastSessionScanAt: Number(bank.lastSessionScanAt) || 0,
    sessions: Array.isArray(bank.sessions) ? bank.sessions : [],
    memories: Array.isArray(bank.memories) ? bank.memories : [],
  }));
}

export function updateBank(fn) {
  return updateJson(FILE, EMPTY_BANK, (cur) => {
    const next = fn(cur);
    if (next === undefined) return undefined;   // 放弃写盘约定
    return {
      version: 2,
      lastExtractAt: Number(next.lastExtractAt) || 0,
      lastSessionScanAt: Number(next.lastSessionScanAt) || 0,
      sessions: Array.isArray(next.sessions) ? next.sessions : [],
      memories: Array.isArray(next.memories) ? next.memories : [],
    };
  });
}

// ── sessions CRUD ────────────────────────────────────────────────────────────

/**
 * 添加一条会话记录（幂等：同 id 不重复插入）。
 * @param {{ id: string, [key: string]: any }} session
 */
export function addSession(session) {
  if (!session || !session.id) throw new Error('session.id required');
  updateBank((bank) => {
    // 同 id 已存在，放弃写盘（幂等）
    if (bank.sessions.some((s) => s.id === session.id)) return undefined;
    return { ...bank, sessions: [...bank.sessions, session] };
  });
}

/**
 * 按 id 读取会话，不存在返回 null。
 * @param {string} id
 * @returns {{ id: string, [key: string]: any } | null}
 */
export function getSession(id) {
  const bank = readBank();
  return bank.sessions.find((s) => s.id === id) || null;
}

/**
 * 按 path + mtime 精确匹配会话，不存在返回 null。
 * 用于判断某个转录文件是否已分析过（两个游标同时匹配才算同一次采集）。
 * @param {string} path
 * @param {number} mtime
 * @returns {{ id: string, [key: string]: any } | null}
 */
export function findSessionByPath(path, mtime) {
  const bank = readBank();
  return bank.sessions.find((s) => s.path === path && s.mtime === mtime) || null;
}

/**
 * 局部更新指定 id 的会话字段（浅合并）。
 * id 不存在时静默放弃，不抛错，不写盘。
 * @param {string} id
 * @param {object} patch
 */
export function patchSession(id, patch) {
  if (!id || !patch) throw new Error('id and patch required');
  updateBank((bank) => {
    const idx = bank.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return undefined; // 不存在则放弃写盘
    if (Object.keys(patch).length === 0) return undefined; // 空 patch 不写盘
    const { id: _drop, ...safePatch } = patch; // 防止 id 字段被覆盖
    const updated = bank.sessions.map((s, i) =>
      i === idx ? { ...s, ...safePatch } : s
    );
    return { ...bank, sessions: updated };
  });
}

// ── v1 stub 导出（保持兼容，避免尚未更新的模块 import 崩溃）──────────────────
// 待 Task 4 完成迁移后可安全移除

/** @deprecated v2 已废弃，条目改用 memories 数组管理 */
export function patchItem(_id, _patch) {
  return undefined;
}

/** @deprecated v2 已废弃 */
export function rejectItem(_id, _now) {
  return undefined;
}

/** @deprecated v2 已废弃 */
export function ackItems(_ids) {
  return undefined;
}
