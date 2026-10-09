/**
 * runs.js 的 journal 事件发射单测（P2）：注入 fake sink 断言事件序列。
 * runs.js 保持纯内存——本文件不落盘；真实落盘链路见 entrypoints/web/run-durability.test.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRun,
  finishRun,
  failRun,
  blockRun,
  retryRun,
  stopRun,
  askUser,
  resolveDecision,
  setRunMode,
  runSession,
  runResult,
  holdMsg,
  withdrawHeldMsg,
  flushHeldMsgs,
  consumeHeldMsgs,
  registerRunJournalSink,
} from './runs.js';

const events = [];
registerRunJournalSink((e) => events.push(e));
const types = () => events.map((e) => e.type);
const makeAsk = (reqId) => ({
  reqId,
  kind: 'permission',
  title: `请求 ${reqId}`,
  body: '',
  options: [
    { id: 'allow', label: '允许' },
    { id: 'deny', label: '拒绝' },
  ],
  defaultChoice: 'deny',
});

test('session / result：发射且 seq 递增、convId 随 run', (t) => {
  events.length = 0;
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c1';
  runSession(run, 'sess-1');
  runResult(run, { subtype: 'success', is_error: false, inputTokens: 3, outputTokens: 4 });
  assert.deepEqual(types(), ['session', 'result']);
  assert.equal(events[0].data.session_id, 'sess-1');
  assert.equal(events[0].convId, 'c1');
  assert.equal(events[0].seq, 1);
  assert.equal(events[1].data.outputTokens, 4);
  assert.ok(events[1].seq > events[0].seq, 'seq 必须单调递增');
});

test('ask / decision：展示位与排队都记 ask；决策记 decision', async (t) => {
  events.length = 0;
  const run = createRun();
  t.after(() => finishRun(run));
  const p1 = askUser(run, makeAsk('r1'));
  const p2 = askUser(run, makeAsk('r2'));
  assert.equal(resolveDecision(run.id, 'r1', 'allow'), true);
  assert.equal(await p1, 'allow');
  assert.equal(resolveDecision(run.id, 'r2', 'deny'), true);
  assert.equal(await p2, 'deny');
  assert.deepEqual(types(), ['ask', 'ask', 'decision', 'decision']);
  assert.deepEqual(events.filter((e) => e.type === 'decision').map((e) => e.data.choice), ['allow', 'deny']);
});

test('setRunMode：中途放宽自动放行的 permission 同样记 decision（via=set_mode）', async (t) => {
  events.length = 0;
  const run = createRun();
  t.after(() => finishRun(run));
  run.startMode = 'default';
  const p1 = askUser(run, makeAsk('m1'));
  const p2 = askUser(run, makeAsk('m2'));
  assert.equal(setRunMode(run.id, 'acceptEdits'), true);
  assert.equal(await p1, 'allow');
  assert.equal(await p2, 'allow');
  const decisions = events.filter((e) => e.type === 'decision');
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((e) => e.data.via === 'set_mode' && e.data.choice === 'allow'));
});

test('steer：持有/撤回/消费各记一条；超长文本截断到 2000 字 + 省略号', (t) => {
  events.length = 0;
  const run = createRun();
  t.after(() => finishRun(run));
  const id1 = holdMsg(run, 'x'.repeat(3000));
  withdrawHeldMsg(run, id1);
  holdMsg(run, '把按钮改蓝');
  holdMsg(run, '再加筛选');
  run._input = { push: () => true };
  const flushed = flushHeldMsgs(run);
  assert.deepEqual(types(), ['steer', 'steer_withdrawn', 'steer', 'steer', 'steer_consumed']);
  const steers = events.filter((e) => e.type === 'steer');
  assert.equal(steers[0].data.text.length, 2001, '2000 字 + 省略号');
  assert.ok(steers[0].data.text.endsWith('…'));
  assert.deepEqual(events.at(-1).data.msgIds, flushed);
  assert.deepEqual(events.at(-1).data.via, 'flush');
});

test('quota 消费 / unsent：consumeHeldMsgs 记 via=quota；终结时未消费消息记 steer_unsent', (t) => {
  events.length = 0;
  const run = createRun();
  run.convId = 'c9';
  holdMsg(run, 'a');
  assert.equal(consumeHeldMsgs(run).length, 1);
  holdMsg(run, 'b');
  blockRun(run, '额度用尽');
  assert.deepEqual(types(), ['steer', 'steer_consumed', 'steer', 'steer_unsent', 'settled']);
  assert.equal(events[1].data.via, 'quota');
  const settled = events.at(-1);
  assert.equal(settled.data.status, 'done');
  assert.equal(settled.data.subtype, 'quota_blocked');
  assert.equal(settled.data.attempts, null);
});

test('settled：fail / stop / retry 各带对应状态、subtype 与续跑代次', () => {
  events.length = 0;
  const r1 = createRun();
  r1.convId = 'cA';
  failRun(r1, 'boom');
  const r2 = createRun();
  r2.convId = 'cB';
  r2.resumeAttempt = 2;
  stopRun(r2);
  const r3 = createRun();
  r3.convId = 'cC';
  retryRun(r3, 'retry', 2000);
  const settleds = events.filter((e) => e.type === 'settled');
  assert.equal(settleds.length, 3);
  assert.deepEqual(
    settleds.map((e) => [e.data.status, e.data.subtype, e.data.attempts]),
    [
      ['error', 'exception', null],
      ['done', 'stopped', 2],
      ['done', 'exception_retry', null],
    ],
  );
});
