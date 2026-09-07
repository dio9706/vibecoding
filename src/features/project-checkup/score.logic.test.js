import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHTS, aggregateScore, gradeOf } from './score.logic.js';
import { DIMENSIONS } from './dimensions/registry.js';
import { scoreOf } from './audit-engine.logic.js';

test('权重合计为 100', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

test('WEIGHTS 由注册表派生，且不含 holistic 与 augment 型条目', () => {
  // holistic 是对其它维度的元评估，计入总分等于把同一批问题数两遍；
  // augment 型条目（hygiene-audit）的结果并进宿主维度，自己不该再占权重。
  // 两者在注册表里都靠「省略 weight」表达，这条测试是那个约定的护栏
  assert.equal(WEIGHTS.holistic, undefined);
  assert.equal(WEIGHTS['hygiene-audit'], undefined);

  const declared = DIMENSIONS.filter((d) => typeof d.weight === 'number').map((d) => d.id).sort();
  assert.deepEqual(Object.keys(WEIGHTS).sort(), declared);
});

test('每个参与加权的维度都声明了判据出处与所属域', () => {
  for (const d of DIMENSIONS) {
    assert.ok(d.source, `${d.id} 缺 source（判据出处要给用户看，让结论可争辩）`);
    assert.ok(d.category, `${d.id} 缺 category`);
  }
});

test('全维度可用时按权重加权', () => {
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: 100, status: 'done' },
    comments: { score: 100, status: 'done' },
  });
  assert.equal(r.total, 100);
});

test('不同分数按权重加权', () => {
  const r = aggregateScore({
    map: { score: 60, status: 'done' },
    prompts: { score: 80, status: 'done' },
    rules: { score: 100, status: 'done' },
    comments: { score: 90, status: 'done' },
  });
  // 只有这四维 done：权重 map10 + prompts11 + rules4 + comments4 = 29
  // (60*10 + 80*11 + 100*4 + 90*4) / 29 = 2240/29 = 77.2 → 77
  assert.equal(r.total, 77);
});

test('N/A 维度的权重按比例分给其余维度', () => {
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: null, status: 'na' },
    comments: { score: 100, status: 'done' },
  });
  assert.equal(r.total, 100);
});

test('pending 维度不计入总分', () => {
  const r = aggregateScore({
    map: { score: 80, status: 'done' },
    prompts: { score: null, status: 'pending' },
    rules: { score: 60, status: 'done' },
    comments: { score: null, status: 'pending' },
  });
  // 只有 map(10) 和 rules(4) 参与：(80×10 + 60×4) / 14 = 1040/14 = 74.3 → 74
  assert.equal(r.total, 74);
  assert.deepEqual(r.countedDims.sort(), ['map', 'rules']);
});

test('disabled 维度不计入总分', () => {
  const r = aggregateScore({
    map: { score: 90, status: 'done' },
    prompts: { score: null, status: 'disabled' },
    rules: { score: null, status: 'disabled' },
    comments: { score: null, status: 'disabled' },
  });
  assert.equal(r.total, 90);
  assert.deepEqual(r.countedDims, ['map']);
});

test('缺失的维度键不会崩', () => {
  const r = aggregateScore({ map: { score: 70, status: 'done' } });
  assert.equal(r.total, 70);
});

test('score 不是数字时排除该维度', () => {
  const r = aggregateScore({
    map: { score: 70, status: 'done' },
    prompts: { score: 'abc', status: 'done' },
  });
  assert.equal(r.total, 70);
  assert.deepEqual(r.countedDims, ['map']);
});

test('全部不可用时总分为 null', () => {
  const r = aggregateScore({
    map: { score: null, status: 'pending' },
    prompts: { score: null, status: 'pending' },
    rules: { score: null, status: 'na' },
    comments: { score: null, status: 'pending' },
  });
  assert.equal(r.total, null);
  assert.equal(r.grade, null);
  assert.deepEqual(r.countedDims, []);
});

