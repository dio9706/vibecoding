/**
 * createInputQueue（插话输入队列）单测。
 * 语义：首条为初始 prompt；运行中可 push 插话；result 到达时 autoClose——
 * 无积压才关流（有刚插入的消息则继续下一轮），close 后 push 无效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputQueue } from './claude.js';

test('初始 prompt 与插话按序产出，close 后流结束', async () => {
  const q = createInputQueue('第一条');
  q.push('插话一');
  q.push('插话二');
  q.close();
  const out = [];
  for await (const m of q) out.push(m.message.content);
  assert.deepEqual(out, ['第一条', '插话一', '插话二']);
});

test('产出符合 SDK 用户消息结构', async () => {
  const q = createInputQueue('你好');
  q.close();
  const out = [];
  for await (const m of q) out.push(m);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    type: 'user',
    message: { role: 'user', content: '你好' },
    parent_tool_use_id: null,
  });
});

test('autoClose：无积压时关闭流', async () => {
  const q = createInputQueue('任务');
  const out = [];
  for await (const m of q) {
    out.push(m.message.content);
    q.autoClose(); // 模拟 result 到达
  }
  assert.deepEqual(out, ['任务']);
});

test('autoClose：有积压插话时不关闭，继续产出', async () => {
  const q = createInputQueue('任务');
  const out = [];
  for await (const m of q) {
    out.push(m.message.content);
    if (out.length === 1) {
      q.push('补充要求'); // result 前恰好插话（竞态）
      q.autoClose(); // 有积压 → 不得关闭
    } else {
      q.autoClose(); // 第二轮 result：无积压 → 关闭
    }
  }
  assert.deepEqual(out, ['任务', '补充要求']);
});

test('push 挂起中的消费者会被唤醒', async () => {
  const q = createInputQueue('任务');
  const out = [];
  const consumer = (async () => {
    for await (const m of q) out.push(m.message.content);
  })();
  await new Promise((r) => setTimeout(r, 10)); // 消费者消费完初始 prompt 后挂起
  q.push('插话');
  q.close();
  await consumer;
  assert.deepEqual(out, ['任务', '插话']);
});

test('close 后 push 返回 false 且不产出', async () => {
  const q = createInputQueue('任务');
  q.close();
  assert.equal(q.push('迟到'), false);
  const out = [];
  for await (const m of q) out.push(m.message.content);
  assert.deepEqual(out, ['任务']);
});
