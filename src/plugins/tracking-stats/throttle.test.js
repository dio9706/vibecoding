import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COOLDOWN_MS,
  MAX_CONCURRENT,
  checkThrottle,
  buildThrottleReply,
  collectExpired,
} from './throttle.js';

test('限流参数回归锚点', () => {
  assert.equal(COOLDOWN_MS, 60_000);
  assert.equal(MAX_CONCURRENT, 2);
});

test('首次请求放行（无历史记录）', () => {
  assert.deepEqual(checkThrottle({ lastAtMs: null, running: 0, now: 1_000_000 }), {
    ok: true,
    reason: null,
    waitMs: 0,
  });
  // undefined（Map.get 未命中）与 null 等价
  assert.equal(checkThrottle({ lastAtMs: undefined, running: 0, now: 1_000_000 }).ok, true);
});

test('冷却期内拒绝，并给出剩余秒数', () => {
  const r = checkThrottle({ lastAtMs: 1_000_000, running: 0, now: 1_000_000 + 20_000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.waitMs, 40_000);
});

test('冷却期边界：整好满一分钟即放行', () => {
  assert.equal(checkThrottle({ lastAtMs: 1_000_000, running: 0, now: 1_060_000 }).ok, true);
  assert.equal(checkThrottle({ lastAtMs: 1_000_000, running: 0, now: 1_059_999 }).ok, false);
});

test('时钟回拨时等待时长封顶为一个冷却窗口', () => {
  // 不封顶的话 waitMs 会变成「冷却窗口 + 回拨量」，用户被锁上远超一分钟且毫无解释
  const r = checkThrottle({ lastAtMs: 2_000_000, running: 0, now: 1_000_000 });
  assert.equal(r.ok, false);
  assert.equal(r.waitMs, COOLDOWN_MS);
});

test('并发达上限时拒绝', () => {
  const r = checkThrottle({ lastAtMs: null, running: 2, now: 1_000_000 });
  assert.deepEqual(r, { ok: false, reason: 'busy', waitMs: 0 });
  // 未达上限仍放行
  assert.equal(checkThrottle({ lastAtMs: null, running: 1, now: 1_000_000 }).ok, true);
});

test('冷却优先于并发判定', () => {
  // 连点的人应拿到「还要等 N 秒」，而不是与他行为对不上的「别人正在跑」
  const r = checkThrottle({ lastAtMs: 1_000_000, running: 5, now: 1_010_000 });
  assert.equal(r.reason, 'cooldown');
});

test('可覆盖阈值（供调用方定制）', () => {
  const opts = { cooldownMs: 10, maxConcurrent: 1 };
  assert.equal(checkThrottle({ lastAtMs: 100, running: 0, now: 105 }, opts).ok, false);
  assert.equal(checkThrottle({ lastAtMs: 100, running: 0, now: 111 }, opts).ok, true);
  assert.equal(checkThrottle({ lastAtMs: null, running: 1, now: 111 }, opts).reason, 'busy');
});

test('拒绝文案：冷却给秒数、并发给上限，且都不为空', () => {
  const cd = buildThrottleReply({ reason: 'cooldown', waitMs: 40_000 });
  assert.match(cd, /40 秒/);
  // 不足 1 秒也要向上取整成 1，「请 0 秒后再试」是句废话
  assert.match(buildThrottleReply({ reason: 'cooldown', waitMs: 200 }), /1 秒/);
  const busy = buildThrottleReply({ reason: 'busy', waitMs: 0 }, 2);
  assert.match(busy, /2 个/);
  assert.notEqual(busy, cd);
});

test('collectExpired：只挑出已过冷却期的键', () => {
  const entries = [
    ['a', 1_000_000], // 刚跑过
    ['b', 900_000], // 已过 100s
    ['c', 'bad'], // 脏数据一并清掉
  ];
  assert.deepEqual(collectExpired(entries, 1_010_000).sort(), ['b', 'c']);
  assert.deepEqual(collectExpired(null, 1_010_000), []);
});
