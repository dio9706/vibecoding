import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'convnotify-routes-'));

const { handleConvNotifyRoutes } = await import('./routes-conv-notify.js');
const { getEntry, pushInjection } = await import('../../store/conv-notify.js');
const { createRun, finishRun } = await import('../../store/runs.js');

let server, base;
test.before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const result = handleConvNotifyRoutes(req, res, url);
    if (result === false) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
// createRun 会起一个看门狗 interval；断言中途失败时收尾语句轮不到执行，留下的定时器足以
// 让 node --test 永不退出（表现为「测试跑不完」而不是「测试失败」）。故统一在此兜底终结。
const spawnedRuns = [];
test.after(() => {
  for (const r of spawnedRuns) finishRun(r);
  server.close();
});

async function post(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(pathname) {
  const res = await fetch(base + pathname);
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('POST /api/conv-notify/new 成功创建新会话', async () => {
  const r = await post('/api/conv-notify/new', { title: '测试会话' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.convId);
  // UUID 格式：36 字符，包括 4 个连字符（8-4-4-4-12）
  assert.match(r.json.convId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
});

test('POST /api/conv-notify/new 返回的 convId 已在 store 中注册', async () => {
  const r = await post('/api/conv-notify/new', { title: '新会话标题', cwd: '/tmp' });
  assert.equal(r.json.ok, true);
  const convId = r.json.convId;

  // 验证 store 中能查到这个会话
  const entry = getEntry(convId);
  assert.ok(entry);
  assert.equal(entry.convId, convId);
  assert.equal(entry.title, '新会话标题');
  assert.equal(entry.cwd, '/tmp');
  assert.equal(entry.model, 'auto');
  assert.equal(entry.effort, 'medium');
  assert.equal(entry.mode, 'default');
  assert.equal(entry.session, ''); // 初始为空
});

test('POST /api/conv-notify/new 使用默认标题', async () => {
  const r = await post('/api/conv-notify/new', {});
  assert.equal(r.json.ok, true);
  const entry = getEntry(r.json.convId);
  assert.equal(entry.title, '飞书新建会话');
});

test('POST /api/conv-notify/new 允许指定 model 和 effort', async () => {
  const r = await post('/api/conv-notify/new', { model: 'opus', effort: 'high' });
  assert.equal(r.json.ok, true);
  const entry = getEntry(r.json.convId);
  assert.equal(entry.model, 'opus');
  assert.equal(entry.effort, 'high');
});

test('POST /api/conv-notify/new 非法 mode 降级为 default', async () => {
  const r = await post('/api/conv-notify/new', { mode: 'invalid-mode' });
  assert.equal(r.json.ok, true);
  const entry = getEntry(r.json.convId);
  assert.equal(entry.mode, 'default');
});

test('POST /api/conv-notify/new 生成的 UUID 互不相同', async () => {
  const r1 = await post('/api/conv-notify/new', {});
  const r2 = await post('/api/conv-notify/new', {});
  assert.notEqual(r1.json.convId, r2.json.convId);
});

test('GET /api/conv-notify/inbox 能查到新建的会话', async () => {
  const r = await post('/api/conv-notify/new', { title: '可查询会话' });
  const convId = r.json.convId;

  const inboxR = await get(`/api/conv-notify/inbox?convId=${convId}`);
  assert.equal(inboxR.status, 200);
  assert.equal(inboxR.json.active, true);
  assert.deepEqual(inboxR.json.items, []);
});

test('POST /api/conv-notify/new 会话初始 inbox 为空', async () => {
  const r = await post('/api/conv-notify/new', {});
  const entry = getEntry(r.json.convId);
  assert.deepEqual(entry.inbox, []);
});

/**
 * 注入项带的 runId 是「注入那一刻」的 run，而 runs 注册表是纯内存的。
 * 用户在飞书回一句、网页当时没开，隔天再进会话时那个 run 早已随进程消失 ——
 * 前端若照旧接流，会撞上 SSE 的「run 不存在」分支（设计上是静默等待续跑），
 * 而这条路径压根没有续跑条目，助手气泡就永久停在「运行中…」（2026-08-28 事故的后半段）。
 * 故 /inbox 必须如实告诉前端这个 run 还在不在，让它自己决定要不要接。
 */
test('GET /api/conv-notify/inbox 标注 runId 是否仍在跑', async () => {
  const r = await post('/api/conv-notify/new', { title: '收件箱存活标注' });
  const convId = r.json.convId;
  const run = createRun();
  spawnedRuns.push(run);
  pushInjection(convId, { id: 'inj_live', text: '继续', runId: run.id, at: Date.now() });
  pushInjection(convId, { id: 'inj_dead', text: '继续', runId: 'run_gone', at: Date.now() });

  const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
  let items = byId((await get(`/api/conv-notify/inbox?convId=${convId}`)).json.items);
  assert.equal(items.inj_live.alive, true, '还在跑的 run 要接流，否则实时进度全看不到');
  assert.equal(items.inj_dead.alive, false, '注册表里没有的 run 不能接，接了就是永久转圈');
  assert.equal(items.inj_live.text, '继续', '原有字段不得被覆写');

  finishRun(run);
  items = byId((await get(`/api/conv-notify/inbox?convId=${convId}`)).json.items);
  assert.equal(items.inj_live.alive, false, 'run 已终结 → 同样不该再接流');
});

test('POST /api/conv-notify/new 会话记录 enabledAt 时间戳', async () => {
  const r = await post('/api/conv-notify/new', {});
  const entry = getEntry(r.json.convId);
  assert.ok(entry.enabledAt);
  // 应该是 ISO 格式
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(entry.enabledAt));
});
