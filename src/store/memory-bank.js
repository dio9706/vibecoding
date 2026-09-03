/**
 * 记忆库持久化 v2 —— memory-bank.json 是会话分析结果的唯一真相源。
 *
 * v2 schema 说明：
 * - `sessions`  已分析的会话索引（两阶段采集结果）
 * - `memories`  最终提炼的记忆条目
 * - `lastExtractAt`    上次整体提炼的时间戳（ms）
 * - `lastSessionScanAt` 上次会话扫描的时间戳（ms）
 *
 * v1 兼容策略：readBank 调用前先执行 migrateV1IfNeeded()，
 * 检测到 v1 文件时备份并原地覆写为空 v2 框架。
 */
import fs from 'node:fs';
import { readJson, updateJson, dataPath } from './index.js';

const FILE = 'memory-bank.json';

export const EMPTY_BANK = {
  version: 2,
  lastExtractAt: 0,
  lastSessionScanAt: 0,
  sessions: [],   // 已分析的会话索引
  memories: [],   // 最终记忆
};

/**
 * 检测并迁移 v1 → v2。幂等：v2 文件或不存在文件时直接返回。
 * 副作用：在磁盘上生成 memory-bank.v1.bak.json 并覆写 memory-bank.json。
 */
function migrateV1IfNeeded() {
  const file = dataPath('memory-bank.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // 文件不存在或解析失败，readBank 会用 fallback，不需要迁移
  }

  if (!raw || raw.version !== 1) return; // 不是 v1，不需要迁移

  // 备份
  const backupFile = dataPath('memory-bank.v1.bak.json');
  try {
    fs.writeFileSync(backupFile, JSON.stringify(raw, null, 2), 'utf8');
  } catch (e) {
    // 备份失败不阻塞迁移，只记日志
    // （logger 可能还未初始化，用 console.warn 替代）
    console.warn('[memory-bank] v1 backup failed:', e?.message);
  }

  // 写入空 v2
  const v2 = { ...EMPTY_BANK };
  try {
    fs.writeFileSync(file, JSON.stringify(v2), 'utf8');
  } catch (e) {
    console.warn('[memory-bank] v1 migration write failed:', e?.message);
  }
}

export function readBank() {
  migrateV1IfNeeded(); // 幂等，v2 文件时直接 return
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

// ── memories CRUD ────────────────────────────────────────────────────────────

/**
 * 添加一条记忆条目（幂等：同 id 不重复插入）。
 * @param {{ id: string, [key: string]: any }} memory
 */
export function addMemory(memory) {
  if (!memory || !memory.id) throw new Error('memory.id required');
  updateBank((bank) => {
    // 同 id 已存在，放弃写盘（幂等）
    if (bank.memories.some((m) => m.id === memory.id)) return undefined;
    return { ...bank, memories: [...bank.memories, memory] };
  });
}

/**
 * 按 id 读取记忆条目，不存在返回 null。
 * @param {string} id
 * @returns {{ id: string, [key: string]: any } | null}
 */
export function getMemory(id) {
  const bank = readBank();
  return bank.memories.find((m) => m.id === id) || null;
}

/**
 * 返回所有记忆条目列表。
 * @returns {Array}
 */
export function listMemories() {
  return readBank().memories;
}

/**
 * 删除指定 id 的记忆条目。
 * id 不存在时静默放弃，不抛错。
 * @param {string} id
 */
export function removeMemory(id) {
  if (!id) throw new Error('id required');
  updateBank((bank) => {
    const exists = bank.memories.some((m) => m.id === id);
    if (!exists) return undefined; // 不存在则放弃写盘
    return { ...bank, memories: bank.memories.filter((m) => m.id !== id) };
  });
}

/**
 * 局部更新指定 id 的记忆字段（浅合并）。
 * id 不存在时静默放弃，不抛错，不写盘。
 * @param {string} id
 * @param {object} patch
 */
export function patchMemory(id, patch) {
  if (!id || !patch) throw new Error('id and patch required');
  updateBank((bank) => {
    const idx = bank.memories.findIndex((m) => m.id === id);
    if (idx < 0) return undefined; // 不存在则放弃写盘
    if (Object.keys(patch).length === 0) return undefined; // 空 patch 不写盘
    const { id: _drop, ...safePatch } = patch; // 防止 id 字段被覆盖
    const updated = bank.memories.map((m, i) =>
      i === idx ? { ...m, ...safePatch } : m
    );
    return { ...bank, memories: updated };
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
