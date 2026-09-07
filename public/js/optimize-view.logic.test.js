import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIM_META, CATEGORY_META, dimListFrom, severityRank, sortIssues, groupDims, groupSummary,
  checkupAge, STALE_CHECKUP_DAYS,
} from './optimize-view.logic.js';
import { displayDimensions, CATEGORIES } from '../../src/features/project-checkup/dimensions/registry.js';

test('前端维度表与后端注册表逐项一致（漂移护栏）', () => {
  // 前端不能直接 import 注册表（那是 node 端模块，还会把整条召回器依赖链拖进浏览器），
  // 所以 DIM_META 是手抄的镜像。这条测试是那份手抄的唯一保障——
  // 后端加了维度而前端忘了加，会在这里报失败，而不是变成一个「算出来但不显示」的静默 bug
  const backend = displayDimensions();
  assert.deepEqual(
    DIM_META.map((d) => d.key).sort(),
    backend.map((d) => d.id).sort(),
    '前后端维度集合必须完全相同',
  );

  const byId = new Map(backend.map((d) => [d.id, d]));
  for (const d of DIM_META) {
    assert.equal(d.label, byId.get(d.key).label, `${d.key} 的 label 与后端不一致`);
    assert.equal(d.category, byId.get(d.key).category, `${d.key} 的 category 与后端不一致`);
  }
});

test('分组表与后端的域定义一致', () => {
  assert.deepEqual(
    CATEGORY_META.map((c) => c.key).sort(),
    CATEGORIES.map((c) => c.key).sort(),
  );
});

test('holistic 排在最前（它就是「先看哪儿」的答案，放末尾没人会滚到）', () => {
  assert.equal(DIM_META[0].key, 'holistic');
  assert.equal(CATEGORY_META[0].key, 'holistic');
});

test('每个维度都有中文标签和说明', () => {
  for (const d of DIM_META) {
    assert.ok(d.label && d.label.length > 0, `${d.key} 缺 label`);
    assert.ok(d.hint && d.hint.length > 0, `${d.key} 缺 hint`);
    assert.ok(d.category && d.category.length > 0, `${d.key} 缺 category`);
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
  const map = list.find((d) => d.key === 'map');
  assert.equal(map.scoreText, '80');
  assert.equal(map.selectable, true);
  assert.equal(map.issueCount, 1);

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
  const map = list.find((d) => d.key === 'map');
  assert.equal(map.scoreText, '0');
  assert.equal(map.selectable, true);
});

test('报告为空时全部维度显示 --', () => {
  const list = dimListFrom(null);
  assert.equal(list.length, DIM_META.length);
  assert.ok(list.every((d) => d.scoreText === '--' && d.selectable === false));
});

test('报告缺 dims 键时不崩', () => {
  const list = dimListFrom({});
  assert.equal(list.length, DIM_META.length);
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

test('dimListFrom 把 holistic 的行动计划带出来（卡片要单独渲染成一块）', () => {
  const plan = { score: 68, verdict: 'v', topActions: [{ title: 't', priority: 'now', files: [], why: '', done: '' }] };
  const list = dimListFrom({ dims: { holistic: { score: 68, status: 'done', issues: [], plan } } });
  assert.deepEqual(list.find((d) => d.key === 'holistic').plan, plan);
  assert.equal(list.find((d) => d.key === 'map').plan, null, '别的维度没有 plan');
});

test('groupDims 按域切分并丢掉空组（空标题只是噪声）', () => {
  const groups = groupDims(dimListFrom(null));
  assert.deepEqual(groups.map((g) => g.key), CATEGORY_META.map((c) => c.key));
  for (const g of groups) assert.ok(g.dims.length > 0);
  assert.deepEqual(
    groupDims([{ key: 'map', category: 'ai' }]).map((g) => g.key),
    ['ai'],
    '只有一个维度时只该出一个组',
  );
});

test('groupSummary 折叠后仍能看出这个域好不好', () => {
  const dims = [
    { score: 80, issueCount: 2 },
    { score: 60, issueCount: 1 },
    { score: null, issueCount: 0 },
  ];
  const s = groupSummary(dims);
  assert.match(s, /2\/3 已出结果/);
  assert.match(s, /均分 70/);
  assert.match(s, /3 个问题/);
});

test('groupSummary 在全部待分析时不硬算均分', () => {
  assert.equal(groupSummary([{ score: null, issueCount: 0 }, { score: null, issueCount: 0 }]), '2 项待分析');
});

// ---------- 报告新鲜度（超过一个月要标红 + 挂「长时间未体检」） ----------

test('checkupAge 按天数判超期，阈值取 30 天', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();

  assert.deepEqual(checkupAge(at(0), now), { days: 0, stale: false });
  assert.deepEqual(checkupAge(at(29), now), { days: 29, stale: false });
  assert.deepEqual(checkupAge(at(30), now), { days: 30, stale: true }, '刚好 30 天就该提示');
  assert.equal(checkupAge(at(200), now).stale, true);
  assert.equal(STALE_CHECKUP_DAYS, 30);
});

test('checkupAge 拿不到时间就不指责用户没体检', () => {
  assert.deepEqual(checkupAge(undefined), { days: null, stale: false });
  assert.deepEqual(checkupAge('不是时间'), { days: null, stale: false });
});
