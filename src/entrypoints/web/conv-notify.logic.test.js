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

test('shouldNotifySettle：手动停止与额度阻塞不通知', () => {
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'stopped' }), false);
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'quota_blocked' }), false);
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

test('buildConvSettledCard：两个按钮 + value 契约', () => {
  const card = buildConvSettledCard(
    { convId: 'c1', title: '重构登录页', mode: 'acceptEdits' },
    { status: 'done', is_error: false, text: 'ok', startedAt: 0, updatedAt: 1000 },
  );
  const actions = card.elements.find((e) => e.tag === 'action').actions;
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0].value, { kind: CONV_CARD_KIND, convId: 'c1', action: 'supplement' });
  assert.deepEqual(actions[1].value, { kind: CONV_CARD_KIND, convId: 'c1', action: 'end' });
  assert.match(card.elements[0].text.content, /重构登录页/);
  assert.match(card.elements[0].text.content, /✅/);
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
