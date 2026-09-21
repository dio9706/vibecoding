# 项目优化面板细粒度修复 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把项目优化的修复决策权下沉到「单条问题」——每条带动作与风险标签、可三层勾选，配套按钮上移、体检可中止、多轮修复与修复报告。

**Architecture:** 在体检报告与修复执行之间插一层**修复计划（FixPlan）**。它不发明分类，只把后端已有的 `claims()` + `riskOf()` 分派结果摊平成可勾选的扁平列表。执行层 `runFixForDim({ dim, issues })` 收的本就是 issues 数组，传子集即可，零改动。

**Tech Stack:** 原生 ESM（无框架）、`node --test`、SSE、`public/app.css` 单文件样式。

**Spec:** `docs/superpowers/specs/2026-09-17-optimize-panel-granular-fix-design.md`

---

## ⚠️ 本计划的两条纪律

1. **不 git 提交**。项目 `CLAUDE.md` 明令「不自动 git 提交，改动留工作区，提交时机由维护者掌控」。所以每个任务以**验证**收尾，不以 commit 收尾。这是对 writing-plans 默认模板的有意偏离。
2. **闸口恒定**：每个任务结束时 `npm test` 必须全绿。基线 2767 passed。已知 flaky `src/entrypoints/web/routes-memory.test.js:294`（全量并发偶发，单独跑三次通过），与本功能无关，撞到时单独复跑确认即可。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/features/project-optimize/fix-engine.logic.js` | 改 | 抽出 `strategyForIssue`，`partitionIssues` 改为复用它（消除认领顺序的二次实现） |
| `src/features/project-optimize/fix-plan.logic.js` | 改 | 新增 `buildFixPlan` / `resolveSelection` / `ACTION_META` |
| `src/features/project-optimize/fix-rules.logic.js` | 改 | `selectFixableRules` 加 `pickIndices` 入参 |
| `src/features/project-optimize/fix-map.logic.js` | 改 | `selectFixableMap` 加 `pickIndices` 入参 |
| `src/features/project-optimize/retest.logic.js` | 新建 | 复测清单纯逻辑 |
| `src/features/project-optimize/retest.js` | 新建 | 读各级 CLAUDE.md 的薄 IO 层 |
| `src/entrypoints/web/optimize-ops.js` | 改 | 体检 AbortController、`startFix` 收 items、复测清单接进 done |
| `src/entrypoints/web/routes-optimize.js` | 改 | `GET /fix-plan`、`POST /checkup/cancel` |
| `public/js/optimize-plan.logic.js` | 新建 | 勾选树纯逻辑 + `topButtonsState` |
| `public/js/optimize-report.js` | 新建 | 修复报告弹窗 |
| `public/js/optimize-view.logic.js` | 改 | `dimListFrom` 加 `cancelled` 分支 |
| `public/js/optimize-view.js` | 改 | 顶部按钮状态机 + 勾选树渲染 |
| `public/index.html` | 改 | 顶部按钮区，删底部 `.opt-actions` |
| `public/app.css` | 改 | `.pretty-check:indeterminate`、风险标签、树、顶部按钮区 |

---

## Task 1：抽出 `strategyForIssue`，消除认领顺序的二次实现

计划构建器要逐条算出「这条 issue 归哪个策略」，而 `partitionIssues` 里已有这段逻辑（按策略顺序逐个挑走未认领的）。**先把它抽成独立函数并让 partitionIssues 复用**，避免两处各写一遍必然漂移。

**Files:**
- Modify: `src/features/project-optimize/fix-engine.logic.js`
- Test: `src/features/project-optimize/fix-engine.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `fix-engine.logic.test.js`：

```js
import { strategyForIssue } from './fix-engine.logic.js';

test('strategyForIssue：按策略顺序取第一个认领者，advisory 兜底', () => {
  const srcIssue = { file: 'src/a.js', line: 1, message: 'x' };
  const docIssue = { file: 'README.md', line: 1, message: 'x' };

  // llm-refactor 认领源码
  assert.equal(strategyForIssue(['llm-refactor', 'advisory'], srcIssue), 'llm-refactor');
  // llm-rewrite 只认文档，源码落到 advisory
  assert.equal(strategyForIssue(['llm-rewrite', 'advisory'], srcIssue), 'advisory');
  assert.equal(strategyForIssue(['llm-rewrite'], docIssue), 'llm-rewrite');
  // 检测器逐条否决 → 一律 advisory
  assert.equal(strategyForIssue(['llm-refactor'], { ...srcIssue, fixable: false }), 'advisory');
  // 没有任何策略 → advisory
  assert.equal(strategyForIssue([], srcIssue), 'advisory');
});

test('strategyForIssue 与 partitionIssues 的认领结果一致（防二次实现漂移）', () => {
  const dim = { id: 'complexity', fix: ['llm-refactor'] };
  const issues = [
    { file: 'src/a.js', line: 1, message: 'a' },
    { file: 'README.md', line: 2, message: 'b' },
    { file: 'src/c.js', line: 3, message: 'c', fixable: false },
  ];
  const part = partitionIssues({ dim, issues });

  // 从 partitionIssues 的分组反推每条 issue 的策略
  const fromPartition = issues.map((it) => {
    const hit = part.byStrategy.find((g) => g.issues.includes(it));
    return hit ? hit.strategy : 'advisory';
  });
  const fromHelper = issues.map((it) => strategyForIssue(['llm-refactor'], it));

  assert.deepEqual(fromHelper, fromPartition);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test src/features/project-optimize/fix-engine.logic.test.js
```

预期：`SyntaxError` 或 `strategyForIssue is not a function`。

- [ ] **Step 3: 实现**

在 `fix-engine.logic.js` 的 `claims` 函数**之后**插入：

```js
/**
 * 单条 issue 归哪个策略 —— 认领顺序的**唯一**实现。
 *
 * 语义：在给定的策略序列里，取第一个认领它的非 advisory 策略；都不认领就归 advisory。
 * 这与 `partitionIssues` 的分组循环完全等价（那里是「每个策略挑走尚未被认领的」，
 * 对单条 issue 而言就是「第一个认领它的策略拿走」）。
 *
 * 抽出来是因为修复计划要**逐条**展示动作与风险，而 partitionIssues 返回的是按策略分组。
 * 两处各写一遍认领规则必然漂移，所以让 partitionIssues 也复用它，
 * 并在测试里做交叉校验钉死一致性。
 *
 * @param {string[]} strategies 已按维度声明顺序排列、且已过滤掉不可用的策略
 * @param {object} issue
 * @returns {string} 策略名，或 'advisory'
 */
export function strategyForIssue(strategies, issue) {
  for (const s of strategies || []) {
    if (s === 'advisory') continue;
    if (claims(s, issue)) return s;
  }
  return 'advisory';
}
```

然后把 `partitionIssues` 里的认领循环改为复用它。将这一段：

```js
  for (const strategy of active) {
    if (strategy === 'advisory') continue; // advisory 是兜底，最后统一处理
    const mine = issues.filter((it, i) => !claimed.has(i) && claims(strategy, it));
    // 记下已认领的下标：同一条 issue 不该被两个策略各改一遍
    issues.forEach((it, i) => { if (mine.includes(it)) claimed.add(i); });
    if (mine.length) byStrategy.push({ strategy, issues: mine });
  }
```

替换为：

```js
  // 逐条定策略再按策略聚合。原实现是「每个策略扫一遍 issues 挑走自己的」，
  // 语义相同但认领规则写在这里；现在统一交给 strategyForIssue，
  // 计划构建器与执行分派共用同一份规则，杜绝漂移
  const groups = new Map();
  issues.forEach((it, i) => {
    const s = strategyForIssue(active, it);
    if (s === 'advisory') return; // advisory 由下面的兜底统一收
    claimed.add(i);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(it);
  });
  // 保持 active 的顺序输出：执行顺序依赖它（如 deterministic 先于 llm-*）
  for (const strategy of active) {
    const mine = groups.get(strategy);
    if (mine?.length) byStrategy.push({ strategy, issues: mine });
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test src/features/project-optimize/fix-engine.logic.test.js
```

预期：全部 PASS（既有测试 + 2 条新测试）。

- [ ] **Step 5: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 2：`buildFixPlan` —— 把分派结果摊平成可勾选列表

**Files:**
- Modify: `src/features/project-optimize/fix-plan.logic.js`
- Test: `src/features/project-optimize/fix-plan.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `fix-plan.logic.test.js`：

```js
import { buildFixPlan, ACTION_META } from './fix-plan.logic.js';

/** 造一个最小维度声明数组，避免测试依赖真实注册表的演化 */
const DIMS = [
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
  const plan = buildFixPlan(report, DIMS);

  assert.equal(plan.at, '2026-09-17T00:00:00.000Z');
  assert.equal(plan.items.length, 2);

  const c = plan.items.find((i) => i.dim === 'complexity');
  assert.equal(c.id, 'complexity#0');
  assert.equal(c.strategy, 'llm-refactor');
  assert.equal(c.risk, 'high');
  assert.equal(c.action, ACTION_META['llm-refactor'].label);
  assert.equal(c.category, 'quality');

  const d = plan.items.find((i) => i.dim === 'docs');
  assert.equal(d.id, 'docs#0');
  assert.equal(d.risk, 'medium');
});

test('buildFixPlan：map / rules 的风险取注册表 risk 字段，不按策略表推', () => {
  const report = {
    at: 'x',
    dims: {
      map: { status: 'done', issues: [{ file: 'CLAUDE.md', line: 0, message: '缺根地图', code: 'M1_NO_ROOT_MAP', fixable: true }] },
      rules: { status: 'done', issues: [{ file: '.claude/rules/a.md', line: 0, message: '该降级', fixable: true }] },
    },
  };
  const plan = buildFixPlan(report, DIMS);

  const m = plan.items.find((i) => i.dim === 'map');
  // 策略是 llm-rewrite（中），注册表也声明 medium —— 但来源必须是注册表
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
  const plan = buildFixPlan(report, DIMS);
  assert.equal(plan.items.length, 1, '不可自动修的项照样进计划，只是动作变成出清单');
  assert.equal(plan.items[0].strategy, 'advisory');
  assert.equal(plan.items[0].risk, 'low');
});

test('buildFixPlan：只收 status=done 的维度', () => {
  const report = {
    at: 'x',
    dims: {
      complexity: { status: 'analyzing', issues: [] },
      docs: { status: 'partial', issues: [{ file: 'README.md', line: 1, message: 'x' }] },
    },
  };
  assert.deepEqual(buildFixPlan(report, DIMS).items, []);
});

