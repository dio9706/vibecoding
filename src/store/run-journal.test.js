/**
 * run-journal 单测：追加/按 run 读取/尾部读取/坏行跳过/清空。
 * 隔离：APP_DATA_DIR 指向临时目录后再动态 import（store/index.js 在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-journal-'));
const { appendRunEvent, readRunEvents, tailRunEvents, clearRunJournal } = await import('./run-journal.js');
const { dataPath } = await import('./index.js');

const ev = (runId, seq, type, data = {}) => ({
  v: 1,
  seq,
  runId,
  convId: 'c1',
  at: 1_700_000_000_000 + seq,
  type,
  data,
});

test('appendRunEvent / readRunEvents：按 run 过滤，文件序即时间序', () => {
  clearRunJournal();
  appendRunEvent(ev('r1', 1, 'submitted', { requestId: 'x' }));
  appendRunEvent(ev('r2', 1, 'session', { session_id: 's2' }));
  appendRunEvent(ev('r1', 2, 'settled', { status: 'done' }));

  const r1 = readRunEvents('r1');
  assert.equal(r1.length, 2);
  assert.deepEqual(r1.map((e) => e.type), ['submitted', 'settled']);
  assert.equal(r1[0].data.requestId, 'x');
  assert.equal(readRunEvents('r2').length, 1);
  assert.deepEqual(readRunEvents('ghost'), []);
  assert.deepEqual(readRunEvents(null), []);
});

test('tailRunEvents：取尾部 N 条（旧→新序保持）', () => {
  clearRunJournal();
  for (let i = 1; i <= 5; i++) appendRunEvent(ev('r1', i, 'step', { i }));
  const tail = tailRunEvents(2);
  assert.deepEqual(tail.map((e) => e.data.i), [4, 5]);
  assert.equal(tailRunEvents(99).length, 5, '请求数超过总量时返回全量');
});

test('坏行跳过：进程被杀留下的半行不炸读取', () => {
  clearRunJournal();
  appendRunEvent(ev('r1', 1, 'submitted'));
  fs.appendFileSync(dataPath('run-journal.jsonl'), '{"v":1,"runId":"r1"'); // 半行
  fs.appendFileSync(dataPath('run-journal.jsonl'), '\n');
  appendRunEvent(ev('r1', 2, 'settled'));
  const r1 = readRunEvents('r1');
  assert.deepEqual(r1.map((e) => e.type), ['submitted', 'settled']);
});

test('clearRunJournal：清空后读取为空', () => {
  clearRunJournal();
  appendRunEvent(ev('r1', 1, 'submitted'));
  clearRunJournal();
  assert.deepEqual(readRunEvents('r1'), []);
  assert.deepEqual(tailRunEvents(10), []);
});
