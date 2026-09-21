import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-routes-'));
const { handleMemoryRoutes, sessionDisplayStatus, pickUnregisteredPaths, groupSessionsForPanel } = await import('./routes-memory.js');
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

// ── sessionDisplayStatus ─────────────────────────────────────────────────────

test('sessionDisplayStatus: 提炼在跑时 analyzing 原样保留', () => {
  assert.equal(
    sessionDisplayStatus({ status: 'analyzing', analyzedAt: 0 }, { running: true, exists: true }),
    'analyzing'
  );
});

test('sessionDisplayStatus: 提炼没在跑时 analyzing 降级重算（重启残留）', () => {
  assert.equal(
    sessionDisplayStatus({ status: 'analyzing', analyzedAt: 0 }, { running: false, exists: true }),
    'pending'
  );
});

test('sessionDisplayStatus: 未分析且源文件还在 → pending', () => {
  assert.equal(sessionDisplayStatus({ analyzedAt: 0 }, { exists: true }), 'pending');
});

test('sessionDisplayStatus: 未分析但源文件已删 → missing（扫描再也扫不到，不能谎报待分析）', () => {
  assert.equal(sessionDisplayStatus({ analyzedAt: 0 }, { exists: false }), 'missing');
});

test('sessionDisplayStatus: 已分析且未变更 → analyzed（findings 为空也算分析完成）', () => {
  assert.equal(
    sessionDisplayStatus({ analyzedAt: 1000, mtime: 900, findings: [] }, { exists: true }),
    'analyzed'
  );
});

test('sessionDisplayStatus: 已分析但源文件后来被删 → 仍是 analyzed（findings 已入库，不是待办）', () => {
  assert.equal(
    sessionDisplayStatus({ analyzedAt: 1000, mtime: 900 }, { exists: false }),
    'analyzed'
  );
});

test('sessionDisplayStatus: mtime 晚于 analyzedAt → outdated', () => {
  assert.equal(
    sessionDisplayStatus({ analyzedAt: 1000, mtime: 2000 }, { exists: true }),
    'outdated'
  );
});

// ── pickUnregisteredPaths ────────────────────────────────────────────────────

test('pickUnregisteredPaths: 剔除已在 sessions 登记过的路径（否则前端同一会话渲染两行）', () => {
  const scanned = [{ path: '/a.jsonl' }, { path: '/b.jsonl' }, { path: '/c.jsonl' }];
  const sessions = [{ path: '/a.jsonl' }, { path: '/c.jsonl' }];
  assert.deepEqual(pickUnregisteredPaths(scanned, sessions), [{ path: '/b.jsonl' }]);
});

test('pickUnregisteredPaths: 空/非法输入不抛错', () => {
  assert.deepEqual(pickUnregisteredPaths(null, null), []);
  assert.deepEqual(pickUnregisteredPaths([{ path: '/a' }], null), [{ path: '/a' }]);
  assert.deepEqual(pickUnregisteredPaths(null, [{ path: '/a' }]), []);
});

// ── groupSessionsForPanel ────────────────────────────────────────────────────

const groupCtx = (over = {}) => ({ running: false, cutoff: 0, exists: () => true, ...over });

test('groupSessionsForPanel: 按状态分成待办 / 已分析两组', () => {
  const { pending, analyzed } = groupSessionsForPanel([
    { id: 'a', path: '/a', mtime: 100, analyzedAt: 200 },          // analyzed
    { id: 'b', path: '/b', mtime: 100, analyzedAt: 0 },            // pending
    { id: 'c', path: '/c', mtime: 300, analyzedAt: 200 },          // outdated → 待办
  ], groupCtx());
  assert.deepEqual(pending.map((s) => s.id).sort(), ['b', 'c']);
  assert.deepEqual(analyzed.map((s) => s.id), ['a']);
});

test('groupSessionsForPanel: missing（源文件已删）两组都不进', () => {
  const { pending, analyzed } = groupSessionsForPanel(
    [{ id: 'z', path: '/gone', mtime: 100, analyzedAt: 0 }],
    groupCtx({ exists: () => false })
  );
  assert.deepEqual(pending, []);
  assert.deepEqual(analyzed, []);
});

