/**
 * run-openai 纯函数层单测（P3 检查点）：悬空工具调用修复。
 * 消息形状与 `providers/agent-loop.js#toToolResultMessage` / ai@7 `responseMessages` 保持一致。
 * （孤儿对账归类已随 P5 迁至 run-reconcile.logic.test.js。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairDanglingToolCalls, resolveMaxSteps } from './run-openai.logic.js';

const user = (text) => ({ role: 'user', content: text });
const asst = (parts) => ({ role: 'assistant', content: parts });
const call = (id, name = 'readFile') => ({ type: 'tool-call', toolCallId: id, toolName: name, input: {} });
const result = (id, name = 'readFile') => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'text', value: 'ok' } }],
});

// ---- repairDanglingToolCalls ----

test('resolveMaxSteps：正整数生效取整；0/空/非法 = Infinity（无上限，同 Claude Code / OpenCode 默认）', () => {
  assert.equal(resolveMaxSteps(5), 5);
  assert.equal(resolveMaxSteps('50'), 50);
  assert.equal(resolveMaxSteps(2.9), 2);
  assert.equal(resolveMaxSteps(0), Infinity);
  assert.equal(resolveMaxSteps('0'), Infinity);
  assert.equal(resolveMaxSteps(''), Infinity);
  assert.equal(resolveMaxSteps(null), Infinity);
  assert.equal(resolveMaxSteps(undefined), Infinity);
  assert.equal(resolveMaxSteps('abc'), Infinity);
  assert.equal(resolveMaxSteps(-3), Infinity);
  assert.equal(resolveMaxSteps(Infinity), Infinity, '显式 Infinity 仍是 Infinity（不因 >0 判定被截）');
});

test('修复：合法序列原样返回（同一引用，零开销）', () => {
  const msgs = [user('hi'), asst([call('t1')]), result('t1'), asst([{ type: 'text', text: 'done' }])];
  const r = repairDanglingToolCalls(msgs);
  assert.deepEqual(r.added, []);
  assert.equal(r.messages, msgs);
});

test('修复：尾部悬空 tool-call → 补合成「未执行」结果（落盘用）', () => {
  const msgs = [user('read a'), asst([call('t1')])];
  const r = repairDanglingToolCalls(msgs, { note: '进程中断，该工具未执行' });
  assert.equal(r.added.length, 1);
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.messages[2], {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'readFile', output: { type: 'text', value: '进程中断，该工具未执行' } },
    ],
  });
  assert.equal(r.added[0], r.messages[2], 'added 必须就是插进去的那条（供调用方落盘）');
  assert.equal(msgs.length, 2, '不得改动原数组');
});

test('修复：一条 assistant 多个调用只回了一个 → 只补缺的那个', () => {
  const msgs = [asst([call('t1'), call('t2', 'writeFile')]), result('t1')];
  const r = repairDanglingToolCalls(msgs);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].content[0].toolCallId, 't2');
});

test('修复：悬空调用后紧跟新 assistant（历史脏数据）→ 合成结果插在其前，消息序保持合法', () => {
  const second = asst([{ type: 'text', text: '我继续' }]);
  const msgs = [asst([call('t1')]), second];
  const r = repairDanglingToolCalls(msgs);
  assert.equal(r.added.length, 1);
  assert.equal(r.messages[1].role, 'tool');
  assert.equal(r.messages[1].content[0].toolCallId, 't1');
  assert.equal(r.messages[2], second, '原消息对象保持原序');
});

test('修复：悬空调用后紧跟 user 消息 → 合成结果插在其前（通知后紧接着用户输入是非法序列）', () => {
  const userMsg = user('新指令');
  const msgs = [asst([call('t1')]), userMsg];
  const r = repairDanglingToolCalls(msgs);
  assert.equal(r.added.length, 1);
  assert.equal(r.messages[1].role, 'tool');
  assert.equal(r.messages[2], userMsg);
});

test('修复：无效调用已由 AI SDK 自带 error 结果 → 不重复补', () => {
  const auto = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'readFile', output: { type: 'error-text', value: 'invalid input' } }],
  };
  const r = repairDanglingToolCalls([asst([call('t1')]), auto]);
  assert.deepEqual(r.added, []);
});

test('修复：空数组 / 非数组入参不抛，原样返回', () => {
  assert.deepEqual(repairDanglingToolCalls([]).added, []);
  assert.deepEqual(repairDanglingToolCalls(null).added, []);
  assert.deepEqual(repairDanglingToolCalls(undefined).added, []);
});
