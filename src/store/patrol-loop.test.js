import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOP, normalizeLoop } from './patrol-loop.js';

test('normalizeLoop：null/非对象 → 默认态（active=false）', () => {
  assert.deepEqual(normalizeLoop(null), DEFAULT_LOOP);
  assert.deepEqual(normalizeLoop('x'), DEFAULT_LOOP);
  assert.deepEqual(normalizeLoop([1, 2]), DEFAULT_LOOP);
  assert.equal(normalizeLoop({}).active, false);
});

test('normalizeLoop：补全缺失字段，保留已有值', () => {
  const r = normalizeLoop({ active: true, openId: 'ou_a', roundNo: 3 });
  assert.equal(r.active, true);
  assert.equal(r.openId, 'ou_a');
  assert.equal(r.roundNo, 3);
  assert.deepEqual(r.seen, {}); // 缺失的补默认
  assert.deepEqual(r.cycleTaskIds, []);
  assert.equal(r.phase, 'scanning');
});

test('normalizeLoop：seen/report 类型错时回退默认（防读坏配置打穿下游）', () => {
  const r = normalizeLoop({ seen: 'bad', cycleTaskIds: 'bad', report: 42 });
  assert.deepEqual(r.seen, {});
  assert.deepEqual(r.cycleTaskIds, []);
  assert.deepEqual(r.report, DEFAULT_LOOP.report);
});

test('normalizeLoop：phase 只认两个合法值，其余落 scanning', () => {
  assert.equal(normalizeLoop({ phase: 'standby' }).phase, 'standby');
  assert.equal(normalizeLoop({ phase: 'scanning' }).phase, 'scanning');
  assert.equal(normalizeLoop({ phase: 'garbage' }).phase, 'scanning');
});

test('normalizeLoop：report 逐个子数组兜底（只坏一个不牵连其余）', () => {
  const r = normalizeLoop({ report: { fixed: [{ title: 'a' }], handoff: 'bad' } });
  assert.deepEqual(r.report.fixed, [{ title: 'a' }]);
  assert.deepEqual(r.report.handoff, []);
  assert.deepEqual(r.report.failed, []);
  assert.deepEqual(r.report.unknown, []);
});

test('DEFAULT_LOOP 不被 normalizeLoop 的调用方污染（每次返回新对象）', () => {
  const a = normalizeLoop(null);
  a.seen.x = 1;
  a.report.fixed.push('污染');
  assert.deepEqual(normalizeLoop(null).seen, {});
  assert.deepEqual(normalizeLoop(null).report.fixed, []);
});

test('normalizeLoop：透传 needHuman（漏了会让 pushReport 写进去的每条都被静默抹掉）', () => {
  const n = normalizeLoop({ report: { needHuman: [{ title: 'x' }] } });
  assert.deepEqual(n.report.needHuman, [{ title: 'x' }]);
  assert.deepEqual(normalizeLoop({}).report.needHuman, [], '缺字段时补空数组');
});

test('DEFAULT_LOOP：report 含 needHuman（pushReport 的隐式白名单靠它）', () => {
  assert.deepEqual(DEFAULT_LOOP.report.needHuman, []);
});
