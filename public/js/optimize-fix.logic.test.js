import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFix, fixButtonLabel, summarizeResults, scoreDelta } from './optimize-fix.logic.js';

test('可优化条件：有报告 + 有勾选 + 不在跑', () => {
  assert.equal(canFix({ hasReport: true, selected: ['rules'], running: false }), true);
  assert.equal(canFix({ hasReport: false, selected: ['rules'], running: false }), false);
  assert.equal(canFix({ hasReport: true, selected: [], running: false }), false);
  assert.equal(canFix({ hasReport: true, selected: ['rules'], running: true }), false);
});

test('canFix 容忍缺省参数', () => {
  assert.equal(canFix({}), false);
  assert.equal(canFix({ hasReport: true }), false);
});

test('按钮文案随状态变化', () => {
  assert.equal(fixButtonLabel(false), '一键优化');
  assert.equal(fixButtonLabel(true), '优化中…');
});

test('结果分组统计', () => {
  const s = summarizeResults([
    { status: 'done', skillName: 'a', refsUpdated: 3 },
    { status: 'done', skillName: 'b', refsUpdated: 0 },
    { status: 'skipped', reason: 'x' },
    { status: 'failed', reason: 'y' },
  ]);
  assert.equal(s.done, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.refsTotal, 3);
  assert.equal(s.text, '成功 2 · 跳过 1 · 失败 1');
});

test('空结果给出可读文案', () => {
  const s = summarizeResults([]);
  assert.equal(s.done, 0);
  assert.equal(s.text, '没有可处理的项');
});

test('summarizeResults 接受 null/undefined', () => {
  assert.equal(summarizeResults(null).done, 0);
  assert.equal(summarizeResults(undefined).text, '没有可处理的项');
});

test('标记出用机械模板生成 description 的项', () => {
  // 这类 description 质量差，UI 要提示用户复核
  const s = summarizeResults([
    { status: 'done', skillName: 'a', descriptionSource: 'llm' },
    { status: 'done', skillName: 'b', descriptionSource: 'fallback' },
  ]);
  assert.equal(s.fallbackCount, 1);
  assert.deepEqual(s.fallbackNames, ['b']);
});

test('分数变化文案', () => {
  assert.equal(scoreDelta(60, 75), '60 → 75（+15）');
  assert.equal(scoreDelta(75, 60), '75 → 60（-15）');
  assert.equal(scoreDelta(70, 70), '70 → 70（无变化）');
});

test('分数变化容忍 null', () => {
  assert.equal(scoreDelta(null, 75), '75');
  assert.equal(scoreDelta(60, null), '60');
  assert.equal(scoreDelta(null, null), '--');
});
