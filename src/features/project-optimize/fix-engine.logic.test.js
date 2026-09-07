import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strategiesOf, claims, partitionIssues, selectFixableDims, needsTestGate, BESPOKE_DIMS,
  riskOf, risksFor, dimHasWorkAt,
} from './fix-engine.logic.js';

const issue = (over = {}) => ({ code: 'X1_MUST_SPLIT', file: 'src/a.js', line: 1, message: 'm', ...over });

test('strategiesOf 同时接受字符串与数组，缺省兜底 advisory', () => {
  assert.deepStrictEqual(strategiesOf({ fix: 'advisory' }), ['advisory']);
  assert.deepStrictEqual(strategiesOf({ fix: ['deterministic', 'llm-rewrite'] }), ['deterministic', 'llm-rewrite']);
  assert.deepStrictEqual(strategiesOf({}), ['advisory']);
});

test('claims：deterministic 只认它的 issue 码', () => {
  assert.ok(claims('deterministic', issue({ code: 'H1_RUNTIME_DATA_TRACKED' })));
  assert.ok(claims('deterministic', issue({ code: 'P4_DUPLICATE' })));
  assert.ok(!claims('deterministic', issue({ code: 'X1_MUST_SPLIT' })));
});

test('claims：rewrite 与 refactor 按扩展名切开（这是安全边界，不是分类偏好）', () => {
  assert.ok(claims('llm-rewrite', issue({ file: 'README.md' })));
  assert.ok(!claims('llm-rewrite', issue({ file: 'src/a.js' })));
  assert.ok(claims('llm-refactor', issue({ file: 'src/a.js' })));
  assert.ok(!claims('llm-refactor', issue({ file: 'README.md' })), '源码策略不该碰文档，反之亦然');
});

test('claims：没有具体文件的 issue 不可定点编辑，只有 advisory 认领', () => {
  const noFile = issue({ file: '.' });
  assert.ok(!claims('llm-refactor', noFile));
  assert.ok(!claims('llm-rewrite', noFile));
  assert.ok(!claims('llm-create', noFile));
  assert.ok(claims('advisory', noFile));
});

test('partitionIssues 把无人认领的 issue 全部兜进 advisory（不静默丢弃）', () => {
  const issues = [
    issue({ code: 'H1_RUNTIME_DATA_TRACKED', file: 'a.log' }),
    issue({ code: 'X1_MUST_SPLIT', file: 'src/a.js' }),
    issue({ code: 'G1_CONTRADICTION', file: '.' }),
  ];
  const r = partitionIssues({ dim: { id: 'x', fix: ['deterministic'] }, issues });

  assert.deepStrictEqual(r.byStrategy.map((s) => s.strategy), ['deterministic']);
  assert.equal(r.byStrategy[0].issues.length, 1);
  assert.equal(r.advisory.length, 2, '另外两条没人认领，必须进清单');
  assert.equal(r.degraded, false);
});

test('partitionIssues 同一条 issue 不会被两个策略各改一遍', () => {
  const issues = [issue({ code: 'P4_DUPLICATE', file: 'CLAUDE.md' })];
  const r = partitionIssues({ dim: { id: 'prompts', fix: ['deterministic', 'llm-rewrite'] }, issues });

  assert.deepStrictEqual(r.byStrategy.map((s) => s.strategy), ['deterministic']);
  assert.equal(r.advisory.length, 0);
});

test('partitionIssues 在测试闸关闭时摘掉 refactor，全部转进 advisory 并带上原因', () => {
  const issues = [issue(), issue({ file: 'src/b.js' })];
  const r = partitionIssues({
    dim: { id: 'complexity', fix: 'llm-refactor' },
    issues,
    gateAllowed: false,
    gateReason: '项目没有可执行的测试命令',
  });

  assert.deepStrictEqual(r.byStrategy, [], '不该让 refactor 跑一遍再逐个失败（那会白烧 LLM 调用）');
  assert.equal(r.advisory.length, 2);
  assert.equal(r.degraded, true);
  assert.equal(r.degradeReason, '项目没有可执行的测试命令');
});

