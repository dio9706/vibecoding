/**
 * JSONL 存储底座 —— event-log / action-log / bot-log 共用。
 *
 * 抽出的动机：三个 store 原本各持一份逐字相同的 readJsonl + compact（连「压缩必须加锁」
 * 那段注释都是复制的）。追加写各自保留（event-log 在每个 HTTP 请求上调用，必须同步；
 * 另两个在 async 上下文，用异步 append），只有读取与压缩是真正重复的部分。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';
import { acquireLock, releaseLock } from './lock.js';

/** 读取全部行（文件序 = 旧→新）。缺文件返回 []；坏行（进程被杀留下的半行）跳过。 */
export function readJsonl(name) {
  let raw = '';
  try {
    raw = fs.readFileSync(dataPath(name), 'utf8');
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
 * 是否在保留窗口内。time 缺失/不可解析一律保留 —— 宁可留下无法判定的条目，也不误删。
 * @param {number} retainMs 窗口毫秒数；含边界（相等视为窗口内）
 */
export function withinRetention(entry, now, retainMs) {
  const t = Date.parse(entry && entry.time);
  if (Number.isNaN(t)) return true;
  return now - t <= retainMs;
}

/**
 * 压缩：时间窗过滤（可选）+ 条数封顶，原子 rename 落盘。
 *
 * **必须加锁**：追加写可以无锁（单行 <4KB 近似原子，极端并发丢一行可接受），
 * 但压缩是「读全量 → rename 覆盖」，跨进程并发时会把对方在这个窗口里追加的行整段吞掉
 * （web 与 feishu 是两个进程，都在写日志，窗口并不罕见）。
 * 抢不到锁说明别人正在压缩，直接跳过本次即可。
 */
export function compactJsonl(name, { max, retainMs } = {}) {
  const file = dataPath(name);
  const lock = file + '.lock';
  let token;
  try {
    token = acquireLock(lock, { maxWaitMs: 2000 });
  } catch {
    return;
  }
  try {
    const list = readJsonl(name);
    let keep = retainMs ? list.filter((e) => withinRetention(e, Date.now(), retainMs)) : list;
    if (max && keep.length > max) keep = keep.slice(-max); // 时间为主、条数为安全上限
    if (keep.length === list.length) return; // 无过期、未超限 → 不写盘
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
  } catch {
    /* 压缩失败不影响主流程，下次再试 */
  } finally {
    releaseLock(lock, token);
  }
}
