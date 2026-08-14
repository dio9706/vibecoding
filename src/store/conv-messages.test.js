import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, MAX_MESSAGES } from './conv-messages.js';

test('mergeMessages：拼接 prev + msgs', () => {
  const out = mergeMessages([{ role: 'user', content: 'a' }], [{ role: 'assistant', content: 'b' }]);
  assert.deepEqual(out, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
});

test('mergeMessages：超过 max 时保留最近 max 条', () => {
  const prev = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: String(i) }));
  const out = mergeMessages(prev, [{ role: 'user', content: '5' }], 3);
  assert.deepEqual(out.map((m) => m.content), ['3', '4', '5']);
});

test('mergeMessages：非数组入参兜底为空', () => {
  assert.deepEqual(mergeMessages(null, null), []);
  assert.deepEqual(mergeMessages(undefined, [{ role: 'user', content: 'x' }]).map((m) => m.content), ['x']);
});

test('mergeMessages：max=0 返回空数组（slice(-0) 全量陷阱守卫）', () => {
  const prev = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  assert.deepEqual(mergeMessages(prev, [{ role: 'user', content: 'c' }], 0), []);
});

test('mergeMessages：默认上限为 MAX_MESSAGES（正整数）', () => {
  assert.equal(typeof MAX_MESSAGES, 'number');
  assert.ok(MAX_MESSAGES > 0);
});
