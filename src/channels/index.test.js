import { test } from 'node:test';
import assert from 'node:assert/strict';
import { has, get, list } from './index.js';

test('默认注册表含内置 feishu，契约形状完整', () => {
  assert.equal(has('feishu'), true);
  const c = get('feishu');
  assert.equal(c.id, 'feishu');
  assert.equal(typeof c.start, 'function');
  assert.equal(typeof c.stop, 'function');
  assert.equal(typeof c.send, 'function');
  assert.equal(typeof c.addReaction, 'function');
  assert.equal(typeof c.removeReaction, 'function');
});

test('feishu 能力位：text/richText/image/reaction 全开', () => {
  const caps = get('feishu').capabilities;
  for (const k of ['text', 'richText', 'image', 'reaction']) assert.equal(caps[k], true, k);
});

test('list 输出 id + capabilities', () => {
  assert.ok(list().some((e) => e.id === 'feishu' && e.capabilities.text === true));
});
