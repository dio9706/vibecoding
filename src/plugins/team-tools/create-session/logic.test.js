import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATE_SESSION_TRIGGERS } from './logic.js';

test('CREATE_SESSION_TRIGGERS 包含期望的触发文案', () => {
  assert(Array.isArray(CREATE_SESSION_TRIGGERS));
  assert(CREATE_SESSION_TRIGGERS.includes('\\10003 新建会话'));
});

test('触发文案严格匹配', () => {
  const trigger = '\\10003 新建会话';
  assert(CREATE_SESSION_TRIGGERS.includes(trigger));
  assert(!CREATE_SESSION_TRIGGERS.includes('\\10003 新建会话 '));
  assert(!CREATE_SESSION_TRIGGERS.includes(' \\10003 新建会话'));
  assert(!CREATE_SESSION_TRIGGERS.includes('10003 新建会话'));
});