test('partitionIssues 对不含 refactor 的维度，闸的开合无影响', () => {
  const r = partitionIssues({
    dim: { id: 'security', fix: 'advisory' },
    issues: [issue()],
    gateAllowed: false,
    gateReason: 'r',
  });
  assert.equal(r.degraded, false);
  assert.equal(r.degradeReason, '');
  assert.equal(r.advisory.length, 1);
});

const DIMS = [
  { id: 'map', fix: 'llm-rewrite' },
  { id: 'rules', fix: 'deterministic' },
  { id: 'complexity', fix: 'llm-refactor' },
  { id: 'security', fix: 'advisory' },
  { id: 'hygiene-audit', augments: 'hygiene', fix: 'deterministic' },
];

test('selectFixableDims 排除专用流程维度与 augment 条目', () => {
  const report = {
    dims: {
      map: { status: 'done', issues: [issue()] },
      rules: { status: 'done', issues: [issue()] },
      complexity: { status: 'done', issues: [issue()] },
      security: { status: 'done', issues: [issue()] },
      'hygiene-audit': { status: 'done', issues: [issue()] },
    },
  };
  const ids = selectFixableDims({ dimensions: DIMS, report }).map((s) => s.dim.id);
  assert.deepStrictEqual(ids, ['complexity', 'security']);
  assert.ok(BESPOKE_DIMS.has('map') && BESPOKE_DIMS.has('rules'));
});

test('selectFixableDims 只要跑出完整结果的维度（partial 的结论不完整）', () => {
  const report = {
    dims: {
      complexity: { status: 'partial', issues: [issue()] },
      security: { status: 'done', issues: [] },
    },
  };
  assert.deepStrictEqual(selectFixableDims({ dimensions: DIMS, report }), []);
});

test('selectFixableDims 尊重勾选；空数组视为全都要（旧前端行为）', () => {
  const report = {
    dims: {
      complexity: { status: 'done', issues: [issue()] },
      security: { status: 'done', issues: [issue()] },
    },
  };
  assert.deepStrictEqual(
    selectFixableDims({ dimensions: DIMS, report, requested: ['security'] }).map((s) => s.dim.id),
    ['security'],
  );
  assert.equal(selectFixableDims({ dimensions: DIMS, report, requested: [] }).length, 2);
});

test('needsTestGate 只在真有源码重构时才要求开闸（开闸要跑几分钟测试）', () => {
  assert.equal(needsTestGate([{ dim: { fix: 'llm-refactor' } }]), true);
  assert.equal(needsTestGate([{ dim: { fix: 'advisory' } }, { dim: { fix: 'llm-rewrite' } }]), false);
  assert.equal(needsTestGate([]), false);
});

// ---------- fixable 的逐条否决权（回归：tests S1 被当成「给 package.json 补测试」） ----------

test('claims 尊重检测器的 fixable:false（逐条否决自动修）', () => {
  const vetoed = issue({ fixable: false, file: 'src/a.js' });
  assert.ok(!claims('llm-refactor', vetoed));
  assert.ok(!claims('llm-create', vetoed));
  assert.ok(!claims('llm-rewrite', issue({ fixable: false, file: 'README.md' })));
  assert.ok(!claims('deterministic', issue({ fixable: false, code: 'H1_RUNTIME_DATA_TRACKED' })));
  assert.ok(claims('advisory', vetoed), 'advisory 是兜底，被否决的正要落到它这里');
});

test('claims 在没有 fixable 字段时不受影响（老 issue 形状仍能自动修）', () => {
  const noField = { code: 'X1_MUST_SPLIT', file: 'src/a.js', line: 1 };
  assert.ok(claims('llm-refactor', noField));
});

