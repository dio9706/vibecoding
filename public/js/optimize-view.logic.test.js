import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIM_META, dimListFrom, severityRank, sortIssues } from './optimize-view.logic.js';

test('维度元信息覆盖六个维度且顺序固定', () => {
  // tests 紧随 map（两者都是高权重的健壮性信号），hygiene 收尾；
  // 原先恒为 disabled 的 deadcode 已由 hygiene 取代
  assert.deepEqual(
    DIM_META.map((d) => d.key),
    ['map', 'tests', 'prompts', 'rules', 'comments', 'hygiene'],
  );
});

test('每个维度都有中文标签和说明', () => {
  for (const d of DIM_META) {
    assert.ok(d.label && d.label.length > 0, `${d.key} 缺 label`);
    assert.ok(d.hint && d.hint.length > 0, `${d.key} 缺 hint`);
  }
});

test('从报告生成维度列表,带上可勾选状态', () => {
  const report = {
    dims: {
      map: { score: 80, status: 'done', issues: [{ code: 'X', severity: 'warn', file: 'a', line: 1 }] },
      prompts: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
      rules: { score: 55, status: 'done', issues: [] },
      comments: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
      tests: { score: 70, status: 'done', issues: [] },
      hygiene: { score: null, status: 'na', issues: [], reason: '不是 git 仓库' },
    },
  };
  const list = dimListFrom(report);
  assert.equal(list[0].key, 'map');
  assert.equal(list[0].scoreText, '80');
  assert.equal(list[0].selectable, true);
  assert.equal(list[0].issueCount, 1);

  // na 维度：无分数、不可勾选，但要把原因透出来
  const hygiene = list.find((d) => d.key === 'hygiene');
  assert.equal(hygiene.selectable, false);
  assert.equal(hygiene.scoreText, '--');
  assert.equal(hygiene.reason, '不是 git 仓库');

  // pending 不可勾选：还没有结果，无从优化
  assert.equal(list.find((d) => d.key === 'prompts').selectable, false);
});

test('analyzing 维度转圈、不可勾选、不显示分数', () => {
  const list = dimListFrom({
    dims: { prompts: { score: null, status: 'analyzing', issues: [], reason: 'AI 分析中…' } },
  });
  const prompts = list.find((d) => d.key === 'prompts');
  assert.equal(prompts.busy, true);
  assert.equal(prompts.selectable, false);
  assert.equal(prompts.scoreText, '--');
});

test('非 analyzing 维度 busy 为 false', () => {
  const list = dimListFrom({ dims: { map: { score: 80, status: 'done', issues: [] } } });
  assert.ok(list.every((d) => d.busy === false));
});

test('partial 维度显示分数但标注未深度分析,且不可勾选', () => {
  const list = dimListFrom({
    dims: { prompts: { score: 42, status: 'partial', issues: [], reason: 'LLM 分析未完成' } },
  });
  const prompts = list.find((d) => d.key === 'prompts');
  assert.equal(prompts.scoreText, '42');
  assert.equal(prompts.selectable, false); // 结论不完整,不该参与一键优化
  assert.equal(prompts.busy, false);
  assert.ok(prompts.note.includes('未深度分析'), `note 应标注未深度分析,实际:${prompts.note}`);
});

test('partial 但没分数时仍显示 --', () => {
  // 注释维度的 partial 是 score:null（提示词维度则给保守占位分），两种都要能渲染
  const list = dimListFrom({
    dims: { comments: { score: null, status: 'partial', issues: [], reason: 'LLM 分析未完成' } },
  });
  const comments = list.find((d) => d.key === 'comments');
  assert.equal(comments.scoreText, '--');
  assert.ok(comments.note.includes('未深度分析'));
});

test('done 维度没有附加标注', () => {
  const list = dimListFrom({ dims: { map: { score: 80, status: 'done', issues: [] } } });
  assert.equal(list.find((d) => d.key === 'map').note, '');
});

test('error 维度不可勾选且不转圈', () => {
  const list = dimListFrom({
    dims: { comments: { score: null, status: 'error', issues: [], reason: '分析失败：超时' } },
  });
  const comments = list.find((d) => d.key === 'comments');
  assert.equal(comments.selectable, false);
  assert.equal(comments.busy, false);
  assert.equal(comments.reason, '分析失败：超时');
});

test('score 为 0 时不能显示成 --', () => {
  // 0 分是合法分数（比如项目根本没有 CLAUDE.md），不是「无结果」
  const list = dimListFrom({ dims: { map: { score: 0, status: 'done', issues: [] } } });
  assert.equal(list[0].scoreText, '0');
  assert.equal(list[0].selectable, true);
});

test('报告为空时全部维度显示 --', () => {
  const list = dimListFrom(null);
  assert.equal(list.length, 6);
  assert.ok(list.every((d) => d.scoreText === '--' && d.selectable === false));
});

test('报告缺 dims 键时不崩', () => {
  const list = dimListFrom({});
  assert.equal(list.length, 6);
  assert.ok(list.every((d) => d.scoreText === '--'));
});

test('问题按严重度排序', () => {
  const issues = [
    { severity: 'info', file: 'b.md', line: 1 },
    { severity: 'error', file: 'a.md', line: 5 },
    { severity: 'warn', file: 'a.md', line: 2 },
  ];
  assert.deepEqual(sortIssues(issues).map((i) => i.severity), ['error', 'warn', 'info']);
});

test('同严重度按文件名和行号排', () => {
  const issues = [
    { severity: 'warn', file: 'b.md', line: 1 },
    { severity: 'warn', file: 'a.md', line: 9 },
    { severity: 'warn', file: 'a.md', line: 2 },
  ];
  assert.deepEqual(sortIssues(issues).map((i) => `${i.file}:${i.line}`), ['a.md:2', 'a.md:9', 'b.md:1']);
});

test('sortIssues 不修改原数组', () => {
  const issues = [{ severity: 'info', file: 'b', line: 1 }, { severity: 'error', file: 'a', line: 1 }];
  const copy = [...issues];
  sortIssues(issues);
  assert.deepEqual(issues, copy);
});

test('sortIssues 接受空值', () => {
  assert.deepEqual(sortIssues(null), []);
  assert.deepEqual(sortIssues(undefined), []);
  assert.deepEqual(sortIssues([]), []);
});

test('severityRank 未知值排最后', () => {
  assert.ok(severityRank('unknown') > severityRank('info'));
});
