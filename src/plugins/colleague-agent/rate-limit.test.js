/**
 * 限流单测。两个闸防的是不同的东西：
 * - per-人滑动窗口：防一个人连珠炮刷额度
 * - 全局并发：防多人同时来把机器打满（每轮 ~10s，2 并发 ≈ 12 轮/分）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, PER_PERSON_MAX, PER_PERSON_WINDOW_MS, GLOBAL_MAX_CONCURRENT } from './rate-limit.js';

test('参数是保守档（改动前先确认是有意的）', () => {
  assert.equal(PER_PERSON_MAX, 5);
  assert.equal(PER_PERSON_WINDOW_MS, 60_000);
  assert.equal(GLOBAL_MAX_CONCURRENT, 2);
});

// ⚠️ 下面三条 per-人用例**必须在每次 tryAcquire 后 release()**。
// 两道闸是不同维度：per-人窗口按**时间**滑出，全局并发按 **release** 释放。
// 不 release 地连调 5 次，模拟的是「5 个会话同时挂着不结束」——那会在第 3 次就撞上
// GLOBAL_MAX_CONCURRENT=2 返回 'busy'，根本走不到第 6 次去验证 'rate'，
// 测的就不是 per-人窗口了。（2026-09-28 实施时实测踩到，原计划漏了 release。）

test('per-人：窗口内第 6 条被拒，理由是 rate', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  // 每条都处理完再来下一条 —— 这才是「一个人连发 6 条」的真实形态
  for (let i = 0; i < 5; i++) {
    const r = rl.tryAcquire('cl_1');
    assert.equal(r.ok, true, `第 ${i + 1} 条应放行`);
    r.release();
  }
  const r = rl.tryAcquire('cl_1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate', '并发位已全部释放，唯一该拦住它的是 per-人窗口');
});

test('per-人：滑出窗口后恢复', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) rl.tryAcquire('cl_1').release();
  now += 60_001;
  assert.equal(rl.tryAcquire('cl_1').ok, true);
});

test('per-人：互不影响，一个人刷爆不该挡住别人', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) rl.tryAcquire('cl_1').release();
  assert.equal(rl.tryAcquire('cl_2').ok, true);
});

test('全局并发：第 3 个并发被拒，理由是 busy', () => {
  const rl = createRateLimiter();
  assert.equal(rl.tryAcquire('cl_1').ok, true);
  assert.equal(rl.tryAcquire('cl_2').ok, true);
  const r = rl.tryAcquire('cl_3');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
});

test('全局并发：release 后位置腾出来', () => {
  const rl = createRateLimiter();
  const a = rl.tryAcquire('cl_1');
  rl.tryAcquire('cl_2');
  assert.equal(rl.tryAcquire('cl_3').ok, false);
  a.release();
  assert.equal(rl.tryAcquire('cl_3').ok, true);
});

test('release 幂等 —— 重复调用不能把并发数减成负的（finally 里调两次是常见写法）', () => {
  const rl = createRateLimiter();
  const a = rl.tryAcquire('cl_1');
  a.release();
  a.release();
  a.release();
  rl.tryAcquire('cl_2');
  rl.tryAcquire('cl_3');
  assert.equal(rl.tryAcquire('cl_4').ok, false, '并发计数被减成负数的话这里会误放行');
});

test('被拒时不占用配额 —— 否则超限那条会把人的窗口越撑越满', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  rl.tryAcquire('cl_1');
  rl.tryAcquire('cl_2');
  rl.tryAcquire('cl_3'); // 被全局并发拒
  // cl_3 一条都没跑成，它的 per-人窗口应该还是空的
  assert.equal(rl.peekPersonCount('cl_3'), 0);
});
