import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-routes-'));
const { handleMemoryRoutes } = await import('./routes-memory.js');
const { writeBank, readBank, EMPTY_BANK } = await import('../../store/memory-bank.js');

function startServer() {
  const server = createServer((req, res) => handleMemoryRoutes(req, res, new URL(req.url, 'http://x')));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
let server, base;
test.before(async () => { server = await startServer(); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const get = (p) => call(p, 'GET');
const post = (p, b) => call(p, 'POST', b ?? {});

const seed = () => {
  const bank = { ...EMPTY_BANK };
  bank.memories = [
    { id: 'm1', category: 'code-style', scope: 'global', projectDir: '', statement: '注释写中文',
      fingerprint: 'f1', status: 'candidate', inject: true, source: 'inferred',
      evidenceCount: 1, evidenceSessions: ['s1'],
      evidence: [{ quote: '不对', sessionId: 's1', at: '', kind: 'correction' }],
      promotedBy: null, acked: true, conflictWith: null, createdAt: 1, updatedAt: 1, lastSeenAt: 1 },
    { id: 'm2', category: 'collaboration', scope: 'global', projectDir: '', statement: '大改前先问我',
      fingerprint: 'f2', status: 'active', inject: true, source: 'explicit',
      evidenceCount: 1, evidenceSessions: ['s2'], evidence: [],
      promotedBy: 'auto', acked: false, conflictWith: null, createdAt: 1, updatedAt: 1, lastSeenAt: 1 },
  ];
  writeBank(bank);
};

test('GET /api/memory/list 返回条目与红点计数', async () => {
  seed();
  const r = await get('/api/memory/list');
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.unackedCount, 1, '未读的自动晋升条目计入红点');
  assert.equal(r.json.conflictCount, 0);
  assert.ok(r.json.budget, '必须回传预算信息供面板提示截断');
});

test('POST /api/memory/confirm 置 active 且 promotedBy=manual', async () => {
  seed();
  const r = await post('/api/memory/confirm', { id: 'm1' });
  assert.equal(r.status, 200);
  const it = readBank().memories.find((i) => i.id === 'm1');
  assert.equal(it.status, 'active');
  assert.equal(it.promotedBy, 'manual');
  assert.equal(it.acked, true, '手工确认的不该再亮红点');
});

test('POST /api/memory/confirm 可同时改写 statement / category / inject', async () => {
  seed();
  await post('/api/memory/confirm', { id: 'm1', statement: '注释写中文，只解释为什么', category: 'writing', inject: false });
  const it = readBank().memories.find((i) => i.id === 'm1');
  assert.equal(it.statement, '注释写中文，只解释为什么');
  assert.equal(it.category, 'writing');
  assert.equal(it.inject, false);
});

test('POST /api/memory/confirm 拒绝未知 category', async () => {
  seed();
  assert.equal((await post('/api/memory/confirm', { id: 'm1', category: 'vibes' })).status, 400);
});

test('POST /api/memory/reject 移出条目', async () => {
  seed();
  const r = await post('/api/memory/reject', { id: 'm1' });
  assert.equal(r.status, 200);
  const bank = readBank();
  assert.equal(bank.memories.find((i) => i.id === 'm1'), undefined);
});

test('POST /api/memory/ack 清红点', async () => {
  seed();
  await post('/api/memory/ack', { all: true });
  assert.ok(readBank().memories.every((i) => i.acked));
});

test('缺 id 返回 400，未知 id 返回 404', async () => {
  seed();
  assert.equal((await post('/api/memory/confirm', {})).status, 400);
  assert.equal((await post('/api/memory/confirm', { id: 'nope' })).status, 404);
});

test('GET /api/memory/export 含全部条目与证据链', async () => {
  seed();
  const r = await get('/api/memory/export?format=json');
  assert.equal(r.status, 200);
  assert.equal(r.json.schema, 'memory-bank/v2');
  assert.equal(r.json.items.length, 2);
  assert.ok(r.json.items[0].evidence, '导出必须含证据链 —— 数字分身要用');
  assert.ok(r.json.stats.byCategory);
});

test('GET /api/memory/sessions 返回会话列表与记忆条目', async () => {
  seed();
  const r = await get('/api/memory/sessions');
  assert.equal(r.status, 200);
  assert.ok(r.json.ok);
  assert.ok(Array.isArray(r.json.sessions));
  assert.ok(Array.isArray(r.json.memories));
  assert.equal(r.json.memories.length, 2);
});

test('POST /api/memory/remove 删除指定记忆条目', async () => {
  seed();
  const r = await post('/api/memory/remove', { id: 'm1' });
  assert.equal(r.status, 200);
  assert.ok(r.json.ok);
  const bank = readBank();
  assert.equal(bank.memories.find((m) => m.id === 'm1'), undefined);
  assert.ok(bank.memories.find((m) => m.id === 'm2'), 'm2 应保留');
});

test('POST /api/memory/remove 缺 id 返回 400', async () => {
  seed();
  assert.equal((await post('/api/memory/remove', {})).status, 400);
});

test('未知路径 404', async () => {
  assert.equal((await get('/api/memory/nope')).status, 404);
});
