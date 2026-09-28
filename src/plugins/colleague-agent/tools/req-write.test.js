import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReqWriteTools, REQ_WRITE_TOOL_NAMES } from './req-write.js';

const REQ_DEV = { id: 'r_a1', title: '订单改版', phase: 'dev', assignees: ['cl_1'], projects: { frontend: { dir: 'D:/fe' } }, apiDocs: [], branches: [{ dir: 'D:/fe', branch: 'feat/order', baseBranch: 'main' }] };
const REQ_TEST = { ...REQ_DEV, id: 'r_t1', phase: 'test' };

function deps(extra = {}) {
  return {
    getRequirement: (id) => ({ r_a1: REQ_DEV, r_t1: REQ_TEST })[id] || null,
    registerApiDoc: () => ({ ok: true, doc: { id: 'd1', name: 'order.md' } }),
    enqueueSystemTask: () => ({ ok: true }),
    ...extra,
  };
}
const pick = (tools, name) => tools.find((t) => t.name === name);

test('REQ_WRITE_TOOL_NAMES：P2 恰好两个工具，且与实际装配一致', () => {
  assert.deepEqual(REQ_WRITE_TOOL_NAMES, ['register_api_doc', 'start_dev_task']);
  assert.deepEqual(buildReqWriteTools(deps()).map((t) => t.name), REQ_WRITE_TOOL_NAMES);
});

test('两个工具都是 reversible，且 buildUndo 必须是函数（注册期不变式）', () => {
  for (const t of buildReqWriteTools(deps())) {
    assert.equal(t.danger, 'reversible', t.name);
    assert.equal(typeof t.buildUndo, 'function', t.name);
  }
});

test('register_api_doc：只对 backend 可见', () => {
  assert.deepEqual(pick(buildReqWriteTools(deps()), 'register_api_doc').roles, ['backend']);
});

test('start_dev_task：backend / product / qa 可见', () => {
  assert.deepEqual(pick(buildReqWriteTools(deps()), 'start_dev_task').roles.slice().sort(), ['backend', 'product', 'qa']);
});

test('两个工具：非参与人一律拒绝（fail-closed）', async () => {
  for (const t of buildReqWriteTools(deps())) {
    const out = await t.handler({ reqId: 'r_a1', name: 'a.md', path: 'D:/a.md', task: 'x' }, { colleagueId: 'cl_9', msgId: 'm1' });
    assert.ok(out.error, t.name);
  }
});

test('两个工具：缺 colleagueId 一律拒绝（不外推成全部可见）', async () => {
  for (const t of buildReqWriteTools(deps())) {
    const out = await t.handler({ reqId: 'r_a1', name: 'a.md', path: 'D:/a.md', task: 'x' }, {});
    assert.ok(out.error, t.name);
  }
});

test('两个工具：非开发期拒绝，且给人话而不是内部状态码', async () => {
  for (const t of buildReqWriteTools(deps())) {
    const out = await t.handler({ reqId: 'r_t1', name: 'a.md', path: 'D:/a.md', task: 'x' }, { colleagueId: 'cl_1', msgId: 'm1' });
    assert.match(out.error, /开发期/, t.name);
  }
});

// 路径不再经 input 传入（模型只知道文件名，见 session.js 的 fileLine 注释）——
// 真实路径经 ctx.files 由服务端按文件名反查，测试也照这个契约喂 ctx。
test('register_api_doc：成功返回可读结果 + delete-apidoc 撤销锚点', async () => {
  const t = pick(buildReqWriteTools(deps()), 'register_api_doc');
  const input = { reqId: 'r_a1', name: 'order.md' };
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'order.md', path: 'D:/order.md' }] };
  const out = await t.handler(input, ctx);
  assert.equal(out.ok, true);
  const undo = t.buildUndo(input, out, ctx);
  assert.equal(undo.kind, 'delete-apidoc');
  assert.equal(undo.reqId, 'r_a1');
  assert.equal(undo.name, 'order.md');
});

