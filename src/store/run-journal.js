/**
 * Run 事件流（run-journal.jsonl）—— run 生命周期的事实流，追加写、只增不改。
 *
 * 为什么需要（T2 spec §4.2）：run 状态目前散在内存注册表、active-runs 镜像、pending-resume
 * 快照与前端 localStorage 四处，出问题只能靠日志倒推；崩溃对账（P5）需要一份「每一步发生过
 * 什么」的权威序列。本 store 只负责追加与读取。
 *
 * 写路径纪律：`store/runs.js` 保持纯内存，事件经注册的 sink 送往这里（真实接线在
 * `entrypoints/web/run-durability.js`）。因此本模块**不在内部吞写失败**——由 sink / emit 层
 * 负责「落盘失败不影响 run 收尾与 SSE」；store 层与 index.js 一样「损坏/失败即抛」，便于测试
 * 与诊断。P2 为影子期：只写不读，读取 API 供 P5 对账与排查使用。
 *
 * 行格式：{ v:1, seq, runId, convId, at, type, data }；seq 为 run 内单调序号（独立事件如
 * abandoned 用 seq:0 / runId:null）。策略：3 天保留窗口 + 5000 条上限，压缩走 jsonl.js。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';
import { readJsonl, compactJsonl } from './jsonl.js';

const FILE = 'run-journal.jsonl';
const MAX = 5000;
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;
// 每多少次 append 触发一次压缩（与 event-log 同策略：< 上限的一半，峰值约 1.5×MAX）
const COMPACT_EVERY = Math.floor(MAX / 2);

let _appends = 0;

/** 追加一条事件（调用方保证事件形状；写失败抛错，由上层吞） */
export function appendRunEvent(event) {
  fs.appendFileSync(dataPath(FILE), JSON.stringify(event) + '\n');
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

function compact() {
  compactJsonl(FILE, { max: MAX, retainMs: RETAIN_MS });
}

/** 某 run 的全部事件（文件序 = 时间序；坏行跳过） */
export function readRunEvents(runId) {
  if (!runId) return [];
  return readJsonl(FILE).filter((e) => e && e.runId === runId);
}

/** 尾部 N 条事件（对账用；文件序旧→新，返回同样旧→新） */
export function tailRunEvents(limit = 200) {
  const all = readJsonl(FILE);
  return all.slice(Math.max(0, all.length - limit));
}

/** 清空（测试/运维用） */
export function clearRunJournal() {
  fs.writeFileSync(dataPath(FILE), '');
}

// 模块加载即压缩一次（跨重启兜底）；延后到事件循环空闲并 unref（同 event-log，
// 避免在启动关键路径上做全量读写、也不阻止进程退出）。
setTimeout(compact, 3000).unref();
