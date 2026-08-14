import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates, applyDormancy, DEFAULT_THRESHOLD } from './promote.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const DAY = 86400000;

// 递增 id 生成器：显式注入，保证纯函数可测（无 random / 无 Date.now）
const idGen = () => { let n = 0; return () => `mem_${++n}`; };

const cand = (over = {}) => ({
  category: 'code-style',
  scope: 'global',
  projectDir: '',
  statement: '注释写中文',
  fingerprint: 'code-style:注释语言',
  source: 'inferred',
  quote: '不对，注释写中文',
  sessionId: 's1',
  at: '2026-08-11T00:00:00.000Z',
  kind: 'correction',
  ...over,
});

const emptyState = () => ({ items: [], blacklist: [] });

test('新候选建为 candidate，不直接生效', () => {
  const r = mergeCandidates(emptyState(), [cand()], { now: NOW, makeId: idGen() });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, 'candidate');
  assert.equal(r.items[0].evidenceCount, 1);
  assert.deepEqual(r.promoted, []);
});

test('同一会话内重复三次 —— 不得自动晋升（同一事件不是三份证据）', () => {
  const r = mergeCandidates(emptyState(), [cand(), cand(), cand()], { now: NOW, makeId: idGen() });
  assert.equal(r.items.length, 1, '同 fingerprint 必须合并成一条');
  assert.equal(r.items[0].evidenceCount, 3);
  assert.deepEqual(r.items[0].evidenceSessions, ['s1'], '同会话只记一个 session');
  assert.equal(r.items[0].status, 'candidate', '跨会话数不足，不能晋升');
  assert.deepEqual(r.promoted, []);
});

test('3 次证据且跨 2 个会话 → 自动晋升，acked=false 供红点消费', () => {
  const makeId = idGen();
  let s = mergeCandidates(emptyState(), [cand(), cand({ sessionId: 's2' })], { now: NOW, makeId });
  assert.equal(s.items[0].status, 'candidate');
  s = mergeCandidates(s, [cand({ sessionId: 's3' })], { now: NOW, makeId });
  assert.equal(s.items[0].status, 'active');
  assert.equal(s.items[0].promotedBy, 'auto');
  assert.equal(s.items[0].acked, false);
  assert.deepEqual(s.promoted, ['mem_1']);
});

test('显式偏好单条证据即晋升（用户直说「以后都用 X」，不该等三次）', () => {
  const r = mergeCandidates(emptyState(), [cand({ source: 'explicit', kind: 'explicit' })], {
    now: NOW, makeId: idGen(),
  });
  assert.equal(r.items[0].status, 'active');
  assert.deepEqual(r.promoted, ['mem_1']);
});

test('黑名单命中直接丢弃 —— 否掉的条目不得反复骚扰', () => {
  const state = { items: [], blacklist: [{ fingerprint: 'code-style:注释语言', rejectedAt: NOW }] };
  const r = mergeCandidates(state, [cand()], { now: NOW, makeId: idGen() });
  assert.deepEqual(r.items, []);
});

test('已有条目的 statement 不被覆盖（用户可能已手工编辑过）', () => {
  const makeId = idGen();
  let s = mergeCandidates(emptyState(), [cand()], { now: NOW, makeId });
  s.items[0].statement = '注释写中文，只解释为什么';
  s = mergeCandidates(s, [cand({ statement: '注释用中文' })], { now: NOW, makeId });
  assert.equal(s.items[0].statement, '注释写中文，只解释为什么');
});

test('evidence 最多留 5 条丢最旧，但 evidenceCount 是累计值', () => {
  const makeId = idGen();
  let s = emptyState();
  for (let i = 1; i <= 7; i++) {
    s = mergeCandidates(s, [cand({ sessionId: `s${i}`, quote: `第${i}次` })], { now: NOW, makeId });
  }
  assert.equal(s.items[0].evidence.length, 5);
  assert.equal(s.items[0].evidence[0].quote, '第3次');
  assert.equal(s.items[0].evidenceCount, 7);
});