test('register_api_doc：底层失败时如实返回不谎报 ok，但下游错误里的磁盘路径不能透给模型', async () => {
  const d = deps({ registerApiDoc: () => ({ ok: false, error: '文件不存在：D:/a.md' }) });
  const t = pick(buildReqWriteTools(d), 'register_api_doc');
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'a.md', path: 'D:/a.md' }] };
  const out = await t.handler({ reqId: 'r_a1', name: 'a.md' }, ctx);
  assert.ok(out.error);
  assert.notEqual(out.ok, true);
  assert.doesNotMatch(out.error, /D:\//, '下游错误里的磁盘路径不能透给模型');
  assert.doesNotMatch(out.error, /文件不存在/, '下游原始文案不该原样转发');
});

// 绝对路径不进模型上下文（P2+P3 跨期漏洞修复）：模型只报得出文件名，
// 报一个从没收到过的文件名时必须明确拒绝，不能拿 undefined 路径去登记。
test('register_api_doc：模型报了个没收到过的文件名 → 返回 error，不调 registerApiDoc', async () => {
  let called = false;
  const d = deps({
    registerApiDoc: () => {
      called = true;
      return { ok: true, doc: { name: 'ghost.md' } };
    },
  });
  const t = pick(buildReqWriteTools(d), 'register_api_doc');
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'order.md', path: 'D:/order.md' }] };
  const out = await t.handler({ reqId: 'r_a1', name: 'ghost.md' }, ctx);
  assert.match(out.error, /ghost\.md/);
  assert.equal(called, false, '路径解析不到就不该去登记');
});

// —— spec §6.2：归属判错会把改动落到别的需求的分支上。
// 解法不是让 agent 更小心，是让最知道答案的人当场看见。
test('start_dev_task：回复必须明写目标需求标题，供同事当场纠错', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_a1', task: '把分页参数改成 pageNo' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.equal(out.ok, true);
  assert.match(out.reply, /订单改版/, '必须带需求标题');
  assert.match(out.reply, /r_a1|分支|feat\/order/, '必须带需求 id 或分支名');
});

test('start_dev_task：入队 payload 带 msgId / colleagueId / prompt / title', async () => {
  let seen = null;
  const d = deps({ enqueueSystemTask: (reqId, kind, p) => { seen = { reqId, kind, p }; return { ok: true }; } });
  const t = pick(buildReqWriteTools(d), 'start_dev_task');
  await t.handler({ reqId: 'r_a1', task: '改分页' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.equal(seen.reqId, 'r_a1');
  assert.equal(seen.kind, 'colleague-dev');
  assert.equal(seen.p.msgId, 'm1');
  assert.equal(seen.p.colleagueId, 'cl_1');
  assert.ok(seen.p.prompt.includes('改分页'), 'prompt 要带上同事说的原话');
  assert.ok(seen.p.title);
});

// —— 真正的 mergeSha 要等 run 跑完才有，由 colleague-dev 的 onSettle 写台账。
// 工具这一刻只能给出「哪个需求、哪条消息起的任务」，供 onSettle 关联。
test('start_dev_task：buildUndo 给 revert-merge 骨架，mergeSha 留 null 待回填', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const input = { reqId: 'r_a1', task: 'x' };
  const ctx = { colleagueId: 'cl_1', msgId: 'm1' };
  const out = await t.handler(input, ctx);
  const undo = t.buildUndo(input, out, ctx);
  assert.equal(undo.kind, 'revert-merge');
  assert.equal(undo.reqId, 'r_a1');
  assert.equal(undo.mergeSha, null);
});

test('start_dev_task：入队失败时如实返回错误', async () => {
  const d = deps({ enqueueSystemTask: () => ({ ok: false, error: '需求忙' }) });
  const t = pick(buildReqWriteTools(d), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_a1', task: 'x' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.ok(out.error);
  assert.notEqual(out.ok, true);
});
