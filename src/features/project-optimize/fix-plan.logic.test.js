import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectFixableRules, buildFixNotes, SUPPORTED_DIMENSIONS,
  buildFixPlan, resolveSelection, ACTION_META, previewGate,
} from './fix-plan.logic.js';

/** 造一份只含 rules 维度的体检报告 */
const reportWith = (issues) => ({ dims: { rules: { status: 'done', issues } } });

// ---------- selectFixableRules ----------

test('只挑出 fixable 的项', () => {
  const r = reportWith([
    { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/design-system.md', fixable: true, message: 'a' },
    { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/keyboard.md', fixable: true, message: 'b' },
  ]);
  assert.deepEqual(selectFixableRules(r).files, ['design-system.md', 'keyboard.md']);
});

test('R2_DEMOTE_UNCERTAIN 被挡下并说明原因', () => {
  // 「有 frontmatter 但解析不出 paths」是故意标成不可自动修的：
  // 基于不确定的判断做删文件 + 改写全仓引用，代价太高
  const r = reportWith([
    { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/a.md', fixable: true, message: 'ok' },
    { code: 'R2_DEMOTE_UNCERTAIN', file: '.claude/rules/b.md', fixable: false, message: '请人工确认' },
  ]);
  const out = selectFixableRules(r);
  assert.deepEqual(out.files, ['a.md']);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0].file, '.claude/rules/b.md');
  assert.match(out.blocked[0].reason, /人工确认/);
});

test('同一个文件出现多条问题时只降级一次', () => {
  const r = reportWith([
    { file: '.claude/rules/a.md', fixable: true, message: 'x' },
    { file: '.claude/rules/a.md', fixable: true, message: 'y' },
  ]);
  assert.deepEqual(selectFixableRules(r).files, ['a.md']);
});

test('rules 维度缺失 / 报告为空都返回空结果而不抛错', () => {
  for (const bad of [null, undefined, {}, { dims: {} }, { dims: { rules: {} } }]) {
    const out = selectFixableRules(bad);
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.blocked, []);
  }
});

test('只认 .claude/rules/ 下的文件', () => {
  // 别的维度将来也可能产出 fixable 的 issue，降级逻辑不该去动它们
  const r = reportWith([
    { file: 'CLAUDE.md', fixable: true, message: 'x' },
    { file: '.claude/rules/a.md', fixable: true, message: 'y' },
  ]);
  assert.deepEqual(selectFixableRules(r).files, ['a.md']);
});

// ---------- buildFixNotes ----------

test('注册表里的维度全部有修复策略（所以「不支持」的提示不该再出现）', () => {
  // 这条断言从「勾了不支持的维度要如实说明」改写而来。原来只有 rules/map 能自动修，
  // 其余维度只得到一句「暂无自动修复能力」；现在每个维度都至少有 advisory 兜底
  // （产出带定位、带依据、带改法的整改清单），「勾了却什么都没发生」不再可能。
  // 保留反向断言是为了钉住这个不变式：注册表新增维度时忘了写 fix 会在这里报出来
  const notes = buildFixNotes({ requested: ['rules', 'comments', 'tests', 'security'], results: [] });
  assert.deepEqual(notes, []);
});

