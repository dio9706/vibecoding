/**
 * ultracode 开关纯逻辑。
 * decorateUltracode 决定 prompt 要不要带关键字 —— 拼错位置（气泡/记忆库）或拼给别家模型都是事故，
 * 所以把「拼不拼」从 chat.js 的 send() 里抽出来单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decorateUltracode, canEnableUltracode } from './ultracode.logic.js';

test('开着 + Claude provider → 前缀 "ultracode "', () => {
  assert.equal(decorateUltracode('重构支付模块', { on: true, provider: 'claude-agent' }), 'ultracode 重构支付模块');
});

test('关着 → 原样返回', () => {
  assert.equal(decorateUltracode('重构支付模块', { on: false, provider: 'claude-agent' }), '重构支付模块');
});

test('openai-compat → 原样返回（别家模型没有 Workflow 工具）', () => {
  assert.equal(decorateUltracode('重构支付模块', { on: true, provider: 'openai-compat' }), '重构支付模块');
});

test('canEnableUltracode：Workflow 被禁用时为 false', () => {
  assert.equal(canEnableUltracode(['Bash', 'Workflow']), false);
});

test('canEnableUltracode：未禁用 / 空数组 / 非数组 → true', () => {
  assert.equal(canEnableUltracode(['Bash']), true);
  assert.equal(canEnableUltracode([]), true);
  assert.equal(canEnableUltracode(undefined), true);
});

test('用户已手打关键字 → 允许双前缀，不做去重（关键字仍在位置 0，触发不受影响；去重是 YAGNI）', () => {
  assert.equal(decorateUltracode('ultracode 重构', { on: true, provider: 'claude-agent' }), 'ultracode ultracode 重构');
});
