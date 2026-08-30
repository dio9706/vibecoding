import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActive, reduceRateLimit, recoverExpired } from './token-rotation.js';

const mk = (o) => ({
  id: o.id,
  providerId: o.providerId, // 不传即 undefined（模拟回填前旧数据）
  label: o.label || o.id,
  token: o.token || ('sk-ant-oat01-' + o.id),
  status: o.status || 'healthy',
  resetsAt: o.resetsAt ?? null,
  rateLimitType: o.rateLimitType ?? null,
  utilization: o.utilization ?? null,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('pickActive：偏好最高的 healthy 优先', () => {
  const list = [mk({ id: 'a', status: 'exhausted' }), mk({ id: 'b' }), mk({ id: 'c' })];
  assert.equal(pickActive(list).id, 'b');
});

test('pickActive：无 healthy 时退而选 warning', () => {
  const list = [mk({ id: 'a', status: 'exhausted' }), mk({ id: 'b', status: 'warning' })];
  assert.equal(pickActive(list).id, 'b');
});

test('pickActive：全 exhausted 返回 null；空池返回 null', () => {
  assert.equal(pickActive([mk({ id: 'a', status: 'exhausted' })]), null);
  assert.equal(pickActive([]), null);
});

test('reduceRateLimit：allowed_warning 标 warning + 记 utilization/resetsAt，active 切到下一个', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  const { tokens, notice } = reduceRateLimit(
    list, 'a',
    { status: 'allowed_warning', utilization: 0.87, resetsAt: 1800, rateLimitType: 'five_hour' },
    1000,
  );
  assert.equal(tokens[0].status, 'warning');
  assert.equal(tokens[0].utilization, 0.87);
  assert.equal(tokens[0].resetsAt, 1800);
  assert.deepEqual(notice, { kind: 'switch', from: 'a', to: 'b', at: 1000 });
  assert.equal(list[0].status, 'healthy'); // 不改入参
});

test('reduceRateLimit：rejected 标 exhausted + resetsAt，active 切换', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  const { tokens, notice } = reduceRateLimit(list, 'a', { status: 'rejected', resetsAt: 5000 }, 1000);
  assert.equal(tokens[0].status, 'exhausted');
  assert.equal(tokens[0].resetsAt, 5000);
  assert.equal(notice.to, 'b');
});

test('reduceRateLimit：rejected 无 resetsAt 时兜底 now+3600', () => {
  const list = [mk({ id: 'a' })];
  const { tokens } = reduceRateLimit(list, 'a', { status: 'rejected' }, 1000);
  assert.equal(tokens[0].resetsAt, 1000 + 3600);
});

test('reduceRateLimit：allowed 恢复 healthy 并清字段', () => {
  const list = [mk({ id: 'a', status: 'warning', utilization: 0.9, resetsAt: 1800 })];
  const { tokens } = reduceRateLimit(list, 'a', { status: 'allowed' }, 1000);
  assert.equal(tokens[0].status, 'healthy');
  assert.equal(tokens[0].resetsAt, null);
  assert.equal(tokens[0].utilization, null);
});

test('reduceRateLimit：active 未变则 notice 为 null', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  const { notice } = reduceRateLimit(list, 'b', { status: 'allowed_warning', utilization: 0.5 }, 1000);
  assert.equal(notice, null);
});

test('reduceRateLimit：未知 tokenId 原样返回', () => {
  const list = [mk({ id: 'a' })];
  const { tokens, notice } = reduceRateLimit(list, 'zzz', { status: 'rejected' }, 1000);
  assert.equal(tokens, list);
  assert.equal(notice, null);
});

test('recoverExpired：resetsAt<=now 的非 healthy 恢复 healthy', () => {
  const list = [
    mk({ id: 'a', status: 'exhausted', resetsAt: 900 }),
    mk({ id: 'b', status: 'warning', resetsAt: 2000 }),
  ];
  const { tokens, changed } = recoverExpired(list, 1000);
  assert.equal(changed, true);
  assert.equal(tokens[0].status, 'healthy');
  assert.equal(tokens[0].resetsAt, null);
  assert.equal(tokens[1].status, 'warning'); // 未到点不动
});

test('recoverExpired：无到点项 changed=false', () => {
  const list = [mk({ id: 'a', status: 'exhausted', resetsAt: 5000 })];
  const { changed } = recoverExpired(list, 1000);
  assert.equal(changed, false);
});

test('reduceRateLimit：未知 status 原样返回（自洽兜底）', () => {
  const list = [mk({ id: 'a' })];
  const r = reduceRateLimit(list, 'a', { status: '???' }, 1000);
  assert.equal(r.tokens, list);
  assert.equal(r.notice, null);
});