test('真出现未登记的维度时仍要如实说明（兜底告知不能丢）', () => {
  const notes = buildFixNotes({ requested: ['rules', '还没实现的维度'], results: [] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /还没实现的维度/);
});

test('产出整改清单时要指路，否则清单等于没产出', () => {
  const notes = buildFixNotes({
    requested: ['security'],
    results: [{ status: 'done', kind: 'advisory', file: '.claude/optimize/security.md', reason: '已生成 3 项整改清单' }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\.claude\/optimize\//);
  assert.match(notes[0], /PLAN\.md/);
});

test('源码维度被测试闸挡下时必须显式否认「代码已改过」', () => {
  const notes = buildFixNotes({
    requested: ['complexity'],
    results: [{
      status: 'done',
      kind: 'advisory',
      file: '.claude/optimize/complexity.md',
      reason: '已生成 5 项整改清单（未改动代码）',
    }],
  });
  // 两条：一条指路清单，一条说明「没改代码」
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => /没有改动任何代码/.test(n)));
  assert.ok(notes.some((n) => /测试健康度/.test(n)), '要告诉用户怎样才能解锁自动修复');
});

test('动过 git 索引要提醒还原不管索引', () => {
  const notes = buildFixNotes({
    requested: ['hygiene'],
    results: [{ status: 'done', kind: 'untrack', file: 'run.log', reason: '已从 git 索引移除' }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /git add/);
});

test('只勾选支持的维度时不产生该提示', () => {
  assert.deepEqual(buildFixNotes({ requested: [...SUPPORTED_DIMENSIONS], results: [] }), []);
});

test('根 CLAUDE.md 仍提到旧文件名时提示手工核对', () => {
  // 索引表里写的是 `big-wide.md` 这种裸文件名，不带 .claude/rules/ 前缀，
  // replaceRuleRefs 匹配不到，会留下指向已删除文件的表格行
  const notes = buildFixNotes({
    requested: ['rules'],
    results: [{ status: 'done', file: '.claude/rules/big-wide.md', skillName: 'big-wide' }],
    rootClaudeMd: '规范见 `/big-wide` 技能。\n\n| `big-wide.md` | 大且宽 |',
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /CLAUDE\.md/);
  assert.match(notes[0], /big-wide\.md/);
});

test('根 CLAUDE.md 已无残留时不提示', () => {
  const notes = buildFixNotes({
    requested: ['rules'],
    results: [{ status: 'done', file: '.claude/rules/big-wide.md', skillName: 'big-wide' }],
    rootClaudeMd: '规范见 `/big-wide` 技能。',
  });
  assert.deepEqual(notes, []);
});

test('没降级成功的文件不参与残留检查', () => {
  // 跳过/失败的文件本来就还在原地，CLAUDE.md 提到它是正确的
  const notes = buildFixNotes({
    requested: ['rules'],
    results: [{ status: 'skipped', file: '.claude/rules/big-wide.md', skillName: 'big-wide' }],
    rootClaudeMd: '见 `.claude/rules/big-wide.md`',
  });
  assert.deepEqual(notes, []);
});

test('读不到根 CLAUDE.md 时不报噪声', () => {
  const results = [{ status: 'done', file: '.claude/rules/a.md', skillName: 'a' }];
  assert.deepEqual(buildFixNotes({ requested: ['rules'], results, rootClaudeMd: null }), []);
  assert.deepEqual(buildFixNotes({ requested: ['rules'], results }), []);
});

test('缺参数不抛错', () => {
  assert.deepEqual(buildFixNotes({}), []);
  assert.deepEqual(buildFixNotes(), []);
});

// ---------- 维度① 地图接入后的补充 ----------

test('map 已进入支持的维度', () => {
  assert.ok(SUPPORTED_DIMENSIONS.includes('map'));
  assert.ok(SUPPORTED_DIMENSIONS.includes('rules'));
});

test('只勾 map 时不再提示「暂无自动修复能力」', () => {
  assert.deepEqual(buildFixNotes({ requested: ['map'], results: [] }), []);
});

test('写过地图文件时提示 mtime 已被刷新', () => {
  // 这是 M3 过期告警会被本次写入清零的唯一提醒。删掉它，用户会把分数上涨
  // 误读成「地图已经更新了」——而地图正文其实一个字都没改
  const notes = buildFixNotes({
    requested: ['map'],
    results: [{ status: 'done', kind: 'stale-audit', file: 'src/a/CLAUDE.md' }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /时间戳|新鲜度|过期/);
  assert.match(notes[0], /自动核对/);
});

test('没有地图写入成功时不产生该提示', () => {
  const notes = buildFixNotes({
    requested: ['map'],
    results: [{ status: 'failed', kind: 'stale-audit', file: 'src/a/CLAUDE.md' }],
  });
  assert.deepEqual(notes, []);
});

test('地图结果不会污染 rules 的残留检查', () => {
  // 地图结果的 file 不以 .claude/rules/ 开头，拿去 slice 会产生垃圾字符串，
  // 再用它去 includes 根 CLAUDE.md 可能误报
  const notes = buildFixNotes({
    requested: ['map', 'rules'],
    results: [{ status: 'done', kind: 'gen-map', file: 'src/a/CLAUDE.md' }],
    rootClaudeMd: '# 根地图\n\n见 `src/a/CLAUDE.md`',
  });
  assert.equal(notes.length, 1, '只该有 mtime 那一条');
  assert.match(notes[0], /时间戳|新鲜度|过期/);
});

// ---------- buildFixPlan：把分派结果摊平成可勾选列表 ----------

/** 造一份最小维度声明数组，避免测试依赖真实注册表的演化 */
const PLAN_DIMS = [
  { id: 'complexity', label: '复杂度与函数规模', category: 'quality', fix: 'llm-refactor' },
  { id: 'docs', label: '文档可上手性', category: 'engineering', fix: 'llm-rewrite' },
  { id: 'map', label: '项目地图', category: 'ai', fix: 'llm-rewrite', risk: 'medium' },
  { id: 'rules', label: '规范加载方式', category: 'ai', fix: 'deterministic', risk: 'high' },
];

test('buildFixPlan：动作与风险都从策略派生，id 为 <dim>#<index>', () => {
  const report = {
    at: '2026-09-17T00:00:00.000Z',
    dims: {
      complexity: { status: 'done', issues: [{ file: 'src/a.js', line: 8, message: '函数过长', severity: 'warn' }] },
      docs: { status: 'done', issues: [{ file: 'README.md', line: 1, message: '上手命令跑不通', severity: 'info' }] },
    },
  };
  const plan = buildFixPlan(report, PLAN_DIMS);

  assert.equal(plan.at, '2026-09-17T00:00:00.000Z');
  assert.equal(plan.items.length, 2);

  const c = plan.items.find((i) => i.dim === 'complexity');
  assert.equal(c.id, 'complexity#0');
  assert.equal(c.strategy, 'llm-refactor');
  assert.equal(c.risk, 'high');
  assert.equal(c.action, ACTION_META['llm-refactor'].label);
  assert.equal(c.category, 'quality');
  assert.equal(c.file, 'src/a.js');
  assert.equal(c.line, 8);

  const d = plan.items.find((i) => i.dim === 'docs');
  assert.equal(d.id, 'docs#0');
  assert.equal(d.risk, 'medium');
});

// ---------- previewGate / 降级标注：让标签在用户点之前就说真话 ----------

/** 带 testRun 的报告工厂。complexity 走 llm-refactor，正是会被闸挡下的那一档 */
const gateReport = (testRun) => ({
  at: '2026-09-21T00:00:00.000Z',
  dims: {
    complexity: {
      status: 'done',
      testRun: undefined,
      issues: [{ file: 'src/a.js', line: 8, message: '函数过长', severity: 'warn' }],
    },
    docs: { status: 'done', issues: [{ file: 'README.md', line: 1, message: '跑不通', severity: 'info' }] },
    ...(testRun ? { tests: { status: 'done', testRun, issues: [] } } : {}),
  },
});

test('previewGate：测试绿 → 放行；红 / 无命令 → 不放行并给出原因', () => {
  assert.deepEqual(previewGate(gateReport({ status: 'pass' })), { known: true, allowed: true, reason: '' });

  const failed = previewGate(gateReport({ status: 'fail', reason: '退出码 1' }));
  assert.equal(failed.known, true);
  assert.equal(failed.allowed, false);
  assert.match(failed.reason, /未通过/, '原因要说清是「测试红」而不是笼统一句降级');

  const none = previewGate(gateReport({ status: 'na', reason: '未定义 test 脚本' }));
  assert.equal(none.allowed, false);
  assert.match(none.reason, /没有可执行的测试命令/);
});

test('previewGate：报告里没有 testRun → known:false，调用方据此闭嘴', () => {
  // 旧报告 / tests 维度没跑完。宁可不标注，也不要对着没判过的状态下结论
  const g = previewGate(gateReport(null));
  assert.equal(g.known, false);
  assert.equal(g.allowed, true, '未知时按不降级处理，不改变既有展示');
  assert.deepEqual(previewGate(null), { known: false, allowed: true, reason: '' });
});

test('buildFixPlan：闸关时 llm-refactor 项改口为「只出清单」并降为低风险', () => {
  // 这正是「全选 → 一键修复 → 重新体检还是三百多项」的根因：
  // 标签承诺「改源码」，实际只写了一份 markdown
  const plan = buildFixPlan(gateReport({ status: 'fail', reason: '退出码 1' }), PLAN_DIMS);
  const c = plan.items.find((i) => i.dim === 'complexity');

  assert.equal(c.strategy, 'llm-refactor', '策略本身不动——执行侧的降级归 fix-engine，这里只改展示');
  assert.equal(c.degraded, true);
  assert.equal(c.action, '只出清单');
  assert.equal(c.risk, 'low', '只写 markdown 的事标成高风险，会让用户以为取消勾选是在避险');

  const d = plan.items.find((i) => i.dim === 'docs');
  assert.equal(d.degraded, undefined, 'llm-rewrite 改的是文档，不过测试闸，不该被牵连');
  assert.equal(d.action, ACTION_META['llm-rewrite'].label);
});

test('buildFixPlan：闸开或未知时一律不打降级标记', () => {
  for (const r of [gateReport({ status: 'pass' }), gateReport(null)]) {
    const c = buildFixPlan(r, PLAN_DIMS).items.find((i) => i.dim === 'complexity');
    assert.equal(c.degraded, undefined);
    assert.equal(c.action, ACTION_META['llm-refactor'].label);
    assert.equal(c.risk, 'high');
  }
});

test('buildFixNotes：降级原因取自本次真实闸裁决，不再写死「缺少测试安全网」', () => {
  // 对一个有 106 个测试文件的项目说它「缺少测试」，用户只会觉得这句说的不是自己
  const results = [{ kind: 'advisory', status: 'done', file: '.claude/optimize/complexity.md', reason: '未改动代码' }];
  const notes = buildFixNotes({
    requested: ['complexity'],
    results,
    gate: { allowed: false, reason: '项目测试当前未通过，无法作为安全基线' },
  });
  const n = notes.find((x) => x.includes('没有改动任何代码'));
  assert.ok(n, '必须有这条否认');
  assert.match(n, /测试当前未通过/);
  assert.ok(!n.includes('缺少可用的测试安全网'), '有测试但跑不过时不该说「缺少测试」');
  assert.match(n, /1 份清单/, '要说清降级了几条');
});

test('buildFixNotes：没传 gate 时退回通用措辞，不炸', () => {
  const results = [{ kind: 'advisory', status: 'done', file: 'x.md', reason: '未改动代码' }];
  const n = buildFixNotes({ requested: [], results }).find((x) => x.includes('没有改动任何代码'));
  assert.match(n, /缺少可用的测试安全网/);
});

test('buildFixPlan：map / rules 的风险取注册表 risk 字段，不按策略表推', () => {
  const report = {
    at: 'x',
    dims: {
      map: { status: 'done', issues: [{ file: 'CLAUDE.md', line: 0, message: '缺根地图', code: 'M1_NO_ROOT_MAP', fixable: true }] },
      rules: { status: 'done', issues: [{ file: '.claude/rules/a.md', line: 0, message: '该降级', fixable: true }] },
    },
  };
  const plan = buildFixPlan(report, PLAN_DIMS);

  const m = plan.items.find((i) => i.dim === 'map');
  assert.equal(m.risk, 'medium');
  assert.equal(m.action, ACTION_META['bespoke-map'].label);

  const r = plan.items.find((i) => i.dim === 'rules');
  // 策略 deterministic 按策略表是 low，但 rules 会删文件+改写全仓引用 → 注册表声明 high
  assert.equal(r.risk, 'high', 'rules 必须取注册表的 high，不能跟着 deterministic 走 low');
  assert.equal(r.action, ACTION_META['bespoke-rules'].label);
});

test('buildFixPlan：fixable:false 落到「只出清单」，不被丢弃', () => {
  const report = {
    at: 'x',
    dims: {
      complexity: { status: 'done', issues: [{ file: 'src/a.js', line: 1, message: 'x', fixable: false }] },
    },
  };
  const plan = buildFixPlan(report, PLAN_DIMS);
  assert.equal(plan.items.length, 1, '不可自动修的项照样进计划，只是动作变成出清单');
  assert.equal(plan.items[0].strategy, 'advisory');
  assert.equal(plan.items[0].risk, 'low');
});

test('buildFixPlan：bespoke 维度里 fixable:false 的项也退回只出清单', () => {
  const report = {
    at: 'x',
    dims: { rules: { status: 'done', issues: [{ file: '.claude/rules/a.md', message: '解析不出 paths', fixable: false }] } },
  };
  const plan = buildFixPlan(report, PLAN_DIMS);
  assert.equal(plan.items[0].strategy, 'advisory');
  assert.equal(plan.items[0].risk, 'low', '不会真去删文件，就不该标成高风险吓人');
});

test('buildFixPlan：只收 status=done 的维度', () => {
  const report = {
    at: 'x',
    dims: {
      complexity: { status: 'analyzing', issues: [] },
      docs: { status: 'partial', issues: [{ file: 'README.md', line: 1, message: 'x' }] },
    },
  };
  assert.deepEqual(buildFixPlan(report, PLAN_DIMS).items, []);
});

test('buildFixPlan：跳过 augment 维度（条目已并进宿主）', () => {
  const dims = [...PLAN_DIMS, { id: 'hygiene-audit', label: 'x', category: 'engineering', augments: 'hygiene', fix: 'deterministic' }];
  const report = { at: 'x', dims: { 'hygiene-audit': { status: 'done', issues: [{ file: 'a.log', message: 'x' }] } } };
  assert.deepEqual(buildFixPlan(report, dims).items, []);
});

test('buildFixPlan：空报告不炸', () => {
  assert.deepEqual(buildFixPlan(null, PLAN_DIMS).items, []);
  assert.deepEqual(buildFixPlan({ dims: {} }, PLAN_DIMS).items, []);
  assert.deepEqual(buildFixPlan({ at: 'x', dims: {} }, null).items, []);
});

// ---------- resolveSelection：安全边界（前端只能传下标） ----------

const SEL_REPORT = {
  at: 'T1',
  dims: {
    complexity: { status: 'done', issues: [{ file: 'a.js', line: 1, message: 'A' }, { file: 'b.js', line: 2, message: 'B' }] },
    docs: { status: 'done', issues: [{ file: 'README.md', line: 1, message: 'C' }] },
  },
};

test('resolveSelection：按维度聚合出 issue 子集', () => {
  const out = resolveSelection(SEL_REPORT, ['complexity#1', 'docs#0']);
  assert.deepEqual(out.byDim.complexity, [{ file: 'b.js', line: 2, message: 'B' }]);
  assert.deepEqual(out.byDim.docs, [{ file: 'README.md', line: 1, message: 'C' }]);
  assert.deepEqual(out.indicesByDim.complexity, [1]);
  assert.equal(out.rejected.length, 0);
});

test('resolveSelection：越界 / 非整数 / 未知维度一律丢弃并记录', () => {
  const out = resolveSelection(SEL_REPORT, [
    'complexity#99',   // 越界
    'complexity#-1',   // 负数
    'complexity#1.5',  // 非整数
    'complexity#abc',  // 非数字
    'nosuch#0',        // 未知维度
    'malformed',       // 没有 #
  ]);
  assert.deepEqual(out.byDim, {});
  assert.equal(out.rejected.length, 6, '每一条都要被记下来，不能静默吞掉');
});

test('resolveSelection：空下标串不被当成 0（Number("") === 0 的坑）', () => {
  const out = resolveSelection(SEL_REPORT, ['complexity#']);
  assert.deepEqual(out.byDim, {});
  assert.equal(out.rejected.length, 1);
});

test('resolveSelection：重复 id 只算一次', () => {
  const out = resolveSelection(SEL_REPORT, ['complexity#0', 'complexity#0']);
  assert.equal(out.byDim.complexity.length, 1);
});

test('resolveSelection：只认 status=done 的维度（analyzing 的结论不完整）', () => {
  const report = { at: 'T', dims: { complexity: { status: 'analyzing', issues: [{ file: 'a.js', line: 1, message: 'A' }] } } };
  const out = resolveSelection(report, ['complexity#0']);
  assert.deepEqual(out.byDim, {});
  assert.equal(out.rejected.length, 1);
});

test('resolveSelection：保持下标升序，与报告顺序一致', () => {
  const out = resolveSelection(SEL_REPORT, ['complexity#1', 'complexity#0']);
  assert.deepEqual(out.indicesByDim.complexity, [0, 1]);
});

test('resolveSelection：脏输入不炸', () => {
  assert.deepEqual(resolveSelection(null, ['a#0']).byDim, {});
  assert.deepEqual(resolveSelection(SEL_REPORT, null).byDim, {});
  assert.deepEqual(resolveSelection(SEL_REPORT, []).byDim, {});
});

// ---------- selectFixableRules 的下标子集入参 ----------

test('selectFixableRules：传 pickIndices 时只处理选中的下标', () => {
  const report = {
    dims: {
      rules: {
        issues: [
          { file: '.claude/rules/a.md', fixable: true },
          { file: '.claude/rules/b.md', fixable: true },
          { file: '.claude/rules/c.md', fixable: true },
        ],
      },
    },
  };
  assert.deepEqual(selectFixableRules(report, [0, 2]).files, ['a.md', 'c.md']);
});

test('selectFixableRules：不传 pickIndices 时行为与改动前完全一致（回归护栏）', () => {
  const report = {
    dims: {
      rules: {
        issues: [
          { file: '.claude/rules/a.md', fixable: true },
          { file: '.claude/rules/b.md', fixable: false, message: '解析不出 paths' },
        ],
      },
    },
  };
  const out = selectFixableRules(report);
  assert.deepEqual(out.files, ['a.md']);
  assert.equal(out.blocked.length, 1);
});

test('selectFixableRules：空 pickIndices 数组表示「一条都不选」，不是「全选」', () => {
  const report = { dims: { rules: { issues: [{ file: '.claude/rules/a.md', fixable: true }] } } };
  assert.deepEqual(selectFixableRules(report, []).files, []);
});
