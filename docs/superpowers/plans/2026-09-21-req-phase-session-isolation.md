# 需求阶段切换：会话按阶段隔离 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本项目约定：不自动 git 提交。** 每个 Task 末尾是「验证」步骤而非 commit，改动全部留在工作区，提交时机由维护者掌控（见仓库根 `CLAUDE.md`「协作约定」）。

**Goal:** 点「完成开发」时校验该需求当前阶段全部会话已跑完，流转到测试期后隐藏开发期会话并自动开一根干净的测试期主会话。

**Architecture:** 给 `sessions[]` 每条加 `phase` 字段标记诞生阶段（读侧 `normalizeSessions` 给存量数据补 `'dev'`）；流转守卫从「只查主会话」改为「遍历当前阶段全部会话」；`dev-done` 物化 sessions 后清空 `convId`/`devSession`，前端见空锚点走既有「新建 conv 并回填」路径产出测试期主会话；侧栏按 `phase` 过滤渲染。`main` 唯一性从全局收窄为阶段内。

**Tech Stack:** Node LTS（≥20）原生 ESM，`node --test` 单测，前端为无框架原生 ESM + jsdom 测试。

**Spec:** `docs/superpowers/specs/2026-09-21-req-phase-session-isolation-design.md`

---

## 文件结构

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `src/store/requirements.js` | 需求数据模型与状态机 | `sessions[]` 加 `phase`；`normalizeSessions` 补齐 |
| `src/entrypoints/web/req-logic.js` | 需求纯逻辑（零 IO） | 新增 `runningSessions`；`buildBugFixPrompt` 加 `seed` |
| `src/entrypoints/web/routes-requirements.js` | 需求 HTTP 路由 | `phaseGuard` / `handleDevDone` / `handleConv` / `handleSession` / `handleSessionDelete` |
| `src/entrypoints/web/requirement-ops.js` | 需求编排 | `dispatchSystemTask` 无 `devSession` 时传 `seed` |
| `public/js/req-view.js` | 需求侧栏与面板 | 侧栏按 `phase` 过滤；`openRequirementChat` 传 `kind`/seed；UI 规范还原文案 |
| `public/js/req-chat.js` | 开发/测试期聊天装饰层 | `phaseAction` 新增 `'newconv'` 分支 + 409 `running` 列表弹窗 |
| `public/js/ui.js` | 通用 UI 原语 | `confirmDialog` 加 `hideCancel` 选项（纯告知型弹窗不该出现两个同义按钮） |

测试文件（均为既有文件，追加用例）：`src/store/requirements.test.js`、`src/entrypoints/web/req-logic.test.js`、`src/entrypoints/web/routes-requirements.test.js`、`public/js/req-view.sessiontree.test.js`。

---

## Task 1: `normalizeSessions` 给存量会话补 `phase`

**Files:**
- Modify: `src/store/requirements.js:23-24`（注释）、`:45`（字段注释）、`:80-101`（`normalizeSessions`）
- Test: `src/store/requirements.test.js:57-92`（改既有用例 + 加新用例）

- [ ] **Step 1: 改既有用例，让它先失败**

`src/store/requirements.test.js` 把第 57-63 行这个用例整体替换为：

```js
test('normalizeSessions：sessions 非空直接返回，缺 phase 的补需求当前阶段', () => {
  const sessions = [
    { convId: 'conv_123', sessionId: 'sess_456', title: 'Test', kind: 'main', createdAt: '2026-08-11T00:00:00Z' },
  ];
  assert.deepEqual(normalizeSessions({ sessions, phase: 'dev' }), [{ ...sessions[0], phase: 'dev' }]);
});

test('normalizeSessions：已在测试期的存量需求，会话补 test 而非 dev（否则会话树整棵消失）', () => {
  const sessions = [
    { convId: 'c_legacy', sessionId: 's1', title: '老会话', kind: 'main', createdAt: '' },
  ];
  assert.equal(normalizeSessions({ sessions, phase: 'test' })[0].phase, 'test');
});

test('normalizeSessions：已有 phase 的会话不被覆盖', () => {
  const sessions = [
    { convId: 'c_t', sessionId: null, title: '测试期主会话', kind: 'main', phase: 'test', createdAt: '' },
    { convId: 'c_d', sessionId: 's1', title: '开发期子会话', kind: 'sub', phase: 'dev', createdAt: '' },
  ];
  assert.deepEqual(normalizeSessions({ sessions, phase: 'test' }), sessions);
});

test('normalizeSessions：混合数组——有 phase 的保留，缺的补当前阶段（迁移期最易出错的形状）', () => {
  const sessions = [
    { convId: 'c_d', sessionId: 's1', title: '开发期会话', kind: 'main', phase: 'dev', createdAt: '' },
    { convId: 'c_x', sessionId: null, title: '未标记会话', kind: 'sub', createdAt: '' },
  ];
  const result = normalizeSessions({ sessions, phase: 'test' });
  assert.equal(result[0].phase, 'dev');
  assert.equal(result[1].phase, 'test');
});

test('normalizeSessions：纯函数——不改动入参数组及其元素', () => {
  const sessions = [{ convId: 'c1', sessionId: null, title: 'x', kind: 'sub', createdAt: '' }];
  normalizeSessions({ sessions, phase: 'dev' });
  assert.equal(sessions[0].phase, undefined);
  assert.equal(sessions.length, 1);
});
```

再把第 65-80 行那个「合成主会话」用例末尾（第 79 行 `createdAt` 断言之后）补一行（该用例的 `req` 没有 `phase` 字段，走 `|| 'dev'` 兜底）：

```js
  assert.equal(result[0].phase, 'dev');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/requirements.test.js`
Expected: FAIL —— 三处断言都因返回值缺 `phase` 而不等。

- [ ] **Step 3: 实现**

`src/store/requirements.js` 第 45 行字段注释改为：

```js
    sessions: [], // [{convId, sessionId, title, kind, phase, createdAt}]
    // kind: 'main'|'sub'|'retro'；phase: 'dev'|'test'|'archiving'（会话诞生时的阶段，见 normalizeSessions）
```

第 23-24 行的迁移说明追加一句：

```js
// sessions[] 渐进迁移：新建需求 sessions 为空数组；旧需求读侧用 normalizeSessions 合成。
// 任何一次真实写入（sessionId 回填 / 新建子会话）都会顺带把合成结果落盘，完成迁移。
// phase 字段同批迁移：存量会话补「需求当前阶段」——缺 phase 说明这个需求从没经历过阶段拆分
// （老流程 dev-done 只改 phase、convId 原样延续），那根会话一路服务到了现在这个阶段。
```

`normalizeSessions` 整体替换为：

