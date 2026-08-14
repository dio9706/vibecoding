/**
 * 评审判例库 —— review-log.jsonl（追加写，最新在后）。
 * 记录每次评审判决与人工覆盖（override）；覆盖判例注入后续评审 prompt 做 few-shot 校准，
 * 让「AI 倾向修改」的偏置随人工纠偏逐步收敛。日志容忍丢行，无需文件锁。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';

const FILE = 'review-log.jsonl';
const MAX = 500;

let _appends = 0;

/** 追加一条判例：{ taskId, type, title, scores?, verdict, override? } */
export function appendReviewVerdict(entry) {
  try {
    fs.appendFileSync(dataPath(FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 判例写失败不影响主流程 */
  }
  if (++_appends >= 200) {
    _appends = 0;
    compact();
  }
}

function readAll() {
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
  return out; // 文件序 = 旧→新
}

/** 最近 N 条人工覆盖判例（旧→新），供评审 prompt few-shot 注入 */
export function recentOverrides(limit = 5) {
  return readAll().filter((e) => e && e.override).slice(-limit);
}

/** 压缩：只保留最新 MAX 条（常驻进程防无限增长） */
function compact() {
  const list = readAll();
  if (list.length <= MAX) return;
  const keep = list.slice(-MAX);
  const tmp = dataPath(FILE) + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, dataPath(FILE));
  } catch {
    /* 压缩失败下次再试 */
  }
}
