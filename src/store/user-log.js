/**
 * 用户输入原始日志（append-only JSONL）—— 记忆库的**数据采集层**。
 *
 * 为什么不复用会话转录（~/.claude/projects/**\/*.jsonl）：实测那份数据脏得没法用 ——
 * 顶层 type:'user' 的事件里混着 skill 注入、<system-reminder>、工具结果、粘贴的大段日志
 * （168 条「用户消息」里中位数 245 字符、最大一条 56 万字符，约 20% 是系统注入）。
 * 在下游反过来分辨「这句是不是人打的」既苦又做不干净。改为在后端起跑/插话路径上直接埋点：
 * 发送框里的东西 100% 是人打的，源头就干净。
 *
 * 为什么原始层与提炼层要分开：提炼算法一定会迭代。边扫边提炼、游标一推进就不回头的话，
 * 算法改进后历史数据全白瞎。这里只负责**无损**落原始日志（不截断、不改写），
 * 提炼层按游标/时间窗消费，随时可以拿老数据重跑。
 *
 * 为什么不走 store/index.js 的 updateJson：那是整份读-改-写 + 文件锁，用在只增不改的日志上
 * 会越写越慢（同 event-log.js 的取舍）。这里只 appendFileSync 追加单行。
 *
 * 与 event-log.js 的差别只有一处：**这里加了文件锁**。event-log 的行都是小结构化对象
 * （远小于 4KB，单次 write 近似原子，丢一行也无所谓），而本日志的 text 是用户原文、长度无上限，
 * 超过一次 write 的量时 PM2 的 principal-web / principal-feishu 两个进程会把彼此的行交错写坏 ——
 * 而「无损」正是这一层唯一的价值，坏一行就是永久丢一份证据。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';
import { acquireLock, releaseLock } from './lock.js';
import { logger } from '../shared/logger.js';

const FILE = 'user-log.jsonl';

/** 日志文件绝对路径（测试与运维排查用） */
export function userLogFile() {
  return dataPath(FILE);
}

/** 元数据字段归一：只收字符串，其余（数字/对象/undefined）一律 null。
 *  归一放在写入前而不是读取后，是为了保证进 JSON.stringify 的永远是安全值 —— 循环引用之类
 *  一旦混进来就会让整条记录写不进去。 */
function metaStr(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * 追加一条用户输入。**永不抛异常**：日志写失败绝不能影响用户的正常对话。
 *
 * @param {object} entry
 * @param {string} entry.text     用户原文，逐字保留（调用方也不要先截断）
 * @param {string} entry.source   'web' | 'feishu'（将来可能有别的入口）
 * @param {string} entry.kind     'send'（新起一轮）| 'steer'（插话打断，高价值信号）
 * @param {number} [entry.at]     毫秒时间戳，缺省取 Date.now()（可注入供测试）
 * @returns {boolean} 是否真的落盘（拒写/写失败均为 false）
 */
export function appendUserLog(entry) {
  const text = entry && entry.text;
  // 只有「非空白字符串」才算用户说了话。纯空白/非字符串直接拒写，
  // 免得下游提炼层再花力气分辨垃圾行（这一层挡掉是最省事的位置）。
  if (typeof text !== 'string' || !text.trim()) return false;
  const rec = {
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
    text, // 不 trim、不截断：首尾空白与换行本身也是用户敲出来的
    source: metaStr(entry.source) || 'unknown',
    // fail-closed：非法值一律归 'send'。steer 是「AI 跑偏被用户打断」这个高价值信号的唯一标记，
    // 宁可漏标也绝不能把来路不明的输入误升成 steer。
    kind: entry.kind === 'steer' ? 'steer' : 'send',
    convId: metaStr(entry.convId),
    sessionId: metaStr(entry.sessionId),
    cwd: metaStr(entry.cwd),
    model: metaStr(entry.model),
  };
  const file = userLogFile();
  const lock = file + '.lock';
  let token;
  try {
    // 拿不到锁就裸写：交错写坏的概率远低于「这条记录彻底不落盘」的代价。
    // maxWait 取 2s（对齐 event-log 的 compact）—— 用户消息本就低频，不会在这里排队。
    try {
      token = acquireLock(lock, { maxWaitMs: 2000 });
    } catch {
      token = null;
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return true;
  } catch (e) {
    logger.warn('user-log', '用户输入日志写入失败（已忽略，不影响对话）', { err: e?.message || String(e) });
    return false;
  } finally {
    if (token) releaseLock(lock, token);
  }
}

/**
 * 按游标 + 时间窗读取（供提炼层消费）。**永不抛异常**。
 *
 * 游标用**字节偏移**而不是时间戳：文件只增不改，偏移量永远稳定且精确；
 * 用时间戳当游标的话，同一毫秒里落的两条会被「上次读到 lastAt」这一条件漏掉一条。
 *
 * @param {object} [opts]
 * @param {number} [opts.offset=0] 上次返回的 offset，从该字节位置续读
 * @param {number} [opts.since]    只要 at > since 的记录（跳过的行照常推进 offset）
 * @param {number} [opts.until]    只要 at <= until 的记录；命中即**停止扫描**，
 *                                 offset 停在此处，窗口之外的记录留给下次读，不会被吞掉
 * @param {number} [opts.limit]    最多返回几条；截断时 offset 也只推进到最后一条被返回的行
 * @returns {{entries: object[], offset: number}} entries 按落盘顺序（即时间顺序）
 */
export function readUserLog({ offset = 0, since, until, limit } = {}) {
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  let buf;
  try {
    const fd = fs.openSync(userLogFile(), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (start >= size) return { entries: [], offset: start };
      buf = Buffer.allocUnsafe(size - start);
      const read = fs.readSync(fd, buf, 0, size - start, start);
      if (read < buf.length) buf = buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { entries: [], offset: start }; // 文件不存在/被占用：当作「暂时没有新数据」
  }

  // 最后一个换行之后的残尾不消费：另一个进程可能正写到一半，等它写完下轮再读。
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { entries: [], offset: start };
  // 从 start 切分永远落在换行之后，不会把多字节字符切两半
  const lines = buf.subarray(0, lastNl + 1).toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // 末尾换行产生的空段

  const entries = [];
  let consumed = start;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 = 行尾换行
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      consumed += lineBytes; // 坏行（进程被杀留下的半截）跳过：整体失败会让游标永久卡死
      continue;
    }
    // until 是「时间窗右界」而不是过滤条件：越界即停，游标不能越过它，
    // 否则下次续读会直接跳过这些还没被消费的记录。
    if (Number.isFinite(until) && e && e.at > until) break;
    consumed += lineBytes;
    if (Number.isFinite(since) && e && e.at <= since) continue;
    entries.push(e);
    if (Number.isFinite(limit) && limit > 0 && entries.length >= limit) break;
  }
  return { entries, offset: consumed };
}

/**
 * 规模统计（面板/排查用）。**永不抛异常**。
 * @returns {{count:number, chars:number, bytes:number, firstAt:number|null, lastAt:number|null}}
 */
export function userLogStats() {
  const { entries } = readUserLog();
  let chars = 0;
  for (const e of entries) chars += typeof e?.text === 'string' ? e.text.length : 0;
  let bytes = 0;
  try {
    bytes = fs.statSync(userLogFile()).size;
  } catch {
    bytes = 0;
  }
  return {
    count: entries.length,
    chars,
    bytes,
    firstAt: entries.length ? entries[0].at : null,
    lastAt: entries.length ? entries[entries.length - 1].at : null,
  };
}