```js
/**
 * 纯函数：合成老数据的主会话记录，并补齐缺失的 phase
 * @param {object} req - 需求对象
 * @returns {object[]} 合成或原有的 sessions 数组（每条保证有 phase）
 *
 * 三个路径：
 * 1. sessions 已非空 → 逐条补 phase 后返回（优先级最高，说明已迁移或手工设置）
 * 2. sessions 空但 convId 非空 → 合成一条主会话（同样补 phase）
 * 3. sessions 空且 convId 空 → 返回空数组（全新需求或完全未初始化）
 *
 * 缺 phase 补的是 req.phase（需求当前阶段）而非字面量 'dev'：一条会话没有 phase，
 * 只可能是它诞生于阶段隔离功能上线之前，也就意味着这个需求从没经历过阶段拆分——
 * 老流程的 dev-done 只改 phase、convId 原样延续，那根会话一路服务到了现在这个阶段。
 * 若按 'dev' 补，一个已在测试期的存量需求会被侧栏过滤判成「没有当前阶段的会话」，
 * 会话树整棵消失（且 convId 非空，走不到「清锚点自动建新主会话」的补救路径），
 * 阶段流转守卫也会遍历到空集、真空通过。
 *
 * 走新流程的需求不受影响：dev-done 的物化发生在 phase 改写之前（读的是旧 req），
 * 开发期会话照样被钉成 'dev' 落盘，此后再不触发回填。
 */
export function normalizeSessions(req) {
  const fallbackPhase = req.phase || 'dev'; // 极老数据可能连 phase 都没有，退到开发期
  // 路径 1：sessions 已非空，逐条补 phase
  if (req.sessions && req.sessions.length > 0) {
    return req.sessions.map((s) => (s.phase ? s : { ...s, phase: fallbackPhase }));
  }

  // 路径 2：sessions 空但 convId 非空 → 合成主会话
  if (req.convId) {
    return [
      {
        convId: req.convId,
        sessionId: req.devSession,
        title: req.title,
        kind: 'main',
        phase: fallbackPhase,
        createdAt: req.createdAt,
      },
    ];
  }

  // 路径 3：sessions 空且 convId 空 → 返回空数组
  return [];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/requirements.test.js`
Expected: PASS，全部用例绿。

- [ ] **Step 5: 验证无连带破坏**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS。若有用例因响应里多出 `phase` 字段而 `deepEqual` 失败，把该断言改成对具体字段的 `assert.equal`，不要回退 Task 1 的实现。

---

## Task 2: `runningSessions` 纯函数

**Files:**
- Modify: `src/entrypoints/web/req-logic.js`（在 `buildBugFixPrompt` 之后、`verdictToBug` 之前插入）
- Test: `src/entrypoints/web/req-logic.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

`src/entrypoints/web/req-logic.test.js` 顶部 import 清单（第 4-7 行那组）追加 `runningSessions`，然后在文件末尾追加：

```js
// ---- runningSessions（阶段流转守卫）----

const SESSIONS = [
  { convId: 'c_dev_main', title: '主会话', kind: 'main', phase: 'dev' },
  { convId: 'c_dev_sub', title: '登录页修复', kind: 'sub', phase: 'dev' },
  { convId: 'c_test_main', title: '测试期主会话', kind: 'main', phase: 'test' },
];

test('runningSessions：无会话在跑 → 空数组', () => {
  assert.deepEqual(runningSessions(SESSIONS, 'dev', () => false), []);
});

test('runningSessions：只回当前阶段在跑的会话，别的阶段不计入', () => {
  const hasActive = (convId) => convId === 'c_dev_sub' || convId === 'c_test_main';
  assert.deepEqual(runningSessions(SESSIONS, 'dev', hasActive), [
    { convId: 'c_dev_sub', title: '登录页修复' },
  ]);
});

test('runningSessions：多条同阶段在跑时全部返回，顺序与 sessions 一致', () => {
  const result = runningSessions(SESSIONS, 'dev', () => true);
  assert.deepEqual(result, [
    { convId: 'c_dev_main', title: '主会话' },
    { convId: 'c_dev_sub', title: '登录页修复' },
  ]);
});

test('runningSessions：无 convId 的会话跳过，不调用 hasActive', () => {
  const calls = [];
  const sessions = [{ convId: '', title: '半截会话', kind: 'sub', phase: 'dev' }];
  const result = runningSessions(sessions, 'dev', (c) => {
    calls.push(c);
    return true;
  });
  assert.deepEqual(result, []);
  assert.deepEqual(calls, []);
});

test('runningSessions：缺 phase 的老会话一律纳入检查（守卫宁可多拦一次）', () => {
  const sessions = [{ convId: 'c_old', title: '老会话', kind: 'main' }];
  // 不论当前处于哪个阶段都要拦住：缺 phase = 该需求没经历过阶段拆分，这根会话就是当前在用的那根
  assert.deepEqual(runningSessions(sessions, 'dev', () => true), [
    { convId: 'c_old', title: '老会话' },
  ]);
  assert.deepEqual(runningSessions(sessions, 'test', () => true), [
    { convId: 'c_old', title: '老会话' },
  ]);
});

test('runningSessions：无标题的会话用 convId 兜底（弹窗不能显示空行）', () => {
  const sessions = [{ convId: 'c_x', title: '', kind: 'sub', phase: 'dev' }];
  assert.deepEqual(runningSessions(sessions, 'dev', () => true), [
    { convId: 'c_x', title: 'c_x' },
  ]);
});

