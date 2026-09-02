// 消息分页加载的切片逻辑单元测试
// 这些是纯函数逻辑，不依赖 DOM
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 分页加载函数（与 chat.js 中的实现一致）
function getInitialSlice(msgs, limit = 30) {
  const offset = Math.min(limit, msgs.length);
  return { slice: msgs.slice(-offset), offset };
}

function getEarlierBatch(msgs, currentOffset, limit = 30) {
  const total = msgs.length;
  const newOffset = Math.min(currentOffset + limit, total);
  const batch = msgs.slice(total - newOffset, total - currentOffset);
  return { batch, newOffset };
}

// ---- 初始加载切片 ----

test('消息数 < 30：全部加载，offset = 实际数量', () => {
  const msgs = Array.from({ length: 15 }, (_, i) => ({ id: i }));
  const { slice, offset } = getInitialSlice(msgs);
  assert.equal(slice.length, 15);
  assert.equal(offset, 15);
  assert.deepEqual(slice[0], { id: 0 });
  assert.deepEqual(slice[14], { id: 14 });
});

test('消息数 = 30：全部加载，offset = 30', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ id: i }));
  const { slice, offset } = getInitialSlice(msgs);
  assert.equal(slice.length, 30);
  assert.equal(offset, 30);
  assert.deepEqual(slice[0], { id: 0 });
});

test('消息数 > 30：只加载最后 30 条', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const { slice, offset } = getInitialSlice(msgs);
  assert.equal(slice.length, 30);
  assert.equal(offset, 30);
  assert.deepEqual(slice[0], { id: 70 });   // 第 71 条
  assert.deepEqual(slice[29], { id: 99 });  // 最后一条
});

// ---- 向前加载批次 ----

test('向前加载：第一批（offset=30, total=100）', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const { batch, newOffset } = getEarlierBatch(msgs, 30);
  assert.equal(batch.length, 30);
  assert.equal(newOffset, 60);
  assert.deepEqual(batch[0], { id: 40 });  // msgs[40]
  assert.deepEqual(batch[29], { id: 69 }); // msgs[69]
});

test('向前加载：剩余不足 30 条时加载全部剩余', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const { batch, newOffset } = getEarlierBatch(msgs, 80); // 已加载 80，剩 20
  assert.equal(batch.length, 20);
  assert.equal(newOffset, 100);
  assert.deepEqual(batch[0], { id: 0 });   // 最早的消息
  assert.deepEqual(batch[19], { id: 19 });
});

test('向前加载：已全部加载时 batch 为空', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ id: i }));
  const { batch, newOffset } = getEarlierBatch(msgs, 50); // 已加载全部
  assert.equal(batch.length, 0);
  assert.equal(newOffset, 50); // 不超过 total
});

// ---- 边界情况 ----

test('空消息数组：初始 slice 为空，offset 为 0', () => {
  const msgs = [];
  const { slice, offset } = getInitialSlice(msgs);
  assert.equal(slice.length, 0);
  assert.equal(offset, 0);
});
