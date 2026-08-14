import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './registry.js';

const fakeProvider = (id) => ({
  id,
  capabilities: { agentic: false },
  run: () => ({ done: Promise.resolve(), abort() {} }),
});

test('register 后 get 返回同一 provider', () => {
  const r = createRegistry();
  const p = fakeProvider('x');
  r.register(p);
  assert.equal(r.get('x'), p);
});

test('get 未知 id 抛错', () => {
  const r = createRegistry();
  assert.throws(() => r.get('nope'), /未知 provider/);
});

test('has 反映注册状态', () => {
  const r = createRegistry();
  assert.equal(r.has('x'), false);
  r.register(fakeProvider('x'));
  assert.equal(r.has('x'), true);
});

test('list 返回 id + capabilities', () => {
  const r = createRegistry();
  r.register(fakeProvider('x'));
  assert.deepEqual(r.list(), [{ id: 'x', capabilities: { agentic: false } }]);
});

test('register 校验 provider 形状', () => {
  const r = createRegistry();
  assert.throws(() => r.register({ id: 'x' }), /run 函数/);
  assert.throws(() => r.register({ run() {} }), /string id/);
});