test('groupSessionsForPanel: 各组按 mtime 倒序（最近的在前）', () => {
  const { analyzed } = groupSessionsForPanel([
    { id: 'old', path: '/o', mtime: 100, analyzedAt: 500 },
    { id: 'new', path: '/n', mtime: 400, analyzedAt: 500 },
    { id: 'mid', path: '/m', mtime: 200, analyzedAt: 500 },
  ], groupCtx());
  assert.deepEqual(analyzed.map((s) => s.id), ['new', 'mid', 'old']);
});

test('groupSessionsForPanel: 超出 cutoff 的会话被过滤，缺 mtime 的保留', () => {
  const { pending, analyzed } = groupSessionsForPanel([
    { id: 'stale', path: '/s', mtime: 10, analyzedAt: 20 },
    { id: 'fresh', path: '/f', mtime: 999, analyzedAt: 1000 },
    { id: 'nomtime', path: '/n', analyzedAt: 0 },
  ], groupCtx({ cutoff: 500 }));
  assert.deepEqual(analyzed.map((s) => s.id), ['fresh']);
  assert.deepEqual(pending.map((s) => s.id), ['nomtime']);
});

test('groupSessionsForPanel: 已分析的会话不做 exists 探测（findings 已入库，文件在不在都不影响）', () => {
  let probes = 0;
  const { analyzed } = groupSessionsForPanel(
    [{ id: 'a', path: '/a', mtime: 100, analyzedAt: 200 }],
    groupCtx({ exists: () => { probes += 1; return true; } })
  );
  assert.equal(analyzed.length, 1);
  assert.equal(probes, 0, '不该对已分析的会话做 stat');
});

test('groupSessionsForPanel: 非数组输入返回空的两组', () => {
  assert.deepEqual(groupSessionsForPanel(null, groupCtx()), { pending: [], analyzed: [] });
});

// ── GET /api/memory/sessions 分组与分页 ──────────────────────────────────────

const seedSessions = (n) => {
  // mtime 必须落在近 30 天窗口内，否则会被 handleSessions 的 cutoff 整批过滤
  const base = Date.now() - 60 * 1000;
  const bank = { ...EMPTY_BANK, memories: [] };
  bank.sessions = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    path: `/p/${i}.jsonl`,
    mtime: base + i,
    analyzedAt: base + n,       // 晚于所有 mtime → 全部判为 analyzed
    findings: [{ type: 'pattern', summary: `f${i}` }],
    status: 'analyzed',
  }));
  bank.sessions.push({ id: 'todo', path: '/p/todo.jsonl', mtime: base, analyzedAt: 0, findings: [], status: 'pending' });
  writeBank(bank);
};

test('GET /api/memory/sessions 默认只回待办组，已分析只给计数', async () => {
  seedSessions(60);
  const r = await get('/api/memory/sessions');
  assert.equal(r.status, 200);
  // 待办组里那条 todo 的源文件不存在 → missing → 不展示；所以 sessions 为空
  assert.ok(Array.isArray(r.json.sessions));
  assert.ok(r.json.sessions.every((s) => s.status !== 'analyzed'), '默认不该混入已分析的会话');
  assert.equal(r.json.analyzedCount, 60, '已分析总数应如实给出');
  assert.ok(!r.json.sessions.some((s) => s.findings?.length), '默认组不该驮着已分析的 findings');
});

test('GET /api/memory/sessions?scope=analyzed 分页返回已分析会话', async () => {
  seedSessions(60);
  const r = await get('/api/memory/sessions?scope=analyzed&offset=0&limit=25');
  assert.equal(r.status, 200);
  assert.equal(r.json.sessions.length, 25);
  assert.equal(r.json.total, 60);
  assert.equal(r.json.hasMore, true);
  // 倒序：mtime 最大的 s59 在最前
  assert.equal(r.json.sessions[0].id, 's59');
});

test('GET /api/memory/sessions?scope=analyzed 末页 hasMore 为 false', async () => {
  seedSessions(60);
  const r = await get('/api/memory/sessions?scope=analyzed&offset=50&limit=25');
  assert.equal(r.json.sessions.length, 10);
  assert.equal(r.json.hasMore, false);
});

test('GET /api/memory/sessions?scope=analyzed 非法分页参数退回默认值，不抛错', async () => {
  seedSessions(60);
  const r = await get('/api/memory/sessions?scope=analyzed&offset=-5&limit=99999');
  assert.equal(r.status, 200);
  assert.equal(r.json.offset, 0);
  assert.ok(r.json.limit <= 200, 'limit 应被夹到上限');
});
