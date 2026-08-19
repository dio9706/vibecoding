/**
 * 功能账本（Feature Ledger）——以功能标签（如「宝宝辅食」）为键，
 * 记录历次需求归档时 git diff 收割出的改动文件及其出现频次。
 * 频次越高表示该文件与本功能模块的耦合越强，开发期优先读取。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'feature-index.json';

/** 获取全量功能账本（对象：tag → entry） */
export function getFeatureIndex() {
  return readJson(FILE, {});
}

/** 获取单条功能条目；不存在时返回 null */
export function getFeature(tag) {
  return readJson(FILE, {})[String(tag || '')] ?? null;
}

/** 列出所有已知功能标签名称（供 docgen prompt 注入） */
export function listFeatureTags() {
  return Object.keys(readJson(FILE, {}));
}

/**
 * 从 git diff 收割的文件路径列表，合并入指定功能标签的文件频次记录。
 * 已存在的路径计数 +1，新路径计数置 1；最终按频次降序排列。
 * tag 为空或 filePaths 为空时静默跳过。
 */
export function harvestFiles(tag, filePaths) {
  if (!tag || !filePaths?.length) return;
  updateJson(FILE, {}, (index) => {
    const entry = index[String(tag)] ?? { tag: String(tag), files: [], lastHarvestedAt: null };
    const fileMap = new Map(entry.files.map((f) => [f.path, f.count]));
    for (const p of filePaths) {
      const clean = String(p).trim();
      if (clean) fileMap.set(clean, (fileMap.get(clean) ?? 0) + 1);
    }
    entry.files = [...fileMap.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count);
    entry.lastHarvestedAt = new Date().toISOString();
    index[String(tag)] = entry;
    return index;
  });
}

/**
 * 获取功能标签的高频文件列表（按频次降序取前 N 条，默认 20）。
 * 供 buildSeedPrompt 注入开发 prompt。标签不存在或无文件记录时返回 null。
 */
export function getTopFiles(tag, n = 20) {
  const entry = getFeature(tag);
  if (!entry?.files?.length) return null;
  return entry.files.slice(0, n);
}