test('tests 维度的 S1 不会被生成测试策略认领（否则目标算成 package.test.json）', () => {
  // check-tests.logic.js 给 S1 的 file 是 package.json——它是测试命令的所在处，
  // 不是「要被补测试的文件」。实测过：不否决就会让模型给 package.json 写单元测试
  const s1 = { code: 'S1_TESTS_FAILING', file: 'package.json', line: 1, fixable: false, message: '测试未通过' };
  const s2 = { code: 'S2_LARGE_FILE_UNTESTED', file: 'src/big.js', line: 1, fixable: true, message: '缺测试' };

  const r = partitionIssues({ dim: { id: 'tests', fix: 'llm-create' }, issues: [s1, s2] });
  assert.deepEqual(r.byStrategy.map((x) => x.strategy), ['llm-create']);
  assert.deepEqual(r.byStrategy[0].issues.map((i) => i.file), ['src/big.js']);
  assert.deepEqual(r.advisory.map((i) => i.file), ['package.json'], 'S1 应落进整改清单');
});

// ---------- 风险分级：低风险按钮只做不改既有代码的事 ----------

test('riskOf 按策略定档，未知策略按最保守处理', () => {
  assert.equal(riskOf('advisory'), 'low');
  assert.equal(riskOf('deterministic'), 'low');
  assert.equal(riskOf('llm-create'), 'low', '只新建测试、跑不通就删，不碰源码');
  assert.equal(riskOf('llm-rewrite'), 'medium', '改既有文档');
  assert.equal(riskOf('llm-refactor'), 'high', '改既有源码');
  assert.equal(riskOf('将来加的新策略'), 'high', 'fail-closed');
});

test('risksFor 三个入口，乱传一律 fail-closed 到只做低风险', () => {
  assert.deepEqual(risksFor('low'), ['low']);
  assert.deepEqual(risksFor('elevated'), ['medium', 'high'], '不含 low：那部分第一个按钮已经做过');
  assert.deepEqual(risksFor('all'), ['low', 'medium', 'high']);
  assert.deepEqual(risksFor(undefined), ['low']);
  assert.deepEqual(risksFor('乱传'), ['low']);
});

test('风险属于策略而非维度：prompts 的去重在低风险档也能做', () => {
  const dim = { id: 'prompts', fix: ['deterministic', 'llm-rewrite'] };
  const issues = [
    issue({ code: 'P4_DUPLICATE', file: 'CLAUDE.md', fixable: true }),
    issue({ code: 'P1_OVER_BROAD', file: 'CLAUDE.md', fixable: true }),
  ];

  const low = partitionIssues({ dim, issues, allowedRisks: ['low'] });
  assert.deepEqual(low.byStrategy.map((x) => x.strategy), ['deterministic'], '去重是纯机械删行，低风险档就该做');
  assert.equal(low.advisory.length, 1, '改写那条落进清单');
  assert.deepEqual(low.skippedByRisk, [{ strategy: 'llm-rewrite', risk: 'medium' }]);

  const high = partitionIssues({ dim, issues, allowedRisks: ['medium', 'high'] });
  assert.deepEqual(high.byStrategy.map((x) => x.strategy), ['llm-rewrite']);
  assert.deepEqual(high.skippedByRisk, [{ strategy: 'deterministic', risk: 'low' }]);
});

test('低风险档位下源码重构整个不参与，issue 转清单并标明原因', () => {
  const r = partitionIssues({
    dim: { id: 'complexity', fix: 'llm-refactor' },
    issues: [issue(), issue({ file: 'src/b.js' })],
    allowedRisks: ['low'],
  });
  assert.deepEqual(r.byStrategy, []);
  assert.equal(r.advisory.length, 2);
  assert.deepEqual(r.skippedByRisk, [{ strategy: 'llm-refactor', risk: 'high' }]);
  assert.equal(r.degraded, false, '不是被测试闸降级，是本轮没授权——两者的文案不该混');
});

