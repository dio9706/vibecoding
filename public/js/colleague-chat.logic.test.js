import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesSignature } from './colleague-chat.logic.js';

/**
 * 对话面板每 10s 轮询一次，靠「内容有没有变」决定要不要重绘（无脑重绘会打断用户正在选中的文本）。
 * 这个判据原先是**消息条数**，而 store 侧 MAX_MESSAGES=500 会从头截断：
 * 满 500 条之后条数恒为 500，判据恒真 → 面板永久停止刷新，新消息再也不显示。
 */

const mk = (n, prefix = 'cm_') => Array.from({ length: n }, (_, i) => ({ id: prefix + i }));

test('messagesSignature：满上限后条数不变、末条变了 —— 签名必须不同', () => {
  const before = mk(500);
  const after = [...before.slice(1), { id: 'cm_new' }]; // 截掉最老一条、追加一条新的
  assert.equal(before.length, after.length, '前提：条数一样，所以按条数判断会漏掉这次更新');
  assert.notEqual(messagesSignature(before), messagesSignature(after));
});

test('messagesSignature：内容没变时签名相同（不打断正在选中的文本）', () => {
  assert.equal(messagesSignature(mk(3)), messagesSignature(mk(3)));
});

test('messagesSignature：新增一条时签名变化', () => {
  assert.notEqual(messagesSignature(mk(3)), messagesSignature(mk(4)));
});

test('messagesSignature：空列表与非数组都给出稳定值，不炸', () => {
  assert.equal(messagesSignature([]), messagesSignature([]));
  assert.doesNotThrow(() => messagesSignature(null));
  assert.notEqual(messagesSignature([]), messagesSignature(mk(1)));
});
