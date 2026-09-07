/**
 * SQL 审计日志（sql-audit.jsonl）—— 自由形数据问答的**第 4 层防线**。
 *
 * ## 为什么这份日志比一般日志重要
 *
 * 该功能刻意**不设身份门禁**（`permission:'any'`，决策依据：一两个人用、1~2 周一次，
 * 建名单不划算）。没有事前门禁，事后可追溯就是唯一手段 —— 这份文件是「谁在什么时候
 * 对生产库查了什么」的唯一记录。
 *
 * 所以有两条与 `action-log.js` 不同的纪律：
 *
 * 1. **被拒绝的 SQL 也要落盘**（`ok:false` + `denyCode`）。只记成功等于把「有人在试探边界」
 *    这个最该看见的信号丢掉 —— 一串 `pii_denied` / `forbidden_keyword` 正是需要有人过问的形态。
 * 2. **SQL 原文不脱敏、不截断到看不懂**。审计的价值在于事后能复现「他到底查了什么」，
 *    脱敏后的 SQL 是不可复现的。真正的隐私保护在执行前（sql-guard 的 PII 黑名单），不在这里。
 *    结果集**不落盘**（只记行数）—— 那才是数据泄露面。
 *
 * 保留策略比 action-log 宽（2000 条 vs 500）：低频功能下 2000 条能覆盖很长时间跨度，
 * 而审计日志的价值恰恰在于「能往回翻得够远」。
 */
import { appendFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { dataPath } from './index.js';
import { compactJsonl } from './jsonl.js';
import { readJsonl } from './jsonl.js';

const FILE = 'sql-audit.jsonl';
const MAX_ENTRIES = 2000;
const COMPACT_EVERY = Math.floor(MAX_ENTRIES / 4);
let _appends = 0;

/** SQL 原文上限：够复现即可，防有人用超长 SQL 把文件撑爆 */
const SQL_MAX = 4000;
/** 用户问题上限 */
const QUESTION_MAX = 500;

function clip(v, max) {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  return s.length <= max ? s : s.slice(0, max) + `…(共 ${s.length} 字)`;
}

/**
 * 追加一条 SQL 审计记录。**永不抛** —— 它在用户消息处理路径上，
 * 写日志失败绝不能把一次正常查询带崩（同 action-log / bot-activity 的纪律）。
 *
 * @param {object} e
 * @param {string} e.userId    发起人（飞书 open_id）
 * @param {string} [e.userName] 展示名（取不到就空，不阻断）
 * @param {string} [e.question] 用户的原始自然语言问题
 * @param {string} e.sql        模型生成的 SQL 原文
 * @param {string} [e.purpose]  模型自述的查询意图（run_query 工具的必填参数）
 * @param {boolean} e.ok        是否真正执行成功
 * @param {string} [e.denyCode] 被 sql-guard 拒绝时的分类码（pii_denied / not_select / …）
 * @param {number} [e.rows]     返回行数（**只记条数，不记内容**）
 * @param {boolean} [e.truncated]
 * @param {number} [e.ms]
 * @param {string} [e.error]
 */
export async function appendSqlAudit(e) {
  try {
    const entry = {
      time: new Date().toISOString(),
      userId: e?.userId ?? null,
      userName: e?.userName ?? null,
      question: clip(e?.question, QUESTION_MAX),
      sql: clip(e?.sql, SQL_MAX),
      purpose: clip(e?.purpose, QUESTION_MAX),
      ok: !!e?.ok,
      denyCode: e?.denyCode ?? null,
      rows: Number.isFinite(e?.rows) ? e.rows : null,
      truncated: !!e?.truncated,
      ms: Number.isFinite(e?.ms) ? e.ms : null,
      error: e?.error ? clip(e.error, 500) : null,
    };
    await appendFile(dataPath(FILE), JSON.stringify(entry) + '\n');

    _appends += 1;
    if (_appends % COMPACT_EVERY === 0) compactJsonl(FILE, { max: MAX_ENTRIES });
  } catch (err) {
    logger.warn('sql-audit', '审计日志写入失败（已忽略，不影响查询）', { err: err?.message || String(err) });
  }
}

/**
 * 读取审计记录（最新在前）。给后续的「谁在查什么」面板与人工排查用。
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function readSqlAudit(limit = 200) {
  const all = readJsonl(FILE);
  return all.slice(-limit).reverse();
}

/**
 * 统计被拒次数（按 denyCode 分组）—— 没有身份门禁时，这是发现异常使用的主要抓手。
 * @param {Array<object>} [entries] 不传则读全量
 * @returns {Record<string, number>}
 */
export function summarizeDenials(entries) {
  const list = entries || readJsonl(FILE);
  const out = {};
  for (const e of list) {
    if (!e || e.ok || !e.denyCode) continue;
    out[e.denyCode] = (out[e.denyCode] || 0) + 1;
  }
  return out;
}
