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

/**
 * 自动关键词的默认配额。真正的单一真相源是
 * `plugins/action-runner/feature/keyword-guard.js` 的 `MAX_AUTO_KEYWORDS`，
 * 调用方经 `meta.max` 传进来；此处的默认值只为「万一没传」兜底 ——
 * store 是下层，不能 import plugins（分层单向依赖）。
 */
export const DEFAULT_AUTO_KEYWORD_MAX = 5;

/**
 * 追加一个自动学来的关键词（关键词自学习的专用写入口）。
 *
 * ⚠️ 合并全过程必须在 `updateJson` 回调**内部**完成。web 与飞书是两个进程、共享同一份
 * action-configs.json，在外面 `getConfig()` 再 `updateConfig()` 是读-改-写竞态，
 * 两边同时学到词会互相覆盖（见本模块 CLAUDE.md 流程 A）。
 * 去重与配额也必须在锁内**重做一次** —— 调用方过闸时读到的是快照。
 *
 * @param {string} id 动作 id
 * @param {string} word 关键词
 * @param {{sourceText?:string, max?:number}} [meta] sourceText 为触发原句（截断存证，便于事后复盘）
 * @returns {boolean} 是否真的写入（false = 动作不存在 / 该词已在 / 配额已满）
 */
export function appendAutoKeyword(id, word, meta = {}) {
  const w = String(word ?? '').trim();
  if (!w) return false;
  const max = Number(meta.max) > 0 ? Number(meta.max) : DEFAULT_AUTO_KEYWORD_MAX;
  let written = false;

  updateConfigs((configs) => {
    const i = configs.findIndex((c) => c.id === id);
    if (i < 0) return undefined; // 动作不存在，不写盘

    const cur = configs[i];
    const keywords = Array.isArray(cur.keywords) ? cur.keywords : [];
    const autoKeywords = Array.isArray(cur.autoKeywords) ? cur.autoKeywords : [];

    if (keywords.includes(w)) return undefined;        // 锁内复核：已存在
    if (autoKeywords.length >= max) return undefined;  // 锁内复核：配额

    const now = new Date().toISOString();
    configs[i] = {
      ...cur,
      keywords: [...keywords, w],
      autoKeywords: [
        ...autoKeywords,
        { word: w, sourceText: String(meta.sourceText ?? '').slice(0, 200), learnedAt: now },
      ],
      updatedAt: now,
    };
    written = true;
    return configs;
  });

  return written;
}

/**
 * 人工编辑关键词后的元数据对账（纯函数，供 `PUT /api/actions/:id` 调用）。
 *
 * 语义：用户在面板上删掉某个**自动词** = 明确否决这个词，它必须进 `rejectedKeywords`。
 * 否则下次同样的话再来一次，自学习会把用户刚删的词原样加回去 —— 撤销就形同虚设。
 * 删手工词不算否决（那只是用户在维护自己的词表），不进黑名单。
 *
 * ## 已知取舍：改字会被当成删除
 *
 * 入参只有两个扁平字符串数组，没有稳定 id，所以分不清「改字」和「删旧词+加新词」。
 * 用户把自动词「清掉业务表」改成「清掉业务表格」（纠正错别字），旧词会被判定为删除、
 * 永久进 `rejectedKeywords` —— 今后自学习再也学不回「清掉业务表」这个说法。
 *
 * 刻意不修：被拉黑的正是用户自己刚否决掉的那个写法，而他已经有了更准的版本；
 * 手工添加从不受 `rejectedKeywords` 限制（它只拦自学习）。真要区分，得给每个关键词加稳定 id、
 * 前端改成结构化编辑 —— 成本远超这点收益。
 *
 * @param {object} prev 更新前的动作配置
 * @param {string[]} nextKeywords 用户提交的新关键词数组
 * @returns {{autoKeywords:object[], rejectedKeywords:string[]}}
 */
export function reconcileAutoKeywords(prev, nextKeywords) {
  const kept = new Set(
    (Array.isArray(nextKeywords) ? nextKeywords : []).map((k) => String(k ?? '').trim()),
  );
  const prevAuto = Array.isArray(prev?.autoKeywords) ? prev.autoKeywords : [];
  const prevRejected = Array.isArray(prev?.rejectedKeywords) ? prev.rejectedKeywords : [];

  const autoKeywords = prevAuto.filter((a) => kept.has(String(a?.word ?? '').trim()));
  const removed = prevAuto
    .map((a) => String(a?.word ?? '').trim())
    .filter((w) => w && !kept.has(w));

  return {
    autoKeywords,
    rejectedKeywords: [...new Set([...prevRejected, ...removed])],
  };
}
