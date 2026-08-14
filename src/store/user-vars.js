/**
 * 用户变量存储 — 支持任意变量的 CRUD
 *
 * 数据格式：{ userId: { varName: value, ... }, ... }
 * 例如：{ "ou_user1": { "phone": "15901039503", "email": "test@example.com" } }
 *
 * API 保证原子性（updateJson），getVar 未找到时返回 null，
 * setVar 自动创建不存在的 userId。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'user-vars.json';

/**
 * 获取某用户全部变量
 * @param {string} userId
 * @returns {object} { varName: value, ... } 空对象如果用户不存在
 */
export function getVars(userId) {
  const all = readJson(FILE, {});
  return all[userId] || {};
}

/**
 * 获取某用户某变量的值
 * @param {string} userId
 * @param {string} varName
 * @returns {*} 值，或 null 如果不存在
 */
export function getVar(userId, varName) {
  const vars = getVars(userId);
  return vars[varName] ?? null;
}

/**
 * 设置某用户某变量（原子）
 * @param {string} userId
 * @param {string} varName
 * @param {*} value
 */
export function setVar(userId, varName, value) {
  updateJson(FILE, {}, (all) => {
    if (!all[userId]) {
      all[userId] = {};
    }
    all[userId][varName] = value;
    return all;
  });
}

/**
 * 获取全部用户数据（Web API 不暴露，仅内部用）
 * @returns {object}
 */
export function getAllVars() {
  return readJson(FILE, {});
}
