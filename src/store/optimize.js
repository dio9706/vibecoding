/**
 * optimize.json 的读写。沿用本项目 store 层的 readJson/updateJson 范式。
 * 用项目绝对路径作为 key——同一台机器上路径唯一，不需要额外生成 id。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'optimize.json';
const EMPTY = () => ({ projects: {} });
const HISTORY_LIMIT = 20;

export function readOptimizeStore() {
  const data = readJson(FILE, EMPTY());
  if (!data.projects || typeof data.projects !== 'object') data.projects = {};
  return data;
}

export function getProjectRecord(dir) {
  const data = readOptimizeStore();
  return data.projects[dir] || null;
}

/** 存一次体检结果，并把分数追加到历史（用于画趋势线） */
export function saveCheckup(dir, report) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || { history: [], busy: null, backups: [] };
    rec.lastCheckup = report;
    if (typeof report.score === 'number') {
      rec.history = [...(rec.history || []), { at: report.at, score: report.score }].slice(-HISTORY_LIMIT);
    }
    data.projects[dir] = rec;
    return data;
  });
}
