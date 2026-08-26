/**
 * optimize.json 的串行闸与优化历史。
 *
 * 隔离：store/index.js 在模块求值时就把数据目录定死，必须「先设 APP_DATA_DIR 到临时目录，
 * 再动态 import」，否则会写进开发机真实的 optimize.json（做法同 src/app/intent.test.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-store-'));

const { acquireBusy, releaseBusy, getBusy, saveFixResult, getProjectRecord, BUSY_STALE_MS } =
  await import('./optimize.js');

/** 每个用例用不同的 dir，免得互相踩（同一个 optimize.json，按 dir 分区） */
let n = 0;
const nextDir = () => `C:/tmp/proj-${++n}`;

test('第一次占用成功，未释放前再占用失败', () => {
  const dir = nextDir();
  assert.equal(acquireBusy(dir, 'fix').ok, true);

  const second = acquireBusy(dir, 'fix');
  assert.equal(second.ok, false);
  assert.equal(second.busy.kind, 'fix');
  assert.ok(second.busy.at, '应带上占用时间，供 UI 提示「自 X 时起正在优化」');
});

test('释放后可以再次占用', () => {
  const dir = nextDir();
  acquireBusy(dir, 'checkup');
  releaseBusy(dir);
  assert.equal(getBusy(dir), null);
  assert.equal(acquireBusy(dir, 'fix').ok, true);
});

test('不同项目互不影响', () => {
  const a = nextDir();
  const b = nextDir();
  acquireBusy(a, 'fix');
  assert.equal(acquireBusy(b, 'fix').ok, true);
});

test('过期的占用可以被抢占', () => {
  // 进程中途崩溃会把 busy 永久留在盘上，没有过期机制的话该项目再也优化不了
  const dir = nextDir();
  acquireBusy(dir, 'fix');
  const stale = new Date(Date.now() - BUSY_STALE_MS - 1000).toISOString();
  const rec = getProjectRecord(dir);
  assert.ok(rec.busy);
  // 直接把占用时间改老，模拟「上次跑到一半进程没了」
  rec.busy.at = stale;
  fs.writeFileSync(
    path.join(process.env.APP_DATA_DIR, 'optimize.json'),
    JSON.stringify({ projects: { [dir]: rec } }, null, 2),
  );

  const again = acquireBusy(dir, 'fix');
  assert.equal(again.ok, true, '超过陈旧阈值应当允许抢占');
});

test('未占用时 getBusy 为 null', () => {
  assert.equal(getBusy(nextDir()), null);
});

test('释放一个没占用过的项目不抛错', () => {
  releaseBusy(nextDir());
});

test('占用记录会带上 jobId 供前端重连', () => {
  const dir = nextDir();
  acquireBusy(dir, 'fix', 'fix_abc');
  assert.equal(getBusy(dir).jobId, 'fix_abc');
});

// ---------- 优化历史 ----------

test('saveFixResult 追加到历史，最新的在前', () => {
  const dir = nextDir();
  saveFixResult(dir, { at: '2026-08-26T01:00:00.000Z', backupDir: 'b1', results: [] });
  saveFixResult(dir, { at: '2026-08-26T02:00:00.000Z', backupDir: 'b2', results: [] });

  const fixes = getProjectRecord(dir).fixes;
  assert.equal(fixes.length, 2);
  assert.equal(fixes[0].backupDir, 'b2', '最新的一次应排在最前');
});

test('优化历史有条数上限', () => {
  const dir = nextDir();
  for (let i = 0; i < 25; i += 1) saveFixResult(dir, { at: `x${i}`, results: [] });
  assert.ok(getProjectRecord(dir).fixes.length <= 20);
});

test('saveFixResult 不动 lastCheckup 和 busy', () => {
  // 优化结束时要「先落结果、再释放闸」，两者写的是同一份 JSON，不能互相覆盖
  const dir = nextDir();
  acquireBusy(dir, 'fix', 'j1');
  saveFixResult(dir, { at: 'now', results: [] });
  assert.equal(getBusy(dir)?.jobId, 'j1');
});
