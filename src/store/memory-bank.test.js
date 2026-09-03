import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'membank-'));
const {
  readBank, writeBank, updateBank, patchItem, rejectItem, ackItems, EMPTY_BANK,
} = await import('./memory-bank.js');
const { dataPath } = await import('./index.js');

// ── v2 schema 测试 ─────────────────────────────────────────────────────────────

test('EMPTY_BANK 是 v2 schema 对象', () => {
  assert.equal(EMPTY_BANK.version, 2);
  assert.equal(EMPTY_BANK.lastExtractAt, 0);
  assert.equal(EMPTY_BANK.lastSessionScanAt, 0);
  assert.deepEqual(EMPTY_BANK.sessions, []);
  assert.deepEqual(EMPTY_BANK.memories, []);
});

test('文件不存在时返回空 v2 骨架', () => {
  const bank = readBank();
  assert.equal(bank.version, 2);
  assert.deepEqual(bank.sessions, []);
  assert.deepEqual(bank.memories, []);
});

test('writeBank 写入后 readBank 可回读 v2 数据', () => {
  const toWrite = {
    version: 2,
    lastExtractAt: 1700000001000,
    lastSessionScanAt: 1700000002000,
    sessions: [{ id: 's1', analyzedAt: 123 }],
    memories: [{ id: 'm1', content: 'hello' }],
  };
  writeBank(toWrite);
  const b = readBank();
  assert.equal(b.version, 2);
  assert.equal(b.lastExtractAt, 1700000001000);
  assert.equal(b.lastSessionScanAt, 1700000002000);
  assert.equal(b.sessions.length, 1);
  assert.equal(b.sessions[0].id, 's1');
  assert.equal(b.memories.length, 1);
  assert.equal(b.memories[0].content, 'hello');
});

test('读到 v1 数据时返回空 v2 框架（迁移兜底）', () => {
  // 直接写一个 v1 格式到文件，绕过 writeBank
  const file = dataPath('memory-bank.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, lastScannedAt: 9999, userLogOffset: 4096,
    lastExtractAt: 100, items: [{ id: 'x' }], blacklist: [],
  }));
  const b = readBank();
  assert.equal(b.version, 2);
  assert.deepEqual(b.sessions, []);
  assert.deepEqual(b.memories, []);
});

test('updateBank 可原子更新 bank', () => {
  writeBank({ ...EMPTY_BANK });
  updateBank((cur) => ({
    ...cur,
    lastExtractAt: 9999,
    memories: [{ id: 'u1', content: 'updated' }],
  }));
  const b = readBank();
  assert.equal(b.lastExtractAt, 9999);
  assert.equal(b.memories.length, 1);
  assert.equal(b.memories[0].id, 'u1');
});

test('updateBank fn 返回 undefined 时不写盘', () => {
  writeBank({ ...EMPTY_BANK, lastExtractAt: 42 });
  updateBank(() => undefined);
  assert.equal(readBank().lastExtractAt, 42);
});

// ── v1 stub 兼容性测试 ──────────────────────────────────────────────────────────

test('patchItem stub：不抛错，返回 undefined', () => {
  assert.equal(patchItem('any', { status: 'active' }), undefined);
});

test('rejectItem stub：不抛错，返回 undefined', () => {
  assert.equal(rejectItem('any', Date.now()), undefined);
});

test('ackItems stub：不抛错，返回 undefined', () => {
  assert.equal(ackItems(null), undefined);
});

// ── 已跳过的 v1 测试（保留原始用例，待 Task 4 迁移完成后决定是否删除）────────────

// SKIP: 'userLogOffset 与 lastScannedAt 是两个独立游标，互不覆盖'
// v2 已将两个游标合并为 lastSessionScanAt，此测试逻辑在 v2 不再适用。
//
// test.skip('userLogOffset 与 lastScannedAt 是两个独立游标...', () => {
//   assert.equal(EMPTY_BANK().userLogOffset, 0);
//   assert.equal(EMPTY_BANK().lastScannedAt, 0);
//   writeBank({ ...EMPTY_BANK(), userLogOffset: 4096, lastScannedAt: 1700000000000 });
//   const b = readBank();
//   assert.equal(b.userLogOffset, 4096);
//   assert.equal(b.lastScannedAt, 1700000000000);
// });

// SKIP: '旧版 memory-bank.json（没有 userLogOffset 字段）读回时归 0'
// v2 读到任何 v1 数据直接返回空 v2 框架，此字段已废弃。

// SKIP: '写入后可回读' (v1 版用 items)
// 对应的 v2 版本已由上面的 'writeBank 写入后 readBank 可回读 v2 数据' 覆盖。

// SKIP: 'patchItem 局部更新，不动其它字段' — patchItem 已是 stub
// SKIP: 'patchItem 找不到 id 时不写盘也不抛错' — patchItem 已是 stub
// SKIP: 'rejectItem：移出 items 且 fingerprint 入黑名单' — rejectItem 已是 stub
// SKIP: 'rejectItem 同一 fingerprint 重复否掉不产生重复黑名单项' — rejectItem 已是 stub
// SKIP: 'ackItems：清红点' — ackItems 已是 stub
