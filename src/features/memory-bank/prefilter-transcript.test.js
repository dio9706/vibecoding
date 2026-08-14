import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals, isRealUserMessage, classifySignal } from './prefilter-transcript.js';

const userMsg = (text, i) => ({
  type: 'user',
  message: { role: 'user', content: text },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});
const asstMsg = (text, i) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});
const toolResult = (text, i) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: text, tool_use_id: 't1' }] },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});
// 工具调用：顶层 type='assistant'，content 块是 tool_use；messageText 对它返回 ''
const toolUse = (i) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }] },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});

test('工具结果伪装成 type=user —— 必须排除，否则工具输出会被当成用户偏好', () => {
  assert.equal(isRealUserMessage(toolResult('不对，应该改成 ESM', 1)), false);
  const { segments } = extractSignals([toolResult('不对，应该改成 ESM', 1)]);
  assert.deepEqual(segments, []);
});

test('classifySignal：explicit 优先级高于 correction', () => {
  assert.equal(classifySignal('以后都要用中文写注释'), 'explicit');
  assert.equal(classifySignal('不对，应该用中文'), 'correction');
  assert.equal(classifySignal('帮我看下这个函数'), null);
});

test('classifySignal：同时命中 explicit 和 correction 正则时必须判为 explicit —— 守住判定顺序这个不变量，因为用互不重叠的字符串测不出「顺序判反」这种 bug（两条正则各自命中各自的分支，谁先判都能通过），只有同时命中两个正则的字符串才能真正暴露顺序问题', () => {
  // "以后"命中 EXPLICIT_RE，"应该"命中 CORRECTION_RE，两者同时出现在一句话里
  assert.equal(classifySignal('以后应该这样做'), 'explicit');
  // "记住"命中 EXPLICIT_RE，"改成"命中 CORRECTION_RE
  assert.equal(classifySignal('记住，改成中文'), 'explicit');
  // "每次"命中 EXPLICIT_RE，"不对"命中 CORRECTION_RE
  assert.equal(classifySignal('每次都不对，一律用中文'), 'explicit');
});

test('命中信号时带上前后各 2 条上下文，且不含自身', () => {
  const events = [
    asstMsg('我加了英文注释', 1),
    userMsg('不对，注释写中文', 2),
    asstMsg('好的，改成中文', 3),
  ];
  const { segments } = extractSignals(events);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'correction');
  assert.equal(segments[0].quote, '不对，注释写中文');
  assert.equal(segments[0].sessionId, 's1');
  assert.deepEqual(segments[0].context, [
    'assistant: 我加了英文注释',
    'assistant: 好的，改成中文',
  ]);
});

test('工具事件（tool_use/tool_result）不占用上下文窗口名额 —— 按索引开窗会被工具事件的空文本挤掉被纠正的那句原话', () => {
  const events = [
    asstMsg('我加了英文注释', 1),
    toolUse(2),
    toolResult('ok', 3),
    userMsg('不对，注释写中文', 4),
  ];
  const { segments } = extractSignals(events);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].context, ['assistant: 我加了英文注释'],
    '应向左游走跳过两条空文本的工具事件，找到真正的助手原话，而不是拿到 []');
});

test('extractSignals 不得修改传入的 events 数组或其元素 —— 纯函数契约回归测试', () => {
  const events = [userMsg('不对，这里错了', 1), asstMsg('好的', 2)];
  const snapshot = JSON.parse(JSON.stringify(events));
  extractSignals(events);
  assert.deepEqual(events, snapshot, '调用后入参事件数组内容不该被修改');
});

test('超出 maxSegments 时按 kind 优先级保留，并如实报告丢弃数', () => {
  const events = [
    userMsg('不对，这里错了', 1),
    userMsg('记住，以后都用 ESM', 2),
    userMsg('别这样写', 3),
  ];
  const { segments, dropped } = extractSignals(events, { maxSegments: 1 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'explicit', 'explicit 必须优先于 correction 被保留');
  assert.equal(dropped, 2);
});

test('畸形输入不抛异常', () => {
  assert.deepEqual(extractSignals(null).segments, []);
  assert.deepEqual(extractSignals([null, {}, { type: 'user' }]).segments, []);
});
