import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canFix, fixButtonLabel, summarizeResults, scoreDelta, stepLabel, dirtyConfirmMessage,
} from './optimize-fix.logic.js';

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
  // refsUpdated / refsFailed 的形状以 demoteOne 的实际返回为准：
  // refsUpdated 是被改写的文件路径数组，refsFailed 是 {path, reason} 数组
  const s = summarizeResults([
    { status: 'done', skillName: 'a', refsUpdated: ['CLAUDE.md', 'docs/a.md', 'docs/b.md'], refsFailed: [] },
    { status: 'done', skillName: 'b', refsUpdated: [], refsFailed: [] },
    { status: 'skipped', reason: 'x' },
    { status: 'failed', reason: 'y' },
  ]);
  assert.equal(s.done, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.refsTotal, 3);
  assert.equal(s.text, '成功 2 · 跳过 1 · 失败 1');
});

test('统计没能改写成功的引用', () => {
  // 改写失败意味着文档里留了指向已删除文件的路径，必须让用户看见，不能只统计成功数
  const s = summarizeResults([
    { status: 'done', skillName: 'a', refsUpdated: ['CLAUDE.md'], refsFailed: [{ path: 'docs/x.md', reason: 'EPERM' }] },
  ]);
  assert.equal(s.refsTotal, 1);
  assert.equal(s.refsFailedTotal, 1);
});

test('缺少 refsUpdated / refsFailed 字段时按 0 计', () => {
  const s = summarizeResults([{ status: 'done', skillName: 'a' }]);
  assert.equal(s.refsTotal, 0);
  assert.equal(s.refsFailedTotal, 0);
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

test('进度阶段有中文说明', () => {
  // step 事件里的 phase 是后端的内部标识，直接摊给用户看等于没说
  assert.equal(stepLabel('describe'), '生成技能描述');
  assert.equal(stepLabel('write-skill'), '写入技能文件');
  assert.equal(stepLabel('delete-rule'), '删除原规则文件');
  assert.equal(stepLabel('replace-refs'), '改写文档引用');
});

test('未知阶段原样回显而不是显示 undefined', () => {
  // 后端将来加新阶段时，UI 不该因为没跟上就把进度行渲染成空白
  assert.equal(stepLabel('brand-new-phase'), 'brand-new-phase');
  assert.equal(stepLabel(''), '');
  assert.equal(stepLabel(undefined), '');
});

test('脏工作区确认文案要说清后果而不只是「有未提交改动」', () => {
  const msg = dirtyConfirmMessage({ dirtyCount: 3, isRepo: true });
  assert.match(msg, /3/);
  assert.match(msg, /混在一起/);
});

test('非 git 仓库的确认文案要点明没有 git 可回退', () => {
  // 有 git 时用户还能 git checkout 兜底；没有时只剩本工具的快照，风险口径不同
  const msg = dirtyConfirmMessage({ dirtyCount: 0, isRepo: false });
  assert.match(msg, /不是 git 仓库/);
  assert.doesNotMatch(msg, /未提交/);
});

test('分数变化容忍 null', () => {
  assert.equal(scoreDelta(null, 75), '75');
  assert.equal(scoreDelta(60, null), '60');
  assert.equal(scoreDelta(null, null), '--');
});

test('地图相关阶段有中文文案', () => {
  // 未知 phase 会被原样回显，所以「文案 === phase 名」就等于没配
  for (const phase of ['dead-link', 'gen-map', 'cancelling']) {
    const label = stepLabel(phase);
    assert.notEqual(label, phase, `${phase} 应有中文文案，实际回显了原始 phase`);
    assert.ok(label.length > 0);
  }
});
