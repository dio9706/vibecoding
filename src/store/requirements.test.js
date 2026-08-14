import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-store-'));
const { createRequirement, getRequirement, getRequirements, updateRequirement, canTransition, normalizeSessions } =
  await import('./requirements.js');

test('createRequirement：初始 review 期、空骨架、history 有创建记录', () => {
  const r = createRequirement({ title: '扫码支付改造' });
  assert.match(r.id, /^r_/);
  assert.equal(r.phase, 'review');
  assert.equal(r.title, '扫码支付改造');
  assert.deepEqual(r.projects, { frontend: null, backend: null });
  assert.deepEqual(r.devDoc, { versions: [] });
  assert.deepEqual(r.supplements, []);
  assert.deepEqual(r.apiDocs, []);
  assert.deepEqual(r.bugs, []);
  assert.equal(r.busy, null);
  assert.equal(r.history[0].event, '创建');
  assert.equal(getRequirement(r.id).id, r.id);
});

test('updateRequirement：patch 合并 + event 入 history；不存在返回 null', () => {
  const r = createRequirement({ title: 'X' });
  const u = updateRequirement(r.id, { designGuidelines: '主色 #4F6EF7' }, '更新设计准则');
  assert.equal(u.designGuidelines, '主色 #4F6EF7');
  assert.equal(u.history.at(-1).event, '更新设计准则');
  assert.equal(updateRequirement('r_none', {}, 'x'), null);
});

test('canTransition：只允许相邻推进，phase 不符返回 error', () => {
  assert.equal(canTransition('review', 'dev').ok, true);
  assert.equal(canTransition('dev', 'test').ok, true);
  assert.equal(canTransition('test', 'archiving').ok, true);
  assert.equal(canTransition('archiving', 'archived').ok, true);
  assert.equal(canTransition('review', 'test').ok, false);
  assert.equal(canTransition('archived', 'review').ok, false);
  assert.match(canTransition('review', 'test').error, /不允许/);
});

test('getRequirements 按 updatedAt 倒序', () => {
  const a = createRequirement({ title: 'A' });
  createRequirement({ title: 'B' }); // 磁盘序首位是 B，唯有真排序才能让 A 排到前面
  updateRequirement(a.id, {}, '触发更新');
  assert.equal(getRequirements()[0].id, a.id);
});

test('createRequirement：sessions 初始为空数组', () => {
  const r = createRequirement({ title: 'sessions 测试' });
  assert.deepEqual(r.sessions, []);
});

test('normalizeSessions：sessions 非空直接返回', () => {
  const sessions = [
    { convId: 'conv_123', sessionId: 'sess_456', title: 'Test', kind: 'main', createdAt: '2026-08-11T00:00:00Z' },
  ];
  const req = { sessions };
  assert.deepEqual(normalizeSessions(req), sessions);
});

test('normalizeSessions：sessions 空但 convId 非空 → 合成主会话', () => {
  const req = {
    sessions: [],
    convId: 'conv_123',
    devSession: 'sess_456',
    title: '需求标题',
    createdAt: '2026-08-11T00:00:00Z',
  };
  const result = normalizeSessions(req);
  assert.equal(result.length, 1);
  assert.equal(result[0].convId, 'conv_123');
  assert.equal(result[0].sessionId, 'sess_456');
  assert.equal(result[0].title, '需求标题');
  assert.equal(result[0].kind, 'main');
  assert.equal(result[0].createdAt, '2026-08-11T00:00:00Z');
});

test('normalizeSessions：sessions 空且 convId 空 → 返回空数组', () => {
  const req = {
    sessions: [],
    convId: null,
    devSession: null,
    title: '新需求',
    createdAt: '2026-08-11T00:00:00Z',
  };
  const result = normalizeSessions(req);
  assert.deepEqual(result, []);
});
