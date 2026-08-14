/**
 * 需求 / 故障 任务（Task）存储 —— feedback / dev-task / doc-driven 共用。
 * 状态机：new → confirmed → analyzing → analyzed → developing → done / rejected
 * （见 ARCHITECTURE §6）。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'tasks.json';

export function getTasks() {
  return readJson(FILE, []);
}

export function getTask(id) {
  return getTasks().find((t) => t.id === id) || null;
}

/**
 * @param {object} t { type:'bug'|'feature', title, detail, source:{openId} }
 */
export function createTask(t) {
  const now = new Date().toISOString();
  const id = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const task = {
    id,
    type: t.type || 'feature',
    title: t.title || '',
    detail: t.detail || '',
    source: t.source || {},
    status: 'new',
    analysis: null, // { suggestion, files } —— Claude 分析产出（只落文档）
    fixNote: null, // 「修正」时补充的方案
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: '创建' }],
  };
  // 锁内追加：web 与 feishu 都会写 tasks.json
  updateJson(FILE, [], (tasks) => {
    tasks.unshift(task);
    return tasks;
  });
  return task;
}

export function updateTask(id, patch = {}, event) {
  let updated = null;
  updateJson(FILE, [], (tasks) => {
    const i = tasks.findIndex((t) => t.id === id);
    if (i < 0) return undefined; // 无此任务：不写盘
    const now = new Date().toISOString();
    tasks[i] = { ...tasks[i], ...patch, updatedAt: now };
    if (event) tasks[i].history.push({ at: now, event });
    updated = tasks[i];
    return tasks;
  });
  return updated;
}
