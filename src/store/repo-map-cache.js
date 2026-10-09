/**
 * Repo map 缓存（repo-map-cache.json）：{ [key]: { repoPath, version, fingerprint, builtAt, files } }。
 *
 * 缓存的是「每文件解析记录」（mtime/size/符号/import/标识符），**不是成品文本**——
 * 成品要按当前任务关键词重新排序，缓存文本会让下一次调用沿用上一个任务的加权。
 * `version` 是抽取器口径版本（repo-map/index.js 写，升级即整体作废，防陈旧地图）。
 * LRU 上限 5 仓：记录随文件数增长，无限累积会把同盘 store 撑肥。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, updateJson } from './index.js';

const FILE = 'repo-map-cache.json';
const MAX_REPOS = 5;

/** 缓存键：仓库绝对路径的短哈希（路径含中文/空格也无需转义，日志里也不泄露完整目录结构） */
export function repoCacheKey(repoPath) {
  return crypto.createHash('md5').update(path.resolve(repoPath)).digest('hex').slice(0, 12);
}

export function getRepoMapCacheRecord(repoPath) {
  const store = readJson(FILE, {});
  const rec = store && typeof store === 'object' && !Array.isArray(store) ? store[repoCacheKey(repoPath)] : null;
  return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
}

export function putRepoMapCacheRecord(repoPath, record) {
  const key = repoCacheKey(repoPath);
  return updateJson(FILE, {}, (cur) => {
    const store = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
    store[key] = { ...record, repoPath: path.resolve(repoPath), builtAt: new Date().toISOString() };
    // LRU：按 builtAt 新→旧保留 MAX_REPOS 个
    const keys = Object.keys(store).sort((a, b) =>
      String(store[b]?.builtAt || '').localeCompare(String(store[a]?.builtAt || '')),
    );
    for (const k of keys.slice(MAX_REPOS)) delete store[k];
    return store;
  });
}
