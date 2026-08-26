/**
 * 评审判例库 —— review-log.jsonl（追加写，最新在后）。
 * 记录每次评审判决与人工覆盖（override）；覆盖判例注入后续评审 prompt 做 few-shot 校准，
 * 让「AI 倾向修改」的偏置随人工纠偏逐步收敛。
 *
 * 读取与压缩下沉到 store/jsonl.js。收敛的动因不只是去重：原来的 compact 是
 * 「读全量 → rename 覆盖」却**没加锁**，而 web / feishu 是两个进程，
 * 压缩窗口内对方追加的行会被整段吞掉（event-log.js 的注释警告过同一场景）。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';
import { readJsonl, compactJsonl } from './jsonl.js';

const FILE = 'review-log.jsonl';
const MAX = 500;
const COMPACT_EVERY = 200;

let _appends = 0;

/** 追加一条判例：{ taskId, type, title, scores?, verdict, override? } */
export function appendReviewVerdict(entry) {
  try {
    fs.appendFileSync(dataPath(FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 判例写失败不影响主流程 */
  }
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

/** 最近 N 条人工覆盖判例（旧→新），供评审 prompt few-shot 注入 */
export function recentOverrides(limit = 5) {
  return readJsonl(FILE).filter((e) => e && e.override).slice(-limit);
}

// 本文件的时间字段是 at 而非 time；compactJsonl 不传 retainMs 时不读任何时间字段，字段名差异无影响
function compact() {
  compactJsonl(FILE, { max: MAX });
}
