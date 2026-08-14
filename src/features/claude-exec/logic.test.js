import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOwnerExec } from './logic.js';

test('shouldOwnerExec：owner 的强提交前缀让路给 feedback', () => {
  assert.equal(shouldOwnerExec('提交需求：加个导出按钮', 'owner'), false);
  assert.equal(shouldOwnerExec('提交故障：扫码页白屏', 'owner'), false);
  assert.equal(shouldOwnerExec('提个需求，现在可以开始全面埋点了', 'owner'), false);
});

test('shouldOwnerExec：owner 的其余消息仍走完整 Claude', () => {
  assert.equal(shouldOwnerExec('/new', 'owner'), true);
  assert.equal(shouldOwnerExec('帮我看下今天的错误日志', 'owner'), true);
  // question 前缀不让路：owner 问问题走完整 Claude 能力更强
  assert.equal(shouldOwnerExec('问个问题：这块逻辑在哪', 'owner'), true);
  // 前缀不在开头 → 不算强提交（matchStrongIntent 要求 index===0）
  assert.equal(shouldOwnerExec('顺手说下，提交需求：随便', 'owner'), true);
});

test('shouldOwnerExec：非 owner 一律不接（claude-exec 是 owner 专属）', () => {
  assert.equal(shouldOwnerExec('帮我看下日志', 'guest'), false);
  assert.equal(shouldOwnerExec('提交需求：加个导出', 'guest'), false);
  assert.equal(shouldOwnerExec('帮我看下日志', undefined), false);
});

test('shouldOwnerExec：空/非字符串文本对 owner 仍接（不因异常入参失声）', () => {
  assert.equal(shouldOwnerExec('', 'owner'), true);
  assert.equal(shouldOwnerExec(undefined, 'owner'), true);
});
