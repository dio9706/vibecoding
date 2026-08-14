/**
 * 额度用尽待续跑任务 —— 落盘（跨 node 重启可恢复）。
 * 额度耗尽且任务未完成时登记；token 重置后自动向该 session 发送「继续」。
 * 每个对话（convId）只保留最新一条。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'pending-resume.json';

export function getPending() {
  return readJson(FILE, []);
}

/** 构造一条待续跑条目（不落盘，供测试）；attempts 默认 0，调用方可覆盖 */
function buildPendingItem(entry) {
  return {
    id: 'pr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: 'waiting', // waiting → resuming → done（done 后删除）| abandoned（熔断，前端消费后 dismiss）
    runId: null,
    attempts: 0, // 已发起的续跑代次；孤儿→续跑→孤儿每轮 +1，达 MAX 熔断
    reason: 'quota_exhausted', // quota_exhausted（额度耗尽）| orphan_recovery（进程重启孤儿恢复）
    createdAt: new Date().toISOString(),
    ...entry,
  };
}

/** 登记一条待续跑（同一 convId 覆盖旧的）。返回落库后的条目 */
export function addPending(entry) {
  const item = buildPendingItem(entry);
  updateJson(FILE, [], (list) => {
    const next = list.filter((e) => e.convId !== entry.convId);
    next.push(item);
    return next;
  });
  return item;
}
addPending.__buildItem = buildPendingItem; // 测试钩子：免落盘验证默认字段

export function updatePending(id, patch = {}) {
  let out = null;
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return undefined;
    list[i] = { ...list[i], ...patch };
    out = list[i];
    return list;
  });
  return out;
}

export function removePending(id) {
  updateJson(FILE, [], (list) => list.filter((e) => e.id !== id));
}

/** 按会话删除全部待续跑条目（前端失效清除 / 熔断 dismiss 用） */
export function removePendingByConv(convId) {
  updateJson(FILE, [], (list) => list.filter((e) => e.convId !== convId));
}

/**
 * 续跑熔断决策：本次续跑代次是否已超上限（超过则应放弃自动续跑）。
 * 纯函数，便于单测。缺省/非法代次按 0（从未续跑）处理，不熔断。
 * @param {number} attempts 本次将要发起的续跑代次（首次孤儿续跑为 1）
 * @param {number} max 续跑上限（MAX_RESUME_ATTEMPTS）
 */
export function shouldAbandonResume(attempts, max) {
  const n = Number.isFinite(attempts) ? attempts : 0;
  return n > max;
}
