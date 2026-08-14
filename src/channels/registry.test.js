import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './registry.js';

const mk = (id) => ({ id, capabilities: { text: true }, start() {}, send() {} });

test('register/get/has/list 基本流', () => {
  const r = createRegistry();
  r.register(mk('feishu'));
  assert.equal(r.has('feishu'), true);
  assert.equal(r.get('feishu').id, 'feishu');
  assert.deepEqual(r.list(), [{ id: 'feishu', capabilities: { text: true } }]);
});

test('register 校验：缺 id / start / send 均抛错', () => {
  const r = createRegistry();
  assert.throws(() => r.register({}), /string id/);
  assert.throws(() => r.register({ id: 'x', send() {} }), /start 函数/);
  assert.throws(() => r.register({ id: 'x', start() {} }), /send 函数/);
});

test('get 未知渠道即抛；同 id 覆盖注册', () => {
  const r = createRegistry();
  assert.throws(() => r.get('qq'), /未知 channel/);
  r.register(mk('a'));
  const b = { ...mk('a'), capabilities: { text: true, image: true } };
  r.register(b);
  assert.equal(r.get('a'), b);
});
