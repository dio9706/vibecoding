import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleague-auto-'));

const { autoHandleMessages } = await import('./colleague-auto.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { addColleague } = await import('../../store/colleagues.js');
const { appendMessage } = await import('../../store/colleague-messages.js');
const { enqueueSystemTask, queuedTasks } = await import('./requirement-ops.js');

function setup() {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_b' });
  const r = createRequirement({ title: '订单导出' });
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id] });
  return { c, r: getRequirement(r.id) };
}

/** 替身依赖：记录调用，不碰 LLM / 飞书 */
function fakeDeps({ classifyResult = null, sample = { path: '/tmp/x.md', sample: 'GET /x' } } = {}) {
  const calls = { classify: [], register: [], enqueue: [], reply: [] };
  return {
    calls,
    deps: {
      classify: async (prompt, tag) => (calls.classify.push({ prompt, tag }), classifyResult),
      readSample: async () => sample,
      register: (req, doc) => (calls.register.push(doc), { ok: true, action: '新增', doc: { id: 'ad_1', name: doc.name, path: doc.path } }),
      enqueue: (reqId, kind, payload) => calls.enqueue.push({ reqId, kind, payload }),
      reply: async (reqId, cid, text) => (calls.reply.push(text), true),
    },
  };
}

test('文件：扩展名不在白名单 → skip:ext，不调分类', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'a.pdf', path: '/tmp/a.pdf', kind: 'file' }] });
  const { deps, calls } = fakeDeps();
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:ext']);
  assert.equal(calls.classify.length, 0);
});

test('文件：判定为接口文档 → 登记、入队 colleague-dev、回「已收到，开始接入」', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'order-api.md', path: '/tmp/o.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: true } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['queued:apidoc']);
  assert.equal(calls.classify[0].tag, 'colleague-auto/apidoc');
  assert.deepEqual(calls.register[0], { name: 'order-api.md', path: '/tmp/x.md' }, 'path 用 readSample 返回的（docx 已转 md）');
  assert.equal(calls.enqueue[0].kind, 'colleague-dev');
  assert.equal(calls.enqueue[0].payload.msgId, m.id);
  assert.equal(calls.enqueue[0].payload.colleagueId, c.id);
  assert.equal(calls.enqueue[0].payload.title, '接入接口文档：order-api.md');
  assert.match(calls.enqueue[0].payload.prompt, /order-api\.md/);
  assert.match(calls.reply[0], /接口文档「order-api\.md」已收到，开始接入开发/);
});

test('文件：判定不是接口文档 → skip:not-apidoc，不登记不入队不回复', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'notes.md', path: '/tmp/n.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: false } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:not-apidoc']);
  assert.equal(calls.enqueue.length + calls.reply.length + calls.register.length, 0);
});

test('文件：读不到样本 → skip:unreadable', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'a.md', path: '', kind: 'file' }] });
  const { deps } = fakeDeps({ sample: null });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:unreadable']);
});

test('文件：登记失败 → skip:register-failed，不入队不回复', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'a.md', path: '/tmp/a.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: true } });
  deps.register = () => ({ ok: false, status: 400, error: '文件不存在' });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:register-failed']);
  assert.equal(calls.enqueue.length + calls.reply.length, 0);
});

test('文字：需要处理 → 入队（prompt 为固定模板：含原话与提炼）、回「正在接入处理：summary」', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '列表接口加了 status 字段', role: 'backend' });
  const { deps, calls } = fakeDeps({ classifyResult: { needsAction: true, summary: '加 status', prompt: '表格加一列 status' } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['queued:text']);
  assert.equal(calls.classify[0].tag, 'colleague-auto/text');
  assert.match(calls.classify[0].prompt, /订单导出/);
  // 子会话 prompt 是固定模板：原话与提炼都要在，Claude 才能对照查证
  assert.match(calls.enqueue[0].payload.prompt, /列表接口加了 status 字段/);
  assert.match(calls.enqueue[0].payload.prompt, /表格加一列 status/);
  assert.match(calls.enqueue[0].payload.prompt, /以原话为准/);
  assert.equal(calls.enqueue[0].payload.title, '后端沟通：加 status');
  assert.equal(calls.reply[0], '已收到，正在接入处理：加 status');
});

test('文字：不需要处理 / 分类返回 null / 空文本 → skip，零副作用', async () => {
  const { c, r } = setup();
  const m1 = appendMessage(r.id, c.id, { dir: 'in', text: '收到，我看看', role: 'backend' });
  const m2 = appendMessage(r.id, c.id, { dir: 'in', text: '   ', role: 'backend' });
  const { deps, calls } = fakeDeps({ classifyResult: { needsAction: false } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m1.id, m2.id], deps), ['skip:no-action', 'skip:empty']);
  assert.equal(calls.enqueue.length + calls.reply.length, 0);
  deps.classify = async () => null; // 超时 / 额度耗尽 / 解析失败
  assert.deepEqual(await autoHandleMessages(r, c.id, [m1.id], deps), ['skip:no-action']);
});

test('过滤：只处理属于该线程、dir=in、未 handled 的 id；单条异常不拖累其它', async () => {
  const { c, r } = setup();
  const m1 = appendMessage(r.id, c.id, { dir: 'in', text: 'a', role: 'backend' });
  const m2 = appendMessage(r.id, c.id, { dir: 'out', text: 'b', role: 'backend' });
  const m3 = appendMessage(r.id, c.id, { dir: 'in', text: 'c', role: 'backend', handledBy: 'manual' });
  const m4 = appendMessage(r.id, c.id, { dir: 'in', text: 'd', role: 'backend' });
  const { deps } = fakeDeps({ classifyResult: { needsAction: false } });
  let n = 0;
  deps.classify = async () => { if (++n === 1) throw new Error('boom'); return { needsAction: false }; };
  const out = await autoHandleMessages(r, c.id, [m1.id, m2.id, m3.id, m4.id, 'cm_ghost'], deps);
  assert.deepEqual(out, ['error', 'skip:no-action'], 'm2(out)/m3(已 handled)/ghost 被过滤；m1 异常记 error 不影响 m4');
});

test('两条都「需要处理」的消息各成一个任务，不被 enqueueSystemTask 的同类合并顶掉（真实入队）', async () => {
  const { c, r } = setup();
  const m1 = appendMessage(r.id, c.id, { dir: 'in', text: 'A 接口加字段', role: 'backend' });
  const m2 = appendMessage(r.id, c.id, { dir: 'in', text: 'B 接口改名', role: 'backend' });
  const { deps } = fakeDeps({ classifyResult: { needsAction: true, summary: 's', prompt: 'p' } });
  deps.enqueue = enqueueSystemTask; // 只有这一处用真的：合并语义是本模块最关键的集成面
  await autoHandleMessages(r, c.id, [m1.id, m2.id], deps);
  const q = queuedTasks(r.id).filter((t) => t.kind === 'colleague-dev');
  assert.deepEqual(q.map((t) => t.payload.msgId), [m1.id, m2.id], '第一条不能被第二条顶掉，否则同事收到「正在接入 A」却永远等不到');
});

test('同时带文字与附件的消息只走文件路径（飞书文件报文正文恒空；将来接富文本时这条会喊）', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '加了字段', role: 'backend', files: [{ name: 'a.md', path: '/tmp/a.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: false } });
  await autoHandleMessages(r, c.id, [m.id], deps);
  assert.deepEqual(calls.classify.map((x) => x.tag), ['colleague-auto/apidoc']);
});
