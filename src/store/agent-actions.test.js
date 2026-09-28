import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAction, isUndoable, UNDO_KINDS } from './agent-actions.js';

// 只测纯函数：有 IO 的 appendAction/markUndone 靠 store/index.js 的文件锁保证，
// 且本仓 store 层单测一律不碰真实数据目录（dev 态 DATA_DIR 就是仓库根，会写脏用户数据）。

test('UNDO_KINDS：四种撤销方式', () => {
  assert.deepEqual([...UNDO_KINDS].sort(), ['delete-apidoc', 'discard-task', 'revert-merge', 'revert-req-change']);
});

test('normalizeAction：补齐缺失字段，不丢原值', () => {
  const a = normalizeAction({ tool: 'start_dev_task', colleagueId: 'cl_1' });
  assert.equal(a.tool, 'start_dev_task');
  assert.equal(a.colleagueId, 'cl_1');
  assert.ok(a.id, '必须补 id');
  assert.ok(a.at, '必须补时间戳');
  assert.equal(a.undone, false);
  assert.equal(a.undo, null);
});

test('normalizeAction：非法 undo.kind 归一为 null，不静默放行', () => {
  assert.equal(normalizeAction({ tool: 't', undo: { kind: 'yolo' } }).undo, null);
  assert.equal(normalizeAction({ tool: 't', undo: { kind: 'revert-merge', repo: 'D:/p' } }).undo.kind, 'revert-merge');
});

test('normalizeAction：合法 undo 的其余字段原样保留（撤销要靠它们）', () => {
  const undo = { kind: 'revert-merge', repo: 'D:/p', branch: 'b', baseBranch: 'main', mergeSha: 'abc' };
  assert.deepEqual(normalizeAction({ tool: 't', undo }).undo, undo);
});

test('normalizeAction：非对象输入不抛', () => {
  assert.equal(normalizeAction(null), null);
  assert.equal(normalizeAction('x'), null);
  assert.equal(normalizeAction([]), null);
});

test('normalizeAction：resultBrief 截断到 200 字', () => {
  const a = normalizeAction({ tool: 't', resultBrief: 'x'.repeat(500) });
  assert.equal(a.resultBrief.length, 200);
});

test('isUndoable：有 undo 且未撤销才可撤', () => {
  assert.equal(isUndoable({ undo: { kind: 'revert-merge' }, undone: false }), true);
  assert.equal(isUndoable({ undo: { kind: 'revert-merge' }, undone: true }), false, '撤过的不能再撤');
  assert.equal(isUndoable({ undo: null, undone: false }), false, 'external 档撤不回');
  assert.equal(isUndoable(null), false);
});

// —— 归一必须是「干净失败」而不是「强转」（2026-09-23 审查）：
// String({}) 得到 '[object Object]'，会把垃圾当成合法 id 存进台账，
// 之后按 id 查撤销永远查不到，而数据看起来是「有值的」。
test('normalizeAction：非字符串字段归空串，不强转成 [object Object]', () => {
  const a = normalizeAction({ tool: {}, colleagueId: 123, reqId: ['r_x'], msgId: true });
  assert.equal(a.tool, '');
  assert.equal(a.colleagueId, '');
  assert.equal(a.reqId, '');
  assert.equal(a.msgId, '');
});

test('normalizeAction：input 排除数组（数组不是合法的工具入参形状）', () => {
  assert.deepEqual(normalizeAction({ tool: 't', input: ['a', 'b'] }).input, {});
  assert.deepEqual(normalizeAction({ tool: 't', input: { reqId: 'r_1' } }).input, { reqId: 'r_1' });
});

test('normalizeAction：undo 是数组时归一为 null（不是对象就没有锚点）', () => {
  assert.equal(normalizeAction({ tool: 't', undo: ['revert-merge'] }).undo, null);
});
