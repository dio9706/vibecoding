import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIM_META, dimListFrom, severityRank, sortIssues } from './optimize-view.logic.js';

test('维度元信息覆盖五个维度且顺序固定', () => {
  assert.deepEqual(DIM_META.map((d) => d.key), ['map', 'prompts', 'rules', 'deadcode', 'comments']);
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
      deadcode: { score: null, status: 'disabled', issues: [], reason: '即将支持' },
      comments: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
    },
  };
  const list = dimListFrom(report);
  assert.equal(list[0].key, 'map');
  assert.equal(list[0].scoreText, '80');
  assert.equal(list[0].selectable, true);
  assert.equal(list[0].issueCount, 1);

  const deadcode = list.find((d) => d.key === 'deadcode');
  assert.equal(deadcode.selectable, false);
  assert.equal(deadcode.scoreText, '--');
  assert.equal(deadcode.reason, '即将支持');

  // pending 不可勾选：还没有结果，无从优化
  assert.equal(list.find((d) => d.key === 'prompts').selectable, false);
});

test('score 为 0 时不能显示成 --', () => {
  // 0 分是合法分数（比如项目根本没有 CLAUDE.md），不是「无结果」
  const list = dimListFrom({ dims: { map: { score: 0, status: 'done', issues: [] } } });
  assert.equal(list[0].scoreText, '0');
  assert.equal(list[0].selectable, true);
});

test('报告为空时全部维度显示 --', () => {
  const list = dimListFrom(null);
  assert.equal(list.length, 5);
  assert.ok(list.every((d) => d.scoreText === '--' && d.selectable === false));
});

test('报告缺 dims 键时不崩', () => {
  const list = dimListFrom({});
  assert.equal(list.length, 5);
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
