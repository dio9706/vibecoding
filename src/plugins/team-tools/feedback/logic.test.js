import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReviewableTask,
  findReviewableTask,
  buildVerdictCard,
  verdictResultCard,
  parseVerdictCardAction,
  canOperateVerdict,
  resolveTrustedOpenIds,
} from './logic.js';

const NOW = new Date('2026-07-31T10:00:00.000Z').getTime();
const mk = (o) => ({
  id: o.id,
  type: o.type || 'feature',
  title: o.title || o.id,
  status: o.status,
  review: o.review,
  source: { openId: 'ou_me', chatId: 'oc_1', ...(o.source || {}) },
  updatedAt: o.updatedAt || new Date(NOW - 60_000).toISOString(),
});

test('isReviewableTask：challenged 可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'challenged' })), true);
});

test('isReviewableTask：rejected + 评审 reject 可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected', review: { verdict: 'reject' } })), true);
});

test('isReviewableTask：rejected + 评审 ask（「算了」后反悔）可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected', review: { verdict: 'ask' } })), true);
});

test('isReviewableTask：无评审否定判决的 rejected（owner triage 手动放弃）不可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected' })), false);
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected', review: { verdict: 'plan' } })), false);
});

test('isReviewableTask：其他状态与空值不可挽回', () => {
  for (const status of ['new', 'reviewing', 'analyzing', 'analyzed', 'queued', 'developing', 'done']) {
    assert.equal(isReviewableTask(mk({ id: 'a', status })), false, status);
  }
  assert.equal(isReviewableTask(null), false);
});

test('findReviewableTask：命中同人同会话窗口内任务', () => {
  const t = mk({ id: 'a', status: 'challenged' });
  assert.equal(findReviewableTask([t], { openId: 'ou_me', chatId: 'oc_1', now: NOW }), t);
});

test('findReviewableTask：超窗（>30 分钟）不命中', () => {
  const stale = mk({ id: 'a', status: 'challenged', updatedAt: new Date(NOW - 31 * 60_000).toISOString() });
  assert.equal(findReviewableTask([stale], { openId: 'ou_me', chatId: 'oc_1', now: NOW }), null);
});

test('findReviewableTask：跨用户 / 跨会话不命中', () => {
  const t = mk({ id: 'a', status: 'challenged' });
  assert.equal(findReviewableTask([t], { openId: 'ou_you', chatId: 'oc_1', now: NOW }), null);
  assert.equal(findReviewableTask([t], { openId: 'ou_me', chatId: 'oc_2', now: NOW }), null);
});

test('findReviewableTask：空列表 / undefined 容错', () => {
  assert.equal(findReviewableTask([], { openId: 'ou_me', chatId: 'oc_1', now: NOW }), null);
  assert.equal(findReviewableTask(undefined, { openId: 'ou_me', chatId: 'oc_1', now: NOW }), null);
});

test('buildVerdictCard：按钮 value 携带 kind/taskId/action', () => {
  const card = buildVerdictCard(mk({ id: 't1', status: 'rejected' }), 'reject', '与现有功能重复');
  const actions = card.elements.find((e) => e.tag === 'action').actions;
  assert.deepEqual(
    actions.map((a) => a.value),
    [
      { kind: 'review-verdict', taskId: 't1', action: 'insist' },
      { kind: 'review-verdict', taskId: 't1', action: 'giveup' },
    ],
  );
});

test('buildVerdictCard：reject 与 ask 文案不同，理由入正文', () => {
  const rj = buildVerdictCard(mk({ id: 't1', status: 'rejected', type: 'bug' }), 'reject', '无法复现');
  assert.match(rj.elements[0].text.content, /未通过评审/);
  assert.match(rj.elements[0].text.content, /无法复现/);
  const ask = buildVerdictCard(mk({ id: 't1', status: 'challenged' }), 'ask', '范围太大');
  assert.match(ask.elements[0].text.content, /建议暂缓/);
});

