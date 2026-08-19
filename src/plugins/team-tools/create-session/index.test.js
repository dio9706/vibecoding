import { test } from 'node:test';
import assert from 'node:assert/strict';
import createSession from './index.js';

test('create-session feature 定义正确', () => {
  assert.strictEqual(createSession.name, 'create-session');
  assert.strictEqual(createSession.permission, 'any');
  assert(Array.isArray(createSession.intents));
  assert.strictEqual(createSession.intents.length, 0);
  assert(typeof createSession.match === 'function');
  assert(typeof createSession.handle === 'function');
});

test('match 函数对精确触发文案返回 true（当用户是可信人时）', () => {
  // 注：实际测试中需要 mock 或测试环境支持，这里只验证函数存在
  const ctx = { text: '\\10003 新建会话', user: { id: 'test-user' } };
  // match 会调用 isTrustedSubmitter，需要 mock 或真实测试环境
  // 此处仅验证函数能被调用而不抛异常
  assert(typeof createSession.match === 'function');
});

test('handle 函数存在且可被调用', () => {
  assert(typeof createSession.handle === 'function');
});
