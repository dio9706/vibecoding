/**
 * routes-colleagues 单测 —— 真实 HTTP server + fetch 联调，验证状态码与校验分支。
 * 只挂 handleColleagueRoutes（不经完整 server.js），避免拉起飞书/token 等无关依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

// 隔离数据目录：本模块间接 import store/colleagues.js（读盘），须在 import 前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleagues-routes-'));

const { handleColleagueRoutes } = await import('./routes-colleagues.js');
const { ROLES } = await import('../../store/colleagues.js');

function startServer() {
  const server = createServer((req, res) => {
    handleColleagueRoutes(req, res, new URL(req.url, 'http://x'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let base;
test.before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('GET /api/colleagues：回 roles + colleagues', async () => {
  const r = await call('/api/colleagues', 'GET');
  assert.equal(r.status, 200);
  // 只断言「原样透传 ROLES」而不是写死条数：枚举本身的内容由 store/colleagues.test.js 钉住，
  // 两处都写死数字的话，加一个职位要改两个不相干的测试
  assert.deepEqual(r.json.roles, ROLES);
  assert.ok(Array.isArray(r.json.colleagues));
});

test('POST → PUT → DELETE 全链路', async () => {
  const c = await call('/api/colleagues', 'POST', {
    role: 'frontend', name: '张三', note: '活动页', feishuOpenId: 'ou_zs',
  });
  assert.equal(c.status, 201);
  const id = c.json.colleague.id;

  const u = await call('/api/colleagues/' + id, 'PUT', { role: 'backend', name: '张三丰' });
  assert.equal(u.status, 200);
  assert.equal(u.json.colleague.name, '张三丰');
  assert.equal(u.json.colleague.role, 'backend');

  const list = await call('/api/colleagues', 'GET');
  assert.ok(list.json.colleagues.some((x) => x.id === id && x.name === '张三丰'));

  const d = await call('/api/colleagues/' + id, 'DELETE');
  assert.equal(d.status, 200);
  const after = await call('/api/colleagues', 'GET');
  assert.ok(!after.json.colleagues.some((x) => x.id === id));
});

test('POST 拒绝：空姓名 400', async () => {
  const r = await call('/api/colleagues', 'POST', { role: 'ops', name: '  ' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /姓名/);
});

test('POST 拒绝：非法 role 400', async () => {
  const r = await call('/api/colleagues', 'POST', { role: 'not-a-role', name: '张三' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /未知职位/);
});

test('POST 拒绝：open_id 前缀不合法 400', async () => {
  const r = await call('/api/colleagues', 'POST', { role: 'ops', name: '张三', feishuOpenId: 'u_123' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /ou_/);
});

test('未知 id 的 PUT / DELETE 回 404', async () => {
  const u = await call('/api/colleagues/cl_none', 'PUT', { role: 'ops', name: 'X' });
  assert.equal(u.status, 404);
  const d = await call('/api/colleagues/cl_none', 'DELETE');
  assert.equal(d.status, 404);
});

test('畸形 id（%）回 400 而不是让进程崩', async () => {
  const r = await call('/api/colleagues/%', 'DELETE');
  assert.equal(r.status, 400);
});

// ==== 从飞书群导入 ====

test('POST /api/colleagues/batch：写入 + 按 open_id 跳过已存在', async () => {
  const dup = await call('/api/colleagues', 'POST', { role: 'frontend', name: '已存在的', feishuOpenId: 'ou_exist' });
  assert.equal(dup.status, 201);

  const r = await call('/api/colleagues/batch', 'POST', {
    colleagues: [
      { role: 'backend', name: '撞号的', feishuOpenId: 'ou_exist' },
      { role: 'ops', name: '新来的', feishuOpenId: 'ou_fresh' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 1);
  assert.equal(r.json.skipped, 1);

  const list = await call('/api/colleagues', 'GET');
  assert.ok(list.json.colleagues.some((c) => c.name === '新来的'));
  // 撞号那条不能覆盖原记录
  assert.equal(list.json.colleagues.find((c) => c.feishuOpenId === 'ou_exist').name, '已存在的');
});

test('POST /api/colleagues/batch：任一条非法 → 400 且整批不写入', async () => {
  const before = (await call('/api/colleagues', 'GET')).json.colleagues.length;
  const r = await call('/api/colleagues/batch', 'POST', {
    colleagues: [
      { role: 'ops', name: '合法的', feishuOpenId: 'ou_atomic' },
      { role: 'not-a-role', name: '非法职位' },
    ],
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /未知职位/);
  const after = (await call('/api/colleagues', 'GET')).json.colleagues.length;
  assert.equal(after, before, '半批写入会留下用户无从判断的残缺名册');
});

test('POST /api/colleagues/batch：colleagues 非数组 400', async () => {
  const r = await call('/api/colleagues/batch', 'POST', { colleagues: 'x' });
  assert.equal(r.status, 400);
});

/**
 * 路由顺序回归点：/api/colleagues/feishu/* 与 /api/colleagues/batch 都落在
 * `startsWith('/api/colleagues/')` 的射程内。若精确路由没排在它前面，
 * 它们会被当成 id=「feishu/chats」的条目操作 —— 症状是静默 404「同事不存在」，
 * 而不是任何一眼能看出是路由问题的报错。
 */
test('子路径不被当成 :id —— feishu/chats 与 batch 各自命中自己的 handler', async () => {
  const chats = await call('/api/colleagues/feishu/chats', 'GET');
  assert.notEqual(chats.status, 404, 'GET feishu/chats 不该落到 :id 分支');
  // 无凭证时回 502 + 明确文案；有凭证则 200。两者都说明命中了正确的 handler
  assert.ok([200, 502].includes(chats.status), `实际 ${chats.status}`);

  const members = await call('/api/colleagues/feishu/members', 'GET');
  assert.equal(members.status, 400, '缺 chatId 应由 members handler 判成 400');
  assert.match(members.json.error, /chatId/);

  // batch 走 POST；同路径的 PUT/DELETE 不该被 :id 分支接走成「同事 batch」
  const asId = await call('/api/colleagues/batch', 'DELETE');
  assert.equal(asId.status, 404, 'DELETE /batch 无对应资源，回 404 即可（不得误删）');
});