test('runningSessions：sessions 非数组不炸（与本文件 pickPendingNotices 同款约定）', () => {
  assert.deepEqual(runningSessions(null, 'dev', () => true), []);
  assert.deepEqual(runningSessions(undefined, 'dev', () => true), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/req-logic.test.js`
Expected: FAIL，报 `runningSessions is not a function`（或 import 解析出 undefined）。

- [ ] **Step 3: 实现**

`src/entrypoints/web/req-logic.js`，在 `buildBugFixPrompt` 函数之后插入：

```js
/**
 * 当前阶段内仍有活跃 run 的会话（阶段流转守卫用）。
 *
 * 只看当前阶段：历史阶段的会话即便还挂着 run（理论上不该有，但多标签页/孤儿恢复能造出来），
 * 也不该拦住本阶段的流转——那是上个阶段遗留的事，不归这一次流转管。
 *
 * `!s.phase` 是冗余防御：normalizeSessions 已保证每条都带 phase，这里只兜住绕过它的调用方。
 * 真正的存量迁移在 normalizeSessions（store 层），不在这儿。取「视为当前阶段」而非跳过，
 * 是守卫该有的失败方向——宁可多拦一次，也不能放一个还在改代码的 run 溜进下个阶段。
 *
 * @param {object[]} sessions - normalizeSessions 的产物
 * @param {string} currentPhase - 需求**当前**阶段。绝不能传流转目标阶段：那会让守卫检查一批
 *   还不存在的会话、对正在跑的那批视而不见，真空通过。（调用点 phaseGuard 的作用域里
 *   正好有个 toPhase，名字还更顺手，这个形参名就是拿来挡它的。）
 * @param {(convId: string) => boolean} hasActive - 注入 store/runs 的 hasActiveRunForConv。
 *   本层零 IO 不能 import store，只能注入；顺带让函数可直测。
 * @returns {{convId: string, title: string}[]} 供 409 响应列给用户看
 */
export function runningSessions(sessions, currentPhase, hasActive) {
  // hasActive 排在最后：它是对全部 run 的线性扫描，让 convId / phase 两个廉价判据先滤掉大部分
  return (sessions || [])
    .filter((s) => s.convId && (!s.phase || s.phase === currentPhase) && hasActive(s.convId))
    .map((s) => ({ convId: s.convId, title: s.title || s.convId }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/req-logic.test.js`
Expected: PASS。

---

## Task 3: `buildBugFixPrompt` 接受 `seed`

**Files:**
- Modify: `src/entrypoints/web/req-logic.js:179-185`
- Test: `src/entrypoints/web/req-logic.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

`src/entrypoints/web/req-logic.test.js` 顶部 import 清单确认已含 `buildBugFixPrompt`（第 5 行已有），末尾追加：

```js
// ---- buildBugFixPrompt 的需求背景注入 ----

const BUG = { title: '扫码页白屏', detail: '点击扫码按钮后页面空白，控制台报 undefined' };

// golden string：这条 prompt 在仓库里此前没有任何全等覆盖，正则断言挡不住措辞被悄悄改写
test('buildBugFixPrompt：无 seed 时输出与原行为逐字节相同', () => {
  assert.equal(
    buildBugFixPrompt({ bug: BUG }),
    '修复以下 BUG：「扫码页白屏」\n详情：\n点击扫码按钮后页面空白，控制台报 undefined\n\n修复后自查；只读参考工程禁止修改。',
  );
});

test('buildBugFixPrompt：有 seed 时前置需求背景段，BUG 正文仍在', () => {
  const p = buildBugFixPrompt({ bug: BUG, seed: '【需求】扫码支付改造 · 分支 req/abc' });
  assert.match(p, /^【需求背景】/);
  assert.match(p, /扫码支付改造/);
  assert.match(p, /修复以下 BUG：「扫码页白屏」/);
  // 背景必须排在 BUG 正文之前
  assert.ok(p.indexOf('【需求背景】') < p.indexOf('修复以下 BUG'));
});

test('buildBugFixPrompt：seed 为空串等同无 seed（不留空标题段）', () => {
  assert.doesNotMatch(buildBugFixPrompt({ bug: BUG, seed: '' }), /【需求背景】/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/req-logic.test.js`
Expected: FAIL —— 第二个用例报「【需求背景】」不匹配。

- [ ] **Step 3: 实现**

`src/entrypoints/web/req-logic.js` 第 179-185 行整体替换为：

```js
/**
 * BUG 修复 prompt：标题 + 详情 + 只读工程约束。
 *
 * seed（buildSeedPrompt 产物）仅在**无 Claude session 可续**时由调用方传入：测试期换了新主会话，
 * devSession 是空的，不带背景的话 AI 会在零上下文的新 session 里改代码。有 session 可续时不要传，
 * 那段背景在会话历史里已经有了，重复塞纯属烧 token。
 *
 * @param {{bug: {title: string, detail: string}, seed?: string}} params
 */
export function buildBugFixPrompt({ bug, seed = '' }) {
  const head = seed ? `【需求背景】\n${seed}\n\n` : '';
  return (
    head +
    `修复以下 BUG：「${bug.title}」\n详情：\n${bug.detail}\n\n` +
    `修复后自查；只读参考工程禁止修改。`
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/req-logic.test.js`
Expected: PASS。

---

## Task 4: `dispatchSystemTask` 无 `devSession` 时注入 seed

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js:360-385`

> 本 Task 无单测：`dispatchSystemTask` 未导出且直连 `startClaudeRun`（真起 SDK），无法直测。行为正确性由 Task 3 的纯函数测试 + 本 Task Step 3 的验证兜底。这是既有约定（见 `src/entrypoints/CLAUDE.md`「编排本体全是 SDK/落盘，无法直测，判定抽 `*.logic.js`」）。

- [ ] **Step 1: 确认 import 已就位**

`src/entrypoints/web/requirement-ops.js` 顶部从 `./req-logic.js` 的 import 清单里确认含 `buildSeedPrompt` 与 `buildBugFixPrompt`。若缺 `buildSeedPrompt` 则补上。同时确认已 import `getTopFiles`（来自 `../../store/feature-index.js`）；若无则补：

```js
import { getTopFiles } from '../../store/feature-index.js';
```

- [ ] **Step 2: 改 `dispatchSystemTask`**

把第 372 行 `const prompt = buildBugFixPrompt(payload);` 替换为：

```js
  // devSession 为空 = 测试期刚换过主会话，没有可续的 Claude session：把需求背景塞进 prompt，
  // 否则 BUG 会在零上下文的新 session 里修（见 spec §7）。有 session 可续时不传，省 token。
  //
  // ★ seed 必须在这里推导，绝不能塞进入队 payload。payload 在入队时就冻结了
  //（req-inspect.js 的 enqueueSystemTask(reqId, 'bug-fix', { bug })），而 devSession 会在
  // 入队与派发之间被写入（buildSystemTaskOnSettle 在前一个任务 settle 时回填），串行闸泵
  // 又会把这段间隔拉得很长。在入队侧判「有没有 session」，就会出现「排队时没有、派发时有了」
  // → 既 resume 了 session 又前置了一遍需求背景，正是这段注释要省的那份 token。
  // 放在这里，seed 与下面 startClaudeRun 的 session 由同一次 req 读取派生，不可能错开。
  const seed = req.devSession
    ? ''
    : buildSeedPrompt(req, { featureSnapshot: buildFeatureSnapshot(req) });
  const prompt = buildBugFixPrompt({ ...payload, seed });
```

并在 `dispatchSystemTask` 之前插入这个小helper（与 `routes-requirements.js:69-75` 的 `featureSnapshot` 构造同源，抽出来避免两处漂移）：

```js
/** 功能文件快照：有 featureTag 且在开发/测试期才有意义（与 routes-requirements 的 handleGet 同口径） */
function buildFeatureSnapshot(req) {
  if (!req.featureTag || (req.phase !== 'dev' && req.phase !== 'test')) return null;
  const files = getTopFiles(req.featureTag);
  return files ? { tag: req.featureTag, files } : null;
}
```

- [ ] **Step 3: 验证**

Run: `node --test src/entrypoints/web/requirement-ops.test.js`
Expected: PASS（既有用例不得回归）。

Run: `node --check src/entrypoints/web/requirement-ops.js`
Expected: 无输出（语法通过）。

---

## Task 4b: `buildFeatureSnapshot` 上提到纯逻辑层并消重（代码评审新增）

**来由**：Task 4 按计划把 `buildFeatureSnapshot` 写成 `requirement-ops.js` 的私有 helper，但计划自己声明的意图是「抽出来避免两处漂移」—— 实际产出是与 `routes-requirements.js` `handleGet` 逐字相同的**第二份**实现，没有任何测试或类型检查守住这份等价。同时它是本次改动里唯一「可测纯逻辑被埋进不可测编排」的地方。按仓库既有范式（`runningSessions(sessions, currentPhase, hasActive)`、`canDispatch(req, hasActive = hasActiveRunForConv)`）上提到 `req-logic.js` 并注入 store reader，一次解决消重 + 可测。

**Files:**
- Modify: `src/entrypoints/web/req-logic.js`（新增导出 `buildFeatureSnapshot`）
- Modify: `src/entrypoints/web/requirement-ops.js`（删私有 helper，改用导入；顺带瘦身注释）
- Modify: `src/entrypoints/web/routes-requirements.js`（`handleGet` 改用共享函数）
- Test: `src/entrypoints/web/req-logic.test.js`

- [ ] **Step 1: 写失败的测试**

`req-logic.test.js` 顶部 import 清单追加 `buildFeatureSnapshot`，文件末尾追加：

```js
// ---- buildFeatureSnapshot（功能文件快照，注入 store reader）----

const FILES = [{ path: 'src/a.js', count: 3 }];

test('buildFeatureSnapshot：开发/测试期且有 featureTag 且有文件 → 返回快照', () => {
  for (const phase of ['dev', 'test']) {
    assert.deepEqual(
      buildFeatureSnapshot({ featureTag: '扫码支付', phase }, () => FILES),
      { tag: '扫码支付', files: FILES },
    );
  }
});

test('buildFeatureSnapshot：无 featureTag → null，且不去读 store', () => {
  let called = false;
  const read = () => { called = true; return FILES; };
  assert.equal(buildFeatureSnapshot({ featureTag: null, phase: 'dev' }, read), null);
  assert.equal(buildFeatureSnapshot({ featureTag: '', phase: 'dev' }, read), null);
  assert.equal(called, false);
});

test('buildFeatureSnapshot：评审/归档等非开发测试期 → null', () => {
  for (const phase of ['review', 'archiving', 'archived', 'discarded', undefined]) {
    assert.equal(buildFeatureSnapshot({ featureTag: '扫码支付', phase }, () => FILES), null);
  }
});

test('buildFeatureSnapshot：账本里没有该标签（reader 回 null）→ null', () => {
  assert.equal(buildFeatureSnapshot({ featureTag: '扫码支付', phase: 'dev' }, () => null), null);
});

test('buildFeatureSnapshot：reader 回空数组也算无快照（不产出空的 files 节）', () => {
  // getTopFiles 现在恒返回 null 而非 []，但本函数不该依赖那个实现细节
  assert.equal(buildFeatureSnapshot({ featureTag: '扫码支付', phase: 'dev' }, () => []), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/req-logic.test.js`
Expected: FAIL，`buildFeatureSnapshot` 尚未导出（ESM 具名导入在模块加载阶段即报 SyntaxError）。

- [ ] **Step 3: 在 `req-logic.js` 实现**

在 `runningSessions` 之后插入：

```js
/**
 * 功能文件快照：基于历史 git diff 收割的「本功能模块常改哪些文件」，喂给 buildSeedPrompt 收窄探索范围。
 *
 * 两个判据性质不同，改动前先分清：
 * - `!req.featureTag` 是**内禀约束**——没标签就没有快照可言，对任何调用方都成立，不可动。
 * - dev/test 之外返回 null 是**展示策略**——「离开开发测试期的快照不值得再展示」是我们的取舍，
 *   不是数据约束。策略正是调用方有朝一日会合理分歧的东西。
 * 现在它留在函数内，因为两个调用方（handleGet 的 seed 预览、dispatchSystemTask 的 bug-fix prompt）
 * 口径一致；上移只会把刚消掉的重复换成两份阶段清单再长回来。真出现第三个调用方要求不同阶段策略时
 * （归档报告、需求只读回看是现实候选），再把策略交还调用点——但别现在预留开关参数，YAGNI。
 *
 * readTopFiles 是**必填位置参数、不给默认值**：本层零 IO（本文件至今零 import 语句），
 * 给默认值就得 import store/feature-index，当场破掉分层属性。这里不能照抄 requirement-ops.js
 * 里 `canDispatch(req, hasActive = hasActiveRunForConv)` 的默认值写法——那个函数住在允许
 * import store 的层。形态对齐本文件的 runningSessions。
 *
 * 空数组与 null 同等对待：调用方要的是「有没有快照」，一个空的 files 节只会误导模型。
 * 不写成 `files ? ...`，是不想依赖 getTopFiles「恒返回 null 而非 []」这个实现细节。
 *
 * @param {object} req - 需求对象（只读 featureTag / phase）
 * @param {(tag: string) => object[]|null} readTopFiles - 注入 store/feature-index 的 getTopFiles
 * @returns {{tag: string, files: object[]}|null}
 */
export function buildFeatureSnapshot(req, readTopFiles) {
  if (!req.featureTag || (req.phase !== 'dev' && req.phase !== 'test')) return null;
  const files = readTopFiles(req.featureTag);
  return files?.length ? { tag: req.featureTag, files } : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/req-logic.test.js`
Expected: PASS。

- [ ] **Step 5: `requirement-ops.js` 改用共享函数并瘦身注释**

删掉 Task 4 加的私有 `buildFeatureSnapshot`；`./req-logic.js` 的 import 清单追加 `buildFeatureSnapshot`（`getTopFiles` 的 import 保留，现在用于传参）。`dispatchSystemTask` 里那段替换为：

```js
  // devSession 为空 = 测试期刚换过主会话，没有可续的 Claude session：把需求背景塞进 prompt，
  // 否则 BUG 会在零上下文的新 session 里修（见 spec §7）。有 session 可续时不传，省 token。
  // ★ seed 必须与下面 startClaudeRun 的 session 派生自同一次 req 读取，不能塞进入队 payload——
  //   完整的竞态论证见 req-logic.js 里 buildBugFixPrompt 的 ★ 段，不在此重复。
  const seed = req.devSession
    ? ''
    : buildSeedPrompt(req, { featureSnapshot: buildFeatureSnapshot(req, getTopFiles) });
  const prompt = buildBugFixPrompt({ ...payload, seed });
```

- [ ] **Step 6: `routes-requirements.js` 的 `handleGet` 改用共享函数**

把第 69-75 行那段 IIFE 替换为：

```js
  const featureSnapshot = buildFeatureSnapshot(r, getTopFiles);
```

并确认该文件已从 `./req-logic.js` 导入 `buildFeatureSnapshot`（缺则补），`getTopFiles` 的既有导入保留。

- [ ] **Step 7: 验证**

Run: `node --test src/entrypoints/web/req-logic.test.js src/entrypoints/web/requirement-ops.test.js src/entrypoints/web/routes-requirements.test.js`
Expected: 全绿。`handleGet` 的 `seed` 字段行为必须与改动前一致——`routes-requirements.test.js` 里既有的 get 相关用例就是这道闸。

Run: `grep -rn "getTopFiles" src/entrypoints/` —— 确认只剩「传参给 buildFeatureSnapshot」这一种用法，没有残留的内联构造。

---

## Task 5: `phaseGuard` 改判据 + 409 带 `running`

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js:527-537`
- Test: `src/entrypoints/web/routes-requirements.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

`src/entrypoints/web/routes-requirements.test.js` 顶部 import 区（第 21-25 行那组 `await import` 之后）追加：

```js
const { createRun, finishRun } = await import('../../store/runs.js');
```

文件末尾追加：

```js
// ---- 阶段流转：会话运行守卫 ----

/**
 * 造一个挂在指定 convId 上的活跃 run，返回 run 供测试结束时收尾。
 * createRun() 不收参数，convId 由调用方事后挂到 run 上——这是 store/runs.js 的既有形状，
 * hasActiveRunForConv 就是按 `r.convId === convId && r.status === 'running'` 匹配的（runs.js:140-144）。
 */
function startRunOn(convId) {
  const run = createRun();
  run.convId = convId;
  return run;
}

test('dev-done：开发期子会话仍在跑 → 409 且响应列出该会话', async () => {
  const req = await createReq('子会话在跑的需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_main_1',
    sessions: [
      { convId: 'c_main_1', sessionId: 's1', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
      { convId: 'c_sub_1', sessionId: null, title: '登录页修复', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });
  const run = startRunOn('c_sub_1');

  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.running, [{ convId: 'c_sub_1', title: '登录页修复' }]);
  assert.equal(getRequirement(id).phase, 'dev'); // 没被流转

  finishRun(run); // 只收 run 一个参数（runs.js:443）；不收尾会污染后续用例的 runs 注册表
});

test('dev-done：会话全部跑完 → 200 放行', async () => {
  const req = await createReq('会话已跑完的需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_main_2',
    sessions: [
      { convId: 'c_main_2', sessionId: 's1', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
    ],
  });
  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 200);
  assert.equal(r.json.phase, 'test');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: FAIL —— 第一个用例拿到 200（子会话没被守卫看见）而非 409。

- [ ] **Step 3: 实现**

`src/entrypoints/web/routes-requirements.js` 顶部从 `./req-logic.js` 的 import 清单追加 `runningSessions`。第 527-537 行整体替换为：

```js
/**
 * dev-done / test-pass 共用的阶段流转守卫：404 → canTransition 不过 409 → 有任务进行中/排队 409。
 *
 * 会话判据覆盖**当前阶段全部会话**而非只有主会话：开发期开的子会话（kind:'sub'）同样在改代码，
 * 它还在跑就流转，等于让上个阶段的 run 在新阶段继续落盘（spec §1 缺陷 A）。
 */
function phaseGuard(id, toPhase) {
  const r = getRequirement(id);
  if (!r) return { ok: false, status: 404, error: '需求不存在' };
  const t = canTransition(r.phase, toPhase);
  if (!t.ok) return { ok: false, status: 409, error: t.error };
  if (r.busy || hasQueuedTasks(id)) {
    return { ok: false, status: 409, error: '有任务进行中/排队，请先等待完成或停止' };
  }
  // ★ 第二参传 r.phase（当前阶段），不是 toPhase。传目标阶段会让守卫检查一批还不存在的会话、
  // 对当前正在跑的那批视而不见——真空通过。runningSessions 的形参就叫 currentPhase，别传错。
  const running = runningSessions(normalizeSessions(r), r.phase, hasActiveRunForConv);
  if (running.length) {
    return { ok: false, status: 409, error: '有会话正在运行，请先等待完成或停止', running };
  }
  return { ok: true };
}
```

`handleDevDone` 与 `handleTestPass` 里回错的那行（第 544、556 行）改为把 `running` 一并带出：

```js
    if (!g.ok) return sendJson(res, g.status, { error: g.error, running: g.running });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS。

---

## Task 6: `handleDevDone` 物化 sessions 并清锚点

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js:539-549`
- Test: `src/entrypoints/web/routes-requirements.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

```js
// ---- dev-done：阶段切换清锚点 + 物化会话 ----

test('dev-done：流转后 convId/devSession 清空，sessions 保留且带 phase:dev', async () => {
  const req = await createReq('阶段切换需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_main_3',
    devSession: 'sess_dev_3',
    sessions: [
      { convId: 'c_main_3', sessionId: 'sess_dev_3', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
      { convId: 'c_sub_3', sessionId: 's2', title: '子会话', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });
  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.phase, 'test');
  assert.equal(after.convId, null);
  assert.equal(after.devSession, null);
  assert.equal(after.sessions.length, 2);
  assert.ok(after.sessions.every((s) => s.phase === 'dev'));
});

test('dev-done：老需求（sessions 空、只有 convId）流转时把主会话物化落盘，历史不丢', async () => {
  const req = await createReq('老数据需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_legacy',
    devSession: 'sess_legacy',
    sessions: [],
  });
  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.convId, null);
  assert.deepEqual(
    after.sessions.map((s) => ({ convId: s.convId, sessionId: s.sessionId, kind: s.kind, phase: s.phase })),
    [{ convId: 'c_legacy', sessionId: 'sess_legacy', kind: 'main', phase: 'dev' }],
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: FAIL —— `after.convId` 仍是 `'c_main_3'`；老数据用例的 `sessions` 仍为空数组。

- [ ] **Step 3: 实现**

`src/entrypoints/web/routes-requirements.js` 第 539-549 行整体替换为：

```js
// ==== POST /api/req/dev-done {id} ====
function handleDevDone(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const g = phaseGuard(id, 'test');
    if (!g.ok) return sendJson(res, g.status, { error: g.error, running: g.running });
    const r = getRequirement(id);
    // ★ normalizeSessions(r) 必须在这一次 updateRequirement 之前、且读未更新的 r 求值，两个理由：
    //   1) 老需求的主会话是读侧靠 convId 合成的，锚点一清合成路径就失效，开发期这段历史
    //      再也拿不回来（归档期「优化汇总」会直接少一整段）；
    //   2) normalizeSessions 的 phase 缺省取 req.phase，此刻还是 'dev'。若改成先落 phase:'test'
    //      再去 normalizeSessions(getRequirement(id))，开发期会话会被全部钉成 'test'、此后永不被隐藏——
    //      功能静默退化成空操作，不报错也不红测。下面那条「存量会话物化成 phase:'dev'」的用例就是钉这个的。
    // 清 convId/devSession 是「测试期开新主会话」的触发器：前端见空锚点走既有的
    // 「新建 conv 并回填」路径（req-view.js openRequirementChat），开发期会话随 phase 沉为历史。
    const updated = updateRequirement(
      id,
      { sessions: normalizeSessions(r), phase: 'test', convId: null, devSession: null },
      '开发完成，进入测试期（开发期会话已归档）',
    );
    logger.info('req-routes', '阶段流转：开发→测试', { reqId: id, archivedSessions: updated.sessions.length });
    sendJson(res, 200, { ok: true, phase: updated.phase });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS。

---

## Task 7: `handleConv` 登记当前阶段的 main 会话

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js:514-525`
- Test: `src/entrypoints/web/routes-requirements.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

```js
// ---- /api/req/conv：登记当前阶段的 main 会话 ----

test('conv：绑定新 convId 时同步登记一条当前阶段的 main 会话', async () => {
  const req = await createReq('测试期建主会话');
  const id = req.id;
  updateRequirement(id, {
    phase: 'test',
    convId: null,
    devSession: null,
    sessions: [
      { convId: 'c_old_main', sessionId: 's_old', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
    ],
  });

  const r = await post('/api/req/conv', { id, convId: 'c_test_main' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.convId, 'c_test_main');
  assert.equal(after.sessions.length, 2);
  const fresh = after.sessions.find((s) => s.convId === 'c_test_main');
  assert.equal(fresh.kind, 'main');
  assert.equal(fresh.phase, 'test');
  assert.equal(fresh.sessionId, null);
  // 开发期那条原样保留
  assert.equal(after.sessions.find((s) => s.convId === 'c_old_main').phase, 'dev');
});

test('conv：同 convId 重复绑定幂等，不插重复行、不覆盖已回填的 sessionId', async () => {
  const req = await createReq('conv 幂等需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', convId: null, sessions: [] });

  await post('/api/req/conv', { id, convId: 'c_dup' });
  // 模拟 run 起来后回填了 sessionId
  await post('/api/req/session', { id, convId: 'c_dup', sessionId: 'sess_new' });
  await post('/api/req/conv', { id, convId: 'c_dup' });

  const after = getRequirement(id);
  assert.equal(after.sessions.filter((s) => s.convId === 'c_dup').length, 1);
  assert.equal(after.sessions[0].sessionId, 'sess_new');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: FAIL —— 第一个用例 `after.sessions.length` 仍为 1（`handleConv` 只写了 `convId`）。

- [ ] **Step 3: 实现**

`src/entrypoints/web/routes-requirements.js` 第 514-525 行整体替换为：

```js
// ==== POST /api/req/conv {id,convId} ====
/**
 * 绑定需求主会话。除了写 convId，还必须往 sessions[] 登记一条**当前阶段**的 main 行——
 * normalizeSessions 的「convId → 合成 main」只在 sessions 为空时生效，测试期换主会话时
 * sessions 里已有开发期那批，合成路径不会触发，不显式登记的话新主会话在侧栏根本不出现，
 * 也逃过阶段流转守卫（spec §6.2）。
 */
function handleConv(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });

    const sessions = normalizeSessions(r);
    // 幂等：前端网络重试、多标签页同开同一需求都会重复调本接口。已有同 convId 条目时
    // 一个字段都不动——它可能已被 run 回填过 sessionId、被用户改过标题。
    if (!sessions.some((s) => s.convId === convId)) {
      sessions.push({
        convId,
        sessionId: null,
        title: r.title,
        kind: 'main',
        phase: r.phase,
        createdAt: new Date().toISOString(),
      });
    }
    updateRequirement(id, { convId, sessions }, '绑定会话');
    sendJson(res, 200, { ok: true, convId });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS。既有的「conv：绑定会话可覆盖」用例（第 359-368 行）也须继续绿 —— 它只断言 `convId`，不受影响。

---

## Task 8: `handleSession` 打 phase + 阶段内 main 唯一 + 回填判据

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js:645-709`（`handleSession`）、`:711-734`（`handleSessionDelete` 文案）
- Test: `src/entrypoints/web/routes-requirements.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

```js
// ---- /api/req/session：phase 归属与阶段内 main 唯一 ----

test('session：新建子会话打上需求当前阶段', async () => {
  const req = await createReq('子会话打标需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', convId: 'c_tm', sessions: [
    { convId: 'c_tm', sessionId: null, title: '主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_new_sub', title: '巡检复现', kind: 'sub' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).sessions.find((s) => s.convId === 'c_new_sub').phase, 'test');
});

test('session：跨阶段两条 main 共存合法', async () => {
  const req = await createReq('跨阶段 main 需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', sessions: [
    { convId: 'c_dm', sessionId: 's1', title: '开发主会话', kind: 'main', phase: 'dev', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_tm2', title: '测试主会话', kind: 'main' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).sessions.filter((s) => s.kind === 'main').length, 2);
});

test('session：同阶段第二条 main → 409', async () => {
  const req = await createReq('同阶段双 main 需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', sessions: [
    { convId: 'c_tm3', sessionId: null, title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_tm4', title: '又一个主会话', kind: 'main' });
  assert.equal(r.status, 409);
  assert.equal(getRequirement(id).sessions.length, 1);
});

test('session：历史阶段 main 的迟到 sessionId 回填不污染当前阶段 devSession', async () => {
  const req = await createReq('迟到回填需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', devSession: 'sess_test', sessions: [
    { convId: 'c_dev_m', sessionId: null, title: '开发主会话', kind: 'main', phase: 'dev', createdAt: '' },
    { convId: 'c_test_m', sessionId: 'sess_test', title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_dev_m', sessionId: 'sess_dev_late' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.devSession, 'sess_test'); // 没被开发期的迟到回填改掉
  assert.equal(after.sessions.find((s) => s.convId === 'c_dev_m').sessionId, 'sess_dev_late'); // 但条目本身照常补齐
});

test('session：当前阶段 main 的 sessionId 回填仍写入 devSession', async () => {
  const req = await createReq('正常回填需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', devSession: null, sessions: [
    { convId: 'c_tm5', sessionId: null, title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  await post('/api/req/session', { id, convId: 'c_tm5', sessionId: 'sess_fresh' });
  assert.equal(getRequirement(id).devSession, 'sess_fresh');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: FAIL —— 「新建子会话打上阶段」拿到 `undefined`；「同阶段第二条 main」拿到 200；「迟到回填」把 `devSession` 改成了 `'sess_dev_late'`。

- [ ] **Step 3: 实现**

`src/entrypoints/web/routes-requirements.js` 的 `handleSession`，把第 683-694 行（`else` 新增分支 + `effectiveKind` 计算）替换为：

```js
    } else {
      // 阶段内 main 唯一：跨阶段共存合法（开发期一条 + 测试期一条），同阶段第二条是数据错乱。
      // 注意 handleConv 已会为主会话登记 main 行，正常前端流程不会走到这里再建 main。
      if (kind === 'main' && sessions.some((s) => s.kind === 'main' && (s.phase || 'dev') === r.phase)) {
        return sendJson(res, 409, { error: '当前阶段已有主会话' });
      }
      // 新增：此时没有既有标题可保，才用默认名兜底
      sessions.push({
        convId,
        sessionId,
        title: title || '新会话',
        kind,
        phase: r.phase,
        createdAt: new Date().toISOString(),
      });
      updated = true;
    }

    // devSession 回写认「既有记录的 kind」而不是请求传入的 kind：
    // 回填方不传 kind 时上面会默认成 'sub'，用它判断的话主会话的 devSession 永远回填不了。
    // 再加一道 phase 判据：历史阶段（如开发期）的 main 若有迟到的 sessionId 回填，
    // 不能覆盖当前阶段的 devSession 锚点——那会让 bug-fix 续到上个阶段的 session 上去。
    const target = idx >= 0 ? sessions[idx] : sessions[sessions.length - 1];
    const effectiveKind = target.kind;
    if (effectiveKind === 'main' && sessionId && (target.phase || 'dev') === r.phase) {
      devSessionPatch = sessionId;
    }
```

同时把第 702-703 行的 `event` 计算里对 `sessions[idx >= 0 ? idx : sessions.length - 1]` 的引用改用上面的 `target`：

```js
      const event =
        effectiveKind === 'main' ? '主会话 sessionId 回填' : `会话登记 ${title || target.title}`;
```

`handleSessionDelete` 第 724-726 行的文案改为：

```js
    if (sessions[idx].kind === 'main') {
      // 所有阶段的 main 都不可删：当前阶段的是 bug-fix 落点，历史阶段的是归档期「优化汇总」的转录数据源。
      return sendJson(res, 409, { error: '不能删除主会话（bug-fix 落点 / 归档汇总数据源）' });
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS，含既有的 session 相关用例。

---

## Task 9: 侧栏按阶段过滤会话树

**Files:**
- Modify: `public/js/req-view.js:425`
- Test: `public/js/req-view.sessiontree.test.js`（文件末尾追加）

- [ ] **Step 1: 写失败的测试**

`public/js/req-view.sessiontree.test.js` 末尾追加（`stubList` / `refreshReqList` / `doc` 在文件顶部已就位，沿用现有 harness 写法；若既有用例用的是别的辅助函数名，照抄同文件里既有用例的调用方式）：

```js
test('测试期需求：只渲当前阶段的会话，开发期会话隐藏', async () => {
  stubList([
    {
      id: 'r_phase1',
      title: '阶段隔离需求',
      phase: 'test',
      updatedAt: new Date().toISOString(),
      busy: false,
      sessions: [
        { convId: 'c_d1', sessionId: 's1', title: '开发主会话', kind: 'main', phase: 'dev', createdAt: '' },
        { convId: 'c_d2', sessionId: null, title: '开发子会话', kind: 'sub', phase: 'dev', createdAt: '' },
        { convId: 'c_t1', sessionId: null, title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
      ],
    },
  ]);
  await refreshReqList();
  const titles = [...doc.querySelectorAll('.req-session-title')].map((e) => e.textContent);
  assert.deepEqual(titles, ['测试主会话']);
});

test('测试期的存量需求：缺 phase 的会话照常显示，不让历史凭空消失', async () => {
  stubList([
    {
      id: 'r_phase2',
      title: '老数据需求',
      phase: 'test',
      updatedAt: new Date().toISOString(),
      busy: false,
      sessions: [{ convId: 'c_old', sessionId: 's1', title: '老会话', kind: 'main', createdAt: '' }],
    },
  ]);
  await refreshReqList();
  const titles = [...doc.querySelectorAll('.req-session-title')].map((e) => e.textContent);
  assert.deepEqual(titles, ['老会话']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/req-view.sessiontree.test.js`
Expected: FAIL —— 第一个用例拿到三条标题而非一条。

- [ ] **Step 3: 实现**

`public/js/req-view.js` 第 425 行替换为：

```js
  // 按阶段过滤：进入新阶段后，上个阶段的会话沉为历史、从树上隐去（数据仍在，归档期汇总还要用）。
  // 缺 phase 的存量会话一律显示：那是阶段隔离上线前的数据，该需求没经历过阶段拆分，
  // 那根会话一路服务到了现在这个阶段，隐掉它等于让用户的历史对话凭空消失。
  const sessions = (r.sessions || []).filter((s) => !s.phase || s.phase === r.phase);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/req-view.sessiontree.test.js`
Expected: PASS，含既有 6 个用例。

---

## Task 10: 测试期新主会话带 kind 与 seed

**Files:**
- Modify: `public/js/req-view.js:874-900`（`openRequirementChat`）、`:3041`（文案）

> 本 Task 无单测：`openRequirementChat` 直连 `createReqConv`（写 localStorage）与两个 fetch，既有测试 harness 未覆盖此路径。正确性由 Task 7 的后端登记测试 + 本 Task Step 3 的语法检查 + 最终的人工验收（见「人工验收」一节）兜底。

- [ ] **Step 1: 改 `openRequirementChat`**

第 881 行替换为：

```js
      // kind:'main' 必须显式传（createReqConv 默认 'sub'）；seed 挂着不发——沿用子会话范式，
      // 用户首次发言时才带出去，不主动烧额度（spec §6.4）。测试期主会话是空白新 session，
      // 没有 seed 的话 AI 完全不知道这个需求在做什么。
      convId = createReqConv({
        reqId: id,
        cwd,
        session: data.devSession,
        title: data.title,
        kind: 'main',
        seedPending: !!data.seed,
        seedText: data.seed || '',
      });
```

- [ ] **Step 2: 改 UI 规范还原的守卫文案**

第 3040-3041 行替换为：

```js
        // 评审期还没有需求会话；测试期刚流转、用户还没打开过聊天时也可能暂时没有
        if (!req.convId) return window.toast.error('还原需要需求会话，请先打开该需求的会话');
```

- [ ] **Step 3: 验证**

Run: `node --check public/js/req-view.js`
Expected: 无输出。

Run: `node --test public/js/req-view.sessiontree.test.js`
Expected: PASS（不得回归）。

---

## Task 11: `phaseAction` 新增 `'newconv'` 分支与运行中会话弹窗

**Files:**
- Modify: `public/js/req-chat.js:289-305`（按钮接线）、`:326-356`（`phaseAction`）

> 本 Task 无单测：`phaseAction` 直连 `confirmDialog` / `fetch` / `mountReqChrome`，无既有 harness。由 Step 5 的语法检查 + 人工验收兜底。

- [ ] **Step 1: 给 `confirmDialog` 加 `hideCancel`**

`confirmDialog` 现在必然渲染取消 + 确认两个按钮（`public/js/ui.js:17`）。「还有会话在运行」是纯告知型弹窗，两个同义按钮是噪音。在 `public/js/ui.js` 第 4-10 行的参数表加一项，并在按钮赋值处隐藏取消键：

```js
      export function confirmDialog({
        title = '确认',
        message = '',
        confirmText = '确认',
        cancelText = '取消',
        danger = false,
        hideCancel = false, // 纯告知型弹窗：只留一个「知道了」，不出现两个同义按钮
      } = {}) {
```

第 22-26 行那段（取到 cancelBtn/okBtn 之后）追加一行：

```js
          cancelBtn.textContent = cancelText;
          okBtn.textContent = confirmText;
          if (hideCancel) cancelBtn.hidden = true;
          okBtn.classList.add(danger ? 'danger' : 'primary');
```

Esc / 点遮罩仍 `resolve(false)` —— 告知型弹窗不看返回值，无需改。

- [ ] **Step 2: 改 `phaseAction`**

第 326-356 行整体替换为：

```js
/**
 * @param {'remount'|'newconv'|'leave'} after 流转成功后的装饰层处置：
 *   remount = 原地重挂（同 conv 继续聊）；
 *   newconv = 卸载后重开需求，让 openRequirementChat 见空 convId 建出新阶段的主会话；
 *   leave   = 卸载并转文档模式。
 */
async function phaseAction(id, url, confirmText, after) {
  // confirmDialog 收对象（{title,message,...}），传裸字符串会被解构成全默认值、正文空白
  const ok = await confirmDialog({ title: '阶段流转', message: confirmText });
  if (!ok) return;
  const epoch = chromeEpoch; // 往返期间用户切走 → 结果作废（不把横幅挂到别的会话/不抢导航）
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json().catch(() => ({}));
    if (epoch !== chromeEpoch || currentReqId !== id) return; // 已切走：静默作废
    if (!r.ok) {
      // 被运行中的会话拦下：单行 toast 说不清是哪几个会话，列出标题让用户能直接去停
      if (d.running?.length) {
        const names = d.running.map((s) => `· ${s.title}`).join('\n');
        await confirmDialog({
          title: '还有会话在运行',
          message: `以下会话仍在运行，请先等待完成或手动停止后再流转：\n\n${names}`,
          confirmText: '知道了',
          hideCancel: true,
        });
        return;
      }
      return window.toast.error(d.error || '操作失败');
    }
    window.toast.success('已流转到下一阶段');
    // 不能依赖 openRequirement→openConv 触发钩子刷新：conv 未变时 openConv 会同会话早返回，
    // 钩子不触发，横幅会停留在旧阶段。流转后的装饰层刷新由本模块自己负责：
    // dev→test 后端已清空 convId，必须走 newconv 让前端建出测试期的新主会话
    //   （用 remount 会把用户原地留在开发期那个 conv 上，与「新阶段」语义相悖）；
    // test→archiving 离开聊天模式，先卸载再交 openRequirement 进文档模式（归档表单页）。
    if (after === 'remount') {
      mountReqChrome(id);
      refreshReqList(); // 侧栏阶段徽标立即联动（否则最长等 30s 轮询才由蓝「开发」变紫「测试」）
    } else {
      unmountReqChrome();
      openRequirement(id);
      if (after === 'newconv') refreshReqList(); // 会话树整批换阶段，侧栏须立刻重拉
    }
  } catch (e) {
    window.toast.error('网络错误：' + (e?.message || e));
  }
}
```

- [ ] **Step 3: 把 dev-done 按钮改用 `'newconv'`**

第 294-295 行替换为：

```js
    btn.addEventListener('click', () =>
      phaseAction(data.id, '/api/req/dev-done', '完成开发后进入测试期：开发期会话将归档隐藏，测试期从新会话开始。确认吗？', 'newconv'));
```

- [ ] **Step 4: 无需补 import**

`public/js/req-chat.js:8` 已有 `import { openRequirement, refreshReqList } from './req-view.js';`，`confirmDialog` 在第 6 行也已导入。本 Task 不新增任何 import，确认一眼即可，不要重复添加（重复 import 同名绑定会直接语法报错）。

- [ ] **Step 5: 验证**

Run: `node --check public/js/req-chat.js && node --check public/js/ui.js`
Expected: 无输出。

> 前端 import 图有语法错误会表现为「卡 PRINCIPAL 启动页 + 窗口按钮消失」，`node --check` 是最快的定位手段，不要跳过。

---

## Task 12: 全量回归

- [ ] **Step 1: 跑全量单测**

Run: `npm test`
Expected: 全绿。若有既有用例因 `sessions` 多出 `phase` 字段而 `deepEqual` 失败，逐个改断言为对具体字段的 `assert.equal`（不要回退实现）。

- [ ] **Step 2: 全量语法检查前端改动文件**

Run: `node --check public/js/req-view.js && node --check public/js/req-chat.js && node --check public/js/ui.js`
Expected: 无输出。

- [ ] **Step 3: 把改动落点同步进架构文档**

`docs/ARCHITECTURE.md` 的需求工作流一节补一句阶段会话隔离的说明（`sessions[].phase` 的语义 + dev→test 会换主会话）。`src/store/CLAUDE.md` 的「要改需求阶段流转」条目补上 `sessions[].phase`。

---

## 人工验收（无法自动化的部分）

跑 `npm start`，浏览器开 `http://127.0.0.1:3000`：

1. 找一个开发期需求，开一个子会话并发一句话让它跑起来 → 点「完成开发」→ 应弹出「还有会话在运行」并列出该子会话标题，需求仍在开发期。
2. 等子会话跑完 → 再点「完成开发」→ 流转成功，侧栏该需求下**只剩一条新的测试期主会话**，开发期主会话与子会话都不见了。
3. 点开测试期主会话 → 聊天区是空的；发一句话 → 首条消息应带上 seed（需求标题 / 分支 / 开发文档路径）。
4. 在测试期跑一次表格巡检并触发一次 BUG 修复 → BUG 修复的 run 首条 prompt 应含「【需求背景】」段。
5. 一路推到归档期，点「优化汇总」→ 汇总仍应遍历到开发期那几个会话的转录（数据没丢）。

---

## 自查记录

- **spec 覆盖**：§4 数据模型 → Task 1；§5 守卫 → Task 2+5；§6.1 → Task 6；§6.2 → Task 7；§6.3 → Task 8；§6.4 → Task 10+11；§6.5 → Task 9；§7 bug-fix 上下文 → Task 3+4；§8 测试 → 各 Task 内联；§10 已知边角 → Task 10 Step 2。无遗漏。
- **命名一致性**：`runningSessions(sessions, phase, hasActive)` 在 Task 2 定义、Task 5 调用，签名一致；`buildBugFixPrompt({ bug, seed })` 在 Task 3 定义、Task 4 调用，形状一致；`buildFeatureSnapshot(req)` 仅 Task 4 内部使用；`hideCancel` 在 Task 11 Step 1 定义、Step 2 使用。
- **无测试的三个 Task**（4/10/11）已逐一注明原因与替代验证手段，非省略。
- **已核实的外部契约**（避免实现时二次确认）：`createRun()` 无参、`run.convId` 由调用方事后挂载、`hasActiveRunForConv` 按 `convId + status==='running'` 匹配（`runs.js:62/140`）；`finishRun(run)` 单参（`runs.js:443`）；`req-chat.js:6,8` 已导入 `confirmDialog` / `openRequirement` / `refreshReqList`；`.confirm-msg` 已是 `white-space: pre-wrap`（`app.css:1457`），弹窗里的 `\n` 会正常换行，无需改 CSS。
