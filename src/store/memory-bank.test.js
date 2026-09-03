import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'membank-'));
const {
  readBank, writeBank, updateBank, patchItem, rejectItem, ackItems, EMPTY_BANK,
  addSession, getSession, findSessionByPath, patchSession,
  addMemory, getMemory, listMemories, removeMemory, patchMemory,
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

// ── sessions CRUD 测试 ─────────────────────────────────────────────────────────

test('addSession 正常添加会话', () => {
  writeBank({ ...EMPTY_BANK });
  addSession({ id: 'sess-1', path: '/a/b.jsonl', mtime: 1000 });
  const b = readBank();
  assert.equal(b.sessions.length, 1);
  assert.equal(b.sessions[0].id, 'sess-1');
});

test('addSession 同 id 幂等，不重复添加', () => {
  writeBank({ ...EMPTY_BANK });
  addSession({ id: 'sess-idempotent', path: '/x.jsonl', mtime: 2000 });
  addSession({ id: 'sess-idempotent', path: '/x.jsonl', mtime: 2000 });
  const b = readBank();
  assert.equal(b.sessions.filter((s) => s.id === 'sess-idempotent').length, 1);
});

test('addSession 缺少 id 时抛错', () => {
  assert.throws(() => addSession({}), /session\.id required/);
  assert.throws(() => addSession(null), /session\.id required/);
});

test('getSession 找到时返回 session', () => {
  writeBank({ ...EMPTY_BANK });
  addSession({ id: 'sess-get', path: '/c.jsonl', mtime: 3000, analyzedAt: 42 });
  const s = getSession('sess-get');
  assert.ok(s !== null);
  assert.equal(s.id, 'sess-get');
  assert.equal(s.analyzedAt, 42);
});

test('getSession 找不到时返回 null', () => {
  writeBank({ ...EMPTY_BANK });
  assert.equal(getSession('nonexistent'), null);
});

test('findSessionByPath 按 path+mtime 精确匹配', () => {
  writeBank({ ...EMPTY_BANK });
  addSession({ id: 'sess-p1', path: '/proj/conv.jsonl', mtime: 5000 });
  addSession({ id: 'sess-p2', path: '/proj/conv.jsonl', mtime: 9999 }); // 同路径不同 mtime

  const found = findSessionByPath('/proj/conv.jsonl', 5000);
  assert.ok(found !== null);
  assert.equal(found.id, 'sess-p1');

  // mtime 不匹配时返回 null
  assert.equal(findSessionByPath('/proj/conv.jsonl', 1111), null);
  // path 不匹配时返回 null
  assert.equal(findSessionByPath('/other.jsonl', 5000), null);
});

test('patchSession 更新指定字段', () => {
  writeBank({ ...EMPTY_BANK });
  addSession({ id: 'sess-patch', path: '/d.jsonl', mtime: 4000, status: 'pending' });
  patchSession('sess-patch', { status: 'analyzed', analyzedAt: 99 });
  const s = getSession('sess-patch');
  assert.equal(s.status, 'analyzed');
  assert.equal(s.analyzedAt, 99);
  assert.equal(s.path, '/d.jsonl'); // 未改字段保留
});

test('patchSession id 不存在时静默放弃，不抛错', () => {
  writeBank({ ...EMPTY_BANK });
  assert.doesNotThrow(() => patchSession('no-such-id', { status: 'x' }));
  assert.equal(readBank().sessions.length, 0);
});

test('patchSession 不覆盖 id 字段', () => {
  writeBank({ ...EMPTY_BANK });
  addSession({ id: 'ses-patch-id', path: '/p.jsonl', mtime: 1, title: 't', analyzedAt: 0, findings: [] });
  patchSession('ses-patch-id', { id: 'hacked', title: 'updated' });
  const s = getSession('ses-patch-id');
  assert(s, 'session should still exist');
  assert.strictEqual(s.id, 'ses-patch-id', 'id must not be overwritten');
  assert.strictEqual(s.title, 'updated', 'title should be updated');
});

// ── memories CRUD 测试 ────────────────────────────────────────────────────────

test('addMemory 正常添加记忆条目', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-1', content: '用户偏好深色模式', createdAt: 1000 });
  const b = readBank();
  assert.equal(b.memories.length, 1);
  assert.equal(b.memories[0].id, 'mem-1');
  assert.equal(b.memories[0].content, '用户偏好深色模式');
});

test('addMemory 同 id 幂等，不重复添加', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-idempotent', content: 'first' });
  addMemory({ id: 'mem-idempotent', content: 'second' });
  const b = readBank();
  assert.equal(b.memories.filter((m) => m.id === 'mem-idempotent').length, 1);
  assert.equal(b.memories[0].content, 'first');
});

test('addMemory 缺少 id 时抛错', () => {
  assert.throws(() => addMemory({}), /memory\.id required/);
  assert.throws(() => addMemory(null), /memory\.id required/);
});

test('getMemory 找到时返回 memory', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-get', content: '喜欢简洁风格', tags: ['ui'] });
  const m = getMemory('mem-get');
  assert.ok(m !== null);
  assert.equal(m.id, 'mem-get');
  assert.equal(m.content, '喜欢简洁风格');
  assert.deepEqual(m.tags, ['ui']);
});