test('buildVerdictCard：群聊加 <at id>，p2p 不加，非法 openId 不拼', () => {
  const grp = buildVerdictCard(mk({ id: 't1', status: 'rejected', source: { chatType: 'group' } }), 'reject', 'r');
  assert.match(grp.elements[0].text.content, /^<at id=ou_me><\/at> /);
  const p2p = buildVerdictCard(mk({ id: 't1', status: 'rejected', source: { chatType: 'p2p' } }), 'reject', 'r');
  assert.doesNotMatch(p2p.elements[0].text.content, /<at/);
  const bad = buildVerdictCard(
    mk({ id: 't1', status: 'rejected', source: { chatType: 'group', openId: 'x"><script' } }),
    'reject',
    'r',
  );
  assert.doesNotMatch(bad.elements[0].text.content, /<at/);
});

test('verdictResultCard：无按钮纯文本终态', () => {
  const card = verdictResultCard('✋ 已坚持修改');
  assert.equal(card.elements.length, 1);
  assert.equal(card.elements[0].text.content, '✋ 已坚持修改');
});

test('parseVerdictCardAction：对象 value 常态解析（v2 schema）', () => {
  const parsed = parseVerdictCardAction({
    operator: { open_id: 'ou_op' },
    context: { open_message_id: 'om_1' },
    action: { value: { kind: 'review-verdict', taskId: 't1', action: 'insist' } },
  });
  assert.deepEqual(parsed, { taskId: 't1', action: 'insist', operatorOpenId: 'ou_op', messageId: 'om_1' });
});

test('parseVerdictCardAction：JSON 字符串 value + 顶层 message_id 兼容', () => {
  const parsed = parseVerdictCardAction({
    message_id: 'om_2',
    action: { value: JSON.stringify({ kind: 'review-verdict', taskId: 't1', action: 'giveup' }) },
  });
  assert.equal(parsed.action, 'giveup');
  assert.equal(parsed.messageId, 'om_2');
});

test('parseVerdictCardAction：非本 kind / 缺 taskId / 非法 action / 空报文 → null', () => {
  assert.equal(parseVerdictCardAction({ action: { value: { kind: 'other', taskId: 't1', action: 'insist' } } }), null);
  assert.equal(parseVerdictCardAction({ action: { value: { kind: 'review-verdict', action: 'insist' } } }), null);
  assert.equal(parseVerdictCardAction({ action: { value: { kind: 'review-verdict', taskId: 't1', action: 'x' } } }), null);
  assert.equal(parseVerdictCardAction({ action: { value: 'not-json{' } }), null);
  assert.equal(parseVerdictCardAction({}), null);
});

test('isReviewableTask：owner 手动毙掉（rejectedBy=owner）不可挽回，即使评审判决残留', () => {
  assert.equal(
    isReviewableTask({ ...mk({ id: 'a', status: 'rejected', review: { verdict: 'ask' } }), rejectedBy: 'owner' }),
    false,
  );
  assert.equal(
    isReviewableTask({ ...mk({ id: 'a', status: 'rejected', review: { verdict: 'reject' } }), rejectedBy: 'owner' }),
    false,
  );
});

test('canOperateVerdict：提交人/可信白名单/owner 可操作，其他人与空值不可', () => {
  const t = mk({ id: 't1', status: 'challenged' });
  assert.equal(canOperateVerdict('ou_me', t, {}), true);
  assert.equal(canOperateVerdict('ou_t', t, { trustedOpenIds: ['ou_t'] }), true);
  assert.equal(canOperateVerdict('ou_o', t, { ownerOpenIds: ['ou_o'] }), true);
  assert.equal(canOperateVerdict('ou_x', t, { trustedOpenIds: ['ou_t'], ownerOpenIds: ['ou_o'] }), false);
  assert.equal(canOperateVerdict(null, t, {}), false);
  assert.equal(canOperateVerdict('ou_me', null, {}), false);
});

test('resolveTrustedOpenIds：有 open_id → 单元素数组', () => {
  assert.deepEqual(resolveTrustedOpenIds('ou_me'), ['ou_me']);
});

test('resolveTrustedOpenIds：空/undefined → 空数组', () => {
  assert.deepEqual(resolveTrustedOpenIds(''), []);
  assert.deepEqual(resolveTrustedOpenIds(undefined), []);
  assert.deepEqual(resolveTrustedOpenIds(null), []);
});
