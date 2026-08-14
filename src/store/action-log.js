/**
 * 执行日志（action-log.jsonl）—— 记录每次用户操作执行结果，支持敏感字段脱敏。
 *
 * 格式：JSONL（每行一条 JSON 记录），文件在项目根目录 action-log.jsonl。
 * 敏感字段脱敏：手机号 → 159****9503（保留前 3 位和后 4 位）。
 * 写失败不影响主流程，仅 logger.warn 记录。
 * 防无限增长：每 500 次 append 自动压缩一次，保留最新 500 条记录。
 */
import fs from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { dataPath } from './index.js';
import { maskValue, maskDeep } from './mask.js';
import { acquireLock, releaseLock } from './lock.js';

const FILE = 'action-log.jsonl';
const MAX_ENTRIES = 500;
const COMPACT_EVERY = Math.floor(MAX_ENTRIES / 2);
let _appends = 0;

/**
 * 读取 JSONL 全部行（每行一条 JSON）
 */
function readJsonl() {
  let raw = '';
  try {
    raw = fs.readFileSync(dataPath(FILE), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/**
 * 压缩：保留最新 MAX_ENTRIES 条，避免文件无限增长
 */
function compact() {
  // 与 event-log 同理：append 可以无锁，但「读全量 → rename 覆盖」必须加锁，
  // 否则跨进程并发时会把对方在压缩窗口内追加的行整段吞掉。
  const file = dataPath(FILE);
  const lock = file + '.lock';
  let token;
  try {
    token = acquireLock(lock, { maxWaitMs: 2000 });
  } catch {
    return; // 别的进程正在压缩，跳过本次
  }
  try {
    const list = readJsonl();
    if (list.length <= MAX_ENTRIES) return; // 未超限，无需压缩

    const keep = list.slice(-MAX_ENTRIES); // 保留最新 N 条
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
  } catch (err) {
    /* 压缩失败不影响主流程，下次再试 */
    logger.warn('action-log', 'Failed to compact', { error: err?.message || String(err) });
  } finally {
    releaseLock(lock, token);
  }
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

    // 异步追加到 JSONL（一行 JSON + 换行）
    await appendFile(
      dataPath(FILE),
      JSON.stringify(maskedEntry) + '\n',
    );
  } catch (err) {
    // 日志写失败仅记录 warn，不抛异常
    logger.warn(
      'action-log',
      'Failed to append action log',
      { error: err?.message || String(err) },
    );
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