test('buildFixPlan：空报告不炸', () => {
  assert.deepEqual(buildFixPlan(null, DIMS).items, []);
  assert.deepEqual(buildFixPlan({ dims: {} }, DIMS).items, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js
```

预期：`buildFixPlan is not a function`。

- [ ] **Step 3: 实现**

在 `fix-plan.logic.js` 顶部 import 区补：

```js
import { strategyForIssue, strategiesOf, riskOf, BESPOKE_DIMS } from './fix-engine.logic.js';
```

在文件末尾追加：

```js
/**
 * 动作标签 —— 给用户看的「勾了会发生什么」。
 *
 * 与风险是同一来源（策略）的两面，所以放同一张表：这保证了标签与实际行为不可能漂移。
 * `bespoke-*` 两条对应 map / rules 的专用流程，它们不走策略表（见 registry 的 risk 字段说明）。
 */
export const ACTION_META = {
  deterministic: { label: '改配置', hint: '追加 .gitignore、git rm --cached、按行删重复条目' },
  'llm-create': { label: '新建测试', hint: '只新建文件，跑不通会自动删掉，绝不碰被测源码' },
  advisory: { label: '只出清单', hint: '写一份带定位、依据、改法的整改清单到 .claude/optimize/，不改任何文件' },
  'llm-rewrite': { label: '改文档', hint: '改写既有 CLAUDE.md / README 等文档，不影响运行时' },
  'llm-refactor': { label: '改源码', hint: '改写既有源码，有测试闸兜底（改前绿、改后重跑、红了回滚该文件）' },
  'bespoke-map': { label: '生成/改写地图', hint: '新建或改写各级 CLAUDE.md 项目地图' },
  'bespoke-rules': { label: '降级为技能', hint: '删除规则文件并改写全仓引用——本功能唯一的破坏性操作' },
};

/**
 * 构建修复计划：把报告里每条 issue 摊平成一个可勾选项，并标注动作与风险。
 *
 * ## 为什么不直接复用 partitionIssues
 *
 * 它返回的是「按策略分组」，而 UI 要的是「逐条」。两者的认领规则由
 * `strategyForIssue` 统一提供（见 fix-engine.logic.js），所以这里没有二次实现。
 *
 * ## map / rules 的例外
 *
 * 这两维走专用流程，风险显式声明在注册表的 `risk` 字段上——`rules` 的策略是
 * `deterministic`（按策略表是低风险），但它会删文件并改写全仓引用，实际是最高风险。
 * 按策略表推会把破坏性操作标成「低风险」并默认勾上，这是绝不能出的错。
 *
 * @param {object|null} report 体检报告
 * @param {Array<object>} dimensions 维度声明（注册表的 fixOrderedDimensions()）
 * @returns {{at:string, items:Array<object>}}
 */
export function buildFixPlan(report, dimensions) {
  const items = [];

  for (const dim of dimensions || []) {
    if (dim?.augments) continue; // augment 条目已并进宿主维度，不重复列出
    const d = report?.dims?.[dim.id];
    if (!d || d.status !== 'done') continue;
    const issues = Array.isArray(d.issues) ? d.issues : [];

    issues.forEach((issue, index) => {
      const { strategy, risk } = classifyPlanItem(dim, issue);
      items.push({
        id: `${dim.id}#${index}`,
        dim: dim.id,
        dimLabel: dim.label || dim.id,
        category: dim.category || '',
        file: String(issue?.file || ''),
        line: Number(issue?.line) || 0,
        message: String(issue?.message || ''),
        severity: String(issue?.severity || 'info'),
        strategy,
        action: ACTION_META[strategy]?.label || strategy,
        risk,
      });
    });
  }

  return { at: String(report?.at || ''), items };
}

/**
 * 单个计划项的策略与风险。
 *
 * bespoke 维度（map / rules）不走策略表：它们的 issue 由专用流程处理，
 * 风险取注册表声明；检测器逐条否决（fixable !== true）的仍退回 advisory。
 */
function classifyPlanItem(dim, issue) {
  if (BESPOKE_DIMS.has(dim.id)) {
    if (issue?.fixable !== true) return { strategy: 'advisory', risk: 'low' };
    return { strategy: `bespoke-${dim.id}`, risk: dim.risk || 'high' };
  }
  const strategy = strategyForIssue(strategiesOf(dim), issue);
  return { strategy, risk: riskOf(strategy) };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 3：`resolveSelection` —— 把前端传来的 id 还原成 issue 子集（含安全校验）

**这是本设计的安全边界**：前端只能传下标，且下标必须做边界校验。

**Files:**
- Modify: `src/features/project-optimize/fix-plan.logic.js`
- Test: `src/features/project-optimize/fix-plan.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { resolveSelection } from './fix-plan.logic.js';

const REPORT = {
  at: 'T1',
  dims: {
    complexity: { status: 'done', issues: [{ file: 'a.js', line: 1, message: 'A' }, { file: 'b.js', line: 2, message: 'B' }] },
    docs: { status: 'done', issues: [{ file: 'README.md', line: 1, message: 'C' }] },
  },
};

test('resolveSelection：按维度聚合出 issue 子集', () => {
  const out = resolveSelection(REPORT, ['complexity#1', 'docs#0']);
  assert.deepEqual(out.byDim.complexity, [{ file: 'b.js', line: 2, message: 'B' }]);
  assert.deepEqual(out.byDim.docs, [{ file: 'README.md', line: 1, message: 'C' }]);
  assert.deepEqual(out.indicesByDim.complexity, [1]);
  assert.equal(out.rejected.length, 0);
});

test('resolveSelection：越界 / 非整数 / 未知维度一律丢弃并记录', () => {
  const out = resolveSelection(REPORT, [
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

test('resolveSelection：重复 id 只算一次', () => {
  const out = resolveSelection(REPORT, ['complexity#0', 'complexity#0']);
  assert.equal(out.byDim.complexity.length, 1);
});

test('resolveSelection：只认 status=done 的维度（analyzing 的结论不完整）', () => {
  const report = { at: 'T', dims: { complexity: { status: 'analyzing', issues: [{ file: 'a.js', line: 1, message: 'A' }] } } };
  const out = resolveSelection(report, ['complexity#0']);
  assert.deepEqual(out.byDim, {});
  assert.equal(out.rejected.length, 1);
});

test('resolveSelection：保持下标升序，与报告顺序一致', () => {
  const out = resolveSelection(REPORT, ['complexity#1', 'complexity#0']);
  assert.deepEqual(out.indicesByDim.complexity, [0, 1]);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js
```

预期：`resolveSelection is not a function`。

- [ ] **Step 3: 实现**

追加到 `fix-plan.logic.js`：

```js
/**
 * 把前端传来的计划项 id 还原成「维度 → issue 子集」。
 *
 * ## 这是一道安全边界，不是格式转换
 *
 * 本功能持有 bypassPermissions 级的写权限：`llm-refactor` 能改写任意源码。
 * 如果让前端直接回传 issue 对象（更省事），改一下请求体的 `file` 字段
 * 就能指挥模型去重构仓库里任何一个文件。所以**前端只能传下标，
 * 真实的 file / line / message 一律从后端自己落盘的报告里取**。
 *
 * 同理，下标必须逐个校验：越界、负数、非整数、未知维度、未跑完的维度，
 * 一律丢弃并计入 rejected（由调用方记日志）——不能信任前端传来的任何数字。
 *
 * @param {object|null} report
 * @param {string[]} ids 形如 `complexity#3`
 * @returns {{byDim:Object<string,Array>, indicesByDim:Object<string,number[]>, rejected:string[]}}
 */
export function resolveSelection(report, ids) {
  /** @type {Object<string, number[]>} */
  const picked = {};
  const rejected = [];
  const seen = new Set();

  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw);
    if (seen.has(id)) continue; // 重复只算一次，不计入 rejected（不是错误）
    seen.add(id);

    const at = id.lastIndexOf('#');
    if (at <= 0) { rejected.push(id); continue; }

    const dimId = id.slice(0, at);
    const idxRaw = id.slice(at + 1);
    // Number() 对 '1.5' / 'abc' / '' 分别给 1.5 / NaN / 0，所以三道都要判
    const idx = Number(idxRaw);
    if (!Number.isInteger(idx) || idx < 0 || idxRaw === '') { rejected.push(id); continue; }

    const d = report?.dims?.[dimId];
    // status 必须是 done：analyzing / partial 的结论不完整，拿它驱动修改会漏改错改
    if (!d || d.status !== 'done' || !Array.isArray(d.issues) || idx >= d.issues.length) {
      rejected.push(id);
      continue;
    }

    (picked[dimId] ||= []).push(idx);
  }

  const byDim = {};
  const indicesByDim = {};
  for (const [dimId, list] of Object.entries(picked)) {
    // 升序：保持与报告里的 issue 顺序一致，下游按行号倒序删除等逻辑依赖稳定次序
    const sorted = [...list].sort((a, b) => a - b);
    indicesByDim[dimId] = sorted;
    byDim[dimId] = sorted.map((i) => report.dims[dimId].issues[i]);
  }

  return { byDim, indicesByDim, rejected };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 4：`selectFixableRules` / `selectFixableMap` 支持下标子集

bespoke 维度的执行入口要能只处理选中的那几条。**默认参数保持原行为**，这是回归护栏的重点。

**Files:**
- Modify: `src/features/project-optimize/fix-plan.logic.js`（`selectFixableRules`）
- Modify: `src/features/project-optimize/fix-map.logic.js`（`selectFixableMap`）
- Test: `src/features/project-optimize/fix-plan.logic.test.js`、`src/features/project-optimize/fix-map.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `fix-plan.logic.test.js`：

```js
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
```

追加到 `fix-map.logic.test.js`：

```js
test('selectFixableMap：传 pickIndices 时只处理选中的下标', () => {
  const report = {
    dims: {
      map: {
        issues: [
          { code: 'M1_NO_ROOT_MAP', file: 'CLAUDE.md', fixable: true },
          { code: 'M2_MISSING_MAP', file: 'src/app/CLAUDE.md', fixable: true },
        ],
      },
    },
  };
  const out = selectFixableMap(report, [1]);
  assert.equal(out.rootMap, false, '没勾 M1 就不该生成根地图');
  assert.deepEqual(out.modules, ['src/app']);
});

test('selectFixableMap：不传 pickIndices 时行为与改动前完全一致（回归护栏）', () => {
  const report = {
    dims: {
      map: {
        issues: [
          { code: 'M1_NO_ROOT_MAP', file: 'CLAUDE.md', fixable: true },
          { code: 'M2_MISSING_MAP', file: 'src/app/CLAUDE.md', fixable: true },
        ],
      },
    },
  };
  const out = selectFixableMap(report);
  assert.equal(out.rootMap, true);
  assert.deepEqual(out.modules, ['src/app']);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js src/features/project-optimize/fix-map.logic.test.js
```

预期：`selectFixableRules(report, [0,2])` 返回全部三个文件（入参被忽略），断言失败。

- [ ] **Step 3: 实现**

`fix-plan.logic.js` —— 改 `selectFixableRules` 签名与循环入口：

```js
export function selectFixableRules(report, pickIndices = null) {
  const issues = report?.dims?.rules?.issues;
  if (!Array.isArray(issues)) return { files: [], blocked: [] };

  // null = 全选（既有调用点的行为，不能变）；数组 = 只看这些下标
  const pick = pickIndices ? new Set(pickIndices) : null;

  const files = [];
  const seen = new Set();
  const blocked = [];

  for (let i = 0; i < issues.length; i += 1) {
    if (pick && !pick.has(i)) continue;
    const it = issues[i];
    const file = String(it?.file || '');
    if (!file.startsWith(RULES_PREFIX)) continue;

    if (it.fixable !== true) {
      blocked.push({ file, reason: String(it?.message || '检测器标记为不可自动修复') });
      continue;
    }
    const name = file.slice(RULES_PREFIX.length);
    if (seen.has(name)) continue;
    seen.add(name);
    files.push(name);
  }

  return { files, blocked };
}
```

`fix-map.logic.js` —— 同样改法：

```js
export function selectFixableMap(report, pickIndices = null) {
  const out = { rootMap: false, modules: [], stale: [], deadLinks: [], blocked: [] };
  const issues = report?.dims?.map?.issues;
  if (!Array.isArray(issues)) return out;

  // null = 全选（既有调用点的行为，不能变）；数组 = 只看这些下标
  const pick = pickIndices ? new Set(pickIndices) : null;

  for (let i = 0; i < issues.length; i += 1) {
    if (pick && !pick.has(i)) continue;
    const it = issues[i];
    const file = String(it?.file || '');
    if (it?.fixable !== true) {
      out.blocked.push({ file, reason: String(it?.message || '检测器标记为不可自动修复') });
      continue;
    }

    switch (it.code) {
      case 'M1_NO_ROOT_MAP':
        out.rootMap = true;
        break;
      case 'M2_MISSING_MAP':
        out.modules.push(file.replace(/\/CLAUDE\.md$/, ''));
        break;
      case 'M3_STALE_MAP':
        if (typeof it.staleDays === 'number') out.stale.push({ file, staleDays: it.staleDays });
        else out.blocked.push({ file, reason: STALE_REPORT_REASON });
        break;
      case 'M4_DEAD_LINK':
        if (typeof it.ref === 'string' && it.ref) out.deadLinks.push({ file, line: it.line, ref: it.ref });
        else out.blocked.push({ file, reason: STALE_REPORT_REASON });
        break;
      default:
        out.blocked.push({ file, reason: `未知的地图问题类型 ${it.code}，未做处理` });
    }
  }

  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js src/features/project-optimize/fix-map.logic.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。既有调用点（`optimize-ops.js`）未传第二参，行为不变。

---

## Task 5：复测清单（规则化，零 LLM）

**Files:**
- Create: `src/features/project-optimize/retest.logic.js`
- Create: `src/features/project-optimize/retest.js`
- Test: `src/features/project-optimize/retest.logic.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/features/project-optimize/retest.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByModule, buildRetestList, firstParagraph } from './retest.logic.js';

test('groupByModule：按目录归拢改动文件', () => {
  const out = groupByModule(['src/app/dispatch.js', 'src/app/intent.js', 'public/js/chat.js']);
  assert.deepEqual(out, {
    'src/app': ['src/app/dispatch.js', 'src/app/intent.js'],
    'public/js': ['public/js/chat.js'],
  });
});

test('groupByModule：Windows 反斜杠路径归一为正斜杠', () => {
  // 后端在 win32 下产出的 file 可能带反斜杠，不归一会和 posix 路径分成两组
  assert.deepEqual(groupByModule(['src\\app\\dispatch.js']), { 'src/app': ['src/app/dispatch.js'] });
});

test('groupByModule：根目录文件归到 "."', () => {
  assert.deepEqual(groupByModule(['README.md']), { '.': ['README.md'] });
});

test('firstParagraph：取 markdown 正文首段，跳过标题与引用', () => {
  const md = '# src/app · 模块地图\n\n> 引用块不算正文\n\n本目录负责分发与意图识别。\n\n第二段不要。';
  assert.equal(firstParagraph(md), '本目录负责分发与意图识别。');
});

test('firstParagraph：没有正文时返回空串（不编造）', () => {
  assert.equal(firstParagraph('# 只有标题'), '');
  assert.equal(firstParagraph(''), '');
});

test('buildRetestList：有地图就带职责，没有就只列文件', () => {
  const out = buildRetestList(
    ['src/app/dispatch.js', 'scripts/foo.js'],
    { 'src/app': '本目录负责分发与意图识别。' },
  );
  assert.deepEqual(out, [
    { dir: 'scripts', responsibility: '', files: ['scripts/foo.js'] },
    { dir: 'src/app', responsibility: '本目录负责分发与意图识别。', files: ['src/app/dispatch.js'] },
  ]);
});

test('buildRetestList：空改动返回空数组', () => {
  assert.deepEqual(buildRetestList([], {}), []);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test src/features/project-optimize/retest.logic.test.js
```

预期：`Cannot find module './retest.logic.js'`。

- [ ] **Step 3: 实现纯逻辑**

新建 `src/features/project-optimize/retest.logic.js`：

```js
/**
 * 修复报告的「需要复测什么」——纯逻辑层，不碰文件系统。
 *
 * ## 为什么是规则化而不是让模型写
 *
 * 复测建议一旦编造就是负价值：用户照着一份虚构的清单去测，会以为覆盖到了。
 * 本项目每级目录都有 `CLAUDE.md` 写明该模块职责，「改了哪个目录 → 那个目录负责什么」
 * 是确定性的事实推导，不需要模型参与，也就不会有幻觉、不花额度、不用等。
 *
 * 代价是产出比较朴素（列模块与职责，不给具体测试步骤）。这是有意的取舍：
 * 朴素但可信 > 详细但可能是编的。
 */

/** 改动文件按所在目录归拢。根目录文件归到 '.' */
export function groupByModule(files) {
  const out = {};
  for (const f of files || []) {
    const p = String(f || '').replace(/\\/g, '/');
    if (!p) continue;
    const at = p.lastIndexOf('/');
    const dir = at < 0 ? '.' : p.slice(0, at);
    (out[dir] ||= []).push(p);
  }
  return out;
}

/**
 * 取 markdown 的正文首段。
 *
 * 跳过标题（`#`）、引用（`>`）、空行与列表——模块地图的开头常是
 * 「# 标题」+「> 导读引用块」，直接取第一行非空会拿到标题，那不是职责描述。
 * 拿不到就返回空串，由调用方降级为「只列文件」，**绝不编造**。
 */
export function firstParagraph(md) {
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('>') || line.startsWith('-') || line.startsWith('*')) continue;
    if (line.startsWith('|') || line.startsWith('```')) continue;
    return line;
  }
  return '';
}

/**
 * 组装复测清单。
 *
 * @param {string[]} changedFiles 本次实际改动过的文件
 * @param {Object<string,string>} responsibilities 目录 → 职责描述（由 IO 层读 CLAUDE.md 提供）
 * @returns {Array<{dir:string, responsibility:string, files:string[]}>} 按目录名排序
 */
export function buildRetestList(changedFiles, responsibilities = {}) {
  const grouped = groupByModule(changedFiles);
  return Object.keys(grouped)
    .sort()
    .map((dir) => ({
      dir,
      responsibility: responsibilities[dir] || '',
      files: grouped[dir],
    }));
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test src/features/project-optimize/retest.logic.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 实现 IO 层**

新建 `src/features/project-optimize/retest.js`：

```js
/**
 * 复测清单的 IO 层：读各级 CLAUDE.md 取模块职责。
 *
 * 极薄——判断逻辑全在 retest.logic.js（本目录 `X.js` + `X.logic.js` 的既定分工）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { groupByModule, firstParagraph, buildRetestList } from './retest.logic.js';

/**
 * 从改动文件列表产出复测清单。
 *
 * 向**上**逐级找 CLAUDE.md：`src/entrypoints/web/` 没有自己的地图时，
 * 用 `src/entrypoints/` 的——那仍是对的模块描述，只是粗一档。
 * 一直找到仓库根都没有就留空，由渲染层降级为只列文件。
 *
 * 读盘失败一律吞成空串：复测清单是报告的锦上添花，
 * 不该因为一个权限问题让整份修复报告出不来。
 */
export function collectRetest(dir, changedFiles) {
  const responsibilities = {};

  for (const moduleDir of Object.keys(groupByModule(changedFiles))) {
    let cur = moduleDir;
    // 逐级上溯；'.' 是终点
    for (;;) {
      const mdPath = path.join(dir, cur === '.' ? '' : cur, 'CLAUDE.md');
      try {
        const text = fs.readFileSync(mdPath, 'utf8');
        const para = firstParagraph(text);
        if (para) { responsibilities[moduleDir] = para; break; }
      } catch { /* 这一级没有地图，继续往上找 */ }

      if (cur === '.') break;
      const at = cur.lastIndexOf('/');
      cur = at < 0 ? '.' : cur.slice(0, at);
    }
  }

  return buildRetestList(changedFiles, responsibilities);
}
```

- [ ] **Step 6: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`，且测试总数增加 6。

---

## Task 6：`GET /api/optimize/fix-plan` 端点

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js`
- Modify: `src/entrypoints/web/routes-optimize.js`
- Test: `src/entrypoints/web/routes-optimize.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `src/entrypoints/web/routes-optimize.test.js`（沿用该文件既有的路由分发测试风格）：

```js
test('GET /api/optimize/fix-plan 缺 dir 回 400', async () => {
  const res = mockRes();
  await handleOptimizeRoutes(
    { method: 'GET' },
    res,
    new URL('http://x/api/optimize/fix-plan'),
  );
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test src/entrypoints/web/routes-optimize.test.js
```

预期：返回 404（路由未注册）而非 400。

- [ ] **Step 3: 在 ops 层加导出**

`optimize-ops.js` —— 找到既有的那行 import（从 `fix-plan.logic.js` 导入 `selectFixableRules` / `buildFixNotes`），在导入列表末尾追加 `buildFixPlan`。执行前先确认当前行内容：

```bash
grep -n "fix-plan.logic.js" src/entrypoints/web/optimize-ops.js
```

改成形如：

```js
import { selectFixableRules, buildFixNotes, buildFixPlan } from '../../features/project-optimize/fix-plan.logic.js';
```

> 只追加符号，不要改动路径或既有符号——`buildFixNotes` 等仍被 `runFix` 使用。

在 `getBusyState` 之后追加：

```js
/**
 * 当前项目的修复计划。
 *
 * 纯计算、零 LLM、零写盘——所以每次前端要就现算，不做缓存：
 * 缓存的唯一收益是省几毫秒，代价却是要处理「报告更新了但计划还是旧的」这类失效问题。
 */
export function getFixPlan(dir) {
  const report = getProjectRecord(dir)?.lastCheckup;
  if (!report) return { at: '', items: [] };
  return buildFixPlan(report, fixOrderedDimensions());
}
```

- [ ] **Step 4: 注册路由**

`routes-optimize.js` —— import 区补 `getFixPlan`，并新增 handler：

```js
// ==== GET /api/optimize/fix-plan?dir=xxx ====
// 修复计划：每条 issue 一项，带动作与风险标签，供前端做细粒度勾选
function handleFixPlan(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  sendJson(res, 200, getFixPlan(dir));
}
```

在 `handleOptimizeRoutes` 的 `/api/optimize/report` 分支**之后**插入：

```js
  if (url.pathname === '/api/optimize/fix-plan' && req.method === 'GET') {
    return handleFixPlan(res, url);
  }
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test src/entrypoints/web/routes-optimize.test.js
```

预期：全部 PASS。

- [ ] **Step 6: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 7：`startFix` 接受 `items`（细粒度选材）

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js`
- Modify: `src/entrypoints/web/routes-optimize.js`

- [ ] **Step 1: 改 `startFix` 签名与选材**

把 `startFix` 的入参与选材段改为：

```js
export async function startFix(dir, { items = null, risk = 'low', force = false, reportAt = '' } = {}) {
  const report = getProjectRecord(dir)?.lastCheckup;
  if (!report) throw new Error('请先跑一次体检，再执行优化');

  // 计划快照校验：前端的 id 是「报告里的下标」，报告一变下标就会错位，
  // 修到不相干的文件上。宁可让前端重拉一次计划，也不能拿旧下标去改文件
  if (reportAt && report.at && reportAt !== report.at) {
    return { stalePlan: true, reportAt: report.at };
  }

  const allowedRisks = risksFor(risk);

  // 细粒度选材：items 非空时按下标还原 issue 子集；为 null 时退回「整维度」老行为
  const sel = items ? resolveSelection(report, items) : null;
  if (sel?.rejected.length) {
    logger.warn('optimize', '修复计划里有无效项，已丢弃', { dir, count: sel.rejected.length, sample: sel.rejected.slice(0, 5) });
  }

  const dimensions = sel ? Object.keys(sel.byDim) : [];
  const want = (d) => !dimensions.length || dimensions.includes(d);
  const allowBespoke = (id) => allowedRisks.includes(dimensionById(id)?.risk || 'high');

  const rules = want('rules') && allowBespoke('rules')
    ? selectFixableRules(report, sel?.indicesByDim.rules || null)
    : { files: [], blocked: [] };
  const map = want('map') && allowBespoke('map')
    ? selectFixableMap(report, sel?.indicesByDim.map || null)
    : { rootMap: false, modules: [], stale: [], deadLinks: [], blocked: [] };

  // 通用引擎：有 items 时用还原出的 issue 子集覆盖掉「该维度全部 issue」
  const engineDims = selectFixableDims({
    dimensions: fixOrderedDimensions(),
    report,
    requested: dimensions,
    allowedRisks,
  }).map((entry) => (sel ? { ...entry, issues: sel.byDim[entry.dim.id] || [] } : entry))
    .filter((entry) => entry.issues.length);
```

其余部分（闸、workspace 检查、job 创建、`runFix` 调用）保持不变，但 `runFix` 的参数里 `dimensions` 仍传 `dimensions`（`buildFixNotes` 用它判「勾了不支持的维度」）。

- [ ] **Step 2: import 补齐**

`optimize-ops.js` 的 import 行补 `resolveSelection`：

```js
import { selectFixableRules, buildFixNotes, buildFixPlan, resolveSelection } from '../../features/project-optimize/fix-plan.logic.js';
```

- [ ] **Step 3: 路由层透传**

`routes-optimize.js` 的 `handleFix` 改为：

```js
function handleFix(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
    // items 是计划项 id 数组。fail-closed：只认字符串数组，脏形状一律当「没传」，
    // 退回整维度老行为而不是把脏数据透传进编排层
    const items = Array.isArray(data.items) ? data.items.map(str).filter(Boolean) : null;
    const risk = str(data.risk) || 'all';
    const reportAt = str(data.reportAt);

    try {
      const out = await startFix(dir, { items, risk, force: !!data.force, reportAt });
      if (out.busy) return sendJson(res, 409, { error: BUSY_MSG, busy: out.busy });
      // 计划过期：前端据此重拉计划再让用户确认，不能拿旧下标去改文件
      if (out.stalePlan) return sendJson(res, 409, { error: '体检报告已更新，请重新加载修复计划', stalePlan: true });
      sendJson(res, 200, out);
    } catch (e) {
      logger.warn('optimize', '优化启动失败', { dir, err: e.message });
      sendJson(res, 400, { error: e.message });
    }
  });
}
```

> `risk` 默认从 `'low'` 改为 `'all'`：风险不再是按钮档位，由勾选决定。勾选里有什么风险的项就执行什么——档位过滤会与勾选语义打架（用户勾了高风险项却被静默跳过）。

- [ ] **Step 4: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 8：中止体检

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js`
- Modify: `src/entrypoints/web/routes-optimize.js`

- [ ] **Step 1: 给 checkup job 挂 AbortController**

`runCheckup` 里的 job 对象改为（照抄 fix job 的两个字段）：

```js
  gc();
  const ac = new AbortController();
  const job = {
    id: jobId || `ckup_${Date.now().toString(36)}_${++seq}`,
    kind: 'checkup',
    dir,
    status: 'running',
    ownsBusy,
    report,
    landed: {},
    done: null,
    subs: new Set(),
    // 中断句柄：17 个维度跑十几分钟，没有取消点等于把人锁在进度条前面。
    // 与 fix job 同构，`cancelCheckupJob` 靠它发信号
    abort: () => ac.abort(),
    signal: ac.signal,
    updatedAt: Date.now(),
  };
```

- [ ] **Step 2: signal 透传到四个调用点**

`runAsyncDims` 里：

```js
  // 取材
  evidence = await collectEvidence(dir, { signal: job.signal });
```

```js
  // 专属检测器
  for (const [key, run] of Object.entries(LEGACY_RUNNERS)) {
    tasks.push({ key, settled: wrap(() => run(dir, { cache: cache[key] || null, force, signal: job.signal })) });
  }
```

```js
  // audit 维度
        ? wrap(() => runAudit(dim, evidence, {
          cache: cache[dim.id] || null,
          force,
          signal: job.signal,
          onProgress: (p) => emit(job, 'progress', p),
        }))
```

```js
  // 整体评估：已 abort 就别再花这一次调用（它是最贵的一段，实测 6.3 分钟）
  if (job.signal?.aborted) { finishJob(job); return; }
  const h = await checkHolistic(dir, job.report, evidence || { files: [] }, { signal: job.signal });
```

> `collectEvidence` / `LEGACY_RUNNERS` 的各 `check-*` / `checkHolistic` 若尚未接受 `signal`，为其 opts 增加该参数并在内部的 LLM 调用前透传；`runAudit` 与 `llm-readonly-agent` 已支持，无需改。

- [ ] **Step 3: finishJob 把未落地维度标 cancelled**

`finishJob` 改为：

```js
function finishJob(job) {
  if (job.status !== 'running') return;

  // 被中止时，仍停在 analyzing 的维度标 cancelled 而不是留着转圈。
  // 必须是新状态而不是复用 error —— 「你自己停的」和「出问题了」处置完全不同，
  // 复用 error 会把主动中止显示成分析失败（这正是上一轮刚修掉的那类误导）
  if (job.signal?.aborted) {
    for (const [key, d] of Object.entries(job.report.dims || {})) {
      if (d?.status === 'analyzing') {
        job.report.dims[key] = { ...d, status: 'cancelled', reason: '已取消，重新体检可续' };
      }
    }
  }

  logger.info('optimize', '体检：收尾', {
    dir: job.dir, job: job.id, landed: Object.keys(job.landed).length, cancelled: !!job.signal?.aborted,
  });
  recomputeReport(job.report);
  saveCheckup(job.dir, job.report);
  job.status = 'done';
  job.done = {
    score: job.report.score,
    grade: job.report.grade,
    issueCount: job.report.issueCount,
    cancelled: !!job.signal?.aborted,
  };
  job.updatedAt = Date.now();
  emit(job, 'done', job.done);
  closeSubs(job);
  if (job.ownsBusy) releaseBusy(job.dir);
}
```

- [ ] **Step 4: 加 `cancelCheckupJob`**

在 `cancelFixJob` 旁边追加（保持两者对称）：

```js
/**
 * 中止一次体检。只发信号、不等它停——正在跑的 LLM 调用由 abortController 打断。
 *
 * 已落地的维度**保留**：它们早已 saveCheckup 落盘，丢掉等于白烧那部分额度。
 * 未跑完的在 finishJob 里标 cancelled，重新体检时已完成的走指纹缓存、
 * 被取消的重跑——「续跑」是这套缓存机制的自然结果，不需要额外的断点机制。
 */
export function cancelCheckupJob(id) {
  const job = id ? jobs.get(id) : null;
  if (!job || job.kind !== 'checkup' || job.status !== 'running') return false;
  job.abort();
  logger.info('optimize', '体检：收到中止信号', { dir: job.dir, job: job.id });
  return true;
}
```

- [ ] **Step 5: 注册路由**

`routes-optimize.js` 加 handler 与分发：

```js
// ==== POST /api/optimize/checkup/cancel {checkupId} ====
// 只发停止信号。已完成的维度保留，未完成的标 cancelled
function handleCheckupCancel(req, res) {
  return withJsonBody(req, res, async (data) => {
    const checkupId = str(data.checkupId);
    if (!checkupId) return sendJson(res, 400, { error: '缺少 checkupId 参数' });
    // 找不到一律 404 而非静默 200：前端据此提示「任务已结束」，
    // 回 200 会让用户以为点停止生效了、然后继续等一个不会来的停止事件
    if (!cancelCheckupJob(checkupId)) return sendJson(res, 404, { error: '体检任务不存在或已结束' });
    sendJson(res, 200, { ok: true });
  });
}
```

分发表中，在 `/api/optimize/checkup-stream` 分支**之前**插入（精确路由必须排在前缀路由之前）：

```js
  if (url.pathname === '/api/optimize/checkup/cancel' && req.method === 'POST') {
    return handleCheckupCancel(req, res);
  }
```

- [ ] **Step 6: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 9：把复测清单接进修复完成事件

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js`

- [ ] **Step 1: import**

```js
import { collectRetest } from '../../features/project-optimize/retest.js';
```

- [ ] **Step 2: 在 `finishFixJob` 的 done 负载里加 retest**

找到 `runFix` 收尾处构造 done 的位置，把本次实际改动过的文件收集出来并算复测清单：

```js
  // 复测清单：从本次真正落盘的改动反推受影响模块。
  // 规则化、零 LLM，所以不会拖慢收尾，也不会编造
  const changedFiles = results
    .filter((r) => r?.status === 'done' && r.file)
    .map((r) => r.file);
  const retest = collectRetest(dir, changedFiles);
```

并把 `retest` 并进 `finishFixJob(job, { ... })` 的负载对象。

- [ ] **Step 3: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 10：前端勾选树纯逻辑

**Files:**
- Create: `public/js/optimize-plan.logic.js`
- Test: `public/js/optimize-plan.logic.test.js`

- [ ] **Step 1: 写失败测试**

新建 `public/js/optimize-plan.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSelection, groupPlan, nodeCheckState, toggleNode, topButtonsState, RISK_LABEL,
} from './optimize-plan.logic.js';

const ITEMS = [
  { id: 'complexity#0', dim: 'complexity', dimLabel: '复杂度', category: 'quality', risk: 'high', action: '改源码', file: 'a.js', line: 1, message: 'A', severity: 'warn' },
  { id: 'complexity#1', dim: 'complexity', dimLabel: '复杂度', category: 'quality', risk: 'low', action: '只出清单', file: 'b.js', line: 2, message: 'B', severity: 'info' },
  { id: 'docs#0', dim: 'docs', dimLabel: '文档', category: 'engineering', risk: 'medium', action: '改文档', file: 'R.md', line: 1, message: 'C', severity: 'info' },
];

test('defaultSelection：默认只勾低风险', () => {
  assert.deepEqual([...defaultSelection(ITEMS)], ['complexity#1']);
});

test('groupPlan：按域 → 维度两层分组，保持首次出现顺序', () => {
  const groups = groupPlan(ITEMS);
  assert.deepEqual(groups.map((g) => g.category), ['quality', 'engineering']);
  assert.deepEqual(groups[0].dims.map((d) => d.dim), ['complexity']);
  assert.equal(groups[0].dims[0].items.length, 2);
});

test('nodeCheckState：全选 / 半选 / 未选三态', () => {
  assert.equal(nodeCheckState(['a', 'b'], new Set(['a', 'b'])), 'all');
  assert.equal(nodeCheckState(['a', 'b'], new Set(['a'])), 'some');
  assert.equal(nodeCheckState(['a', 'b'], new Set()), 'none');
  assert.equal(nodeCheckState([], new Set()), 'none', '空节点不算全选');
});

test('toggleNode：半选与未选都变全选，全选变全不选', () => {
  assert.deepEqual([...toggleNode(['a', 'b'], new Set())], ['a', 'b']);
  assert.deepEqual([...toggleNode(['a', 'b'], new Set(['a']))], ['a', 'b']);
  assert.deepEqual([...toggleNode(['a', 'b'], new Set(['a', 'b']))], []);
});

test('toggleNode：不影响节点之外的选中项', () => {
  assert.deepEqual([...toggleNode(['a'], new Set(['a', 'z']))].sort(), ['z']);
});

test('topButtonsState：五种状态', () => {
  const base = { hasReport: true, checkupBusy: '', fixRunning: false, items: ITEMS, selected: new Set(['complexity#1']), handled: new Set() };

  assert.deepEqual(topButtonsState({ ...base, hasReport: false, items: [] }), { mode: 'idle', fixCount: 0, fixDisabled: true });
  assert.deepEqual(topButtonsState({ ...base, checkupBusy: 'analyzing' }), { mode: 'checking', fixCount: 0, fixDisabled: true });
  assert.deepEqual(topButtonsState({ ...base, fixRunning: true }), { mode: 'fixing', fixCount: 0, fixDisabled: true });
  assert.deepEqual(topButtonsState(base), { mode: 'ready', fixCount: 1, fixDisabled: false });

  // 全部项都已处理 → 不再显示一键修复
  const allHandled = new Set(ITEMS.map((i) => i.id));
  assert.deepEqual(topButtonsState({ ...base, handled: allHandled }), { mode: 'done-all', fixCount: 0, fixDisabled: true });
});

test('topButtonsState：勾选为空时按钮禁用但不隐藏', () => {
  const s = topButtonsState({ hasReport: true, checkupBusy: '', fixRunning: false, items: ITEMS, selected: new Set(), handled: new Set() });
  assert.equal(s.mode, 'ready', '还有未处理项就该继续显示按钮');
  assert.equal(s.fixCount, 0);
  assert.equal(s.fixDisabled, true);
});

test('topButtonsState：已处理的项不计入可修数', () => {
  const s = topButtonsState({
    hasReport: true, checkupBusy: '', fixRunning: false, items: ITEMS,
    selected: new Set(['complexity#0', 'complexity#1']), handled: new Set(['complexity#0']),
  });
  assert.equal(s.fixCount, 1);
});

test('RISK_LABEL 三档齐全', () => {
  assert.deepEqual(Object.keys(RISK_LABEL).sort(), ['high', 'low', 'medium']);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test public/js/optimize-plan.logic.test.js
```

预期：`Cannot find module './optimize-plan.logic.js'`。

- [ ] **Step 3: 实现**

新建 `public/js/optimize-plan.logic.js`：

```js
/**
 * 修复计划勾选树的纯逻辑层：不碰 DOM，可在 node 下单测。
 *
 * 这里承载的是「勾了什么、按钮该长什么样」这类判定。把它们留在渲染函数里，
 * 就会重演上一轮 `checkupBusy` 的事故形状——状态变量改了，某个渲染分支没跟上。
 */

/** 风险档位的展示文案。与后端 RISK_META 对应，措辞保持一致 */
export const RISK_LABEL = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

/**
 * 初始勾选：只勾低风险。
 *
 * 这是个会改文件的操作，默认值必须是最保守的那个。中高风险要用户自己一条条勾，
 * 「默认全不勾」则会让用户面对一棵空树无从下手——低风险项本身是安全的
 * （只新增文件、改配置、出清单），默认勾上既有产出又不会造成意外改动。
 */
export function defaultSelection(items) {
  return new Set((items || []).filter((i) => i.risk === 'low').map((i) => i.id));
}

/**
 * 按「域 → 维度」两层分组，组内保持计划里的原始顺序。
 *
 * 不排序的理由：计划本身已按注册表的 fixOrder 排好，那个顺序有语义
 * （补测试在改源码之前），重排会让用户看到的次序与实际执行次序不一致。
 */
export function groupPlan(items) {
  const byCat = new Map();
  for (const it of items || []) {
    if (!byCat.has(it.category)) byCat.set(it.category, new Map());
    const dims = byCat.get(it.category);
    if (!dims.has(it.dim)) dims.set(it.dim, { dim: it.dim, dimLabel: it.dimLabel, items: [] });
    dims.get(it.dim).items.push(it);
  }
  return [...byCat.entries()].map(([category, dims]) => ({
    category,
    dims: [...dims.values()],
  }));
}

/**
 * 一个节点（域或维度）的勾选态。
 *
 * 空节点返回 'none' 而不是 'all'：`[].every()` 恒为 true，不特判的话
 * 一个没有任何可修项的分组会显示成「已全选」，点一下却什么都没发生。
 */
export function nodeCheckState(ids, selected) {
  const list = ids || [];
  if (!list.length) return 'none';
  const n = list.filter((id) => selected.has(id)).length;
  if (n === 0) return 'none';
  return n === list.length ? 'all' : 'some';
}

/**
 * 切换一个节点：全选态 → 全不选，其余（含半选）→ 全选。
 *
 * 半选按「变全选」处理，是因为用户点一个半选的分组时想的是「都要」——
 * 点成全不选会把他刚才手工勾的那几条也一起清掉。
 *
 * 返回新 Set 而不是原地改：调用方按不可变语义重渲染，避免漏掉某处更新。
 */
export function toggleNode(ids, selected) {
  const next = new Set(selected);
  const state = nodeCheckState(ids, selected);
  for (const id of ids || []) {
    if (state === 'all') next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * 顶部按钮区该显示什么。
 *
 * ## 两个数必须分清
 *
 * - **显示/隐藏「一键修复」** 看的是计划里**还有没有未处理项**（与勾选无关）。
 *   用户只勾低风险修完后，中高风险项仍未处理，按钮该留着。
 * - **`fixCount` 与可点性** 看的是**当前勾选且未处理**的数量。
 *   全取消勾选时禁用但**不隐藏**——隐藏会让用户以为没东西可修了。
 *
 * @returns {{mode:'idle'|'checking'|'fixing'|'ready'|'done-all', fixCount:number, fixDisabled:boolean}}
 */
export function topButtonsState({ hasReport, checkupBusy, fixRunning, items, selected, handled }) {
  if (checkupBusy) return { mode: 'checking', fixCount: 0, fixDisabled: true };
  if (fixRunning) return { mode: 'fixing', fixCount: 0, fixDisabled: true };
  if (!hasReport) return { mode: 'idle', fixCount: 0, fixDisabled: true };

  const list = items || [];
  const done = handled || new Set();
  const remaining = list.filter((i) => !done.has(i.id));
  if (!remaining.length) return { mode: 'done-all', fixCount: 0, fixDisabled: true };

  const fixCount = remaining.filter((i) => selected.has(i.id)).length;
  return { mode: 'ready', fixCount, fixDisabled: fixCount === 0 };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test public/js/optimize-plan.logic.test.js
```

预期：全部 PASS（10 条）。

- [ ] **Step 5: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 11：`dimListFrom` 支持 `cancelled` 状态

**Files:**
- Modify: `public/js/optimize-view.logic.js`
- Test: `public/js/optimize-view.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
test('dimListFrom：cancelled 是中止而非失败，不转圈、不可勾选', () => {
  const report = { dims: { complexity: { status: 'cancelled', reason: '已取消，重新体检可续' } } };
  const d = dimListFrom(report).find((x) => x.key === 'complexity');
  assert.equal(d.status, 'cancelled');
  assert.equal(d.busy, false, '已经停了就不该继续转圈');
  assert.equal(d.selectable, false, '没有完整结论，不能拿去驱动修改');
  assert.equal(d.cancelled, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test public/js/optimize-view.logic.test.js
```

预期：`d.cancelled` 为 `undefined`。

- [ ] **Step 3: 实现**

`dimListFrom` 的返回对象里追加一个字段：

```js
      busy: status === 'analyzing',
      // 中止与失败必须分开：前者是用户自己停的、随时可续，后者要看原因。
      // 混为一谈会把「你停的」显示成「失败了」
      cancelled: status === 'cancelled',
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test public/js/optimize-view.logic.test.js
```

预期：PASS。

- [ ] **Step 5: 验证无回归**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`。

---

## Task 12：样式（严格复用项目既有体系）

> 本任务是用户明确要求的重点：必须用项目现有风格，不允许随手写。逐条对照 spec 第十节。

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: 补 `.pretty-check` 的半选态**

在 `.pretty-check:focus-visible` 规则**之后**追加（与既有规则同段，保持同一套视觉语言）：

```css
      /* 半选：树的域/维度节点用。沿用 .pretty-check 的全部形制，
         只把「勾」换成「横杠」——另起一套视觉会让同一棵树里出现两种复选框语言 */
      .pretty-check:indeterminate {
        background: var(--accent); border-color: var(--accent);
      }
      .pretty-check:indeterminate::after {
        content: ''; position: absolute; left: 3px; top: 6.5px;
        width: 10px; height: 2px; background: #fff; border-radius: 1px;
      }
```

- [ ] **Step 2: 顶部按钮区**

在优化面板段落的 `.opt-score` 规则之后追加：

```css
/* 顶部操作区：按钮统一收在分数卡右侧。原来体检在顶部、修复在底部，
   用户要在一屏里上下找两次才能完成一轮操作 */
.opt-score-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.opt-done-note { color: var(--muted); font-size: 12px; max-width: 220px; line-height: 1.5; }
```

- [ ] **Step 3: 勾选树**

追加到优化面板段落末尾：

```css
/* ---- 修复计划勾选树 ---- */
.opt-plan { display: flex; flex-direction: column; gap: 8px; }
.opt-plan-empty { color: var(--muted); font-size: 12px; padding: 10px 0; }

/* 域与维度两层节点：复用 .opt-group 的折叠箭头形制，只调尺寸层级 */
.opt-plan-node { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.opt-plan-node .opt-plan-title { font-weight: 600; font-size: 13px; }
.opt-plan-node .opt-plan-count { color: var(--muted); font-size: 12px; margin-left: auto; }

.opt-plan-dim { display: flex; flex-direction: column; gap: 6px; padding-left: 22px; }
.opt-plan-items { display: flex; flex-direction: column; gap: 4px; padding-left: 22px; }
.opt-plan-items.is-folded, .opt-plan-dim.is-folded { display: none; }

/* 单条计划项 */
.opt-plan-item {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 8px; border-radius: 6px;
}
.opt-plan-item:hover { background: var(--accent-extra-soft); }
.opt-plan-item.is-handled { opacity: .5; }
.opt-plan-loc { color: var(--accent-hi); font-size: 12px; white-space: nowrap; }
.opt-plan-msg { color: var(--muted); font-size: 12px; flex: 1; min-width: 0; }

/* 动作 / 风险标签：照 .t-badge 形制（11px / 1px 7px / radius 10px），
   颜色一律走变量，不硬编码色值 */
.opt-tag {
  font-size: 11px; padding: 1px 7px; border-radius: 10px;
  white-space: nowrap; flex: none;
}
.opt-tag.risk-low { background: rgba(108, 195, 138, .15); color: var(--green); }
.opt-tag.risk-medium { background: rgba(217, 164, 65, .15); color: var(--amber); }
.opt-tag.risk-high { background: rgba(229, 104, 122, .15); color: var(--red); }
.opt-plan-handled { font-size: 11px; color: var(--faint); white-space: nowrap; }

/* ---- 修复报告弹窗 ---- */
.opt-report-modal { width: min(680px, 94vw); }
.opt-report-sec { margin-bottom: 16px; }
.opt-report-sec:last-child { margin-bottom: 0; }
.opt-report-sec h4 { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.opt-report-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 0; font-size: 12px; color: var(--muted);
}
.opt-report-dir { color: var(--text); font-weight: 600; font-size: 12px; }
.opt-report-resp { color: var(--muted); font-size: 12px; line-height: 1.6; }
.opt-report-foot {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 16px; border-top: 1px solid var(--border-soft);
}
```

- [ ] **Step 4: 删除底部操作区遗留样式**

删掉这两行（`.opt-actions` 整块在 Task 13 从 HTML 移除）：

```css
.opt-actions { display: flex; align-items: center; gap: 12px; }
.opt-actions[hidden] { display: none; }
```

`.opt-phase-note` 保留（顶部提示仍用它）。

- [ ] **Step 5: 验证**

```bash
node -e "const c=require('fs').readFileSync('public/app.css','utf8');
const o=(c.match(/{/g)||[]).length, x=(c.match(/}/g)||[]).length;
console.log('braces', o, x, o===x?'OK':'MISMATCH');"
```

预期：`OK`。

---

## Task 13：HTML 结构调整

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 顶部分数卡加按钮区**

把 `.opt-score` 块内的单个体检按钮：

```html
              <button id="optRunCheckup" class="btn primary">体检</button>
```

替换为：

```html
              <div class="opt-score-actions" id="optScoreActions">
                <button id="optRunCheckup" class="btn primary">开始体检</button>
                <button id="optCancelCheckup" class="btn stop" hidden>中止体检</button>
                <button id="optFix" class="btn primary" hidden>一键修复</button>
                <button id="optFixCancel" class="btn stop" hidden>停止修复</button>
                <span class="opt-done-note" id="optDoneNote" hidden></span>
              </div>
```

- [ ] **Step 2: 加修复计划树容器**

在 `<div class="opt-dims" id="optDims"></div>` **之后**插入：

```html
            <!-- 修复计划勾选树：由 optimize-view.js 用 createElement + textContent 填充（禁 innerHTML） -->
            <div class="opt-plan" id="optPlan"></div>
```

- [ ] **Step 3: 删除底部操作区**

整块删除：

```html
            <div class="opt-actions" id="optActions">
              <button id="optFix" class="btn primary" disabled>一键优化（低风险）</button>
              <button id="optFixElevated" class="btn" disabled>中高风险优化</button>
              <button id="optFixCancel" class="btn" hidden>停止</button>
              <span class="opt-phase-note" id="optFixHint">低风险只新增测试与整改清单、改 .gitignore；改文档与改源码走右边那个按钮</span>
            </div>
```

> `optFix` / `optFixCancel` 已在 Step 1 移到顶部；`optFixElevated` 与 `optFixHint` 随风险档位一起废弃。

- [ ] **Step 4: 验证结构完整**

```bash
node -e "const h=require('fs').readFileSync('public/index.html','utf8');
for (const id of ['optRunCheckup','optCancelCheckup','optFix','optFixCancel','optPlan','optDoneNote']) {
  if (!h.includes('id=\"'+id+'\"')) throw new Error('缺 '+id);
}
if (h.includes('optFixElevated')) throw new Error('optFixElevated 未删干净');
console.log('HTML OK');"
```

预期：`HTML OK`。

---

## Task 14：前端顶部按钮状态机与中止体检接线

**Files:**
- Modify: `public/js/optimize-view.js`

- [ ] **Step 1: import 与模块状态**

顶部 import 区追加：

```js
import {
  defaultSelection, groupPlan, nodeCheckState, toggleNode, topButtonsState, RISK_LABEL,
} from './optimize-plan.logic.js';
import { openFixReport } from './optimize-report.js';
```

模块状态区追加：

```js
/** 当前修复计划（后端算的，前端只读不改） */
let plan = { at: '', items: [] };
/** 已勾选的计划项 id */
let selected = new Set();
/** 本轮已处理的计划项 id —— 防重复勾，不参与分数重算（分数必须重新体检才更新） */
let handled = new Set();
/** 正在跑的体检 job id，「中止体检」要拿它调 cancel 接口 */
let checkupJobId = null;
```

- [ ] **Step 2: 用状态机替换 `refreshButtons` / `refreshFixButton`**

删除既有的 `refreshButtons` 与 `refreshFixButton`，替换为：

```js
const CHECKUP_LABEL = { posting: '启动中…', analyzing: '体检中…' };

/**
 * 顶部按钮区。**判定全在 optimize-plan.logic.js 的 topButtonsState**，
 * 这里只负责把结果映射到 DOM —— 上一轮的事故教训是「状态变量改了但某个渲染分支没跟上」，
 * 把判定收进一个可单测的纯函数是杜绝它的唯一办法。
 */
function refreshButtons() {
  const s = topButtonsState({
    hasReport: !!currentReport,
    checkupBusy,
    fixRunning,
    items: plan.items,
    selected,
    handled,
  });

  const run = $('#optRunCheckup');
  const cancelCk = $('#optCancelCheckup');
  const fix = $('#optFix');
  const cancelFixBtn = $('#optFixCancel');
  const note = $('#optDoneNote');

  // 体检按钮：没报告时是「开始体检」，有报告时是「重新体检」；体检中整个让位给「中止体检」
  if (run) {
    run.hidden = s.mode === 'checking' || s.mode === 'fixing';
    run.disabled = s.mode === 'fixing';
    run.textContent = currentReport ? '重新体检' : '开始体检';
  }
  if (cancelCk) {
    cancelCk.hidden = s.mode !== 'checking';
    cancelCk.disabled = false;
    cancelCk.textContent = checkupBusy === 'posting' ? CHECKUP_LABEL.posting : '中止体检';
  }
  if (fix) {
    // 只有 ready 态才显示：done-all（全处理完）与 idle（没报告）都不该有这个按钮
    fix.hidden = s.mode !== 'ready';
    fix.disabled = s.fixDisabled;
    fix.textContent = s.fixCount ? `一键修复（${s.fixCount} 项）` : '一键修复';
  }
  if (cancelFixBtn) {
    cancelFixBtn.hidden = s.mode !== 'fixing';
    cancelFixBtn.disabled = false;
    cancelFixBtn.textContent = '停止修复';
  }
  if (note) {
    note.hidden = s.mode !== 'done-all';
    // 必须说清「分数没重算」：不说的话用户会以为当前分数已经反映了修复结果
    note.textContent = '本轮可修项已全部处理。分数与问题数仍是修复前的值，重新体检才会更新。';
  }
}
```

- [ ] **Step 3: 加载计划**

在 `loadReport` 的成功分支里，`render()` 之前插入计划拉取：

```js
    await loadPlan(dir);
```

并新增：

```js
/**
 * 拉取修复计划。
 *
 * 换项目或重新体检后必须重拉：计划项的 id 是「报告里的下标」，
 * 报告一变下标就会错位（后端还有一道 reportAt 校验兜底，但前端不该主动送错数据）。
 */
async function loadPlan(dir) {
  if (!dir) { plan = { at: '', items: [] }; selected = new Set(); handled = new Set(); return; }
  try {
    const r = await fetch(`/api/optimize/fix-plan?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    plan = { at: String(data.at || ''), items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    plan = { at: '', items: [] };
  }
  selected = defaultSelection(plan.items); // 默认只勾低风险
  handled = new Set();
}
```

- [ ] **Step 4: 中止体检**

新增：

```js
/** 中止体检。已完成的维度保留，未跑完的由后端标 cancelled */
async function cancelCheckup() {
  if (!checkupJobId) return;
  const btn = $('#optCancelCheckup');
  if (btn) { btn.disabled = true; btn.textContent = '中止中…'; }
  const { ok } = await postJson('/api/optimize/checkup/cancel', { checkupId: checkupJobId });
  // 404 = 已经自己跑完了，不是错误，照常收尾
  if (!ok && btn) { btn.disabled = false; btn.textContent = '中止体检'; }
}
```

`openCheckupStream` 里记下 job id（`checkupBusy = 'analyzing'` 那行之后）：

```js
  checkupJobId = checkupId;
```

`closeCheckupStream` 里清掉：

```js
  checkupJobId = null;
```

体检结束后重拉计划——`applyCheckupDone` 末尾追加：

```js
  // 新报告 = 新下标，计划必须重拉
  loadPlan(currentDir).then(() => render());
```

- [ ] **Step 5: 绑定事件**

`initOptimizePanel` 的绑定段改为：

```js
    $('#optRunCheckup')?.addEventListener('click', runCheckup);
    $('#optCancelCheckup')?.addEventListener('click', cancelCheckup);
    $('#optFix')?.addEventListener('click', runFix);
    $('#optFixCancel')?.addEventListener('click', cancelFix);
```

- [ ] **Step 6: 验证语法**

```bash
node --check public/js/optimize-view.js && echo "SYNTAX OK"
```

预期：`SYNTAX OK`。

---

## Task 15：勾选树渲染

**Files:**
- Modify: `public/js/optimize-view.js`

- [ ] **Step 1: 实现渲染**

新增（并在 `render()` 里调用 `renderPlan()`）：

```js
/** 造一个项目风格的复选框。三态由 checked / indeterminate 两个属性表达 */
function planCheckbox(state, onToggle) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'pretty-check'; // 项目既有的样式化复选框，不要用裸 checkbox
  cb.checked = state === 'all';
  cb.indeterminate = state === 'some';
  cb.disabled = fixRunning || !!checkupBusy;
  cb.addEventListener('click', (e) => {
    e.stopPropagation(); // 勾选不触发所在行的折叠
    onToggle();
  });
  return cb;
}

/** 一个标签（动作 · 风险）。文案来自后端，颜色由风险档决定 */
function planTag(item) {
  const tag = el('span', `opt-tag risk-${item.risk}`, `${item.action}·${RISK_LABEL[item.risk] || item.risk}`);
  return tag;
}

function renderPlan() {
  const host = $('#optPlan');
  if (!host) return;
  host.textContent = '';

  if (!currentReport) return;
  if (!plan.items.length) {
    host.appendChild(el('div', 'opt-plan-empty', '本次体检没有发现可自动处理的问题。'));
    return;
  }

  for (const group of groupPlan(plan.items)) {
    const catIds = group.dims.flatMap((d) => d.items.map((i) => i.id));
    const section = el('div', 'opt-group');

    // 域级节点
    const head = el('div', 'opt-group-head opt-plan-node');
    head.appendChild(planCheckbox(nodeCheckState(catIds, selected), () => {
      selected = toggleNode(catIds, selected);
      render();
    }));
    head.appendChild(el('span', 'opt-plan-title', categoryLabel(group.category)));
    head.appendChild(el('span', 'opt-plan-count', `${catIds.filter((id) => selected.has(id)).length}/${catIds.length} 已勾`));
    head.addEventListener('click', () => section.classList.toggle('is-folded'));
    section.appendChild(head);

    const body = el('div', 'opt-group-body');

    for (const d of group.dims) {
      const dimIds = d.items.map((i) => i.id);
      const dimBox = el('div', 'opt-plan-dim');

      const dimHead = el('div', 'opt-plan-node');
      dimHead.appendChild(planCheckbox(nodeCheckState(dimIds, selected), () => {
        selected = toggleNode(dimIds, selected);
        render();
      }));
      dimHead.appendChild(el('span', 'opt-plan-title', d.dimLabel));
      dimHead.appendChild(el('span', 'opt-plan-count', `${dimIds.filter((id) => selected.has(id)).length}/${dimIds.length}`));

      const itemsBox = el('div', 'opt-plan-items');
      dimHead.addEventListener('click', () => itemsBox.classList.toggle('is-folded'));
      dimBox.appendChild(dimHead);

      for (const item of d.items) {
        const row = el('div', 'opt-plan-item');
        const isHandled = handled.has(item.id);
        if (isHandled) row.classList.add('is-handled');

        const cb = planCheckbox(selected.has(item.id) ? 'all' : 'none', () => {
          selected = toggleNode([item.id], selected);
          render();
        });
        // 已处理的项不可再勾：防止用户在同一轮里重复修同一条
        if (isHandled) cb.disabled = true;
        row.appendChild(cb);

        row.appendChild(el('span', 'opt-plan-loc', item.line ? `${item.file}:${item.line}` : item.file));
        row.appendChild(el('span', 'opt-plan-msg', item.message));
        row.appendChild(planTag(item));
        if (isHandled) row.appendChild(el('span', 'opt-plan-handled', '本轮已处理'));

        itemsBox.appendChild(row);
      }

      dimBox.appendChild(itemsBox);
      body.appendChild(dimBox);
    }

    section.appendChild(body);
    host.appendChild(section);
  }
}

/** 域 key → 中文标签。复用维度表里已有的分组定义，不另起一份 */
function categoryLabel(key) {
  return CATEGORY_META.find((c) => c.key === key)?.label || key;
}
```

`optimize-view.js` 的 import 补 `CATEGORY_META`：

```js
import {
  dimListFrom, groupDims, groupSummary, checkupAge, STALE_CHECKUP_DAYS, shouldNormalizeStale, CATEGORY_META,
} from './optimize-view.logic.js';
```

`render()` 改为：

```js
function render() {
  renderScore(currentReport);
  renderDims(currentReport);
  renderPlan();
  refreshButtons();
}
```

- [ ] **Step 2: 移除维度卡片上的旧勾选框**

`renderDimCards` 里删除 checkbox 相关代码（勾选已由计划树承担，维度卡片回归"只读展示结论"）：删掉 `const cb = ...` 到 `head.appendChild(cb);` 整段，以及 `head.addEventListener('click', (e) => { if (e.target === cb) return; ... })` 里的 `cb` 判断（改为直接 toggle）。

同时删除 `deselectedDims` 与 `selectedKeys()`——它们的职责已被 `selected` 取代。

- [ ] **Step 3: 验证语法**

```bash
node --check public/js/optimize-view.js && echo "SYNTAX OK"
```

预期：`SYNTAX OK`。

---

## Task 16：修复执行与报告弹窗

**Files:**
- Create: `public/js/optimize-report.js`
- Modify: `public/js/optimize-view.js`

- [ ] **Step 1: 实现报告弹窗**

新建 `public/js/optimize-report.js`：

```js
/**
 * 修复报告弹窗。
 *
 * 为什么不扩展 ui.js 的 confirmDialog：那是「纯文本 message + 两个按钮」的原语，
 * 它的 message 走 textContent，天然渲染不了分组列表。塞富结构进去会把它变成胖接口。
 * 这里只复用它的 .mask / .modal **CSS**，JS 独立。
 *
 * 安全：全部内容来自后端与模型（文件路径、原因、模块职责），一律 createElement + textContent。
 */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

const STATUS_LABEL = { done: '已处理', skipped: '已跳过', failed: '失败' };

/** 一个小节；rows 为空时整节不渲染，避免报告里堆满空标题 */
function section(title, rows) {
  if (!rows.length) return null;
  const sec = el('div', 'opt-report-sec');
  sec.appendChild(el('h4', null, title));
  for (const r of rows) sec.appendChild(r);
  return sec;
}

/**
 * 弹出修复报告。
 *
 * @param {object} done 后端 done 事件的负载
 * @param {object} handlers
 * @param {Function} handlers.onRollback 还原本次优化
 * @param {Function} handlers.onRecheck  重新体检
 */
export function openFixReport(done, { onRollback, onRecheck } = {}) {
  const mask = el('div', 'mask');
  const modal = el('div', 'modal opt-report-modal');

  const head = el('div', 'head');
  head.appendChild(el('h3', null, '修复报告'));
  const closeBtn = el('button', 'close', '✕');
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = el('div', 'body');

  if (done.error) {
    body.appendChild(el('div', 'opt-res-error', `优化过程报错：${done.error}`));
  }

  // ① 改了什么 —— 按动作分组，让「重构了源码」和「只写了清单」一眼可分
  const results = done.results || [];
  const byKind = new Map();
  for (const r of results) {
    const k = r.kind || r.strategy || '其它';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(r);
  }
  const changeRows = [];
  for (const [kind, list] of byKind) {
    changeRows.push(el('div', 'opt-report-dir', `${kind}（${list.length}）`));
    for (const r of list) {
      const row = el('div', 'opt-report-row');
      row.appendChild(el('span', `opt-res-badge sev-${r.status}`, STATUS_LABEL[r.status] || r.status));
      row.appendChild(el('span', 'opt-plan-loc', r.file || ''));
      if (r.reason) row.appendChild(el('span', 'opt-plan-msg', r.reason));
      changeRows.push(row);
    }
  }
  const sChange = section(`改动了 ${results.length} 处`, changeRows);
  if (sChange) body.appendChild(sChange);

  // ② 需要复测 —— 规则化产出，地图缺失的目录只列文件不编职责
  const retestRows = [];
  for (const m of done.retest || []) {
    const row = el('div', 'opt-report-row');
    const box = el('div');
    box.appendChild(el('div', 'opt-report-dir', m.dir));
    if (m.responsibility) box.appendChild(el('div', 'opt-report-resp', m.responsibility));
    box.appendChild(el('div', 'opt-report-resp', m.files.join('、')));
    row.appendChild(box);
    retestRows.push(row);
  }
  const sRetest = section('需要复测', retestRows);
  if (sRetest) body.appendChild(sRetest);

  // ③ 未处理的 —— 「不说就会被误以为已处理好」的那些，必须进报告
  const noteRows = [];
  for (const b of done.blocked || []) {
    noteRows.push(el('div', 'opt-report-row', `${b.file}：${b.reason}`));
  }
  for (const n of done.notes || []) {
    noteRows.push(el('div', 'opt-report-row', n));
  }
  const sNotes = section('未自动处理 / 需要你知道', noteRows);
  if (sNotes) body.appendChild(sNotes);

  modal.appendChild(body);

  const foot = el('div', 'opt-report-foot');
  if (done.backupDir) {
    const rb = el('button', 'btn danger', '还原本次优化');
    rb.addEventListener('click', () => { close(); onRollback?.(done.backupDir); });
    foot.appendChild(rb);
  }
  const rc = el('button', 'btn', '重新体检');
  rc.addEventListener('click', () => { close(); onRecheck?.(); });
  foot.appendChild(rc);
  const ok = el('button', 'btn primary', '关闭');
  foot.appendChild(ok);
  modal.appendChild(foot);

  mask.appendChild(modal);
  document.body.appendChild(mask);

  function close() {
    mask.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  closeBtn.addEventListener('click', close);
  ok.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey);
}
```

- [ ] **Step 2: 改 `runFix` 走勾选 + 二次确认**

`optimize-view.js` 的 `runFix` 替换为：

```js
/**
 * 跑一次修复：用户勾了什么就修什么。
 *
 * 风险不再是按钮档位（那套语义与逐条勾选打架：用户勾了高风险项却被静默跳过）。
 * 勾选里含中/高风险时弹二次确认，并**列出具体会改写的文件**——
 * 只写一句「有风险」等于没确认。
 */
async function runFix({ force = false } = {}) {
  const dir = currentDir;
  if (!dir) { toast.error('请先在顶栏选择项目目录'); return; }

  const picked = plan.items.filter((i) => selected.has(i.id) && !handled.has(i.id));
  if (!picked.length) { toast.error('请先勾选要修复的项'); return; }

  const risky = picked.filter((i) => i.risk === 'medium' || i.risk === 'high');
  if (risky.length && !force) {
    const lines = risky.slice(0, 12).map((i) => `· ${i.file} —— ${i.action}（${RISK_LABEL[i.risk]}）`);
    const more = risky.length > 12 ? `\n…另有 ${risky.length - 12} 项` : '';
    const go = await confirmDialog({
      title: '确认修复',
      message: `本次勾选含 ${risky.length} 项中高风险，会改动这些既有文件：\n\n${lines.join('\n')}${more}\n\n`
        + '兜底：开工前打全量快照；源码改动逐个文件跑测试，测试变红立即回滚该文件；'
        + '项目没有可跑的测试时，源码维度自动降级为只出清单。\n\n'
        + '出问题可以用「还原本次优化」撤销全部改动。',
      confirmText: '我了解，开始修复',
      danger: true,
    });
    if (!go) return;
  }

  fixRunning = true;
  render();
  $('#optProgress').textContent = '';
  $('#optProgress').hidden = true;

  try {
    const { ok, data } = await postJson('/api/optimize/fix', {
      dir,
      items: picked.map((i) => i.id),
      reportAt: plan.at,
      risk: 'all',
      force,
    });

    if (!ok) {
      fixRunning = false;
      render();
      // 计划过期：报告变了，下标会错位。重拉计划让用户在新计划上重勾
      if (data.stalePlan) {
        toast.error('体检报告已更新，已为你重新加载修复计划');
        await loadPlan(dir);
        render();
        return;
      }
      if (data.busy?.jobId) {
        toast.error('该项目已有一次优化在跑，已切换到它的进度');
        fixRunning = true;
        render();
        openFixStream(data.busy.jobId);
        return;
      }
      toast.error(data.error || '修复失败');
      return;
    }

    if (data.needsConfirm) {
      fixRunning = false;
      render();
      const go = await confirmDialog({
        title: '工作区有未提交的改动',
        message: dirtyConfirmMessage(data),
        confirmText: '仍然修复',
        danger: true,
      });
      if (go) await runFix({ force: true });
      return;
    }

    if (data.nothing) {
      fixRunning = false;
      render();
      toast.info('勾选的项目前没有可自动处理的内容');
      return;
    }

    openFixStream(data.jobId);
  } catch (e) {
    fixRunning = false;
    render();
    toast.error('修复请求失败：' + (e?.message || e));
  }
}
```

- [ ] **Step 3: 修复完成后弹报告、标记已处理**

`openFixStream` 的 `finish` 改为：

```js
  const finish = (done) => {
    fixRunning = false;
    // 后端在优化结束时重算过静态维度，直接用它的报告
    if (done?.report) currentReport = done.report;

    // 本轮处理过的项打标：防止用户在同一轮里重复修同一条。
    // **不重算分数与问题数** —— 那必须重新体检才更新（见 spec 拍板 #4）
    for (const id of done?.handledIds || []) handled.add(id);

    render();
    closeFixStream();
    openFixReport(done || {}, {
      onRollback: (backupDir) => rollbackFix(backupDir),
      onRecheck: () => runCheckup(),
    });
  };
```

- [ ] **Step 4: 后端回传 handledIds**

`optimize-ops.js` 的 `runFix` 收尾处，把本次提交的 items 原样带回（前端据此标记）：

```js
  // 把本次实际提交的计划项 id 带回前端做「本轮已处理」标记。
  // 原样返回而不是从 results 反推：results 的粒度是「文件」，
  // 一条 issue 可能没有对应的文件产出（如被策略跳过），反推会漏标
  handledIds: submittedItemIds,
```

其中 `submittedItemIds` 由 `startFix` 传进 `runFix` 的参数携带（`items || []`）。

- [ ] **Step 5: 验证语法**

```bash
node --check public/js/optimize-report.js && node --check public/js/optimize-view.js && echo "SYNTAX OK"
```

预期：`SYNTAX OK`。

---

## Task 17：全量验证

- [ ] **Step 1: 前端模块图完整性**

前端 import 图有语法错误会导致「卡启动页 + 窗口按钮消失」，一条命令先拦掉：

```bash
cd public && for f in app.js js/*.js; do node --check "$f" || echo "FAIL $f"; done; echo "ALL CHECKED"
```

预期：无 `FAIL` 行。

- [ ] **Step 2: 全量单测**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

预期：`fail 0`，测试总数 ≈ 2767 + 约 30 条新增。

- [ ] **Step 3: 人工验收清单**

启动 `npm start`，打开项目优化面板逐条确认：

1. 未体检时顶部只有「开始体检」；点击后变「中止体检」，底部无任何按钮。
2. 体检中切到对话再切回来——仍显示「体检中」与转圈，**不出现**「上次分析未完成」。
3. 点「中止体检」——已完成维度保留分数，未完成的显示「已取消，重新体检可续」（中性色，不是红色）。
4. 体检完成后顶部是「重新体检」+「一键修复(N)」，N = 默认勾选的低风险项数。
5. 勾选树三层可勾：点域 → 该域全选；取消一条 → 域变半选（横杠，与勾同一套视觉）。
6. 每项都有「动作·风险」标签，低绿 / 中黄 / 高红。
7. 勾上一条高风险项点修复 → 二次确认列出**具体文件**。
8. 修复完成 → 弹报告，含「改了什么 / 需要复测 / 未自动处理」三块。
9. 关闭报告 → 已处理项灰显标「本轮已处理」且不可勾；两个按钮仍在，可继续修剩下的。
10. 全部处理完 → 「一键修复」消失，提示「分数仍是修复前的值，重新体检才会更新」。
11. 复选框外观与设置页的「开机自启动」一致（18px 圆角方块、accent 填充、白勾）。

---

## 自审记录

**Spec 覆盖检查**：spec 十四节逐节对照——①②③④ → Task 2/3；⑤模块落点 → 全任务；⑥按钮状态机 → Task 10/14；⑦中止体检 → Task 8/11；⑧复测清单 → Task 5/9；⑨报告弹窗 → Task 16；⑩样式契约 → Task 12；⑪测试策略 → 各任务 Step 1；⑫YAGNI → 未实现筛选器/持久化，符合；⑬风险 → stalePlan 409（Task 7）、两级折叠（Task 15）、地图缺失降级（Task 5）、二次确认列具体文件（Task 16）均已落实。

**类型一致性**：`buildFixPlan` 产出的字段（`id/dim/dimLabel/category/file/line/message/severity/strategy/action/risk`）在 Task 10 的测试夹具、Task 15 的渲染、Task 16 的确认弹窗中引用一致；`resolveSelection` 的 `{byDim, indicesByDim, rejected}` 在 Task 7 被完整消费；`topButtonsState` 的五个 mode 在 Task 14 全部有分支。

**已知待实现细节**：Task 8 Step 2 提到 `collectEvidence` / `LEGACY_RUNNERS` 各检测器 / `checkHolistic` 若尚未接受 `signal` 需补参数——执行该任务时先 grep 确认各函数签名，缺则补。这是接线工作，不改内部逻辑。