test('冲突：新证据与已生效条目对立时不覆盖，两边都置 conflict 停止注入', () => {
  const makeId = idGen();
  let s = mergeCandidates(emptyState(), [cand({ source: 'explicit' })], { now: NOW, makeId });
  assert.equal(s.items[0].status, 'active');
  s = mergeCandidates(s, [cand({ statement: '注释写英文', contradicts: true, source: 'explicit' })], {
    now: NOW, makeId,
  });
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].status, 'conflict');
  assert.equal(s.items[1].status, 'conflict');
  assert.equal(s.items[0].conflictWith, s.items[1].id);
  assert.equal(s.items[1].conflictWith, s.items[0].id);
});

test('applyDormancy：90 天无新证据降级 dormant，数据保留', () => {
  const items = [
    { id: 'a', status: 'active', lastSeenAt: NOW - 91 * DAY, statement: 'x' },
    { id: 'b', status: 'active', lastSeenAt: NOW - 10 * DAY, statement: 'y' },
    { id: 'c', status: 'candidate', lastSeenAt: NOW - 200 * DAY, statement: 'z' },
  ];
  const out = applyDormancy(items, { now: NOW, dormantDays: 90 });
  assert.equal(out[0].status, 'dormant');
  assert.equal(out[0].statement, 'x', '降级只改状态，不删数据');
  assert.equal(out[1].status, 'active');
  assert.equal(out[2].status, 'candidate', 'candidate 不参与休眠降级');
});

test('dormant 条目再次出现证据 → 复活为 active', () => {
  const state = {
    items: [{
      id: 'mem_x', category: 'code-style', scope: 'global', projectDir: '',
      statement: '注释写中文', fingerprint: 'code-style:注释语言',
      status: 'dormant', inject: true, source: 'inferred',
      evidenceCount: 3, evidenceSessions: ['s1', 's2'], evidence: [],
      promotedBy: 'auto', acked: true, conflictWith: null,
      createdAt: NOW - 200 * DAY, updatedAt: NOW - 200 * DAY, lastSeenAt: NOW - 200 * DAY,
    }],
    blacklist: [],
  };
  const r = mergeCandidates(state, [cand({ sessionId: 's9' })], { now: NOW, makeId: idGen() });
  assert.equal(r.items[0].status, 'active');
});

test('DEFAULT_THRESHOLD 暴露为可配值', () => {
  assert.deepEqual(DEFAULT_THRESHOLD, { minEvidence: 3, minSessions: 2 });
});

test('mergeCandidates 不得修改传入的 state —— 文件头注明「纯函数」，调用方有权假设旧引用不被污染', () => {
  const makeId = idGen();
  const originalSessions = ['s1'];
  const originalEvidence = [{ sessionId: 's1', at: '2026-08-01T00:00:00.000Z', quote: '旧证据', kind: 'correction' }];
  const state = {
    items: [{
      id: 'mem_x', category: 'code-style', scope: 'global', projectDir: '',
      statement: '注释写中文', fingerprint: 'code-style:注释语言',
      status: 'candidate', inject: true, source: 'inferred',
      evidenceCount: 1, evidenceSessions: originalSessions, evidence: originalEvidence,
      promotedBy: null, acked: true, conflictWith: null,
      createdAt: NOW, updatedAt: NOW, lastSeenAt: NOW,
    }],
    blacklist: [],
  };

  const r = mergeCandidates(state, [cand({ sessionId: 's2' })], { now: NOW, makeId });

  // 只做了浅拷贝：items 数组和 item 对象是新的，但 item 内部的数组字段仍是原引用；
  // 若实现里对 evidenceSessions 用 .push()，就会原地改到调用方持有的旧数组上。
  assert.deepEqual(originalSessions, ['s1'], '调用前持有的 evidenceSessions 引用，调用后内容不该变');
  assert.notEqual(r.items[0].evidenceSessions, originalSessions, '返回值的 evidenceSessions 必须是新数组，不能与入参共享引用');
  assert.deepEqual(originalEvidence, [{ sessionId: 's1', at: '2026-08-01T00:00:00.000Z', quote: '旧证据', kind: 'correction' }], 'evidence 字段同理不该被污染（当前用 concat+slice 重新赋值，此断言应天然通过）');
});