test('getMemory 找不到时返回 null', () => {
  writeBank({ ...EMPTY_BANK });
  assert.equal(getMemory('nonexistent-mem'), null);
});

test('listMemories 返回所有记忆条目', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-list-1', content: 'a' });
  addMemory({ id: 'mem-list-2', content: 'b' });
  const list = listMemories();
  assert.equal(list.length, 2);
  assert.ok(list.some((m) => m.id === 'mem-list-1'));
  assert.ok(list.some((m) => m.id === 'mem-list-2'));
});

test('listMemories bank 为空时返回空数组', () => {
  writeBank({ ...EMPTY_BANK });
  const list = listMemories();
  assert.deepEqual(list, []);
});

test('removeMemory 删除指定 id 的条目', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-rm-1', content: 'keep' });
  addMemory({ id: 'mem-rm-2', content: 'remove me' });
  removeMemory('mem-rm-2');
  const b = readBank();
  assert.equal(b.memories.length, 1);
  assert.equal(b.memories[0].id, 'mem-rm-1');
});

test('removeMemory id 不存在时静默放弃，不抛错', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-rm-exist', content: 'x' });
  assert.doesNotThrow(() => removeMemory('no-such-mem'));
  assert.equal(readBank().memories.length, 1);
});

test('removeMemory id 缺失时抛错', () => {
  assert.throws(() => removeMemory(''), /id required/);
  assert.throws(() => removeMemory(null), /id required/);
});

test('patchMemory 更新指定字段', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-patch', content: 'old content', tags: ['a'], score: 1 });
  patchMemory('mem-patch', { content: 'new content', score: 5 });
  const m = getMemory('mem-patch');
  assert.equal(m.content, 'new content');
  assert.equal(m.score, 5);
  assert.deepEqual(m.tags, ['a']); // 未改字段保留
});

test('patchMemory id 不存在时静默放弃，不抛错', () => {
  writeBank({ ...EMPTY_BANK });
  assert.doesNotThrow(() => patchMemory('no-such-mem', { content: 'x' }));
  assert.equal(readBank().memories.length, 0);
});

test('patchMemory 不覆盖 id 字段', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-patch-id', content: 'original' });
  patchMemory('mem-patch-id', { id: 'hacked', content: 'updated' });
  const m = getMemory('mem-patch-id');
  assert.ok(m, 'memory should still exist');
  assert.strictEqual(m.id, 'mem-patch-id', 'id must not be overwritten');
  assert.strictEqual(m.content, 'updated', 'content should be updated');
});

test('patchMemory 空 patch {} 时不写盘', () => {
  writeBank({ ...EMPTY_BANK });
  addMemory({ id: 'mem-patch-empty', content: 'unchanged' });
  patchMemory('mem-patch-empty', {});
  const m = getMemory('mem-patch-empty');
  assert.equal(m.content, 'unchanged');
});

test('patchMemory 缺少 id 或 patch 时抛错', () => {
  assert.throws(() => patchMemory('', { content: 'x' }), /id and patch required/);
  assert.throws(() => patchMemory(null, { content: 'x' }), /id and patch required/);
  assert.throws(() => patchMemory('some-id', null), /id and patch required/);
});

// ── v1 → v2 迁移测试 ──────────────────────────────────────────────────────────

test('readBank migrates v1 to v2 on first read', () => {
  // 写入 v1 格式文件
  const v1 = {
    version: 1,
    lastExtractAt: 999,
    userLogOffset: 100,
    items: [{ id: 'old-item', statement: 'old rule' }],
    blacklist: [],
  };
  fs.writeFileSync(dataPath('memory-bank.json'), JSON.stringify(v1), 'utf8');

  // 读取时触发迁移
  const bank = readBank();

  // v2 结构
  assert.strictEqual(bank.version, 2);
  assert(Array.isArray(bank.sessions));
  assert(Array.isArray(bank.memories));
  assert.strictEqual(bank.sessions.length, 0);
  assert.strictEqual(bank.memories.length, 0);

  // 备份文件存在
  const backupExists = fs.existsSync(dataPath('memory-bank.v1.bak.json'));
  assert(backupExists, 'backup file should exist');

  // 备份内容是 v1
  const backup = JSON.parse(fs.readFileSync(dataPath('memory-bank.v1.bak.json'), 'utf8'));
  assert.strictEqual(backup.version, 1);
  assert.strictEqual(backup.items.length, 1);

  // 清理备份，避免影响后续测试
  try { fs.unlinkSync(dataPath('memory-bank.v1.bak.json')); } catch { /* ignore */ }
});

test('readBank migration is idempotent for v2 files', () => {
  writeBank({ ...EMPTY_BANK });
  const bank1 = readBank();
  const bank2 = readBank();
  assert.strictEqual(bank1.version, 2);
  assert.strictEqual(bank2.version, 2);
  // 没有生成 backup（v2 不触发迁移）
  assert(!fs.existsSync(dataPath('memory-bank.v1.bak.json')), 'no backup for v2 files');
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
