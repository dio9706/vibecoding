import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSelection, groupPlan, nodeCheckState, toggleNode, topButtonsState, buttonVisibility,
  riskyPicks, RISK_LABEL,
} from './optimize-plan.logic.js';

const ITEMS = [
  { id: 'complexity#0', dim: 'complexity', dimLabel: '复杂度', category: 'quality', risk: 'high', action: '改源码', file: 'a.js', line: 1, message: 'A', severity: 'warn' },
  { id: 'complexity#1', dim: 'complexity', dimLabel: '复杂度', category: 'quality', risk: 'low', action: '只出清单', file: 'b.js', line: 2, message: 'B', severity: 'info' },
  { id: 'docs#0', dim: 'docs', dimLabel: '文档', category: 'engineering', risk: 'medium', action: '改文档', file: 'R.md', line: 1, message: 'C', severity: 'info' },
];

// ---------- 默认勾选 ----------

test('defaultSelection：默认只勾低风险', () => {
  assert.deepEqual([...defaultSelection(ITEMS)], ['complexity#1']);
});

test('defaultSelection：空计划不炸', () => {
  assert.deepEqual([...defaultSelection([])], []);
  assert.deepEqual([...defaultSelection(null)], []);
});

// ---------- 分组 ----------

test('groupPlan：按域 → 维度两层分组，保持首次出现顺序', () => {
  const groups = groupPlan(ITEMS);
  assert.deepEqual(groups.map((g) => g.category), ['quality', 'engineering']);
  assert.deepEqual(groups[0].dims.map((d) => d.dim), ['complexity']);
  assert.equal(groups[0].dims[0].items.length, 2);
  assert.equal(groups[0].dims[0].dimLabel, '复杂度');
});

test('groupPlan：不排序——计划已按 fixOrder 排好，那个顺序有语义', () => {
  // 补测试在改源码之前，重排会让用户看到的次序与实际执行次序不一致
  const reordered = [ITEMS[2], ITEMS[0]];
  assert.deepEqual(groupPlan(reordered).map((g) => g.category), ['engineering', 'quality']);
});

// ---------- 三态勾选 ----------

test('nodeCheckState：全选 / 半选 / 未选三态', () => {
  assert.equal(nodeCheckState(['a', 'b'], new Set(['a', 'b'])), 'all');
  assert.equal(nodeCheckState(['a', 'b'], new Set(['a'])), 'some');
  assert.equal(nodeCheckState(['a', 'b'], new Set()), 'none');
});

test('nodeCheckState：空节点是 none 而不是 all', () => {
  // [].every() 恒为 true，不特判的话空分组会显示成「已全选」，点一下却什么都没发生
  assert.equal(nodeCheckState([], new Set()), 'none');
  assert.equal(nodeCheckState(null, new Set()), 'none');
});

test('toggleNode：半选与未选都变全选，全选变全不选', () => {
  assert.deepEqual([...toggleNode(['a', 'b'], new Set())], ['a', 'b']);
  // 半选按「变全选」处理：用户点半选分组时想的是「都要」，
  // 点成全不选会把他刚手工勾的那几条也清掉
  assert.deepEqual([...toggleNode(['a', 'b'], new Set(['a']))], ['a', 'b']);
  assert.deepEqual([...toggleNode(['a', 'b'], new Set(['a', 'b']))], []);
});

test('toggleNode：不影响节点之外的选中项', () => {
  assert.deepEqual([...toggleNode(['a'], new Set(['a', 'z']))].sort(), ['z']);
});

test('toggleNode：返回新 Set，不原地改（调用方按不可变语义重渲染）', () => {
  const before = new Set(['a']);
  const after = toggleNode(['a'], before);
  assert.notEqual(before, after);
  assert.deepEqual([...before], ['a'], '原 Set 不该被动过');
});

// ---------- 顶部按钮状态机 ----------

const base = {
  hasReport: true, checkupBusy: '', fixRunning: false,
  items: ITEMS, selected: new Set(['complexity#1']), handled: new Set(),
};