test('多维度加权（权重表变更的护栏）', () => {
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: 100, status: 'done' },
    comments: { score: 100, status: 'done' },
    tests: { score: 0, status: 'done' },
    hygiene: { score: 0, status: 'done' },
  });
  // 权重 map10 + prompts11 + rules4 + comments4 + tests12 + hygiene4 = 45
  // (100*10 + 100*11 + 100*4 + 100*4 + 0*12 + 0*4) / 45 = 2900/45 = 64.4 → 64
  assert.equal(r.total, 64);
  assert.equal(r.countedDims.length, 6);
});

test('新维度为 na 时权重按比例分摊给其余维度', () => {
  const r = aggregateScore({
    map: { score: 80, status: 'done' },
    prompts: { score: null, status: 'na' },
    rules: { score: null, status: 'na' },
    comments: { score: null, status: 'na' },
    tests: { score: 60, status: 'done' },
    hygiene: { score: null, status: 'na' },
  });
  // 只有 map(10) 和 tests(12) 参与：(80*10 + 60*12) / 22 = 1520/22 = 69.1 → 69
  assert.equal(r.total, 69);
  assert.deepEqual(r.countedDims.sort(), ['map', 'tests']);
});

test('档位映射', () => {
  assert.equal(gradeOf(95).key, 'healthy');
  assert.equal(gradeOf(90).key, 'healthy');
  assert.equal(gradeOf(89).key, 'good');
  assert.equal(gradeOf(70).key, 'good');
  assert.equal(gradeOf(69).key, 'needs-work');
  assert.equal(gradeOf(50).key, 'needs-work');
  assert.equal(gradeOf(49).key, 'poor');
  assert.equal(gradeOf(0).key, 'poor');
  assert.equal(gradeOf(null), null);
  assert.equal(gradeOf(undefined), null);
});

test('档位带中文标签和 CSS 变量名', () => {
  const g = gradeOf(95);
  assert.equal(g.label, '健康');
  assert.equal(g.cssVar, '--green');
});

// ---------- 判分曲线的分辨力护栏（回归：structure 4 条就打满，修一半看不到变化） ----------

test('absolute 判分的维度不能在少量问题时就打满上限（否则修一半没反馈）', () => {
  // 2026-09-03 实测：structure 旧值 violation=20 / 上限 80 → 4 条即触顶，
  // 8 条和 4 条同为 20 分。用户修掉一半却看不到任何变化，指标就失去了反馈作用。
  // 这条测试钉住「最严重档连出 4 条时，分数仍要高于底线」这个不变式
  for (const dim of DIMENSIONS.filter((d) => d.scoring?.mode === 'absolute')) {
    const worst = Object.entries(dim.verdicts)
      .sort((a, b) => b[1].weight - a[1].weight)[0];
    if (!worst || !worst[1].weight) continue;

    const four = Array.from({ length: 4 }, () => ({ verdict: worst[0] }));
    const floor = 100 - dim.scoring.maxDeduct;
    const score = scoreOf(dim, four, 437);
    assert.ok(
      score > floor,
      `${dim.id}：4 条「${worst[0]}」就得到 ${score} 分（底线 ${floor}），`
      + '之后再多问题也不会变——分辨力已经丢了，请下调单条权重或抬高 maxDeduct',
    );
  }
});

test('structure 的判分曲线（改动权重要是有意为之）', () => {
  const dim = DIMENSIONS.find((d) => d.id === 'structure');
  const n = (count) => scoreOf(dim, Array.from({ length: count }, () => ({ verdict: 'violation' })), 437);
  assert.equal(n(1), 91);
  assert.equal(n(4), 64, '修掉一半要能看到明显变化');
  assert.equal(n(8), 28);
});

test('security 单条可利用漏洞就足以让这一维很难看', () => {
  const dim = DIMENSIONS.find((d) => d.id === 'security');
  const n = (count) => scoreOf(dim, Array.from({ length: count }, () => ({ verdict: 'vulnerable' })), 437);
  assert.equal(n(1), 78, '一个漏洞不该只扣几分');
  assert.ok(n(2) < n(1) && n(3) < n(2), '前几条要保持刻度');
});
