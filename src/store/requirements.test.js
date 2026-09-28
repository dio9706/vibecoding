import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-store-'));
const { createRequirement, getRequirement, getRequirements, updateRequirement, deleteRequirement, canTransition, normalizeSessions, addAgentWorktree } =
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

test('normalizeSessions：sessions 非空直接返回，缺 phase 的补需求当前阶段', () => {
  const sessions = [
    { convId: 'conv_123', sessionId: 'sess_456', title: 'Test', kind: 'main', createdAt: '2026-08-11T00:00:00Z' },
  ];
  assert.deepEqual(normalizeSessions({ sessions, phase: 'dev' }), [{ ...sessions[0], phase: 'dev' }]);
});

test('normalizeSessions：已在测试期的存量需求，会话补 test 而非 dev（否则会话树整棵消失）', () => {
  const sessions = [
    { convId: 'c_legacy', sessionId: 's1', title: '老会话', kind: 'main', createdAt: '' },
  ];
  assert.equal(normalizeSessions({ sessions, phase: 'test' })[0].phase, 'test');
});

test('normalizeSessions：已有 phase 的会话不被覆盖', () => {
  const sessions = [
    { convId: 'c_t', sessionId: null, title: '测试期主会话', kind: 'main', phase: 'test', createdAt: '' },
    { convId: 'c_d', sessionId: 's1', title: '开发期子会话', kind: 'sub', phase: 'dev', createdAt: '' },
  ];
  assert.deepEqual(normalizeSessions({ sessions, phase: 'test' }), sessions);
});

test('normalizeSessions：混合数组——有 phase 的保留，缺的补当前阶段（迁移期最易出错的形状）', () => {
  const sessions = [
    { convId: 'c_d', sessionId: 's1', title: '开发期会话', kind: 'main', phase: 'dev', createdAt: '' },
    { convId: 'c_x', sessionId: null, title: '未标记会话', kind: 'sub', createdAt: '' },
  ];
  const result = normalizeSessions({ sessions, phase: 'test' });
  assert.equal(result[0].phase, 'dev');
  assert.equal(result[1].phase, 'test');
});

test('normalizeSessions：纯函数——不改动入参数组及其元素', () => {
  const sessions = [{ convId: 'c1', sessionId: null, title: 'x', kind: 'sub', createdAt: '' }];
  normalizeSessions({ sessions, phase: 'dev' });
  assert.equal(sessions[0].phase, undefined);
  assert.equal(sessions.length, 1);
});

test('normalizeSessions：sessions 空但 convId 非空 → 合成主会话', () => {
  const req = {
    sessions: [],
    convId: 'conv_123',
    devSession: 'sess_456',
    title: '需求标题',
    phase: 'test',
    createdAt: '2026-08-11T00:00:00Z',
  };
  const result = normalizeSessions(req);
  assert.equal(result.length, 1);
  assert.equal(result[0].convId, 'conv_123');
  assert.equal(result[0].sessionId, 'sess_456');
  assert.equal(result[0].title, '需求标题');
  assert.equal(result[0].kind, 'main');
  assert.equal(result[0].createdAt, '2026-08-11T00:00:00Z');
  assert.equal(result[0].phase, 'test'); // 路径 2 同样按需求当前阶段打标
});

test('normalizeSessions：需求连 phase 都没有（极老数据）→ 退到 dev', () => {
  const req = { sessions: [], convId: 'conv_ancient', devSession: null, title: '远古需求', createdAt: '' };
  assert.equal(normalizeSessions(req)[0].phase, 'dev');
  assert.equal(normalizeSessions({ sessions: [{ convId: 'c', title: 'x', kind: 'sub' }] })[0].phase, 'dev');
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

// ==== Task 10：per-需求 agent worktree 登记（补 spec §5.3）====

test('agentWorktrees：新建需求默认空数组', () => {
  const r = createRequirement({ title: 'x' });
  assert.deepEqual(getRequirement(r.id).agentWorktrees, []);
});

test('addAgentWorktree：登记一条，字段齐全', () => {
  const r = createRequirement({ title: 'x' });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-r_ab', branch: 'agent/x' });
  const list = getRequirement(r.id).agentWorktrees;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { dir: 'D:/p', worktreeDir: 'D:/p.req-r_ab', branch: 'agent/x' });
});

test('addAgentWorktree：同一 worktreeDir 只登记一次（同需求多次派活是常态）', () => {
  const r = createRequirement({ title: 'x' });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b1' });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b2' });
  const list = getRequirement(r.id).agentWorktrees;
  assert.equal(list.length, 1, 'ensureReqWorktree 对同一需求是幂等的，登记也该是');
  assert.equal(list[0].branch, 'b1', '先登记的那条保留，不被后来的覆盖');
});

test('addAgentWorktree：缺 worktreeDir 的条目直接拒绝（那是要删的目录，缺了这条登记没意义）', () => {
  const r = createRequirement({ title: 'x' });
  addAgentWorktree(r.id, { dir: 'D:/p', branch: 'b' });
  addAgentWorktree(r.id, null);
  assert.deepEqual(getRequirement(r.id).agentWorktrees, []);
});

test('addAgentWorktree：需求不存在时安静返回 null，不写盘', () => {
  assert.equal(addAgentWorktree('r_nope', { worktreeDir: 'D:/x' }), null);
});

test('存量需求（盘上没有 agentWorktrees 字段）也能登记', () => {
  const r = createRequirement({ title: 'x' });
  // 模拟存量数据：把字段删掉再登记
  updateRequirement(r.id, { agentWorktrees: undefined });
  addAgentWorktree(r.id, { dir: 'D:/p', worktreeDir: 'D:/p.req-old', branch: 'b' });
  assert.equal(getRequirement(r.id).agentWorktrees.length, 1);
});

test('deleteRequirement：物理删除并返回被删记录；不存在返回 null 且不影响其它需求', () => {
  const a = createRequirement({ title: '待删需求' });
  const b = createRequirement({ title: '保留需求' });
  const removed = deleteRequirement(a.id);
  assert.equal(removed.id, a.id);
  assert.equal(getRequirement(a.id), null, '删完必须查不到——不是改状态位');
  assert.equal(getRequirement(b.id).id, b.id, '同批需求不能被连坐');
  assert.equal(deleteRequirement('r_none'), null);
});
