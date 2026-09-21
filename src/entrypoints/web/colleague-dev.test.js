import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleague-dev-'));
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;

const { replyColleague, buildColleagueDevOnSettle, dispatchColleagueDev, abandonColleagueDev, COLLEAGUE_DEV_KIND } = await import('./colleague-dev.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { addColleague } = await import('../../store/colleagues.js');
const { appendMessage, getThread } = await import('../../store/colleague-messages.js');
const { getRun, finishRun } = await import('../../store/runs.js');

function setupReq() {
  const c = addColleague({ name: '后端小王', role: 'backend', feishuOpenId: 'ou_wang' });
  const r = createRequirement({ title: '订单导出' });
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main' });
  return { c, r: getRequirement(r.id) };
}

test('COLLEAGUE_DEV_KIND 常量', () => {
  assert.equal(COLLEAGUE_DEV_KIND, 'colleague-dev');
});

test('replyColleague：无机器人凭证时返回 false，且不落 out 消息（落了界面会显示一条其实没送达的）', async () => {
  const { c, r } = setupReq();
  const ok = await replyColleague(r.id, c.id, '测试回复');
  assert.equal(ok, false);
  assert.equal(getThread(r.id, c.id).messages.length, 0);
});

test('replyColleague：同事无 open_id 时返回 false', async () => {
  const c = addColleague({ name: '无号', role: 'backend' });
  const r = createRequirement({ title: 'x' });
  assert.equal(await replyColleague(r.id, c.id, 'hi'), false);
});

test('onSettle 成功：清 busy、回填子会话 sessionId、消息标 handledBy:ai、history 留痕', async () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: '接口文档', role: 'backend' });
  const convId = 'c1700000000000abc';
  updateRequirement(r.id, {
    sessions: [{ convId, sessionId: null, title: '接入接口文档：a.md', kind: 'sub', phase: 'dev', createdAt: 'x' }],
    busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_1', startedAt: 1, convId },
  });
  const onSettle = buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: '接入接口文档：a.md' }, convId);
  onSettle(true, { id: 'run_1', session_id: 'sess_9', result: '改了两个文件' });
  await new Promise((res) => setImmediate(res)); // 让 fire-and-forget 的回复 promise 在用例内结束，避免跨用例噪声

  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.sessions[0].sessionId, 'sess_9');
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 完成：接入接口文档：a.md`);
  const m = getThread(r.id, c.id).messages.find((x) => x.id === msg.id);
  assert.equal(m.handledBy, 'ai');
  assert.equal(m.handledNote, '已处理 · 接入接口文档：a.md');
});

test('onSettle 失败：handledNote 记失败，history 记失败', () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_2', startedAt: 1, convId: 'c_x' } });
  buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_x')(false, { id: 'run_2' });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 失败：T`);
  assert.equal(getThread(r.id, c.id).messages[0].handledNote, '处理失败 · T');
});

test('onSettle 归属校验：busy.runId 不是本 run 时不清 busy（防击穿串行闸），其余照做', () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: 'bug-fix', runId: 'run_other', startedAt: 1 } });
  buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_y')(true, { id: 'run_mine', session_id: 's' });
  assert.equal(getRequirement(r.id).busy.runId, 'run_other', 'healStaleBusy 可能已清过并派了下一个，那份 busy 不归本回调管');
  assert.equal(getThread(r.id, c.id).messages[0].handledBy, 'ai');
});

test('onSettle：需求已被删时静默返回', () => {
  assert.doesNotThrow(() => buildColleagueDevOnSettle('r_gone', { msgId: 'm', colleagueId: 'c', title: 'T' }, 'c_z')(true, { id: 'r' }));
});

test('abandonColleagueDev：留痕 + markHandled + 回同事（无凭证时回复返 false 不抛）', async () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: 'x', role: 'backend' });
  abandonColleagueDev(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, '需求已离开开发期');
  await new Promise((res) => setImmediate(res));
  assert.equal(getRequirement(r.id).history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 作废：需求已离开开发期`);
  const m = getThread(r.id, c.id).messages[0];
  assert.equal(m.handledBy, 'ai');
  assert.equal(m.handledNote, '作废（需求已离开开发期） · T');
});

test('dispatchColleagueDev 主路径：建子会话、busy 带 convId、以 bypassPermissions 起新上下文 run', (t) => {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_x' });
  const r = createRequirement({ title: '主路径' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cwd-'));
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main', projects: { frontend: { dir, dev: true }, backend: null } });
  let seen = null;
  dispatchColleagueDev(getRequirement(r.id), { msgId: 'm1', colleagueId: c.id, prompt: 'P', title: 'T' }, { start: (run, opts) => { seen = { run, opts }; } });
  // 注入的 start 是空操作，不会像真实 startClaudeRun 那样走到终结口——run 会一直挂在 running，
  // 看门狗 setInterval 未 unref，不清掉会让 node --test 进程挂起（对齐 routes-run.test.js 的 t.after 用法）
  t.after(() => finishRun(seen.run));
  const after = getRequirement(r.id);
  const sub = after.sessions.at(-1);
  assert.equal(sub.kind, 'sub');
  assert.equal(sub.phase, 'dev');
  assert.equal(sub.title, 'T');
  assert.equal(after.busy.kind, COLLEAGUE_DEV_KIND);
  assert.equal(after.busy.convId, sub.convId, 'busy.convId 指向新建的子会话，前端接流与 healStaleBusy 都靠它');
  assert.equal(after.busy.runId, seen.run.id);
  assert.equal(seen.opts.mode, 'bypassPermissions');
  assert.equal(seen.opts.convId, sub.convId);
  assert.equal(seen.opts.cwd, dir);
  assert.equal(seen.opts.session, undefined, '新上下文，不 resume devSession');
  assert.equal(typeof seen.run.onSettle, 'function');
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 启动：T`);
});

test('dispatchColleagueDev 起跑抛错：清 busy、撤掉子会话条目、run 置错、onSettle 摘掉', async () => {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_y' });
  const r = createRequirement({ title: '起跑失败' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cwd2-'));
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main', projects: { frontend: { dir, dev: true }, backend: null } });
  let runRef = null;
  dispatchColleagueDev(getRequirement(r.id), { msgId: 'm2', colleagueId: c.id, prompt: 'P', title: 'T2' }, { start: (run) => { runRef = run; throw new Error('settings 损坏'); } });
  await new Promise((res) => setImmediate(res)); // 让 fire-and-forget 的回复 promise 在用例内结束
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.sessions.some((s) => s.title === 'T2'), false, '失败的子会话不该留空壳');
  assert.match(after.history.at(-1).event, /起跑失败：settings 损坏/);
  assert.equal(runRef.onSettle, null);
  assert.equal(getRun(runRef.id)?.status, 'error');
});
