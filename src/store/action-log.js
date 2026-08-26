/**
 * 执行日志（action-log.jsonl）—— 记录每次用户操作执行结果，支持敏感字段脱敏。
 *
 * 格式：JSONL（每行一条 JSON 记录）。敏感字段脱敏：手机号 → 159****9503。
 * 写失败不影响主流程，仅 logger.warn 记录。
 * 防无限增长：每 250 次 append 压缩一次，保留最新 500 条（读取与压缩见 store/jsonl.js）。
 *
 * 注意：本文件是**审计**用途（结构化 vars + 脱敏）。面板展示用的机器人日志在 store/bot-log.js，
 * 两者并行写入，互不替代。
 */
import { appendFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { dataPath } from './index.js';
import { maskValue, maskDeep } from './mask.js';
import { compactJsonl } from './jsonl.js';

const FILE = 'action-log.jsonl';
const MAX_ENTRIES = 500;
const COMPACT_EVERY = Math.floor(MAX_ENTRIES / 2);
let _appends = 0;

function compact() {
  compactJsonl(FILE, { max: MAX_ENTRIES });
}

/**
 * 异步追加执行日志到 action-log.jsonl
 * @param {Object} entry - 日志记录，包含 { time, userId, actionId, actionName, vars, ok, code }
 * @returns {Promise<void>}
 */
export async function appendActionLog(entry) {
  try {
    // 脱敏 vars 中的敏感字段
    const maskedEntry = {
      ...entry,
      vars: entry.vars ? maskDeep(entry.vars) : undefined,
    };
    await appendFile(dataPath(FILE), JSON.stringify(maskedEntry) + '\n');
  } catch (err) {
    // 日志写失败仅记录 warn，不抛异常
    logger.warn('action-log', 'Failed to append action log', {
      error: err?.message || String(err),
    });
  }

  // 压缩阈值必须**小于** MAX_ENTRIES，否则文件常态会稳定在上限的 2 倍以上
  // （此前写死 500，恰好等于 MAX_ENTRIES）
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

// 模块加载时压缩一次，跨重启兜底。延后到事件循环空闲执行：
// 同步跑会在启动关键路径上做一次全量读+写，拖慢冷启动。unref 保证不阻止进程退出。
setTimeout(compact, 3000).unref();

export { maskValue }; // 兼容既有引用；实现已迁至 ./mask.js