test('低风险档位不为源码重构开测试闸（跑一遍全量测试是纯浪费）', () => {
  const sel = [{ dim: { id: 'complexity', fix: 'llm-refactor' } }];
  assert.equal(needsTestGate(sel, ['low']), false);
  assert.equal(needsTestGate(sel, ['medium', 'high']), true);
});

test('任何维度在低风险档位下都至少能产出整改清单', () => {
  for (const fix of ['llm-refactor', 'llm-rewrite', 'advisory', 'deterministic']) {
    assert.equal(dimHasWorkAt({ id: 'x', fix }, ['low']), true, `${fix} 在低风险档也该有清单产出`);
  }
});

test('selectFixableDims 在中高风险档位剔除只有低风险修法的维度', () => {
  const dims = [
    { id: 'security', fix: 'advisory' },
    { id: 'complexity', fix: 'llm-refactor' },
  ];
  const report = {
    dims: {
      security: { status: 'done', issues: [issue()] },
      complexity: { status: 'done', issues: [issue()] },
    },
  };
  assert.deepEqual(
    selectFixableDims({ dimensions: dims, report, allowedRisks: ['medium', 'high'] }).map((s) => s.dim.id),
    ['complexity'],
    'security 只有 advisory（低风险），中高风险轮不该重复写一遍它的清单',
  );
});

// ---------- 测试闸覆盖 llm-create（回归：生成的测试在红仓库里被全部误删） ----------

test('llm-create 也需要绿色基线：闸关时降级为清单，不去删无辜的新测试', () => {
  // 实测形状：本仓库有 14 个既有失败（jsdom 缺 ResizeObserver）。
  // 不设这道闸，runCreateTests 跑全量测试拿到 fail，就把每一份新生成的测试都删掉，
  // 还报「生成的测试未通过」——用户据此会以为模型写不出能跑的测试
  const dim = { id: 'tests', fix: 'llm-create' };
  const issues = [issue({ code: 'S2_LARGE_FILE_UNTESTED', file: 'src/big.js', fixable: true })];

  const closed = partitionIssues({
    dim, issues, allowedRisks: ['low'], gateAllowed: false, gateReason: '项目测试当前未通过',
  });
  assert.deepEqual(closed.byStrategy, [], '闸关时不该去生成');
  assert.equal(closed.degraded, true);
  assert.equal(closed.advisory.length, 1, '转成清单，而不是生成后删掉');

  const open = partitionIssues({ dim, issues, allowedRisks: ['low'], gateAllowed: true });
  assert.deepEqual(open.byStrategy.map((s) => s.strategy), ['llm-create']);
});

test('needsTestGate 覆盖两种需要基线的策略，且尊重风险档位', () => {
  const tests = [{ dim: { id: 'tests', fix: 'llm-create' } }];
  const refactor = [{ dim: { id: 'complexity', fix: 'llm-refactor' } }];
  const advisory = [{ dim: { id: 'security', fix: 'advisory' } }];

  assert.equal(needsTestGate(tests, ['low']), true, 'llm-create 在低风险档也要基线');
  assert.equal(needsTestGate(refactor, ['low']), false, '源码重构在低风险档不参与，不必为它开闸');
  assert.equal(needsTestGate(refactor, ['medium', 'high']), true);
  assert.equal(needsTestGate(advisory, ['low', 'medium', 'high']), false, '只出清单永远不需要基线');
});

test('不需要基线的策略不受闸影响（闸关也照常跑）', () => {
  const r = partitionIssues({
    dim: { id: 'hygiene', fix: 'deterministic' },
    issues: [issue({ code: 'H1_RUNTIME_DATA_TRACKED', file: 'run.log', fixable: true })],
    allowedRisks: ['low'],
    gateAllowed: false,
    gateReason: 'x',
  });
  assert.deepEqual(r.byStrategy.map((s) => s.strategy), ['deterministic']);
  assert.equal(r.degraded, false, '机械修复不碰代码行为，与测试基线无关');
});