test('topButtonsState：五种状态', () => {
  assert.deepEqual(topButtonsState({ ...base, hasReport: false, items: [] }), { mode: 'idle', fixCount: 0, fixDisabled: true });
  assert.deepEqual(topButtonsState({ ...base, checkupBusy: 'analyzing' }), { mode: 'checking', fixCount: 0, fixDisabled: true });
  assert.deepEqual(topButtonsState({ ...base, fixRunning: true }), { mode: 'fixing', fixCount: 0, fixDisabled: true });
  assert.deepEqual(topButtonsState(base), { mode: 'ready', fixCount: 1, fixDisabled: false });

  const allHandled = new Set(ITEMS.map((i) => i.id));
  assert.deepEqual(topButtonsState({ ...base, handled: allHandled }), { mode: 'done-all', fixCount: 0, fixDisabled: true });
});

test('buttonVisibility：五种状态 × 四个按钮，任一时刻至多一个主动作', () => {
  // 整张表摆出来，是因为这四格曾经同时错过三格：
  // 修复中「重新体检」没隐藏、体检完「中止体检」还在、修复完「停止修复」还在
  const TABLE = {
    idle: { checkup: true, cancelCheckup: false, fix: false, cancelFix: false },
    checking: { checkup: false, cancelCheckup: true, fix: false, cancelFix: false },
    fixing: { checkup: false, cancelCheckup: false, fix: false, cancelFix: true },
    ready: { checkup: true, cancelCheckup: false, fix: true, cancelFix: false },
    'done-all': { checkup: true, cancelCheckup: false, fix: false, cancelFix: false },
  };
  for (const [mode, expected] of Object.entries(TABLE)) {
    assert.deepEqual(buttonVisibility(mode), expected, mode);
  }
});

test('buttonVisibility：体检中/修复中只剩一个可点的按钮', () => {
  for (const mode of ['checking', 'fixing']) {
    const shown = Object.values(buttonVisibility(mode)).filter(Boolean);
    assert.equal(shown.length, 1, `${mode} 期间该只剩中止/停止那一个`);
  }
});

test('topButtonsState：勾选为空时按钮禁用但不隐藏', () => {
  // 隐藏会让用户以为没东西可修了；实际只是这一刻没勾而已
  const s = topButtonsState({ ...base, selected: new Set() });
  assert.equal(s.mode, 'ready', '还有未处理项就该继续显示按钮');
  assert.equal(s.fixCount, 0);
  assert.equal(s.fixDisabled, true);
});

test('topButtonsState：已处理的项不计入可修数', () => {
  const s = topButtonsState({
    ...base,
    selected: new Set(['complexity#0', 'complexity#1']),
    handled: new Set(['complexity#0']),
  });
  assert.equal(s.fixCount, 1);
});

test('topButtonsState：只修完低风险后，中高风险项仍未处理 → 按钮保留', () => {
  const s = topButtonsState({ ...base, handled: new Set(['complexity#1']) });
  assert.equal(s.mode, 'ready', '隐藏按钮看的是「计划里还有没有未处理项」，与勾选无关');
});

test('topButtonsState：体检中优先于一切（此刻报告是旧的）', () => {
  const s = topButtonsState({ ...base, checkupBusy: 'posting', fixRunning: true });
  assert.equal(s.mode, 'checking');
});

// ---------- 二次确认的取材 ----------

test('riskyPicks：挑出勾选里的中高风险项，低风险不计', () => {
  const picked = riskyPicks(ITEMS, new Set(['complexity#0', 'complexity#1', 'docs#0']), new Set());
  assert.deepEqual(picked.map((i) => i.id), ['complexity#0', 'docs#0']);
});

test('riskyPicks：已处理的项不再要求确认', () => {
  const picked = riskyPicks(ITEMS, new Set(['complexity#0']), new Set(['complexity#0']));
  assert.deepEqual(picked, []);
});

test('RISK_LABEL 三档齐全', () => {
  assert.deepEqual(Object.keys(RISK_LABEL).sort(), ['high', 'low', 'medium']);
});
