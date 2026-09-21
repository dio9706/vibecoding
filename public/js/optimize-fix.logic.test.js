import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeResults, scoreDelta, stepLabel, dirtyConfirmMessage, kindLabel, fixRowState,
} from './optimize-fix.logic.js';

// 注：原 canFix / fixButtonLabel 的测试随函数一并移除 ——
// 按钮判定已移交 optimize-plan.logic.js 的 topButtonsState，
// 那边的测试覆盖了包括 done-all 在内的全部五种状态。

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

test('kindLabel 把结果类型翻成人话，未知类型原样回显', () => {
  // 不显示 kind 的话，「重构了 src/a.js」和「为 src/a.js 写了条清单」在结果列表里长得一样，
  // 而这正是风险分级要让用户看清的东西
  assert.equal(kindLabel('refactor'), '重构源码');
  assert.equal(kindLabel('advisory'), '整改清单');
  assert.equal(kindLabel('create-test'), '新建测试');
  assert.equal(kindLabel('untrack'), '脱离 git 索引');
  assert.equal(kindLabel('将来加的新策略'), '将来加的新策略', '后端加新类型时至少看得到标识');
  assert.equal(kindLabel(undefined), '');
});

// ---- fixRowState：issue 行在本轮修复里的进度态 ----

/** 常用参数的默认底座，每个用例只覆盖它关心的那几个字段 */
const rowArgs = (over = {}) => ({
  inRound: true,
  dim: 'deadcode',
  file: 'src/a.js',
  activeDim: '',
  seenDims: new Set(),
  doneFiles: new Map(),
  ...over,
});

test('fixRowState：不在本轮的行恒为 idle（不管进度跑到哪）', () => {
  assert.equal(
    fixRowState(rowArgs({ inRound: false, activeDim: 'deadcode', seenDims: new Set(['deadcode']) })),
    'idle',
  );
  // 连它自己的文件都出结果了也一样 —— 没勾就不该被本轮的进度染色
  assert.equal(
    fixRowState(rowArgs({ inRound: false, doneFiles: new Map([['src/a.js', 'done']]) })),
    'idle',
  );
});

test('fixRowState：维度还没开跑 → 排队中；正在跑 → 修复中', () => {
  assert.equal(fixRowState(rowArgs({ activeDim: 'comments', seenDims: new Set(['comments']) })), 'queued');
  assert.equal(fixRowState(rowArgs({ activeDim: 'deadcode', seenDims: new Set(['deadcode']) })), 'running');
});

test('fixRowState：维度已跑过但这一条没等到 file 事件 → done（整改清单是整维一个文件，不逐条回报）', () => {
  assert.equal(
    fixRowState(rowArgs({ activeDim: 'naming', seenDims: new Set(['deadcode', 'naming']) })),
    'done',
  );
});

test('fixRowState：文件结果落定后以它为准，status 非 done 一律 failed（fail-closed）', () => {
  // 即使该维度还在跑，自己这个文件已经出结果了就落定
  assert.equal(
    fixRowState(rowArgs({ activeDim: 'deadcode', seenDims: new Set(['deadcode']), doneFiles: new Map([['src/a.js', 'done']]) })),
    'done',
  );
  for (const st of ['failed', 'skipped', '未来新增的值']) {
    assert.equal(
      fixRowState(rowArgs({ activeDim: 'deadcode', seenDims: new Set(['deadcode']), doneFiles: new Map([['src/a.js', st]]) })),
      'failed',
      `status=${st} 应按未完成显示`,
    );
  }
  // 别的文件出结果不影响本行
  assert.equal(
    fixRowState(rowArgs({ activeDim: 'deadcode', seenDims: new Set(['deadcode']), doneFiles: new Map([['src/b.js', 'done']]) })),
    'running',
  );
});

test('fixRowState：缺 dim / 缺集合时不炸，退到 queued', () => {
  assert.equal(fixRowState(rowArgs({ dim: '', activeDim: 'deadcode' })), 'queued');
  assert.equal(fixRowState({ inRound: true, dim: 'deadcode', file: 'src/a.js' }), 'queued');
});
