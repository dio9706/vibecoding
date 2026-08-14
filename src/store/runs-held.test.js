/**
 * heldMsgs（插话持有缓冲）单测。
 * 语义：插话消息先存服务端 run.heldMsgs（可撤回）；flush 时按序推进 SDK 输入流。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdMsg, withdrawHeldMsg, flushHeldMsgs, consumeHeldMsgs } from './runs.js';

// 最小 run 假件：绕过 createRun（其看门狗 setInterval 会挂住测试进程）
function fakeRun(input) {
  return {
    id: 'run_test',
    status: 'running',
    heldMsgs: [],
    _input: input || null,
    subscribers: new Set(),
    updatedAt: 0,
    lastProgressAt: 0,
  };
}

test('holdMsg 追加并返回 msgId；withdrawHeldMsg 移除，重复撤回返回 false', () => {
  const run = fakeRun();
  const id1 = holdMsg(run, '第一条');
  const id2 = holdMsg(run, '第二条');
  assert.equal(run.heldMsgs.length, 2);
  assert.ok(id1 && id2 && id1 !== id2);
  assert.equal(withdrawHeldMsg(run, id1), true);
  assert.deepEqual(run.heldMsgs.map((m) => m.text), ['第二条']);
  assert.equal(withdrawHeldMsg(run, id1), false); // 已移除 → 撤回失败
});

test('flushHeldMsgs 按序推进 _input 并清空持有区，返回已消费 id', () => {
  const pushed = [];
  const run = fakeRun({ push: (t) => (pushed.push(t), true) });
  const id1 = holdMsg(run, 'a');
  const id2 = holdMsg(run, 'b');
  const ids = flushHeldMsgs(run);
  assert.deepEqual(pushed, ['a', 'b']);
  assert.deepEqual(ids, [id1, id2]);
  assert.equal(run.heldMsgs.length, 0);
});

test('flushHeldMsgs 无 _input 时不消费（判档窗口内消息继续持有）', () => {
  const run = fakeRun(null);
  holdMsg(run, 'a');
  assert.deepEqual(flushHeldMsgs(run), []);
  assert.equal(run.heldMsgs.length, 1);
});

test('flushHeldMsgs push 失败的消息保留在持有区（输入流已关的窄窗口）', () => {
  const run = fakeRun({ push: () => false });
  holdMsg(run, 'a');
  assert.deepEqual(flushHeldMsgs(run), []);
  assert.equal(run.heldMsgs.length, 1);
});

test('consumeHeldMsgs 取空持有区并返回消息（额度用尽续跑打包用）', () => {
  const run = fakeRun();
  holdMsg(run, 'x');
  holdMsg(run, 'y');
  const msgs = consumeHeldMsgs(run);
  assert.deepEqual(msgs.map((m) => m.text), ['x', 'y']);
  assert.equal(run.heldMsgs.length, 0);
  assert.deepEqual(consumeHeldMsgs(run), []);
});

test('stopRun 终结：done 事件附带 unsent（未消费持有消息）并清空持有区', async () => {
  const { stopRun, holdMsg: hold } = await import('./runs.js');
  const events = [];
  const res = { write: (s) => (events.push(s), true), end: () => {} };
  const run = {
    id: 'run_test2',
    status: 'running',
    text: '',
    heldMsgs: [],
    _input: null,
    pending: null,
    pendingQueue: [],
    waiting: false,
    waitingSince: 0,
    waitedMs: 0,
    abortController: new AbortController(),
    subscribers: new Set([res]),
    updatedAt: 0,
    lastProgressAt: 0,
    _watchdog: null,
  };
  const id = hold(run, '未发出的插话');
  stopRun(run, '已手动停止');
  const doneIdx = events.findIndex((s) => s.includes('event: done'));
  const payload = JSON.parse(events[doneIdx + 1].replace(/^data: /, ''));
  assert.deepEqual(payload.unsent, [id]);
  assert.equal(run.heldMsgs.length, 0);
});
