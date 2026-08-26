import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// APP_DATA_DIR 必须先于 store 模块引入设定（DATA_DIR 全进程只求值一次，详见 jsonl.test.js）
const TMP = path.join(os.tmpdir(), `cad-reviewlog-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { appendReviewVerdict, recentOverrides } = await import('./review-log.js');
const FILE = path.join(TMP, 'review-log.jsonl');

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('appendReviewVerdict 落盘 + at 自动补齐', () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  appendReviewVerdict({ taskId: 't1', type: 'bug', title: 'X', verdict: 'approve' });

  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.taskId, 't1');
  assert.ok(rec.at, 'at 应由 store 补齐');
});

test('recentOverrides 只取 override 判例，按旧→新返回末 N 条', () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  appendReviewVerdict({ taskId: 'a', verdict: 'reject' }); // 非 override
  appendReviewVerdict({ taskId: 'b', verdict: 'reject', override: true });
  appendReviewVerdict({ taskId: 'c', verdict: 'reject', override: true });

  const got = recentOverrides(2).map((e) => e.taskId);
  assert.deepStrictEqual(got, ['b', 'c'], '过滤 override 且保持旧→新');
  assert.deepStrictEqual(recentOverrides(1).map((e) => e.taskId), ['c'], '只要最新一条');
});

test('坏行（进程被杀留下的半截 JSON）跳过', () => {
  fs.writeFileSync(FILE, '{"taskId":"ok","override":true}\n{"taskId":"bad"\n');
  assert.deepStrictEqual(recentOverrides(5).map((e) => e.taskId), ['ok']);
});

test('写失败不抛（目标文件名被目录占住）', () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  fs.mkdirSync(FILE);
  try {
    appendReviewVerdict({ taskId: 'x' }); // 不抛即通过
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});
