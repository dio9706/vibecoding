/**
 * 动作配置（Action Configs）存储 —— 通用动作配置管理
 * 提供 CRUD 操作，所有配置含 id、createdAt、updatedAt 时间戳。
 * updateJson 保证跨进程原子性。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'action-configs.json';

/**
 * 读取全部配置
 */
export function getConfigs() {
  return readJson(FILE, []);
}

/**
 * 保存全部配置（原子替换）
 */
export function saveConfigs(configs) {
  updateJson(FILE, [], () => configs);
}

/**
 * 获取单个配置
 */
export function getConfig(id) {
  const configs = getConfigs();
  return configs.find((c) => c.id === id) || null;
}

/**
 * 内部 helper：原子更新配置列表
 * @param {function} fn 接收当前配置列表，返回更新后的列表（或 undefined 表示放弃写盘）
 */
function updateConfigs(fn) {
  return updateJson(FILE, [], fn);
}

/**
 * 添加配置（自动生成 id、createdAt、updatedAt）
 * @param {object} config 配置对象（不含 id、createdAt、updatedAt）
 * @returns {object} 创建后的完整配置对象
 */
export function addConfig(config) {
  const now = new Date().toISOString();
  const id = 'ac_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const newConfig = {
    ...config,
    id,
    createdAt: now,
    updatedAt: now,
  };

  updateConfigs((configs) => {
    configs.push(newConfig);
    return configs;
  });

  return newConfig;
}

/**
 * 更新配置
 * createdAt 和 id 不可修改，updatedAt 自动更新
 * @param {string} id 配置 id
 * @param {object} updates 更新字段
 * @returns {object|null} 更新后的配置对象，或 null 如果配置不存在
 */
export function updateConfig(id, updates) {
  let updated = null;
  updateConfigs((configs) => {
    const i = configs.findIndex((c) => c.id === id);
    if (i < 0) return undefined; // 配置不存在，不写盘

    const now = new Date().toISOString();
    configs[i] = {
      ...configs[i],
      ...updates,
      id: configs[i].id, // id 不可修改
      createdAt: configs[i].createdAt, // createdAt 不可修改
      updatedAt: now, // 更新时间戳
    };
    updated = configs[i];
    return configs;
  });

  return updated;
}

/**
 * 收养无主动作：botId 缺失或指向不存在机器人的动作回填 fallbackBotId（迁移/导入治愈用）
 * @param {string} fallbackBotId 收养方机器人 id
 * @param {Set<string>} validBotIds 现存机器人 id 集合
 * @returns {number} 收养数量
 */
export function adoptOrphanConfigs(fallbackBotId, validBotIds) {
  let adopted = 0;
  updateConfigs((configs) => {
    const next = configs.map((c) => {
      if (c && (!c.botId || !validBotIds.has(c.botId))) {
        adopted++;
        return { ...c, botId: fallbackBotId };
      }
      return c;
    });
    return adopted > 0 ? next : undefined;
  });
  return adopted;
}

/**
 * 删除某机器人的全部动作（删机器人时级联）
 * @param {string} botId 机器人 id
 * @returns {number} 删除数量
 */
export function deleteConfigsByBot(botId) {
  let removed = 0;
  updateConfigs((configs) => {
    const next = configs.filter((c) => {
      const hit = c && c.botId === botId;
      if (hit) removed++;
      return !hit;
    });
    return removed > 0 ? next : undefined;
  });
  return removed;
}

/**
 * 删除配置
 * @param {string} id 配置 id
 */
export function deleteConfig(id) {
  updateConfigs((configs) => {
    const i = configs.findIndex((c) => c.id === id);
    if (i < 0) return undefined; // 配置不存在，不写盘

    configs.splice(i, 1);
    return configs;
  });
}