test('reduceRateLimit：info 为空不抛异常，原样返回', () => {
  const list = [mk({ id: 'a' })];
  const r = reduceRateLimit(list, 'a', null, 1000);
  assert.equal(r.tokens, list);
  assert.equal(r.notice, null);
});

test('reduceRateLimit：allowed_warning 缺省 utilization/resetsAt 时保留旧值（部分更新）', () => {
  const list = [mk({ id: 'a', status: 'warning', utilization: 0.5, resetsAt: 900, rateLimitType: 'five_hour' })];
  const { tokens } = reduceRateLimit(list, 'a', { status: 'allowed_warning' }, 1000);
  assert.equal(tokens[0].utilization, 0.5);
  assert.equal(tokens[0].resetsAt, 900);
  assert.equal(tokens[0].rateLimitType, 'five_hour');
});

test('pickActive：providerId 过滤——只在该 provider 内选号', () => {
  const list = [
    mk({ id: 'c1', providerId: 'claude-agent', status: 'exhausted' }),
    mk({ id: 'o1', providerId: 'openai-compat', status: 'healthy' }),
    mk({ id: 'c2', providerId: 'claude-agent', status: 'healthy' }),
  ];
  assert.equal(pickActive(list, 'claude-agent').id, 'c2');
  assert.equal(pickActive(list, 'openai-compat').id, 'o1');
});

test('pickActive：省略 providerId 时跨所有 provider（向后兼容）', () => {
  const list = [mk({ id: 'a', status: 'exhausted' }), mk({ id: 'b' })];
  assert.equal(pickActive(list).id, 'b');
});

test('pickActive：缺 providerId 字段的旧数据按 claude-agent 处理', () => {
  const list = [mk({ id: 'a' })]; // 无 providerId
  assert.equal(pickActive(list, 'claude-agent').id, 'a');
  assert.equal(pickActive(list, 'openai-compat'), null); // 不属于 openai
});

test('reduceRateLimit：switch 通知限定在同一 provider 内（不会误切到别的 provider）', () => {
  const list = [
    mk({ id: 'c1', providerId: 'claude-agent' }),
    mk({ id: 'o1', providerId: 'openai-compat' }),
  ];
  // 限流 claude 唯一号 → 该 provider 内无备用 → to 为 null，且绝不跳到 openai 的 o1
  const { notice } = reduceRateLimit(list, 'c1', { status: 'rejected', resetsAt: 5000 }, 1000);
  assert.equal(notice.from, 'c1');
  assert.equal(notice.to, null);
});

test('reduceRateLimit：同 provider 内有备用则切到该 provider 的备用', () => {
  const list = [
    mk({ id: 'c1', providerId: 'claude-agent' }),
    mk({ id: 'c2', providerId: 'claude-agent' }),
    mk({ id: 'o1', providerId: 'openai-compat' }),
  ];
  const { notice } = reduceRateLimit(list, 'c1', { status: 'rejected', resetsAt: 5000 }, 1000);
  assert.equal(notice.to, 'c2'); // 不会跳到 o1
});

test('reduceRateLimit：allowed 状态记录 windowResetsAt，且不清空 resetsAt 之外的窗口信息', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'healthy', resetsAt: null }];
  const r = reduceRateLimit(tokens, 't1', { status: 'allowed', resetsAt: 1785412800 }, 1785400000);
  assert.equal(r.tokens[0].status, 'healthy');
  assert.equal(r.tokens[0].resetsAt, null, 'healthy 时 resetsAt 仍应清空（原语义不变）');
  assert.equal(r.tokens[0].windowResetsAt, 1785412800, '计费窗口时刻必须留下，调度器要用');
});

test('reduceRateLimit：allowed 未带 resetsAt 时，保留上一次的 windowResetsAt 不抹掉', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'healthy', windowResetsAt: 111 }];
  const r = reduceRateLimit(tokens, 't1', { status: 'allowed' }, 1000);
  assert.equal(r.tokens[0].windowResetsAt, 111);
});

test('reduceRateLimit：限流/告警状态同样记录 windowResetsAt', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'healthy' }];
  const warn = reduceRateLimit(tokens, 't1', { status: 'allowed_warning', resetsAt: 222, utilization: 0.9 }, 1000);
  assert.equal(warn.tokens[0].windowResetsAt, 222);
  const rej = reduceRateLimit(tokens, 't1', { status: 'rejected', resetsAt: 333 }, 1000);
  assert.equal(rej.tokens[0].windowResetsAt, 333);
});

test('recoverExpired 恢复 healthy 时不得抹掉 windowResetsAt', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'exhausted', resetsAt: 100, windowResetsAt: 100 }];
  const r = recoverExpired(tokens, 200);
  assert.equal(r.tokens[0].status, 'healthy');
  assert.equal(r.tokens[0].windowResetsAt, 100);
});
