import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONV_CARD_KIND,
  shouldNotifySettle,
  summarize,
  formatDuration,
  buildConvSettledCard,
} from './conv-notify.logic.js';

test('shouldNotifySettle：正常完成与异常失败要通知', () => {
  assert.equal(shouldNotifySettle({ status: 'done', subtype: null }), true);
  assert.equal(shouldNotifySettle({ status: 'error', subtype: 'exception', is_error: true }), true);
});

test('shouldNotifySettle：手动停止、额度阻塞、异常待重试都不通知', () => {
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'stopped' }), false);
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'quota_blocked' }), false);
  // 异常重试中：任务逻辑上没结束。不过滤会推一张「❌ 失败」紧接一张「✅ 完成」，属噪音误报
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'exception_retry', is_error: true }), false);
});

test('shouldNotifySettle：还在跑的 run 不通知（纵深防御）', () => {
  assert.equal(shouldNotifySettle({ status: 'running' }), false);
});

test('summarize 截断并加省略号，短文本原样', () => {
  assert.equal(summarize('abc', 10), 'abc');
  assert.equal(summarize('a'.repeat(20), 10), '…' + 'a'.repeat(10));
  assert.equal(summarize('', 10), '(无输出)');
  assert.equal(summarize(null, 10), '(无输出)');
});

test('formatDuration：秒/分', () => {
  assert.equal(formatDuration(1500), '1s');
  assert.equal(formatDuration(95_000), '1m 35s');
});

test('buildConvSettledCard：卡片结构含会话ID提示', () => {
  const card = buildConvSettledCard(
    { convId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: '重构登录页', mode: 'acceptEdits' },
    { status: 'done', is_error: false, text: 'ok', startedAt: 0, updatedAt: 1000 },
  );
  assert.equal(card.elements.length, 1);
  assert.equal(card.elements[0].tag, 'div');
  const content = card.elements[0].text.content;
  assert.match(content, /重构登录页/);
  assert.match(content, /✅/);
  assert.match(content, /会话ID：`a1b2c3d4`/);
  assert.match(content, /会话 a1b2c3d4 你的内容/);
});

test('buildConvSettledCard：失败标 ❌；询问模式加审批提示', () => {
  const card = buildConvSettledCard(
    { convId: 'c1', title: 'T', mode: 'default' },
    { status: 'error', is_error: true, text: 'boom', startedAt: 0, updatedAt: 1000 },
  );
  const content = card.elements[0].text.content;
  assert.match(content, /❌/);
  assert.match(content, /询问模式/);
});
