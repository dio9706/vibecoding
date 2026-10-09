/**
 * 启动对账归类纯函数单测（T2-P5）：classifyInterrupted 表驱动。
 * 判定只看 index 锚点 + journal 事实（settled），不看内存残留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInterrupted } from './run-reconcile.logic.js';

const claude = (extra = {}) => ({
  runId: 'run_1',
  convId: 'c1',
  provider: 'claude-agent',
  session_id: 'sess_1',
  resumeAttempt: 0,
  status: 'running',
  ...extra,
});
const openai = (extra = {}) => ({
  runId: 'run_o',
  convId: 'c1',
  provider: 'openai-compat',
  resumeAttempt: 0,
  status: 'running',
  ...extra,
});

test('空条目 → discard（empty_entry）', () => {
  assert.deepEqual(classifyInterrupted(null, []), { action: 'discard', reason: 'empty_entry' });
  assert.deepEqual(classifyInterrupted({ convId: 'c' }, []), { action: 'discard', reason: 'empty_entry' });
});

test('journal 已有 settled → discard（索引残留，任务其实已收尾，绝不续）', () => {
  const tail = [{ type: 'submitted' }, { type: 'started' }, { type: 'settled', data: { status: 'done' } }];
  for (const entry of [claude(), openai(), claude({ resumeAttempt: 0 })]) {
    const d = classifyInterrupted(entry, tail, { maxAttempts: 3 });
    assert.equal(d.action, 'discard');
    assert.equal(d.reason, 'settled_residue');
  }
});

test('status 非 running → discard（not_running）', () => {
  assert.deepEqual(classifyInterrupted(claude({ status: 'settled' }), []), { action: 'discard', reason: 'not_running' });
});

test('Claude：session+conv 齐全 → resume（代次 = 原代次 + 1）', () => {
  const d = classifyInterrupted(claude({ resumeAttempt: 1 }), [], { maxAttempts: 3 });
  assert.equal(d.action, 'resume');
  assert.equal(d.attempt, 2);
  assert.equal(d.reason, 'session');
});

test('openai：conv 在 → resume（检查点锚点，无 session 概念）', () => {
  const d = classifyInterrupted(openai({ resumeAttempt: 0 }), [], { maxAttempts: 3 });
  assert.equal(d.action, 'resume');
  assert.equal(d.attempt, 1);
  assert.equal(d.reason, 'checkpoint');
});

test('熔断：attempts 超限且可提示（有 convId）→ abandon，原因带上限', () => {
  for (const entry of [claude({ resumeAttempt: 3 }), openai({ resumeAttempt: 3 })]) {
    const d = classifyInterrupted(entry, [], { maxAttempts: 3 });
    assert.equal(d.action, 'abandon');
    assert.equal(d.attempt, 4);
    assert.match(d.reason, /超过上限 3/);
  }
});

test('熔断：超限但连 convId 都没有 → discard（无处提示，不留垃圾标记）', () => {
  const d = classifyInterrupted(claude({ resumeAttempt: 3, convId: null }), [], { maxAttempts: 3 });
  assert.deepEqual(d, { action: 'discard', reason: 'no_conv' });
});

test('Claude：无 session 锚点但有 convId → abandon（可向用户提示无法续跑）', () => {
  const d = classifyInterrupted(claude({ session_id: null }), [], { maxAttempts: 3 });
  assert.equal(d.action, 'abandon');
  assert.equal(d.attempt, 1);
  assert.match(d.reason, /无 session 锚点/);
});

test('Claude：连 convId 都没有 → discard（no_session）', () => {
  const d = classifyInterrupted(claude({ session_id: null, convId: null }), []);
  assert.equal(d.action, 'discard');
  assert.match(d.reason, /no_session/);
});

test('Claude：有 session 但无 convId → discard（排程回不了会话）', () => {
  const d = classifyInterrupted(claude({ convId: null }), []);
  assert.deepEqual(d, { action: 'discard', reason: 'no_conv' });
});

test('openai：无 convId → discard（检查点无从定位）', () => {
  const d = classifyInterrupted(openai({ convId: null }), []);
  assert.deepEqual(d, { action: 'discard', reason: 'no_conv' });
});

test('未知 provider → discard（不猜续跑方式；旧数据缺 provider 按 Claude 兼容）', () => {
  const unknown = classifyInterrupted({ runId: 'r', convId: 'c', session_id: 's', provider: 'future-x' }, []);
  assert.deepEqual(unknown, { action: 'discard', reason: 'unknown_provider' });
  // P2 早期的镜像条目没有 provider 字段：按 Claude 处理（锚点判定同上）
  const legacy = classifyInterrupted({ runId: 'r', convId: 'c', session_id: 's' }, []);
  assert.equal(legacy.action, 'resume');
  assert.equal(legacy.reason, 'session');
});

test('resumeAttempt 缺失/非法按 0（首轮）处理', () => {
  for (const attempt of [undefined, null, NaN, 'x']) {
    const d = classifyInterrupted(claude({ resumeAttempt: attempt }), [], { maxAttempts: 3 });
    assert.equal(d.action, 'resume');
    assert.equal(d.attempt, 1);
  }
});

test('journal 无 settled 事件（含空/非数组入参）不影响正常续跑', () => {
  assert.equal(classifyInterrupted(claude(), undefined).action, 'resume');
  assert.equal(classifyInterrupted(claude(), [{ type: 'started' }, { type: 'steer' }]).action, 'resume');
});
