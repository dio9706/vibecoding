import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReqReadTools, pickProjectDir, REQ_READ_TOOL_NAMES } from './req-read.js';

const REQS = [
  { id: 'r_a1', title: '订单列表改版', phase: 'dev', assignees: ['cl_1'],
    projects: { frontend: { dir: 'D:/fe' }, backend: { dir: 'D:/be' } },
    apiDocs: [{ id: 'd1', name: 'order.md', path: 'D:/u/order.md', updatedAt: '2026-09-20T00:00:00Z' }],
    history: [{ at: '2026-09-20T00:00:00Z', event: '定稿' }],
    sessions: [{ convId: 'c1', title: '主会话', kind: 'main', phase: 'dev' }] },
  { id: 'r_b2', title: '优惠券', phase: 'archived', assignees: ['cl_1'], projects: {}, apiDocs: [], history: [], sessions: [] },
  { id: 'r_c3', title: '别人的需求', phase: 'dev', assignees: ['cl_9'], projects: {}, apiDocs: [], history: [], sessions: [] },
];

function deps(extra = {}) {
  return {
    getRequirements: () => REQS,
    getRequirement: (id) => REQS.find((r) => r.id === id) || null,
    runReadonlyAgent: async () => ({ data: { answer: '代码里是 camelCase' }, reason: null, denied: [] }),
    ...extra,
  };
}

/** 从装配结果里按名字取一个工具定义 */
function pick(tools, name) {
  const t = tools.find((d) => d.name === name);
  assert.ok(t, `未装配工具 ${name}`);
  return t;
}

test('REQ_READ_TOOL_NAMES：P1 恰好 5 个 safe 工具，且与实际装配一一对应（防漏装）', () => {
  assert.deepEqual(REQ_READ_TOOL_NAMES, [
    'list_my_requirements', 'get_requirement', 'get_api_doc', 'get_dev_progress', 'read_project_code',
  ]);
  // 常量与实际装配必须同步 —— 只钉常量的话，handler 漏写一个测试照样绿
  assert.deepEqual(buildReqReadTools(deps()).map((t) => t.name), REQ_READ_TOOL_NAMES);
});

test('全部工具 danger 都是 safe（P1 不含任何写操作）', () => {
  for (const t of buildReqReadTools(deps())) assert.equal(t.danger, 'safe', t.name);
});

test('list_my_requirements：只返回他参与的、且未归档未废弃的', async () => {
  const t = pick(buildReqReadTools(deps()), 'list_my_requirements');
  const out = await t.handler({}, { colleagueId: 'cl_1' });
  assert.deepEqual(out.requirements.map((r) => r.id), ['r_a1']);
});

test('list_my_requirements：没有 colleagueId 时返回空而不是全部（fail-closed）', async () => {
  const t = pick(buildReqReadTools(deps()), 'list_my_requirements');
  assert.deepEqual((await t.handler({}, {})).requirements, []);
});

test('get_requirement：只返回摘要字段，不把整条记录倒给模型', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_requirement');
  const out = await t.handler({ reqId: 'r_a1' }, { colleagueId: 'cl_1' });
  assert.equal(out.id, 'r_a1');
  assert.equal(out.title, '订单列表改版');
  assert.equal(out.phase, 'dev');
  assert.equal(out.apiDocCount, 1);
  assert.equal(out.busy, undefined, '内部字段不得外泄');
});

test('get_requirement：非参与人查不到（fail-closed，不泄露他人需求）', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_requirement');
  const out = await t.handler({ reqId: 'r_c3' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /没有|无权|找不到/);
});

test('get_requirement：id 不存在时给明确错误，不抛', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_requirement');
  const out = await t.handler({ reqId: 'r_nope' }, { colleagueId: 'cl_1' });
  assert.ok(out.error);
});

test('get_api_doc：列出该需求的接口文档', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_api_doc');
  const out = await t.handler({ reqId: 'r_a1' }, { colleagueId: 'cl_1' });
  assert.deepEqual(out.docs.map((d) => d.name), ['order.md']);
  assert.equal(out.docs[0].path, undefined, '落盘绝对路径不给模型');
});

test('get_dev_progress：返回历史与会话摘要', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_dev_progress');
  const out = await t.handler({ reqId: 'r_a1' }, { colleagueId: 'cl_1' });
  assert.equal(out.phase, 'dev');
  assert.equal(out.sessionCount, 1);
  assert.equal(out.history.length, 1);
});

test('pickProjectDir：前端优先，缺则后端，都缺返回空串', () => {
  assert.equal(pickProjectDir({ frontend: { dir: 'D:/fe' }, backend: { dir: 'D:/be' } }), 'D:/fe');
  assert.equal(pickProjectDir({ frontend: null, backend: { dir: 'D:/be' } }), 'D:/be');
  assert.equal(pickProjectDir({}), '');
  assert.equal(pickProjectDir(null), '');
});

test('read_project_code：把问题交给只读 agent，返回它的 answer', async () => {
  const t = pick(buildReqReadTools(deps()), 'read_project_code');
  const out = await t.handler({ reqId: 'r_a1', question: '字段命名是什么风格' }, { colleagueId: 'cl_1' });
  assert.equal(out.answer, '代码里是 camelCase');
});

test('read_project_code：只读 agent 失败时给出可读原因，不抛', async () => {
  const d = deps({ runReadonlyAgent: async () => ({ data: null, reason: 'timeout', denied: [] }) });
  const t = pick(buildReqReadTools(d), 'read_project_code');
  const out = await t.handler({ reqId: 'r_a1', question: 'x' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /timeout/);
});

test('read_project_code：需求没配工程目录时明确报错', async () => {
  const t = pick(buildReqReadTools(deps()), 'read_project_code');
  const out = await t.handler({ reqId: 'r_b2', question: 'x' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /工程目录/);
});
