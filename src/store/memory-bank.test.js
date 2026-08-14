import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'membank-'));
const {
  readBank, writeBank, patchItem, rejectItem, ackItems, EMPTY_BANK,
} = await import('./memory-bank.js');

test('文件不存在时返回空库骨架', () => {
  assert.deepEqual(readBank(), EMPTY_BANK());
});

test('userLogOffset 与 lastScannedAt 是两个独立游标，互不覆盖 —— 前者是 user-log 的字节偏移（默认链路），后者是转录 mtime（历史回填/终端场景）', () => {
  assert.equal(EMPTY_BANK().userLogOffset, 0);
  assert.equal(EMPTY_BANK().lastScannedAt, 0);
  writeBank({ ...EMPTY_BANK(), userLogOffset: 4096, lastScannedAt: 1700000000000 });
  const b = readBank();
  assert.equal(b.userLogOffset, 4096);
  assert.equal(b.lastScannedAt, 1700000000000);
});

test('旧版 memory-bank.json（没有 userLogOffset 字段）读回时归 0，从头扫一遍 user-log', () => {
  const old = { version: 1, lastScannedAt: 123, lastExtractAt: 456, items: [], blacklist: [] };
  writeBank(old);
  assert.equal(readBank().userLogOffset, 0);
  // 收尾：把游标清干净，免得影响后面按 items 断言的用例
  writeBank(EMPTY_BANK());
});

test('写入后可回读', () => {
  const bank = EMPTY_BANK();
  bank.items.push({ id: 'm1', statement: 'x', status: 'candidate', fingerprint: 'f1', acked: true });
  writeBank(bank);
  assert.equal(readBank().items.length, 1);
});

test('patchItem 局部更新，不动其它字段', () => {
  patchItem('m1', { status: 'active', statement: 'y' });
  const it = readBank().items.find((i) => i.id === 'm1');
  assert.equal(it.status, 'active');
  assert.equal(it.statement, 'y');
  assert.equal(it.fingerprint, 'f1');
});

test('patchItem 找不到 id 时不写盘也不抛错', () => {
  const before = JSON.stringify(readBank());
  patchItem('nope', { status: 'active' });
  assert.equal(JSON.stringify(readBank()), before);
});

test('rejectItem：移出 items 且 fingerprint 入黑名单', () => {
  rejectItem('m1', 1234);
  const bank = readBank();
  assert.equal(bank.items.length, 0);
  assert.equal(bank.blacklist.length, 1);
  assert.equal(bank.blacklist[0].fingerprint, 'f1');
  assert.equal(bank.blacklist[0].rejectedAt, 1234);
});

test('rejectItem 同一 fingerprint 重复否掉不产生重复黑名单项', () => {
  const bank = readBank();
  bank.items.push({ id: 'm2', statement: 'z', status: 'candidate', fingerprint: 'f1', acked: true });
  writeBank(bank);
  rejectItem('m2', 5678);
  assert.equal(readBank().blacklist.length, 1);
});

test('ackItems：清红点', () => {
  const bank = readBank();
  bank.items.push({ id: 'm3', fingerprint: 'f3', status: 'active', acked: false, statement: 'a' });
  bank.items.push({ id: 'm4', fingerprint: 'f4', status: 'active', acked: false, statement: 'b' });
  writeBank(bank);
  ackItems(['m3']);
  const after = readBank().items;
  assert.equal(after.find((i) => i.id === 'm3').acked, true);
  assert.equal(after.find((i) => i.id === 'm4').acked, false);
  ackItems(null); // null = 全部已读
  assert.ok(readBank().items.every((i) => i.acked));
});
