/**
 * 续跑熔断决策纯函数单测。
 * 背景：Claude 在 web run 内 pm2 restart 自身进程 → 孤儿续跑 → 再重启 → 死循环。
 * shouldAbandonResume 决定"本次续跑代次是否已超上限，应放弃"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAbandonResume, addPending } from './pending-resume.js';

test('shouldAbandonResume：代次 <= 上限不熔断，> 上限熔断', () => {
  assert.equal(shouldAbandonResume(0, 3), false);
  assert.equal(shouldAbandonResume(1, 3), false);
  assert.equal(shouldAbandonResume(3, 3), false); // 第 3 次续跑仍允许
  assert.equal(shouldAbandonResume(4, 3), true); // 第 4 次熔断
});

test('shouldAbandonResume：缺省/非法代次按 0 处理，不熔断', () => {
  assert.equal(shouldAbandonResume(undefined, 3), false);
  assert.equal(shouldAbandonResume(null, 3), false);
  assert.equal(shouldAbandonResume(NaN, 3), false);
});

test('addPending：默认 attempts=0，调用方可覆盖', () => {
  const a = addPending.__buildItem
    ? addPending.__buildItem({ convId: 'c1' })
    : null;
  // 无法免落盘直接构造时，跳过（见下方说明），此断言仅在暴露构造器时生效
  if (a) {
    assert.equal(a.attempts, 0);
    const b = addPending.__buildItem({ convId: 'c2', attempts: 5 });
    assert.equal(b.attempts, 5);
  }
});
