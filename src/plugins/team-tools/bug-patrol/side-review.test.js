import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSideWithTimeout } from './side-review.js';

test('reviewSideWithTimeout：正常返回原样透传', async () => {
  const r = await reviewSideWithTimeout(
    {},
    {},
    { review: async () => ({ side: 'backend', evidence: 'e', advice: 'a' }), timeoutMs: 1000 },
  );
  assert.equal(r.side, 'backend');
  assert.equal(r.advice, 'a');
});

test('reviewSideWithTimeout：超时 → unknown（不中断整轮）', async () => {
  const r = await reviewSideWithTimeout(
    {},
    {},
    {
      review: () => new Promise((res) => setTimeout(() => res({ side: 'backend' }), 200)),
      timeoutMs: 20,
    },
  );
  assert.equal(r.side, 'unknown');
  assert.match(r.evidence, /超时/);
  assert.equal(r.advice, ''); // unknown 不该带建议
});

test('reviewSideWithTimeout：调用抛错 → unknown（无人值守链路绝不向上抛）', async () => {
  const r = await reviewSideWithTimeout(
    {},
    {},
    {
      review: async () => {
        throw new Error('网络炸了');
      },
      timeoutMs: 1000,
    },
  );
  assert.equal(r.side, 'unknown');
  assert.match(r.evidence, /网络炸了/);
});

test('reviewSideWithTimeout：调用先赢时清掉计时器（否则拖住进程退出）', async () => {
  // 计时器没 clear 的话，本用例结束后事件循环里仍挂着一个 60s 的 timer。
  // node --test 会等它，整个测试文件的 duration 会暴涨到 60s——以此作为回归锚点。
  const t0 = Date.now();
  await reviewSideWithTimeout({}, {}, { review: async () => ({ side: 'frontend' }), timeoutMs: 60_000 });
  assert.ok(Date.now() - t0 < 1000);
});
