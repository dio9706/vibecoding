# 体检二期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给项目体检加上「这不是问题」豁免机制、体检中状态标签、中止即停额度，并把勾选项上移到维度卡片、修掉折叠缺陷、重做顶部按钮。

**Architecture:** 豁免清单以 `(dim, code, file)` 三元组落 `checkup-ignores.json`（真相源）并渲染 `.claude/optimize/IGNORED.md`（人与 AI 可读副本）；生效于两处——audit 引擎召回阶段排除候选（省额度）与 `optimize-ops` 落地前兜底过滤（覆盖全 17 维）。中止能力靠给 `llm-classify` 加可选外部 `signal` 并链到内部 `AbortController`。前端把修复计划树整块并入维度卡片，折叠态改为模块级 Set 显式持有。

**Tech Stack:** Node ≥20 原生 ESM、`node --test`（零测试框架依赖）、原生 DOM（无前端框架）、SSE。

**设计依据：** `docs/superpowers/specs/2026-09-18-checkup-phase2-design.md`

---

## ⚠️ 本项目的两条硬约束（每个任务都适用）

1. **不做 git 提交。** 项目 `CLAUDE.md` 明写「不自动 git 提交，改动留工作区，提交时机由维护者掌控」。本计划因此**不含任何 `git commit` 步骤**，每个任务以「跑测试验证」收尾。
2. **前端禁裸 `innerHTML` 渲染后端/模型文本。** 一律 `createElement` + `textContent`（`optimize-view.js` 文件头的硬性约定）。

**全量测试命令：** `npm test`
**单文件测试命令：** `node --test <文件路径>`

---

## 文件结构

### 新增

| 文件 | 职责 | 依赖方向 |
|---|---|---|
| `src/store/checkup-ignores.js` | 豁免清单持久化，唯一真相源 | → `store/index.js` |
| `src/store/checkup-ignores.test.js` | 上述单测 | — |
| `src/features/project-checkup/ignore.logic.js` | 纯函数：匹配 / 过滤 / 码表 / md 渲染 / 文案 | 零依赖 |
| `src/features/project-checkup/ignore.logic.test.js` | 上述单测 | — |
| `src/features/project-checkup/ignore.js` | 薄 IO 层：store 读写 + md 落盘 + 缓存作废 | → `store/*`、`ignore.logic.js`、`registry.js` |
| `public/js/optimize-badge.js` | 侧栏「体检中/修复中」标签状态机 | 零 import（只碰 DOM 与 fetch） |

### 修改

| 文件 | 改动要点 |
|---|---|
| `src/capabilities/llm-classify.js` | `runClassifierDetailed` 收 `signal`；`classifyOutcome` 加 `aborted` 归因 |
| `src/capabilities/llm-classify.test.js` | 补归因用例 |
| `src/features/project-checkup/audit-engine.js` | `judgeBatch` 透传 signal；`runAudit` 召回后排除已豁免候选 |
| `src/features/project-checkup/audit-engine.logic.js` | 新增 `weightedCodesOf` / `excludeIgnoredCandidates` |
| `src/features/project-checkup/audit-engine.logic.test.js` | 上述单测 |
| `src/features/project-checkup/check-prompts.js` | 签名收 `signal` 并透传到批判定 |
| `src/features/project-checkup/check-comments.js` | 同上 |
| `src/store/optimize.js` | 新增 `dropLlmCache(dir, key)` |
| `src/entrypoints/web/optimize-ops.js` | 三处套用豁免过滤；LEGACY_RUNNERS 传 signal；两处过期注释订正 |
| `src/entrypoints/web/routes-optimize.js` | 三条 ignore 接口 |
| `src/entrypoints/web/routes-optimize.test.js` | 三条接口分发用例 |
| `public/index.html` | 加 `#optToolTag` / `#optIgnoredEntry`；删 `#optPlan` |
| `public/js/optimize-view.logic.js` | `dimListFrom` 排序前附 `planId` |
| `public/js/optimize-view.logic.test.js` | `planId` 下标正确性用例 |
| `public/js/optimize-view.js` | 勾选上移、计划树移除、折叠态显式持有、豁免交互、badge 联动 |
| `public/js/chat.js` | cwd 变更时刷新 badge |
| `public/app.css` | 按钮层级、`.tool-item-tag`、issue 行新元素、清理 `.opt-plan-*` |
| `docs/ARCHITECTURE.md` + 三份模块 `CLAUDE.md` | 同步登记 |

---

## Task 1：`llm-classify` 支持外部 signal

**Files:**
- Modify: `src/capabilities/llm-classify.js`（`classifyOutcome` ~172 行、`runClassifierDetailed` ~199 行）
- Test: `src/capabilities/llm-classify.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/capabilities/llm-classify.test.js` 末尾追加（文件已 import 了 `classifyOutcome`，若没有则把它加进顶部的 import 列表）：

```js
test('外部中止归因为 aborted，且优先于「先尝试解析」', () => {
  // 手上即使已有可解析的 JSON 也不返回：用户已经明确不要这个结果了，
  // 上层 land 的守卫也会把它丢弃，返回它只会让调用方误以为这批成功了
  const out = classifyOutcome({ externalAbort: true, text: '{"verdicts":[]}' });
  assert.equal(out.data, null);
  assert.equal(out.reason, 'aborted');
});

test('额度耗尽仍优先于外部中止', () => {
  // exhausted 是 fail-fast 的结论，比「用户中止」更靠前：
  // 两者同时成立时，调用方要知道的是「池子空了」而不是「被停了」
  const out = classifyOutcome({ exhausted: true, externalAbort: true });
  assert.equal(out.reason, 'exhausted');
});

test('aborted 与 timeout 必须分开：超时值得重试，用户中止绝不该重试', () => {
  assert.equal(classifyOutcome({ aborted: true, text: '' }).reason, 'timeout');
  assert.equal(classifyOutcome({ externalAbort: true, text: '' }).reason, 'aborted');
});

test('没有外部中止时，既有归因行为一字不变', () => {
  assert.equal(classifyOutcome({ text: '{"a":1}' }).reason, null);
  assert.deepEqual(classifyOutcome({ text: '{"a":1}' }).data, { a: 1 });
  assert.equal(classifyOutcome({ text: 'no json here' }).reason, 'unparsable');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/capabilities/llm-classify.test.js`
Expected: FAIL —— 「外部中止归因为 aborted」用例拿到 `reason: null`（当前实现会解析出 `{verdicts:[]}`）。

- [ ] **Step 3: 改 `classifyOutcome`**

把 `src/capabilities/llm-classify.js` 的 `classifyOutcome` 改为：

```js
/**
 * 把一次分类调用的终局状态归结为「数据 + 失败原因」。纯函数，四条失败分支各自钉死。
 *
 * 为什么要区分原因（2026-08-26 事故）：埋点统计的阶段 A 拿到 null 后一律回话
 * 「没听懂这个统计需求，换个说法试试」。而那次的真实情况是模型花了 52.2s 算完、
 * 预算只有 47s，结果被丢弃 —— 需求表述完全正常。把超时说成「没听懂」，
 * 用户只会一遍遍改说法，而改说法对超时毫无作用，等于把人引进死路。
 * 调用方要能分开回话，就必须先能分开归因。
 *
 * **先尝试解析、再看是否超时**，顺序是关键：abort 只说明「流没按时结束」，
 * 不代表没拿到答案。模型常常早早就把 JSON 吐完了，SDK 流却迟迟不收尾（限流时尤其明显）。
 * 此时手里已有完整结果还回一句失败，是白烧一次额度又骗了用户。
 *
 * **唯一的例外是 externalAbort**（用户点了中止）：它排在解析之前。此时结果即使能解析出来
 * 也没有价值——上层 `optimize-ops.land` 的守卫会把已中止 job 的结果一律丢弃。
 * 更要紧的是它必须与 `timeout` 分开：超时值得重试（audit-engine 就重试一次），
 * 用户中止绝不该重试，否则「点中止」反而会多烧一轮额度。
 *
 * @param {{exhausted?:boolean, aborted?:boolean, externalAbort?:boolean, text?:unknown}} [o]
 * @returns {{data: object|null, reason: 'exhausted'|'aborted'|'timeout'|'unparsable'|null}}
 */
export function classifyOutcome(o) {
  const { exhausted = false, aborted = false, externalAbort = false, text = '' } = o || {};
  if (exhausted) return { data: null, reason: 'exhausted' };
  if (externalAbort) return { data: null, reason: 'aborted' };

  const block = extractFirstJsonObject(text);
  if (block) {
    try {
      return { data: JSON.parse(block), reason: null };
    } catch {
      /* 大括号配平却仍非法（如尾逗号）：属输出质量问题，落到下面按 unparsable 归因 */
    }
  }
  // 超时优先于 unparsable：被截断的残缺 JSON 正是超时的典型表现，
  // 归到 unparsable 会把排查往「模型不听话」的方向带偏。
  return { data: null, reason: aborted ? 'timeout' : 'unparsable' };
}
```

- [ ] **Step 4: 改 `runClassifierDetailed` 接入 signal**

把该函数改为（改动点：签名多 `signal`、开头 fail-fast、listener 链接与摘除、末尾传 `externalAbort`）：

```js
/**
 * 与 runClassifierOnce 同一套调用逻辑，但**连失败原因一起返回**。
 *
 * 独立导出而不是改 runClassifierOnce 的签名：后者有 10 个调用点，
 * 绝大多数只关心「拿到没拿到」。为一个调用点的需要去改公共契约，
 * 收益不抵风险 —— runClassifierOnce 就此退化为本函数的一层薄包装。
 *
 * @param {object} opts 同 runClassifierOnce
 * @param {AbortSignal} [opts.signal] 外部中止信号（体检 job 的 signal）。
 *   不传即行为与从前完全一致——这是本参数唯一的兼容性承诺，10 个调用点里只有
 *   体检链路的三处会传。
 * @returns {Promise<{data: object|null, reason: string|null}>}
 */
export async function runClassifierDetailed({
  prompt, systemPrompt, model, logTag, timeoutMs, effort, signal,
}) {
  // 额度耗尽 fail-fast：曾发生五小时限流窗口内 SDK 流永不结束 → 不发起注定失败 / 会 stall 的分类调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-classify', 'token 池全部耗尽，跳过分类（fail-fast）', { logTag });
    return classifyOutcome({ exhausted: true });
  }
  // 已中止就别发起：这一整轮的结果注定会被上层丢弃，发出去就是纯粹的额度浪费。
  // 体检有 49 批量级的调用，逐批在这里早退，「点中止」才是真的立刻止血
  if (signal?.aborted) {
    logger.info('llm-classify', '外部已中止，跳过本次分类调用', { logTag });
    return classifyOutcome({ externalAbort: true });
  }

  // 意图分类点传 10s（用户在等第一条回复）；其余调用点不传，沿用 30s
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : CLASSIFY_TIMEOUT_MS;
  const effortOpt = resolveEffort(effort);
  let out = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
  // 外部 signal 链到内部 controller。**必须在 finally 里摘掉**：一个体检 job 的 signal
  // 会被几十个批次挂载（deadcode 实测 19 批 × 多维度并行），不摘就是长跑进程里的泄漏。
  // `once: true` 只回收「真触发了」的那一个，正常结束的几十个仍要靠 removeEventListener。
  const onExternalAbort = () => abort.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    // abort 走 SDK 优雅关闭（stdin EOF），限流卡死时流可能迟迟不结束（实测拖 10 分钟+）
    // → 再用 race 兜底：到点不管流死活直接返回，调用方绝不被拖死。
    const call = runClaude(prompt, {
      ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(effortOpt ? { effort: effortOpt } : {}),
      persistSession: false, // 内部一次性调用，不落盘 session
      model,
      maxTurns: 1, // 分类只需一轮文本输出；即使模型试图调工具也就此收束
      // 通配符禁全部工具：`"*"` 会把所有工具定义从请求里移除，模型根本看不见。
      // 为什么不用逐个列名的黑名单（原写法）：黑名单补不全。2026-08-24 实测中
      // haiku 绕过了列名黑名单——它调 ToolSearch 把被禁的 Read 重新捞出来，
      // 吃掉 maxTurns 唯一一轮，整批分类作废。SDK 每加一个新工具，黑名单就多一个洞。
      disallowedTools: ['*'],
      abortController: abort,
      onText: (t) => (out += t),
      onResult: (info) => {
        if (!out && info.result) out = info.result;
      },
    });
    // race 放弃后该 promise 仍可能 reject，预挂 catch 防 unhandled；留日志便于排查
    call.catch((e) => logger.warn('llm-classify', '分类调用异常（已落兜底）', { logTag, err: e?.message || String(e) }));
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, budget + 2_000))]);
  } catch {
    /* 超时 abort 或调用异常 → 落兜底 */
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
  // 用 signal.aborted 判超时而不是量耗时：abort 只由上面那个 timer 触发，
  // 它是「预算用尽」的权威信号。拿耗时去猜会在「调用早早异常返回」时误判成超时。
  // externalAbort 单独判：同样是 abort.signal.aborted，成因不同、调用方处置相反。
  return classifyOutcome({
    aborted: abort.signal.aborted,
    externalAbort: !!signal?.aborted,
    text: out,
  });
}
```

同时把 `runClassifierOnce` 的 JSDoc 补一行参数说明：

```js
 * @param {AbortSignal} [opts.signal] 外部中止信号；不传即行为不变
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test src/capabilities/llm-classify.test.js`
Expected: PASS，全部用例绿。

- [ ] **Step 6: 跑全量测试确认没碰坏别的调用点**

Run: `npm test`
Expected: PASS。其余 9 个调用点不传 `signal`，`signal?.` 全部短路，行为不变。

---

## Task 2：中止信号透传到三条 LLM 链路

**Files:**
- Modify: `src/features/project-checkup/audit-engine.js:101-147`（`judgeBatch`）
- Modify: `src/features/project-checkup/check-prompts.js:385`（`judgeBatch`）、`:457`（入口）、`:511`（调度）
- Modify: `src/features/project-checkup/check-comments.js:364`（`judgeBatch`）、`:456`（入口）、`:507`（调度）
- Modify: `src/entrypoints/web/optimize-ops.js:336`（`land` 注释）、`:392`（LEGACY_RUNNERS 调度）、`:505`（`cancelCheckupJob` 注释）

> 本任务改的全是 SDK 调用编排，无法直测（项目既有纪律：IO 层薄、判定收进 `.logic.js`）。验证靠 Task 1 的归因测试 + 全量测试不回归 + §手工验收第 2 条。

- [ ] **Step 1: `audit-engine.judgeBatch` 透传 signal**

`src/features/project-checkup/audit-engine.js` 中，把 `runClassifierOnce` 调用改为带 signal：

```js
    const raw = await runClassifierOnce({
      prompt,
      systemPrompt,
      model: JUDGE_MODEL,
      logTag: `audit/${dim.id}#${index}`,
      timeoutMs: BATCH_TIMEOUT_MS,
      // 批**内**也要能停。原先只在批之间检查 signal，而单批预算是 300s——
      // 用户点中止后最坏要等 5 分钟才真的停下，那 5 分钟的额度全是白烧的
      signal,
    });
```

- [ ] **Step 2: `check-prompts` 接入 signal**

改三处。`judgeBatch` 签名与调用：

```js
async function judgeBatch(batch, index, signal) {
  const prompt = buildPrompt(batch);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 重试前先看中止：用户已经停了，第二次尝试是纯粹的额度浪费
    if (signal?.aborted) return null;
    const raw = await runClassifierOnce({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      model: JUDGE_MODEL,
      logTag: `checkup/prompts#${index}`,
      timeoutMs: BATCH_TIMEOUT_MS,
      signal,
    });
    const list = raw ? validateVerdicts(raw, batch.length) : null;
    if (list) return list;
    logger.warn('check-prompts', 'LLM 判定失败（无输出或结构不合法）', {
      batch: index,
      attempt,
      size: batch.length,
      got: raw ? JSON.stringify(raw).slice(0, 200) : null,
    });
  }
  return null;
}
```

入口签名（`:457`）：

```js
export async function checkPrompts(projectDir, { cache = null, force = false, signal } = {}) {
```

并在入口 JSDoc 补：

```js
 * @param {AbortSignal} [opts.signal] 中止信号：用户点「中止体检」时立刻停掉正在跑的批，
 *   不再烧额度（结果由上层 land 的守卫丢弃）
```

调度处（`:511`）：

```js
  const results = await mapLimited(batches, MAX_CONCURRENCY, (b, i) => judgeBatch(b, i + 1, signal));
```

- [ ] **Step 3: `check-comments` 接入 signal**

同 Step 2 的三处，改 `src/features/project-checkup/check-comments.js`：

`judgeBatch` 加第三个参数 `signal`，在 `for (let attempt...)` 循环体首行加 `if (signal?.aborted) return null;`，并给它内部的 `runClassifierOnce({...})` 调用加上 `signal,`；

入口（`:456`）改为：

```js
export async function checkComments(projectDir, { cache = null, force = false, signal } = {}) {
```

调度（`:507`）改为：

```js
  const results = await mapLimited(batches, MAX_CONCURRENCY, (b, i) => judgeBatch(b, i + 1, signal));
```

- [ ] **Step 4: `optimize-ops` 把 job.signal 交给四个专属检测器**

`src/entrypoints/web/optimize-ops.js` 的 `runAsyncDims` 里（约 :392）：

```js
  const tasks = [];
  for (const [key, run] of Object.entries(LEGACY_RUNNERS)) {
    // signal 一并给：prompts / comments 走 llm-classify（已支持外部 signal），
    // tests / hygiene 起子进程、不收这个参数，多传一个键对它们无害
    tasks.push({ key, settled: wrap(() => run(dir, { cache: cache[key] || null, force, signal: job.signal })) });
  }
```

- [ ] **Step 5: 订正两处已过期的注释**

`land()` 函数头（约 :336）里那段说明改为：

```js
/** 把一个维度的结果写进报告、落盘并推给前端。每落一个就做一次，中途刷新页面能看到已出的那一半 */
function land(job, key, dim) {
  // 已收尾的 job 不再接收结果。
  //
  // 中止时我们**立即** finishJob 让界面马上响应，而正在跑的检测器要过一小会儿才收到信号
  // （llm-classify 现已支持外部 signal，会在当前 SDK 调用上 abort，但收尾仍有几百毫秒量级的延迟）。
  // 那些任务停下后仍会调到这里——没有这道守卫，它们会把已经标成 cancelled 的维度又改回 done，
  // 用户看到的就是「我明明停了，它却还在出结果」。
  if (job.status !== 'running') return;
```

`cancelCheckupJob()` 的「已知代价」段（约 :505）改为：

```js
/**
 * 中止一次体检。
 *
 * **立即收尾**而不是等任务自然结束：用户点「中止」要的是界面马上回到可操作状态。
 * 已落地的维度保留（它们早已 saveCheckup 落盘，丢掉等于白烧那部分额度），
 * 未跑完的由 finishJob 标 cancelled。
 *
 * 额度侧已全面止血：`runAudit`（10 个 audit 维度）、`checkHolistic`（最贵的一段，
 * 实测 6.3 分钟）、以及走 `llm-classify` 的 `checkPrompts` / `checkComments`
 * 都吃 job.signal，会在当前 SDK 调用上 abort 并跳过后续批次。
 * 仅 `checkTests` / `checkHygiene` 不吃 signal——它们起子进程跑测试命令与 git ls-files，
 * 不消耗 LLM 额度，让它们自然跑完比中途杀子进程更安全。
 */
```

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS，无回归。

---

## Task 3：豁免清单持久化 store

**Files:**
- Create: `src/store/checkup-ignores.js`
- Test: `src/store/checkup-ignores.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/store/checkup-ignores.test.js`：

```js
/**
 * 体检豁免清单的读写。
 *
 * 隔离：store/index.js 在模块求值时就把数据目录定死，必须「先设 APP_DATA_DIR 到临时目录，
 * 再动态 import」，否则会写进开发机真实的 checkup-ignores.json（做法同 store/optimize.test.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-ignores-'));

const { readIgnores, addIgnore, removeIgnore } = await import('./checkup-ignores.js');

let n = 0;
const nextDir = () => `C:/tmp/proj-${++n}`;

const rule = (over = {}) => ({
  dim: 'structure',
  code: 'A1_DEP_VIOLATION',
  file: 'src/api/request.js',
  message: 'api 层直接 import store',
  note: '历史遗留兼容层，下版本整体删除',
  at: '2026-09-18T10:00:00.000Z',
  ...over,
});

test('新项目读出空数组而不是 undefined', () => {
  assert.deepEqual(readIgnores(nextDir()), []);
});

test('加一条后能读回来', () => {
  const dir = nextDir();
  addIgnore(dir, rule());
  const got = readIgnores(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].note, '历史遗留兼容层，下版本整体删除');
});

test('同一 (dim, code, file) 重复提交是覆盖而非追加', () => {
  // 用户改主意重新写理由时，应当留下最新那条，而不是两条互相矛盾的记录
  const dir = nextDir();
  addIgnore(dir, rule({ note: '第一版理由' }));
  addIgnore(dir, rule({ note: '第二版理由', at: '2026-09-18T11:00:00.000Z' }));
  const got = readIgnores(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].note, '第二版理由');
  assert.equal(got[0].at, '2026-09-18T11:00:00.000Z');
});

test('code 不同视为两条独立记录', () => {
  // 这正是「召回阶段要全部 code 都被豁免才剔除候选」这条规则的前提
  const dir = nextDir();
  addIgnore(dir, rule({ code: 'A1_DEP_VIOLATION' }));
  addIgnore(dir, rule({ code: 'A2_DEP_SMELL' }));
  assert.equal(readIgnores(dir).length, 2);
});

test('file 不同视为两条独立记录', () => {
  const dir = nextDir();
  addIgnore(dir, rule({ file: 'src/a.js' }));
  addIgnore(dir, rule({ file: 'src/b.js' }));
  assert.equal(readIgnores(dir).length, 2);
});

test('跨项目互不影响', () => {
  const a = nextDir();
  const b = nextDir();
  addIgnore(a, rule());
  assert.equal(readIgnores(a).length, 1);
  assert.deepEqual(readIgnores(b), []);
});

test('删除命中的条目', () => {
  const dir = nextDir();
  addIgnore(dir, rule({ code: 'A1_DEP_VIOLATION' }));
  addIgnore(dir, rule({ code: 'A2_DEP_SMELL' }));
  removeIgnore(dir, { dim: 'structure', code: 'A1_DEP_VIOLATION', file: 'src/api/request.js' });
  const got = readIgnores(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].code, 'A2_DEP_SMELL');
});

test('删除不存在的条目不抛错也不改动已有数据', () => {
  const dir = nextDir();
  addIgnore(dir, rule());
  removeIgnore(dir, { dim: 'structure', code: 'NOPE', file: 'src/api/request.js' });
  assert.equal(readIgnores(dir).length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/checkup-ignores.test.js`
Expected: FAIL —— `Cannot find module './checkup-ignores.js'`。

- [ ] **Step 3: 实现 store**

创建 `src/store/checkup-ignores.js`：

```js
/**
 * 体检豁免清单（checkup-ignores.json）—— 用户点「这不是问题」的记录，唯一真相源。
 *
 * 与 optimize.json 同样用项目绝对路径作 key：同一台机器上路径唯一，不需要额外生成 id。
 *
 * 为什么独立成一个文件而不是塞进 optimize.json：那份文件装的是「体检产出」
 * （报告、历史、串行闸、LLM 缓存），会被体检流程高频整份读改写；豁免是**人工判断**，
 * 低频、长寿、且值得单独备份。混在一起意味着每次体检落盘都要带上这些人工记录，
 * 一次损坏就把两类数据一起赔进去。
 *
 * 面向人和 AI 的可读副本是 `.claude/optimize/IGNORED.md`，由
 * `features/project-checkup/ignore.js` 从本文件渲染——那是派生物，本文件才是真相源。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'checkup-ignores.json';
const EMPTY = () => ({ projects: {} });

/**
 * 两条记录是否指同一个豁免。
 *
 * 键是 `(dim, code, file)` 三元组，**刻意不含行号**：行号会随任何编辑漂移，
 * 下一次体检就对不上，豁免等于没记。代价是同文件同类型的其他问题会被一起免掉，
 * 这是设计时接受的取舍（详见 spec §1.1）。
 */
function sameRule(a, b) {
  return a?.dim === b?.dim && a?.code === b?.code && a?.file === b?.file;
}

/** 某项目的全部豁免记录；没有记录时返回空数组（不是 undefined，调用方一律可以直接遍历） */
export function readIgnores(dir) {
  const items = readJson(FILE, EMPTY()).projects?.[dir]?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * 记一条豁免。同三元组**覆盖**而非追加——用户改主意重写理由时，
 * 留下两条互相矛盾的记录比留下最新那条糟糕得多。
 */
export function addIgnore(dir, rule) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || { items: [] };
    const kept = (rec.items || []).filter((it) => !sameRule(it, rule));
    rec.items = [...kept, rule];
    data.projects[dir] = rec;
    return data;
  });
}

/** 撤销一条豁免。没命中任何记录时返回 undefined 放弃写盘（别为一次空操作刷新文件） */
export function removeIgnore(dir, key) {
  return updateJson(FILE, EMPTY(), (data) => {
    const rec = data.projects?.[dir];
    if (!rec?.items?.length) return undefined;
    const kept = rec.items.filter((it) => !sameRule(it, key));
    if (kept.length === rec.items.length) return undefined;
    rec.items = kept;
    return data;
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/checkup-ignores.test.js`
Expected: PASS，8 个用例全绿。

---

## Task 4：豁免匹配与渲染的纯函数层

**Files:**
- Create: `src/features/project-checkup/ignore.logic.js`
- Test: `src/features/project-checkup/ignore.logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/project-checkup/ignore.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFile, matchesIgnore, filterIgnoredIssues, ignoredCodesFor,
  appendIgnoreNote, renderIgnoredMd,
} from './ignore.logic.js';

const rule = (over = {}) => ({
  dim: 'structure',
  code: 'A1_DEP_VIOLATION',
  file: 'src/api/request.js',
  message: 'api 层直接 import store',
  note: '历史遗留兼容层',
  at: '2026-09-18T10:00:00.000Z',
  ...over,
});

const issue = (over = {}) => ({
  code: 'A1_DEP_VIOLATION',
  severity: 'error',
  file: 'src/api/request.js',
  line: 12,
  message: 'api 层直接 import store',
  ...over,
});

test('分隔符归一：反斜杠与正斜杠视为同一路径', () => {
  assert.equal(normalizeFile('src\\api\\request.js'), 'src/api/request.js');
  assert.equal(normalizeFile('  src/api/request.js  '), 'src/api/request.js');
});

test('大小写**不**归一：大小写敏感的文件系统上它们是两个文件', () => {
  assert.notEqual(normalizeFile('src/Api/x.js'), normalizeFile('src/api/x.js'));
});

test('三元组全中才算匹配', () => {
  assert.equal(matchesIgnore('structure', issue(), rule()), true);
});

test('维度不同不匹配', () => {
  assert.equal(matchesIgnore('complexity', issue(), rule()), false);
});

test('code 不同不匹配（同文件的其他类型问题仍要报）', () => {
  assert.equal(matchesIgnore('structure', issue({ code: 'A2_DEP_SMELL' }), rule()), false);
});

test('行号不参与匹配：代码上下挪动后豁免依然有效', () => {
  assert.equal(matchesIgnore('structure', issue({ line: 987 }), rule()), true);
});

test('过滤返回保留项与被豁免条数', () => {
  const issues = [issue(), issue({ code: 'A2_DEP_SMELL' }), issue({ file: 'src/b.js' })];
  const out = filterIgnoredIssues('structure', issues, [rule()]);
  assert.equal(out.ignoredCount, 1);
  assert.equal(out.kept.length, 2);
  assert.deepEqual(out.kept.map((i) => i.code), ['A2_DEP_SMELL', 'A1_DEP_VIOLATION']);
});

test('没有豁免记录时原样返回，不复制数组', () => {
  const issues = [issue()];
  const out = filterIgnoredIssues('structure', issues, []);
  assert.equal(out.ignoredCount, 0);
  assert.equal(out.kept, issues, '零豁免是最常见的路径，不该产生垃圾');
});

test('ignoredCodesFor 只收该维度该文件的 code', () => {
  const ignores = [
    rule({ code: 'A1_DEP_VIOLATION' }),
    rule({ code: 'A2_DEP_SMELL' }),
    rule({ file: 'src/other.js', code: 'A3_X' }),
    rule({ dim: 'complexity', code: 'A4_Y' }),
  ];
  const got = ignoredCodesFor('structure', 'src/api/request.js', ignores);
  assert.deepEqual([...got].sort(), ['A1_DEP_VIOLATION', 'A2_DEP_SMELL']);
});

test('分数已调整与未调整的说明文案必须不同', () => {
  // 两类维度的分数口径不同，不说清楚就会出现「0 个问题却 72 分」的无解观感
  assert.equal(appendIgnoreNote('', 2, true), '已豁免 2 条');
  assert.equal(appendIgnoreNote('', 2, false), '已豁免 2 条，本维度分数未重算');
  assert.equal(appendIgnoreNote('原因说明', 1, true), '原因说明（已豁免 1 条）');
  assert.equal(appendIgnoreNote('原因说明', 0, true), '原因说明', '零豁免不该留痕');
});

test('md 渲染含备注原文、维度中文名与免改声明', () => {
  const md = renderIgnoredMd([rule()], [{ id: 'structure', label: '分层与依赖方向' }]);
  assert.match(md, /手工修改会在下次豁免操作时被覆盖/);
  assert.match(md, /分层与依赖方向/);
  assert.match(md, /src\/api\/request\.js/);
  assert.match(md, /A1_DEP_VIOLATION/);
  assert.match(md, /历史遗留兼容层/);
});

test('md 在清单为空时也给出完整文件（而不是空串）', () => {
  // 撤销最后一条豁免后要把文件写成「空清单」，不能留着上一版内容骗人
  const md = renderIgnoredMd([], []);
  assert.match(md, /体检豁免清单/);
  assert.match(md, /目前没有任何豁免记录/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-checkup/ignore.logic.test.js`
Expected: FAIL —— `Cannot find module './ignore.logic.js'`。

- [ ] **Step 3: 实现纯函数层**

创建 `src/features/project-checkup/ignore.logic.js`：

```js
/**
 * 体检豁免的纯函数层：匹配、过滤、码表、文案、md 渲染。零 IO，可直测。
 *
 * 豁免键是 `(dim, code, file)` 三元组。为什么是这三样、为什么不含行号、
 * 为什么不细到代码单元，见 spec `docs/superpowers/specs/2026-09-18-checkup-phase2-design.md` §1.1。
 */

/**
 * 路径归一。
 *
 * **只归一分隔符，不归一大小写**：比较两侧的 file 都来自同一次体检的产出
 * （git ls-files / fs 遍历），大小写本就一致；而强行小写会在大小写敏感的文件系统上
 * 把 `src/Api/x.js` 和 `src/api/x.js` 误判成同一个文件，一条豁免会吃掉两个文件的问题。
 * 分隔符仍要归一——md 可被手工编辑，不同来源可能混入反斜杠。
 */
export function normalizeFile(file) {
  return String(file || '').trim().replace(/\\/g, '/');
}

/** 一条 issue 是否命中某条豁免记录 */
export function matchesIgnore(dimId, issue, rule) {
  return rule?.dim === dimId
    && rule?.code === issue?.code
    && normalizeFile(rule?.file) === normalizeFile(issue?.file);
}

/**
 * 过滤掉被豁免的 issue。
 *
 * @returns {{kept: Array, ignoredCount: number}} 零豁免时 `kept` 就是传入的同一个数组引用
 *   —— 这是最常见的路径（绝大多数项目没有任何豁免），不该为它产生垃圾
 */
export function filterIgnoredIssues(dimId, issues, ignores) {
  const list = Array.isArray(issues) ? issues : [];
  const rules = (Array.isArray(ignores) ? ignores : []).filter((r) => r?.dim === dimId);
  if (!rules.length || !list.length) return { kept: list, ignoredCount: 0 };

  const kept = list.filter((it) => !rules.some((r) => matchesIgnore(dimId, it, r)));
  return { kept, ignoredCount: list.length - kept.length };
}

/**
 * 某维度某文件上已被豁免的 code 集合。
 *
 * 给召回阶段排除用：召回时还不知道 verdict code（code 是判定的产物），
 * 所以只能反过来问「这个文件上哪些 code 已经被免了」，再由调用方判断是否覆盖了全部有权重的 code。
 */
export function ignoredCodesFor(dimId, file, ignores) {
  const f = normalizeFile(file);
  const out = new Set();
  for (const r of Array.isArray(ignores) ? ignores : []) {
    if (r?.dim === dimId && normalizeFile(r.file) === f) out.add(r.code);
  }
  return out;
}

/**
 * 往维度的 reason 上追加豁免说明。
 *
 * `scoreAdjusted` 必须如实区分：走召回排除的 audit 维度分数会跟着变，
 * 只走兜底过滤的维度分数不变。不说清楚，用户会看到「0 个问题却 72 分」而无从理解。
 */
export function appendIgnoreNote(reason, count, scoreAdjusted) {
  if (!count) return reason || '';
  const note = scoreAdjusted ? `已豁免 ${count} 条` : `已豁免 ${count} 条，本维度分数未重算`;
  return reason ? `${reason}（${note}）` : note;
}

/** 时间戳 → `YYYY-MM-DD HH:mm`；解析不出就原样返回（宁可难看也别丢信息） */
function fmtAt(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return String(at || '');
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 渲染 `.claude/optimize/IGNORED.md`。
 *
 * 每次写入/删除后**整份重渲染**，不做增量拼接：增量拼接必然漂移，
 * 而整份重渲染是一次纯计算加一次写盘，成本可以忽略。
 *
 * 顶部那句「手工修改会被覆盖」是必须的——不写的话用户会在里面补充内容然后丢失。
 *
 * @param {Array} items 豁免记录
 * @param {Array<{id:string,label:string}>} dims 维度声明（只取 id 与 label）
 */
export function renderIgnoredMd(items, dims) {
  const label = new Map((dims || []).map((d) => [d.id, d.label || d.id]));
  const lines = [
    '# 体检豁免清单',
    '',
    '> 本文件由「项目优化 → 这不是问题」自动生成，**手工修改会在下次豁免操作时被覆盖**。',
    '> 真相源是应用数据目录下的 `checkup-ignores.json`；此处是给人和 AI 读的副本。',
    '> 下一次体检会跳过这里列出的问题。',
    '',
  ];

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    lines.push('目前没有任何豁免记录。', '');
    return lines.join('\n');
  }

  // 按维度分组：同一个维度的豁免通常有共同的背景，凑在一起读才有上下文
  const byDim = new Map();
  for (const it of list) {
    if (!byDim.has(it.dim)) byDim.set(it.dim, []);
    byDim.get(it.dim).push(it);
  }

  for (const [dimId, group] of byDim) {
    lines.push(`## ${label.get(dimId) || dimId}（${dimId}）`, '');
    for (const it of group) {
      lines.push(`### ${normalizeFile(it.file)} · ${it.code}`);
      if (it.message) lines.push(`- **原始判定**：${it.message}`);
      lines.push(`- **豁免理由**：${it.note || '（未填写）'}`);
      lines.push(`- **登记时间**：${fmtAt(it.at)}`, '');
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-checkup/ignore.logic.test.js`
Expected: PASS，13 个用例全绿。

---

## Task 5：豁免 IO 层 + 缓存精确作废

**Files:**
- Create: `src/features/project-checkup/ignore.js`
- Modify: `src/store/optimize.js`（在 `saveLlmCache` 之后加 `dropLlmCache`）

> IO 层无法直测（写真实文件系统），正确性靠 Task 4 的纯函数测试 + 手工验收第 3 条。

- [ ] **Step 1: 给 `store/optimize.js` 加 `dropLlmCache`**

在 `saveLlmCache` 函数之后插入：

```js
/**
 * 丢弃单个维度的指纹缓存，强制它下次体检重跑。
 *
 * 唯一的用途是豁免清单变更：豁免会改变该维度的候选集合（召回阶段排除），
 * 而缓存里的 `score` 是按**排除前**的候选算出来的。不作废就会出现
 * 「同一份代码，缓存命中与否两个分数」的长期不一致。
 *
 * 为什么不把豁免清单的 hash 纳入指纹：那会让「加一条豁免」作废全部 17 个维度的缓存，
 * 下次体检十几分钟起步、一整轮额度。按维度精确作废是同样效果下最小的代价。
 */
export function dropLlmCache(dir, key) {
  return updateJson(FILE, EMPTY(), (data) => {
    const rec = data.projects?.[dir];
    if (!rec?.llmCache?.[key]) return undefined; // 本来就没有，别为空操作刷新文件
    delete rec.llmCache[key];
    return data;
  });
}
```

- [ ] **Step 2: 实现 IO 层**

创建 `src/features/project-checkup/ignore.js`：

```js
/**
 * 体检豁免的 IO 层（与本目录 `check-X.js` + `check-X.logic.js` 成对出现的纪律一致）。
 *
 * 三件事都在这里收口，调用方（routes-optimize / optimize-ops）不必知道其中任何一件：
 *   1. 读写 `checkup-ignores.json`（真相源）；
 *   2. 重渲染 `.claude/optimize/IGNORED.md`（给人和 AI 读的副本）；
 *   3. 作废该维度的指纹缓存（不作废就会出现「缓存命中与否两个分数」）。
 *
 * 为什么不复用 `project-optimize/strategies/advisory.js` 里那个同形状的 `writeUnder`：
 * 它是那个模块的私有函数，导出后会造成 `project-checkup → project-optimize` 的反向依赖
 * （当前方向是 optimize 依赖 checkup，反过来即成环）。为三行 mkdir + write 制造一个环，
 * 或者把三行下沉到 shared，代价都比在这里重写高。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readIgnores, addIgnore as addToStore, removeIgnore as removeFromStore } from '../../store/checkup-ignores.js';
import { dropLlmCache } from '../../store/optimize.js';
import { DIMENSIONS } from './dimensions/registry.js';
import { renderIgnoredMd, normalizeFile } from './ignore.logic.js';
import { logger } from '../../shared/logger.js';

/** 与 advisory 策略的产出同目录：用户对 `.claude/optimize/` 已经有预期，不再新开一处 */
export const IGNORED_PATH = '.claude/optimize/IGNORED.md';

/** 某项目的全部豁免记录 */
export function getIgnores(dir) {
  return readIgnores(dir);
}

/**
 * 重渲染 md 副本。
 *
 * 失败只告警不抛：真相源已经落盘了，md 写不出去（目录只读、磁盘满）不该让整个请求失败——
 * 那会让用户以为豁免没记上，于是再点一次。
 */
function renderSideCar(dir) {
  try {
    const full = path.join(dir, IGNORED_PATH);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, renderIgnoredMd(readIgnores(dir), DIMENSIONS), 'utf8');
  } catch (e) {
    logger.warn('checkup-ignore', 'IGNORED.md 写入失败（豁免已落盘，仅副本缺失）', {
      dir, err: e?.message || String(e),
    });
  }
}

/**
 * 记一条豁免。
 *
 * @param {string} dir 项目根
 * @param {{dim:string, code:string, file:string, message?:string, note:string}} input
 * @returns {number} 该项目当前的豁免条数
 */
export function addIgnore(dir, input) {
  const rule = {
    dim: String(input.dim),
    code: String(input.code),
    file: normalizeFile(input.file),
    message: String(input.message || ''),
    note: String(input.note || '').trim(),
    at: new Date().toISOString(),
  };
  addToStore(dir, rule);
  dropLlmCache(dir, rule.dim);
  renderSideCar(dir);
  logger.info('checkup-ignore', '记录豁免', { dir, dim: rule.dim, code: rule.code, file: rule.file });
  return readIgnores(dir).length;
}

/**
 * 撤销一条豁免。缓存同样要作废——撤销后这条问题应当在下次体检重新出现。
 *
 * @param {string} dir
 * @param {{dim:string, code:string, file:string}} key
 * @returns {number} 该项目剩余的豁免条数
 */
export function removeIgnore(dir, key) {
  const dim = String(key.dim);
  removeFromStore(dir, { dim, code: String(key.code), file: normalizeFile(key.file) });
  dropLlmCache(dir, dim);
  renderSideCar(dir);
  logger.info('checkup-ignore', '撤销豁免', { dir, dim, code: key.code, file: key.file });
  return readIgnores(dir).length;
}
```

- [ ] **Step 3: 跑全量测试确认没破坏 store**

Run: `npm test`
Expected: PASS（`src/store/optimize.test.js` 不受影响，新函数是纯增量）。

---

## Task 6：召回阶段排除已豁免候选

**Files:**
- Modify: `src/features/project-checkup/audit-engine.logic.js`（文件末尾加两个导出）
- Modify: `src/features/project-checkup/audit-engine.js:164-204`（`runAudit`）
- Test: `src/features/project-checkup/audit-engine.logic.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/features/project-checkup/audit-engine.logic.test.js` 末尾追加（顶部 import 列表加上 `weightedCodesOf, excludeIgnoredCandidates`）：

```js
const dimFixture = {
  id: 'structure',
  verdicts: {
    violation: { weight: 9, code: 'A1_DEP_VIOLATION', severity: 'error' },
    smell: { weight: 3, code: 'A2_DEP_SMELL', severity: 'warn' },
    acceptable: { weight: 0 },
  },
};

test('weightedCodesOf 只取会产生 issue 的档位', () => {
  // weight 为 0 的 acceptable 档不产出 issue，也就无从豁免
  assert.deepEqual(weightedCodesOf(dimFixture).sort(), ['A1_DEP_VIOLATION', 'A2_DEP_SMELL']);
});

test('有权重 code 全部被豁免时，该文件的候选被剔除（省额度）', () => {
  const candidates = [{ file: 'src/a.js', line: 1 }, { file: 'src/b.js', line: 2 }];
  const ignores = [
    { dim: 'structure', code: 'A1_DEP_VIOLATION', file: 'src/a.js' },
    { dim: 'structure', code: 'A2_DEP_SMELL', file: 'src/a.js' },
  ];
  const out = excludeIgnoredCandidates(candidates, dimFixture, ignores);
  assert.deepEqual(out.map((c) => c.file), ['src/b.js']);
});

test('只豁免了部分 code 时候选必须保留', () => {
  // 剔除了就等于连没被豁免的那类问题也不查了 —— 那是静默漏报，比多烧一次额度糟得多
  const candidates = [{ file: 'src/a.js', line: 1 }];
  const ignores = [{ dim: 'structure', code: 'A1_DEP_VIOLATION', file: 'src/a.js' }];
  assert.equal(excludeIgnoredCandidates(candidates, dimFixture, ignores).length, 1);
});

test('别的维度的豁免不影响本维度', () => {
  const candidates = [{ file: 'src/a.js', line: 1 }];
  const ignores = [
    { dim: 'complexity', code: 'A1_DEP_VIOLATION', file: 'src/a.js' },
    { dim: 'complexity', code: 'A2_DEP_SMELL', file: 'src/a.js' },
  ];
  assert.equal(excludeIgnoredCandidates(candidates, dimFixture, ignores).length, 1);
});

test('没有豁免记录时原样返回同一个数组引用', () => {
  const candidates = [{ file: 'src/a.js', line: 1 }];
  assert.equal(excludeIgnoredCandidates(candidates, dimFixture, []), candidates);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-checkup/audit-engine.logic.test.js`
Expected: FAIL —— `weightedCodesOf is not a function`（import 报错）。

- [ ] **Step 3: 实现两个纯函数**

在 `src/features/project-checkup/audit-engine.logic.js` 顶部 import 区加：

```js
import { ignoredCodesFor } from './ignore.logic.js';
```

在文件末尾追加：

```js
/**
 * 这个维度里「会产生 issue 的 code」集合。
 *
 * 注册表的 `verdicts` 同时是校验白名单、扣分表、issue 码表（见 registry.js 的字段契约），
 * 其中 `weight` 为 0 的档位（`OK`）不产出 issue —— 它们也就无从被豁免。
 */
export function weightedCodesOf(dim) {
  return Object.values(dim?.verdicts || {})
    .filter((v) => v?.weight && v.code)
    .map((v) => v.code);
}

/**
 * 召回后剔除「已被完全豁免」的候选，让它们连 LLM 都不用送 —— 这是豁免机制省额度的那一半。
 *
 * ## 为什么规则是「全部 code 都被豁免才剔除」
 *
 * 豁免键含 `code`，而召回时**还不知道 code**：code 是判定的产物，候选阶段只有文件和位置。
 * 所以只能反过来问：这个文件上被豁免的 code，是否已经覆盖了本维度全部会出 issue 的 code？
 *   - 覆盖了 → 送去判也只会得到已被豁免的结论，纯属烧额度，剔除；
 *   - 没覆盖 → 必须保留。剔除就等于连没被豁免的那类问题也不查了，那是静默漏报。
 *
 * 实践含义：用户要把一个文件从某维度里彻底免掉，通常得点两次「这不是问题」
 * （比如 structure 的 violation 和 smell 各一次）。第一次只是不显示，第二次才真省额度。
 *
 * @param {Array} candidates 召回器产出的候选
 * @param {object} dim 维度声明
 * @param {Array} ignores 该项目的豁免记录
 * @returns {Array} 零豁免时返回传入的同一个数组引用（最常见路径，不产生垃圾）
 */
export function excludeIgnoredCandidates(candidates, dim, ignores) {
  const list = Array.isArray(candidates) ? candidates : [];
  const rules = (Array.isArray(ignores) ? ignores : []).filter((r) => r?.dim === dim?.id);
  if (!rules.length || !list.length) return list;

  const codes = weightedCodesOf(dim);
  if (!codes.length) return list;

  return list.filter((c) => {
    const ignored = ignoredCodesFor(dim.id, c.file, rules);
    return !codes.every((code) => ignored.has(code));
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-checkup/audit-engine.logic.test.js`
Expected: PASS。

- [ ] **Step 5: 接进 `runAudit`**

`src/features/project-checkup/audit-engine.js`：

顶部 import 加 `excludeIgnoredCandidates`：

```js
import {
  normalizeRecall, buildSystemPrompt, buildPrompt, validateVerdicts,
  reanchor, evaluateAudit, chunk, excludeIgnoredCandidates,
} from './audit-engine.logic.js';
```

`runAudit` 的 JSDoc 加一行参数：

```js
 * @param {Array} [opts.ignores] 该项目的豁免记录。命中「全部有权重 code 都被豁免」的文件，
 *   其候选在这里就被剔除，连 LLM 都不送
```

签名与召回后的处理改为：

```js
export async function runAudit(dim, evidence, {
  cache = null, force = false, signal, onProgress, ignores = [],
} = {}) {
```

把 `const { candidates, sharedContext, na } = recalled;` 这一行替换为：

```js
  const { candidates: recalledCandidates, sharedContext, na } = recalled;
  // 豁免排除放在召回之后、判分之前：候选数变少 → 分数跟着变，issue 与分数口径天然一致。
  // 放到判定之后再滤就只能滤掉 issue，分数仍按未排除的候选算，两者会打架
  const candidates = excludeIgnoredCandidates(recalledCandidates, dim, ignores);
  if (candidates.length !== recalledCandidates.length) {
    logger.info('audit-engine', '按豁免清单剔除候选', {
      dim: dim.id, before: recalledCandidates.length, after: candidates.length,
    });
  }
```

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS。`ignores` 默认空数组，未传时行为完全不变。

---

## Task 7：编排层套用豁免（覆盖全 17 维）

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js`（import 区、`runCheckup`、`runAsyncDims`、`refreshStaticReport`）

> 编排层无法直测，正确性由 Task 4/6 的纯函数测试 + 手工验收第 3 条保证。

- [ ] **Step 1: 补 import 并加一个本地辅助函数**

`src/entrypoints/web/optimize-ops.js` 顶部 import 区加：

```js
import { getIgnores } from '../../features/project-checkup/ignore.js';
import { filterIgnoredIssues, appendIgnoreNote } from '../../features/project-checkup/ignore.logic.js';
```

在 `failedDim` 函数之后插入：

```js
/**
 * 走 audit 引擎的维度 id 集合。
 *
 * 用途只有一个：判断豁免之后**分数是否也跟着变了**。audit 维度在召回阶段就把候选剔除了，
 * 分数与 issue 口径一致；其余维度（四个专属检测器 + map / rules）只在这里滤 issue，
 * 分数仍是按未过滤的结论算的。两者必须对用户如实区分，否则就是「0 个问题却 72 分」的无解观感。
 */
const AUDIT_DIM_IDS = new Set(auditDimensions().map((d) => d.id));

/**
 * 把豁免清单套到一个维度结果上：滤掉被豁免的 issue，并在 reason 里留痕。
 *
 * 这是覆盖**全部 17 个维度**的那一道（audit 侧还有更前面的召回排除）。放在这里的理由：
 *   1. 四个专属检测器与两个静态维度不走召回器，只有这一处能拦；
 *   2. 它在指纹缓存的**出口**之后——缓存命中返回的是旧 result，一样会被过滤。
 */
function applyIgnores(key, dim, ignores) {
  if (!dim?.issues?.length || !ignores.length) return dim;
  const { kept, ignoredCount } = filterIgnoredIssues(key, dim.issues, ignores);
  if (!ignoredCount) return dim;
  return {
    ...dim,
    issues: kept,
    reason: appendIgnoreNote(dim.reason, ignoredCount, AUDIT_DIM_IDS.has(key)),
  };
}
```

- [ ] **Step 2: `runCheckup` 里覆盖同步维度（map / rules）**

同步维度在 `runStaticCheckup` 里就产出了，不经过 `land`，必须单独套一次。把 `runCheckup` 开头改为：

```js
async function runCheckup(dir, { force = false, ownsBusy = false, jobId = null } = {}) {
  // 先跑静态维度：目录非法会在这里抛，早于任何 LLM 调用 —— 不会为一个打错的路径白烧额度
  const report = runStaticCheckup(dir);

  // 同步维度（map / rules）不经过 land，豁免必须在这里单独套一次。
  // 漏了这一步的表现是：用户豁免了一条地图死链，下次体检它照样出现
  const ignores = getIgnores(dir);
  for (const key of Object.keys(report.dims)) {
    report.dims[key] = applyIgnores(key, report.dims[key], ignores);
  }
```

- [ ] **Step 3: `runAsyncDims` 里读一次清单并套到每个落地维度**

把 `runAsyncDims` 开头的 `const cache = getLlmCache(dir);` 改为：

```js
  const cache = getLlmCache(dir);
  // 整轮体检读一次就够：豁免是人工低频操作，一轮体检跑十几分钟，
  // 中途变更不必立刻生效（下一轮自然生效），但逐维度读盘 17 次是纯粹的浪费
  const ignores = getIgnores(dir);
```

把 audit 维度的 `runAudit` 调用加上 `ignores`：

```js
        settled: evidence
          ? wrap(() => runAudit(dim, evidence, {
            cache: cache[dim.id] || null,
            force,
            // 用户中止时立刻停掉，别再烧额度（audit 引擎逐批检查它）
            signal: job.signal,
            // 召回阶段就剔除已被完全豁免的文件——这是豁免省额度的那一半
            ignores,
            // 批级进度：维度要全部批次跑完才落地，19 批的维度会让卡片转圈二十多分钟。
            // 不推这个事件，用户就只能靠等来猜「是在跑还是死了」——实测已经误判过一次
            onProgress: (p) => emit(job, 'progress', p),
          }))
          : Promise.resolve({ ok: false, message: '项目取材失败，本维度未执行' }),
```

第一轮落地处（`plain.map` 里）改为：

```js
  await Promise.all(plain.map(async (t) => {
    const t0 = Date.now();
    const dim = applyIgnores(t.key, settleDim(dir, t.key, await t.settled), ignores);
    land(job, t.key, dim);
```

第二轮 augment 落地处改为：

```js
    const aug = out.ok ? toDim(out.r) : null;
    if (out.ok) saveLlmCache(dir, t.key, out.r.cacheEntry);
    land(job, t.augments, applyIgnores(t.augments, mergeAugmentDim(job.report.dims[t.augments], aug), ignores));
```

第三轮 holistic 落地处改为：

```js
    land(job, 'holistic', applyIgnores('holistic', h, ignores));
```

- [ ] **Step 4: `refreshStaticReport` 也要套**

优化结束与还原之后都会调它重算静态分，不套的话被豁免的 map / rules 问题会重新冒出来：

```js
function refreshStaticReport(dir) {
  const report = runStaticCheckup(dir);
  // 与 runCheckup 同一个理由：静态维度不经过 land，豁免必须在这里单独套
  const ignores = getIgnores(dir);
  for (const key of Object.keys(report.dims)) {
    report.dims[key] = applyIgnores(key, report.dims[key], ignores);
  }
  for (const key of LLM_DIM_KEYS) {
    if (report.dims[key]) report.dims[key].reason = '代码已变动，请重新体检以刷新 AI 分析';
  }
  recomputeReport(report);
  saveCheckup(dir, report);
  return report;
}
```

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: PASS。

---

## Task 8：豁免的三条 HTTP 接口

**Files:**
- Modify: `src/entrypoints/web/routes-optimize.js`
- Test: `src/entrypoints/web/routes-optimize.test.js`

- [ ] **Step 1: 写失败测试**

该文件已经起了一个**真实的 http server**（`test.before` 里 `createServer(...)`），并提供了 `get(pathname)` / `post(pathname, body)` 两个辅助与 `project(issues, opts)` 造临时项目目录。直接沿用它们，在文件末尾追加：

```js
test('豁免接口：登记 → 列出 → 撤销 的完整闭环', async () => {
  const dir = project();

  // 空清单也要回 200 + 空数组：前端据此渲染「没有豁免」，404 会被它当成请求失败
  const empty = await get(`/api/optimize/ignores?dir=${encodeURIComponent(dir)}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.items, []);

  const added = await post('/api/optimize/ignore', {
    dir, dim: 'map', code: 'M4_DEAD_LINK', file: 'CLAUDE.md',
    message: '死链 ./gone.md', note: '那份文档是故意删的，链接下个版本一起清',
  });
  assert.equal(added.status, 200);
  assert.equal(added.json.count, 1);

  const listed = await get(`/api/optimize/ignores?dir=${encodeURIComponent(dir)}`);
  assert.equal(listed.json.items.length, 1);
  assert.equal(listed.json.items[0].note, '那份文档是故意删的，链接下个版本一起清');

  // 副本必须落到项目里：它是这个功能「记录到一个单独的文档」的交付物
  const md = fs.readFileSync(path.join(dir, '.claude/optimize/IGNORED.md'), 'utf8');
  assert.match(md, /M4_DEAD_LINK/);
  assert.match(md, /那份文档是故意删的/);

  const removed = await post('/api/optimize/ignore/remove', {
    dir, dim: 'map', code: 'M4_DEAD_LINK', file: 'CLAUDE.md',
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.count, 0);
});

test('豁免登记缺 note 时回 400', async () => {
  // 空备注等于没记录 —— 三个月后没人知道为什么豁免。前端必填只是第一道，服务端也要卡
  const dir = project();
  const r = await post('/api/optimize/ignore', {
    dir, dim: 'map', code: 'M4_DEAD_LINK', file: 'CLAUDE.md', note: '   ',
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /为什么/);
});

test('豁免登记缺 dim / code / file 时回 400', async () => {
  const dir = project();
  const r = await post('/api/optimize/ignore', { dir, code: 'M4_DEAD_LINK', file: 'a.md', note: '理由' });
  assert.equal(r.status, 400);
});

test('撤销不存在的豁免不报错，返回剩余条数 0', async () => {
  // 用户在两个标签页各点一次撤销时会走到这里，报错只会让人以为出了问题
  const dir = project();
  const r = await post('/api/optimize/ignore/remove', {
    dir, dim: 'map', code: 'NOPE', file: 'a.md',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 0);
});
```

> **注意** `project()` 不传参数即造一个不含报告的空临时目录，正合本组用例（豁免不依赖报告存在）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-optimize.test.js`
Expected: FAIL —— 分发用例拿到 404。

- [ ] **Step 3: 实现三条 handler**

`src/entrypoints/web/routes-optimize.js` 顶部 import 加：

```js
import { getIgnores, addIgnore, removeIgnore } from '../../features/project-checkup/ignore.js';
```

在 `handleBusyHeal` 之后插入：

```js
// ==== GET /api/optimize/ignores?dir=xxx ====
// 「已豁免 N 项」面板的数据源
function handleIgnoreList(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  sendJson(res, 200, { items: getIgnores(dir) });
}

// ==== POST /api/optimize/ignore {dir, dim, code, file, message, note} ====
// 记一条「这不是问题」。note 必填：空备注等于没记录，下次没人知道为什么豁免——
// 前端必填只是第一道，这里是第二道
function handleIgnoreAdd(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    const dim = str(data.dim);
    const code = str(data.code);
    const file = str(data.file);
    const note = str(data.note).trim();
    if (!dir || !dim || !code || !file) {
      return sendJson(res, 400, { error: '缺少 dir / dim / code / file 参数' });
    }
    if (!note) return sendJson(res, 400, { error: '请填写「为什么这不是问题」' });

    try {
      const count = addIgnore(dir, { dim, code, file, message: str(data.message), note });
      return sendJson(res, 200, { ok: true, count });
    } catch (e) {
      logger.warn('optimize', '记录豁免失败', { dir, dim, code, err: e.message });
      return sendJson(res, 400, { error: e.message });
    }
  });
}

// ==== POST /api/optimize/ignore/remove {dir, dim, code, file} ====
// 撤销一条豁免。用 POST 子路径而非 DELETE + body：本文件既有路由全是 GET/POST，
// 且 DELETE 带 body 在部分中间层会被丢弃。与 /api/optimize/checkup/cancel 同一范式
function handleIgnoreRemove(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    const dim = str(data.dim);
    const code = str(data.code);
    const file = str(data.file);
    if (!dir || !dim || !code || !file) {
      return sendJson(res, 400, { error: '缺少 dir / dim / code / file 参数' });
    }
    try {
      const count = removeIgnore(dir, { dim, code, file });
      return sendJson(res, 200, { ok: true, count });
    } catch (e) {
      logger.warn('optimize', '撤销豁免失败', { dir, dim, code, err: e.message });
      return sendJson(res, 400, { error: e.message });
    }
  });
}
```

- [ ] **Step 4: 注册路由**

在 `handleOptimizeRoutes` 里，`/api/optimize/busy/heal` 那条之后插入：

```js
  if (url.pathname === '/api/optimize/ignores' && req.method === 'GET') {
    return handleIgnoreList(res, url);
  }
  // 精确路由排在前：本文件用的是 pathname === 精确比较，理论上不会遮蔽，
  // 但既有代码已为 checkup/cancel 留下同样的顺序约定，保持一致以免下一个人改成前缀匹配时踩坑
  if (url.pathname === '/api/optimize/ignore/remove' && req.method === 'POST') {
    return handleIgnoreRemove(req, res);
  }
  if (url.pathname === '/api/optimize/ignore' && req.method === 'POST') {
    return handleIgnoreAdd(req, res);
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-optimize.test.js`
Expected: PASS。

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS。

---

## Task 9：`dimListFrom` 附带稳定的 `planId`

**Files:**
- Modify: `public/js/optimize-view.logic.js:135-158`（`dimListFrom`）
- Test: `public/js/optimize-view.logic.test.js`

> 这是整个前端改造的地基，也是本计划**最容易出事的一处**：搞错就是「修复动作打到不相干的文件上」。

- [ ] **Step 1: 写失败测试**

在 `public/js/optimize-view.logic.test.js` 末尾追加：

```js
test('planId 指向报告里的原始下标，不受展示排序影响（核心回归）', () => {
  // 计划项 id 是 `<dim>#<报告 issues 数组下标>`，后端 resolveSelection 按它取真实 issue。
  // 而卡片按严重度排序展示 —— 用渲染序号拼 id 就会把修复动作打到不相干的文件上。
  const report = {
    dims: {
      map: {
        status: 'done',
        score: 60,
        issues: [
          { severity: 'info', file: 'z.md', line: 1, message: '轻', code: 'M3_STALE_MAP' },
          { severity: 'error', file: 'a.md', line: 2, message: '重', code: 'M4_DEAD_LINK' },
        ],
      },
    },
  };

  const mapDim = dimListFrom(report).find((d) => d.key === 'map');
  // 排序把 error 提到了最前，它在报告里的原始下标是 1
  assert.equal(mapDim.issues[0].severity, 'error');
  assert.equal(mapDim.issues[0].planId, 'map#1');
  assert.equal(mapDim.issues[1].planId, 'map#0');
});

test('planId 的维度前缀用维度 key', () => {
  const report = {
    dims: { complexity: { status: 'done', issues: [{ severity: 'warn', file: 'a.js', line: 1, message: 'x' }] } },
  };
  const dim = dimListFrom(report).find((d) => d.key === 'complexity');
  assert.equal(dim.issues[0].planId, 'complexity#0');
});

test('没有 issues 的维度不会崩', () => {
  const dim = dimListFrom({ dims: { map: { status: 'na' } } }).find((d) => d.key === 'map');
  assert.deepEqual(dim.issues, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/optimize-view.logic.test.js`
Expected: FAIL —— `planId` 为 `undefined`。

- [ ] **Step 3: 改 `dimListFrom`**

把 `public/js/optimize-view.logic.js` 的 `dimListFrom` 改为：

```js
/**
 * 把报告摊平成 UI 需要的维度列表。
 *
 * selectable 的含义是「这个维度能不能参与一键优化」——只有跑出**完整**结果的才行。
 * partial 有分数但结论不完整（LLM 只判了一部分/没判成），拿它去驱动自动修改会漏改错改，
 * 所以照样不可勾选，只把分数亮出来并标注原因。
 *
 * busy 专给 analyzing：异步维度是回填的，卡片要先转圈占位，等 SSE 送来结果再变成分数。
 *
 * ## 为什么 planId 必须在排序**之前**打
 *
 * 修复计划项的 id 是 `<dim>#<报告 issues 数组里的下标>`，后端 `resolveSelection`
 * 按这个下标去报告里取真实的 issue（那是安全边界：前端传的下标只用于定位，
 * file / line 一律以后端报告为准）。而卡片是按严重度排序展示的——
 * 用渲染序号拼 id 会让下标整体错位，后果是**修复动作打到不相干的文件上**。
 * 所以下标必须在 `sortIssues` 之前就固定下来，随 issue 一起被排序带走。
 */
export function dimListFrom(report) {
  return DIM_META.map((meta) => {
    const d = report?.dims?.[meta.key];
    const status = d?.status || 'idle';
    const hasScore = typeof d?.score === 'number';
    const rawIssues = Array.isArray(d?.issues) ? d.issues : [];
    const tagged = rawIssues.map((it, index) => ({ ...it, planId: `${meta.key}#${index}` }));
    return {
      ...meta,
      status,
      score: hasScore ? d.score : null,
      scoreText: hasScore ? String(d.score) : '--',
      issueCount: rawIssues.length,
      issues: sortIssues(tagged),
      reason: d?.reason || '',
      // 只有 holistic 有：行动计划，卡片里要单独渲染成一块
      plan: d?.plan || null,
      busy: status === 'analyzing',
      // 中止与失败必须分开：前者是用户自己停的、随时可续，后者要看原因。
      // 混为一谈会把「你停的」显示成「失败了」——上一轮刚修掉的就是这类误导
      cancelled: status === 'cancelled',
      note: status === 'partial' ? '未深度分析，分数仅供参考且不计入总分' : '',
      selectable: status === 'done',
    };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/optimize-view.logic.test.js`
Expected: PASS，含既有的前后端维度表一致性用例。

---

## Task 10：勾选上移 + 计划树移除 + 折叠态修复

**Files:**
- Modify: `public/index.html:777`（删 `#optPlan`）
- Modify: `public/js/optimize-view.js`（多处，见下）

> 需求 5 与需求 6 同属 issue 行/卡片渲染的改造，分开做会导致同一块 DOM 重排两次。

- [ ] **Step 1: 删掉 HTML 里的计划树容器**

`public/index.html` 第 777 行整行删除：

```html
            <div class="opt-plan" id="optPlan"></div>
```

- [ ] **Step 2: 加两个折叠态 Set 与一个计划索引**

`public/js/optimize-view.js` 的模块级状态区（`let dimProgress = new Map();` 之后）插入：

```js
/**
 * 用户手动展开的维度卡片 key。
 *
 * **必须显式持有，不能从 selected 之类的状态现推。** 这正是「勾选时莫名收起/展开」
 * 那个缺陷的根因：原实现每次 render 都按「这个维度有没有勾选项」重新决定折叠，
 * 而任何勾选都会触发 render —— 于是勾掉最后一条会连带收起、域级全选会连带展开。
 * 折叠是**用户意图**，只有用户点击才该改变它。
 */
let openCards = new Set();
/** 用户手动折叠的域 key。理由同 openCards */
let foldedGroups = new Set();
```

- [ ] **Step 3: 改 `renderDims`，折叠态读 `foldedGroups`**

```js
function renderDims(report) {
  const host = $('#optDims');
  host.textContent = '';

  for (const group of groupDims(dimListFrom(report))) {
    const section = el('div', 'opt-group');
    // 折叠态读显式持有的 Set，render 只读不写（写只发生在下面的 click handler 里）
    if (foldedGroups.has(group.key)) section.classList.add('is-folded');

    const head = el('div', 'opt-group-head');
    head.appendChild(el('span', 'opt-group-label', group.label));
    head.appendChild(el('span', 'opt-group-sum', groupSummary(group.dims)));
    // 组标题可折叠：17 个维度全展开是一面墙，用户往往只关心一两个域。
    // 折叠后靠 groupSummary 仍能看出这个域好不好，不是把信息藏起来
    head.addEventListener('click', () => {
      if (foldedGroups.has(group.key)) foldedGroups.delete(group.key);
      else foldedGroups.add(group.key);
      section.classList.toggle('is-folded', foldedGroups.has(group.key));
    });
    section.appendChild(head);

    const body = el('div', 'opt-group-body');
    renderDimCards(body, group.dims);
    section.appendChild(body);

    host.appendChild(section);
  }
}
```

- [ ] **Step 4: 加计划索引辅助函数**

在 `renderDimCards` 之前插入：

```js
/** planId → 计划项。issue 行要靠它决定能不能勾、显示什么动作与风险标签 */
function planItemIndex() {
  return new Map(plan.items.map((i) => [i.id, i]));
}

/** 某维度在当前计划里的全部 planId（维度头部三态复选框的作用域） */
function planIdsOfDim(dimKey) {
  return plan.items.filter((i) => i.dim === dimKey).map((i) => i.id);
}

/**
 * 勾选变化后的**定点**刷新：只改复选框状态、计数与顶部按钮，不重建任何 DOM。
 *
 * 为什么不直接 render()：本仓库实测一次体检 265 项问题，全量重建意味着每点一次复选框
 * 就重造几百个节点——不只是卡顿，还会把用户正在看的展开状态和滚动位置一起扰乱。
 * （批级进度事件早就为同一个理由做过定点更新，见 openCheckupStream 里的 progress 处理。）
 */
function refreshSelectionUi() {
  for (const cb of document.querySelectorAll('#optDims input[data-plan-id]')) {
    cb.checked = selected.has(cb.dataset.planId);
  }
  for (const cb of document.querySelectorAll('#optDims input[data-dim-check]')) {
    const ids = planIdsOfDim(cb.dataset.dimCheck);
    const state = nodeCheckState(ids, selected);
    cb.checked = state === 'all';
    cb.indeterminate = state === 'some';
  }
  for (const label of document.querySelectorAll('#optDims [data-dim-count]')) {
    const ids = planIdsOfDim(label.dataset.dimCount);
    label.textContent = `已勾 ${ids.filter((id) => selected.has(id)).length}/${ids.length}`;
  }
  refreshButtons();
}
```

- [ ] **Step 5: 改 `renderIssues`，每行加复选框**

```js
/**
 * 渲染一个维度的问题清单。
 *
 * 每条前面带复选框——勾选从底部那棵独立的「修复计划树」上移到了这里。
 * 一处勾选、一处真相：两处都能勾会让用户不知道以哪个为准，而同一状态两处渲染的
 * 同步成本长期看远高于横向筛选带来的便利。
 *
 * 不在计划里的 issue（维度 status 非 done，或该 issue 没有可用的修复策略）
 * 渲染一个等宽占位而不是复选框 —— 少了占位，有勾和没勾的行会左右错开。
 */
function renderIssues(box, dimKey, issues) {
  const byId = planItemIndex();

  for (const it of issues) {
    const row = el('div', 'opt-issue');
    const item = byId.get(it.planId);

    if (item) {
      const isHandled = handled.has(item.id);
      if (isHandled) row.classList.add('is-handled');
      const cb = planCheckbox(selected.has(item.id) ? 'all' : 'none', () => {
        selected = toggleNode([item.id], selected);
        refreshSelectionUi();
      });
      cb.dataset.planId = item.id;
      // 已处理的不可再勾：防止用户在同一轮里重复修同一条
      if (isHandled) cb.disabled = true;
      row.appendChild(cb);
    } else {
      row.appendChild(el('span', 'opt-issue-nocheck'));
    }

    row.appendChild(el('span', `opt-issue-sev sev-${it.severity}`, it.severity));
    row.appendChild(el('span', 'opt-issue-loc', it.line ? `${it.file}:${it.line}` : it.file));
    const msg = el('span', 'opt-issue-msg', it.message);
    msg.title = it.message; // 超宽由 CSS 截断，title 兜住全文
    row.appendChild(msg);

    // 动作与风险是同一来源（策略）的两面，合成一个标签：分成两个会让人以为是两种属性
    if (item) {
      row.appendChild(el('span', `opt-tag risk-${item.risk}`, `${item.action}·${RISK_LABEL[item.risk] || item.risk}`));
    }
    if (item && handled.has(item.id)) row.appendChild(el('span', 'opt-plan-handled', '本轮已处理'));

    box.appendChild(row);
  }
}
```

- [ ] **Step 6: 改 `renderDimCards`，头部加三态勾选与计数、展开态读 `openCards`**

```js
function renderDimCards(host, dims) {
  for (const d of dims) {
    const card = el('div', 'opt-dim');
    card.dataset.dim = d.key;
    if (d.status === 'disabled') card.classList.add('is-disabled');
    if (d.busy) card.classList.add('is-busy');

    const head = el('div', 'opt-dim-head');

    // 维度级三态勾选：全选 / 部分 / 无。只有该维度在计划里有条目时才出现
    const dimIds = planIdsOfDim(d.key);
    if (dimIds.length) {
      const cb = planCheckbox(nodeCheckState(dimIds, selected), () => {
        selected = toggleNode(dimIds, selected);
        refreshSelectionUi();
      });
      cb.dataset.dimCheck = d.key;
      head.appendChild(cb);
    } else {
      head.appendChild(el('span', 'opt-issue-nocheck'));
    }

    head.appendChild(el('span', 'opt-dim-label', d.label));

    // analyzing / pending / disabled / error 用 reason 说明为什么没分，避免用户以为坏了；
    // partial 有分数但结论不完整，用 note 标注出来别让人当成可信分数
    const hintText = d.status === 'done' ? d.hint : (d.note || d.reason || d.hint);
    const hintEl = el('span', 'opt-dim-hint', progressText(d) || hintText);
    // 打上 data-dim：批级进度事件来得很频繁（每批一次），靠它定点改这一个节点，
    // 不必为每个进度事件重建全部 17 张卡片
    hintEl.dataset.dimHint = d.key;
    head.appendChild(hintEl);

    if (dimIds.length) {
      const count = el('span', 'opt-dim-count', `已勾 ${dimIds.filter((id) => selected.has(id)).length}/${dimIds.length}`);
      count.dataset.dimCount = d.key;
      head.appendChild(count);
    }

    if (d.issueCount > 0) head.appendChild(el('span', 'opt-dim-badge', `${d.issueCount} 项`));
    // analyzing 时分数位换成转圈，等 SSE 送来结果再变成数字
    if (d.busy) head.appendChild(el('span', 'opt-dim-spin'));
    else head.appendChild(el('span', 'opt-dim-score', d.scoreText));

    // 点头部展开问题清单。展开态记进 openCards —— 否则下一次 render 就丢了
    const expandable = d.issueCount > 0 || !!d.plan;
    head.addEventListener('click', (e) => {
      // 复选框有自己的 stopPropagation，这里再挡一道 label 等可能的冒泡来源
      if (e.target.closest('input')) return;
      if (!expandable) return;
      if (openCards.has(d.key)) openCards.delete(d.key);
      else openCards.add(d.key);
      card.classList.toggle('is-open', openCards.has(d.key));
    });

    card.appendChild(head);

    if (expandable) {
      const box = el('div', 'opt-issues');
      // 计划在前、逐条 issue 在后：计划是「先做哪件」，issue 是「哪里有问题」。
      // 反序会让用户先读完 17 条问题才看到该从哪下手
      if (d.plan) renderPlan(box, d.plan);
      if (d.issueCount > 0) renderIssues(box, d.key, d.issues);
      card.appendChild(box);
    }

    if (expandable && openCards.has(d.key)) card.classList.add('is-open');

    host.appendChild(card);
  }
}
```

- [ ] **Step 7: 删掉计划树的全部代码**

删除以下三个函数及其上方注释块（`// ==================== 修复计划勾选树 ====================` 这一段里，**保留 `planCheckbox`**，它现在被 issue 行和维度头部复用）：

- `categoryLabel(key)`
- `renderPlanItem(host, item)`
- `renderFixPlan()`

把那段分隔注释改为：

```js
// ==================== 勾选控件 ====================
```

并把 `planCheckbox` 的文档补上新用途：

```js
/**
 * 造一个项目风格的复选框。issue 行与维度头部共用。
 *
 * 用 `.pretty-check`（项目既有的样式化复选框）而不是裸 `input[type=checkbox]`——
 * 后者会渲染成浏览器原生控件，与整个界面的视觉语言不符。
 * 三态由 `checked` / `indeterminate` 两个原生属性表达，CSS 已为两者都定义了样式。
 */
```

同时删掉 `optimize-plan.logic.js` 的 `groupPlan` import（它只被删掉的 `renderFixPlan` 用），import 语句改为：

```js
import {
  defaultSelection, nodeCheckState, toggleNode, topButtonsState, riskyPicks, RISK_LABEL,
} from './optimize-plan.logic.js';
```

> `groupPlan` 本身保留在 `optimize-plan.logic.js` 里不删——它有自己的单测，删掉会连带改测试，而留着一个未被引用的纯函数导出没有成本。

- [ ] **Step 8: `render()` 去掉计划树调用**

```js
function render() {
  renderScore(currentReport);
  renderDims(currentReport);
  refreshButtons();
}
```

- [ ] **Step 9: `loadPlan` 里重置并初始化折叠态**

把 `loadPlan` 的收尾两行改为：

```js
  selected = defaultSelection(plan.items); // 默认只勾低风险
  handled = new Set();
  // 折叠态跟着新计划重来。初始值取「有勾选项的维度」——低风险默认勾选，
  // 所以一进来展开的正好是本轮会动的那些（这是原计划树的好行为，保留下来）。
  // 之后它只由用户点击改变，不再被勾选影响——那正是「勾选时莫名收起/展开」的根因
  openCards = new Set(plan.items.filter((i) => selected.has(i.id)).map((i) => i.dim));
  // 整体评估默认展开：它是「先看哪儿」的答案，要用户多点一下才看到就白搭了
  openCards.add('holistic');
  foldedGroups = new Set();
```

- [ ] **Step 10: 手工验证**

启动服务 `npm start`，打开项目优化面板，对一个已有报告的项目：

1. 展开一个维度 → 勾掉它最后一个勾选项 → **卡片必须保持展开**（这是需求 6 的核心验收）；
2. 点维度头部三态框全选 → **其他维度不得莫名展开**；
3. 折叠一个域 → 任意勾选 → **该域保持折叠**；
4. 页面底部不再有独立的修复计划树；
5. 顶部「一键修复（N 项）」的 N 随勾选实时变化。

---

## Task 11：「这不是问题」交互

**Files:**
- Modify: `public/index.html`（分数卡区加「已豁免」入口）
- Modify: `public/js/optimize-view.js`

- [ ] **Step 1: HTML 加入口**

`public/index.html` 的 `.opt-score-side` 块里，`optLastAt` 之后加一行：

```html
                <button class="opt-ignored-entry" id="optIgnoredEntry" hidden></button>
```

- [ ] **Step 2: 引入 `textareaDialog`**

`public/js/optimize-view.js` 顶部 import 改为：

```js
import { confirmDialog, textareaDialog } from './ui.js';
```

- [ ] **Step 3: 加豁免相关状态与函数**

在 `renderIssues` 之前插入：

```js
/** 当前项目的豁免清单（`/api/optimize/ignores` 拉的），只用于「已豁免 N 项」入口与面板 */
let ignoredItems = [];

/** 拉一次豁免清单并刷新入口按钮。失败静默——它是附加信息，不该挡住看报告 */
async function loadIgnored(dir) {
  if (!dir) { ignoredItems = []; renderIgnoredEntry(); return; }
  try {
    const r = await fetch(`/api/optimize/ignores?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    ignoredItems = Array.isArray(data.items) ? data.items : [];
  } catch {
    ignoredItems = [];
  }
  renderIgnoredEntry();
}

function renderIgnoredEntry() {
  const btn = $('#optIgnoredEntry');
  if (!btn) return;
  btn.hidden = !ignoredItems.length;
  btn.textContent = `已豁免 ${ignoredItems.length} 项`;
  btn.title = '查看并撤销「这不是问题」的记录';
}

/**
 * 把一条 issue 标记为「这不是问题」。
 *
 * 备注必填：空备注等于没记录 —— 三个月后翻到 IGNORED.md 的人（包括提交者自己）
 * 无从判断这条豁免还成不成立，那样的记录比没有更糟，因为它看起来像个结论。
 */
async function ignoreIssue(dimKey, issue, row) {
  const where = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  const note = await textareaDialog({
    title: '这不是问题',
    message: `${where}\n${issue.message}\n\n说明为什么这不算问题。下次体检会跳过它，理由会记进 .claude/optimize/IGNORED.md。`,
    placeholder: '例如：这是历史商城遗留的兼容层，下个版本整体删除，现在解耦不划算',
    confirmText: '记下并忽略',
  });
  // null = 取消；空白 = 没写理由，两者都不该落盘
  if (note === null || !note.trim()) return;

  const { ok, data } = await postJson('/api/optimize/ignore', {
    dir: currentDir,
    dim: dimKey,
    code: issue.code,
    file: issue.file,
    message: issue.message,
    note: note.trim(),
  });
  if (!ok) { toast.error(data.error || '记录失败'); return; }

  // 就地移除而不是整体 render：此刻后端报告里那条 issue 还在
  // （过滤发生在下一次体检），重渲染会把它原样画回来
  row.remove();
  await loadIgnored(currentDir);
  toast.success('已记下，下次体检会跳过这一条');
}

/** 「已豁免 N 项」面板：逐条列出，可撤销 */
async function openIgnoredPanel() {
  if (!ignoredItems.length) return;
  const lines = ignoredItems.slice(0, 20).map((it) => `· ${it.file}（${it.code}）—— ${it.note}`);
  const more = ignoredItems.length > 20 ? `\n…另有 ${ignoredItems.length - 20} 项，完整清单见 .claude/optimize/IGNORED.md` : '';
  const go = await confirmDialog({
    title: `已豁免 ${ignoredItems.length} 项`,
    message: `${lines.join('\n')}${more}\n\n撤销全部豁免后，这些问题会在下次体检重新出现。`,
    confirmText: '全部撤销',
    cancelText: '关闭',
    danger: true,
  });
  if (!go) return;

  for (const it of ignoredItems) {
    await postJson('/api/optimize/ignore/remove', {
      dir: currentDir, dim: it.dim, code: it.code, file: it.file,
    });
  }
  await loadIgnored(currentDir);
  toast.success('已撤销全部豁免，重新体检后这些问题会重新出现');
}
```

> **取舍说明**（写进代码注释里）：「已豁免」面板复用 `confirmDialog` 做只读列表 + 全部撤销，而不是做一个可逐条撤销的自定义弹窗。逐条撤销的价值在这里很低——用户真要精修就去改 `IGNORED.md` 旁边的真相源或重新豁免；为它造一套新弹窗的代价不成比例。YAGNI。

- [ ] **Step 4: issue 行加按钮**

在 Task 10 Step 5 写好的 `renderIssues` 里，`box.appendChild(row);` **之前**（即整行的最后一个子元素）插入：

```js
    // 「这不是问题」：行尾最后一个元素，次要样式（hover 才明显），不跟勾选框抢注意力。
    // 必须是**最后**追加：它的 margin-left:auto 会吃掉剩余空间把自己顶到最右，
    // 放在「本轮已处理」之前会把那个标记挤到按钮右边去
    const ignoreBtn = el('button', 'opt-issue-ignore', '这不是问题');
    ignoreBtn.title = '标记为「这不是问题」并填写理由，下次体检会跳过';
    ignoreBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 别触发所在卡片的折叠
      ignoreIssue(dimKey, it, row);
    });
    row.appendChild(ignoreBtn);
```

- [ ] **Step 5: 接上生命周期**

`loadReport` 里，`await loadPlan(dir);` 之后加一行：

```js
    await loadIgnored(dir);
```

`loadReport` 的空目录分支（`if (!dir) {` 那段）里，`handled = new Set();` 之后加：

```js
    ignoredItems = [];
```

`initOptimizePanel` 的一次性绑定区加：

```js
    $('#optIgnoredEntry')?.addEventListener('click', openIgnoredPanel);
```

- [ ] **Step 6: 手工验证**

1. 对任一 issue 点「这不是问题」→ 弹窗出现，**不填理由点确认无反应**（不落盘）；
2. 填理由确认 → 该行消失、toast 提示、顶部出现「已豁免 1 项」；
3. 打开项目目录，确认 `.claude/optimize/IGNORED.md` 已生成且含备注原文；
4. 重新体检 → 该条问题不再出现；
5. 点「已豁免 N 项」→ 全部撤销 → 重新体检 → 问题重新出现。

---

## Task 12：侧栏「体检中 / 修复中」标签

**Files:**
- Modify: `public/index.html:214`（`#toolOptimize` 标题）
- Create: `public/js/optimize-badge.js`
- Modify: `public/js/optimize-view.js`（四处流开关联动）
- Modify: `public/js/chat.js:25`（绑定）、`:2916`（cwd 变更）

- [ ] **Step 1: HTML 加标签位**

`public/index.html` 第 214 行改为：

```html
              <span class="tool-item-title">项目优化<span class="tool-item-tag" id="optToolTag" hidden></span></span>
```

- [ ] **Step 2: 实现 badge 模块**

创建 `public/js/optimize-badge.js`：

```js
/**
 * 侧栏「项目优化」卡片上的状态标签（体检中 / 修复中）。
 *
 * ## 为什么独立成一个模块
 *
 * 这块状态要在**面板关闭时**也保持正确 —— 体检跑十几分钟，用户多半会切走。
 * 而 `optimize-view.js` 已经上千行，且它的状态是围绕「面板打开着」组织的。
 * 拆开之后两者的职责很清楚：面板管面板，这里只管侧栏那一个小标签。
 *
 * ## 两条驱动路径
 *
 * 1. 面板开着 → `optimize-view.js` 在四个流开关处直接调 `setOptimizeBadge`，零延迟；
 * 2. 面板没开 / 刚刷新 → `probeOptimizeBadge` 探测一次 `/api/optimize/report` 的 busy，
 *    **只有探测到活跃任务时才开轮询**，任务结束立刻停。
 *
 * 不做常驻轮询：体检是低频操作（一天可能一次），给它挂一条永久心跳不值当。
 */

const POLL_MS = 30_000;

const LABEL = { checkup: '体检中', fix: '修复中' };

let timer = null;
let pollDir = '';
/**
 * 当前项目目录读取器，由 chat.js 经 `bindOptimizeBadgeCwd` 注入。
 *
 * 与 `bindOptimizeCwd` / `bindGitSelector` 同一范式：**惰性读**。
 * chat.js 的 `let cwd` 在模块顶层那几行绑定语句之后才初始化，
 * 直接取值会撞 TDZ（既有代码的注释里明写了这一点）。
 */
let _getCwd = () => '';

/** 注入当前项目目录读取器（chat.js 在 import 后立即调用） */
export function bindOptimizeBadgeCwd({ getCwd }) {
  _getCwd = getCwd || (() => '');
}

function node() {
  return document.getElementById('optToolTag');
}

/**
 * 直接设置标签。
 * @param {'checkup'|'fix'|''} kind 空串即摘掉标签
 */
export function setOptimizeBadge(kind) {
  const el = node();
  if (!el) return;
  const text = LABEL[kind] || '';
  el.textContent = text;
  el.hidden = !text;
}

function stopPoll() {
  if (timer) clearInterval(timer);
  timer = null;
  pollDir = '';
}

async function pollOnce(dir) {
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    const busy = data?.busy;
    // alive 为 false = 占用记录还在但任务已死（服务重启过），不该继续显示「体检中」
    if (busy?.alive && LABEL[busy.kind]) {
      setOptimizeBadge(busy.kind);
      return true;
    }
  } catch {
    // 网络抖动不该让标签乱跳，保持现状等下一轮
    return true;
  }
  setOptimizeBadge('');
  return false;
}

/**
 * 探测一次某项目的占用状态；有活跃任务就开轮询，没有就收手。
 *
 * 换目录时重复调用是安全的：旧轮询会先被停掉。
 */
export async function probeOptimizeBadge(dir) {
  stopPoll();
  setOptimizeBadge('');
  if (!dir) return;

  const running = await pollOnce(dir);
  if (!running) return;

  pollDir = dir;
  timer = setInterval(async () => {
    // 目录在轮询期间被换掉的话，这一轮的结果已经不作数了
    if (pollDir !== dir) return;
    const still = await pollOnce(dir);
    if (!still) stopPoll();
  }, POLL_MS);
}

/**
 * 按当前项目探测一次。给「展开工具列表」这类拿不到 cwd 的调用方用。
 *
 * 挂在工具列表展开的时机上，正好解决「刷新页面后标签不见了」——
 * 页面刷新会清掉内存里的 SSE 状态，而用户要看到这张卡片必然先展开工具列表，
 * 那一刻探测既及时又天然节流（不展开就不请求）。
 */
export function refreshOptimizeBadge() {
  return probeOptimizeBadge(_getCwd());
}
```

- [ ] **Step 3: `optimize-view.js` 四处联动**

顶部 import 加：

```js
import { setOptimizeBadge, probeOptimizeBadge } from './optimize-badge.js';
```

在 `openCheckupStream(checkupId)` 里，`checkupJobId = checkupId;` 之后加：

```js
  setOptimizeBadge('checkup'); // 面板开着时直接驱动侧栏标签，不必等轮询
```

在 `closeCheckupStream()` 的 `dimProgress = new Map();` 之后加：

```js
  setOptimizeBadge('');
```

在 `openFixStream(jobId)` 的 `fixJobId = jobId;` 之后加：

```js
  setOptimizeBadge('fix');
```

在 `closeFixStream()` 的 `fixJobId = null;` 之后加：

```js
  setOptimizeBadge('');
```

在 `initOptimizePanel` 的末尾（`loadReport(...)` 那行之后）加：

```js
  // 面板打开时也探一次：用户可能是在别处发起的体检（另一个标签页 / 服务重启前）
  probeOptimizeBadge(currentDir);
```

- [ ] **Step 4: `chat.js` 在换目录时刷新**

`public/js/chat.js` 顶部 import 区追加一行（不动既有的 `bindOptimizeCwd` 那行）：

```js
import { bindOptimizeBadgeCwd, probeOptimizeBadge, refreshOptimizeBadge } from './optimize-badge.js';
```

在既有的 `bindOptimizeCwd({ getCwd: () => cwd });` 那行之后追加两行：

```js
bindOptimizeBadgeCwd({ getCwd: () => cwd }); // 同上：惰性读，此刻 cwd 尚未初始化
// 挂全局给 app.js 的「展开工具列表」用（项目已有 _setSidebarToolsMode 等同类挂载）
window._refreshOptimizeBadge = refreshOptimizeBadge;
```

> ⚠️ **不要在这里直接调 `probeOptimizeBadge(cwd)`。** 此处的 `cwd` 还没初始化（`let cwd` 在后面），既有的 `getCwd: () => cwd` 是**惰性读**才安全——注释里明写了「惰性读 cwd 无 TDZ」。直接取值会抛 ReferenceError。

在 `selectDir(p)` 函数里（约 2916 行）的 `reinitializeGitSelector();` 之后追加：

```js
        probeOptimizeBadge(p); // 换项目：标签必须跟着换，否则会把 A 项目的体检显示在 B 上
```

- [ ] **Step 4b: `app.js` 展开工具列表时探测**

`public/app.js` 的 `setToolsMode(on)` 函数（约 136 行）里，`if (on) {` 分支的末尾（`window._setSidebarCreateVisible?.(false);` 之后）追加：

```js
            // 用户此刻才看得见「项目优化」那张卡片，探测放在这里既及时又天然节流。
            // 这也是页面刷新后标签能恢复的唯一路径——刷新会清掉内存里的 SSE 状态
            window._refreshOptimizeBadge?.();
```

- [ ] **Step 5: 手工验证**

1. 发起体检 → 切到对话视图 → 打开工具列表，「项目优化」卡片带 `体检中` 标签；
2. 体检结束（或点中止）→ 标签在 30s 内消失（面板开着时是立刻）；
3. 换到另一个没在体检的项目 → 标签立刻消失；
4. **体检中刷新页面 → 展开工具列表 → 标签重新出现**（这条验的是 Step 4b 那条恢复路径）；
5. 打开工具列表后在浏览器 Network 面板确认：没有活跃任务时只发一次 `report` 请求，不会持续轮询。

---

## Task 13：按钮与新元素的样式

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: 顶部操作按钮分主次**

找到 `.opt-score-actions { display: flex; align-items: center; gap: 10px; flex: none; }`（约 4511 行），替换为：

```css
/* 顶部操作区。
   原来「重新体检」和「一键修复」都是 .btn.primary —— 两个同权重的实心橙块并排，
   没有主次层级，一起把分数环压了下去。现在只有主动作保持实心，次动作降为描边。 */
.opt-score-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.opt-score-actions .btn {
  padding: 7px 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* 次动作：描边幽灵。已有报告时的「重新体检」属于这一档 */
.opt-score-actions #optRunCheckup {
  background: transparent;
  border-color: var(--border);
  color: var(--muted);
  font-weight: 500;
}
.opt-score-actions #optRunCheckup:hover:not(:disabled) {
  background: var(--panel);
  color: var(--text);
  border-color: var(--accent);
}
/* 唯一例外：还没体检过时它是这个面板上唯一的动作，此时该是实心的。
   由 refreshButtons() 按 !currentReport 切换这个类 */
.opt-score-actions #optRunCheckup.is-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #1a1109;
  font-weight: 600;
}
.opt-score-actions #optRunCheckup.is-primary:hover:not(:disabled) {
  background: var(--accent-hi);
}
```

- [ ] **Step 2: `refreshButtons` 切换 `is-primary`**

`public/js/optimize-view.js` 的 `refreshButtons()` 里，`run.textContent = ...` 那行之后加：

```js
    // 没体检过时它是面板上唯一的动作，该用实心；有报告后让位给「一键修复」
    run.classList.toggle('is-primary', !currentReport);
```

- [ ] **Step 3: 新元素样式**

在「项目优化面板」样式段末尾追加：

```css
/* ---- 侧栏工具卡片的状态标签 ---- */
.tool-item-tag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--accent-hi);
  border: 1px solid rgba(217, 119, 87, 0.45);
  background: rgba(217, 119, 87, 0.12);
  vertical-align: middle;
}

/* ---- issue 行：勾选框 + 豁免按钮 ---- */
.opt-issue { display: flex; align-items: center; gap: 8px; }
/* 无复选框的行（维度未跑完 / 该条没有修复策略）用等宽占位，否则整列会左右错开 */
.opt-issue-nocheck { width: 14px; flex: none; }
.opt-issue.is-handled { opacity: 0.55; }

/* 「这不是问题」：次要动作，平时低调，hover 才浮出来。
   它和勾选框抢注意力的话，用户会先去点它而不是先勾修复项 */
.opt-issue-ignore {
  margin-left: auto;
  flex: none;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--muted);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  transition: opacity .15s, color .15s, border-color .15s;
}
.opt-issue:hover .opt-issue-ignore { opacity: 1; }
.opt-issue-ignore:hover {
  color: var(--text);
  border-color: var(--border);
  background: var(--panel);
}
/* 触屏 / 键盘可达：hover 不可用时也要能看见 */
.opt-issue-ignore:focus-visible { opacity: 1; }

/* ---- 维度头部的勾选计数 ---- */
.opt-dim-count { color: var(--muted); font-size: 11.5px; flex: none; }

/* ---- 「已豁免 N 项」入口 ---- */
.opt-ignored-entry {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--muted);
  border: 1px solid var(--faint);
  background: transparent;
  cursor: pointer;
}
.opt-ignored-entry:hover { color: var(--text); border-color: var(--border); }
```

- [ ] **Step 4: 清理计划树的废样式**

删除 `public/app.css` 里 `.opt-plan`、`.opt-plan-item`、`.opt-plan-dim`、`.opt-plan-items`、`.opt-plan-node`、`.opt-plan-count`、`.opt-plan-empty`、`.opt-plan-loc`、`.opt-plan-msg` 这些**只服务于已删除计划树**的规则。

> ⚠️ **不要误删** `.opt-plan-title`、`.opt-plan-text`、`.opt-plan-list`、`.opt-plan-sub`、`.opt-plan-biz`、`.opt-plan-verdict`、`.opt-plan-risks`、`.opt-plan-strengths`、`.opt-plan-contra`、`.opt-plan-handled` —— 这些是 holistic 维度**行动计划**（`renderPlan`）和「本轮已处理」标记在用的，名字相近但完全是另一个东西。删之前用 `grep -n "opt-plan" public/js/optimize-view.js` 核对一遍还在用哪些。

- [ ] **Step 5: 手工验证**

1. 未体检的项目：「开始体检」是实心橙；
2. 已有报告：「重新体检」是描边、「一键修复」是实心，两者层级分明；
3. issue 行 hover 时「这不是问题」浮现，不 hover 时不干扰阅读；
4. 全面翻一遍面板，确认 holistic 的行动计划块（业务理解 / 总体判断 / 风险 / 优势 / 矛盾）样式完好 —— 这是 Step 4 最容易误伤的地方。

---

## Task 14：文档同步

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `src/store/CLAUDE.md`
- Modify: `src/features/CLAUDE.md`
- Modify: `src/capabilities/CLAUDE.md`

- [ ] **Step 1: `src/store/CLAUDE.md`**

在「业务领域 store」清单里，`optimize.js` 那条之后插入：

```markdown
- `checkup-ignores.js` — 体检豁免清单（`checkup-ignores.json`）：用户点「这不是问题」的记录，键为 `(dim, code, file)` 三元组（**不含行号**，行号会漂移）。独立于 `optimize.json` 的理由见文件头注释（那份是高频读改写的体检产出，这份是低频长寿的人工判断）。
```

在「常见改动入口」追加：

```markdown
- **要改豁免记录的键或去重口径** → `checkup-ignores.js` 的 `sameRule`；改它之前先读 spec `docs/superpowers/specs/2026-09-18-checkup-phase2-design.md` §1.1（粒度是拍板过的取舍，不是随手选的）。
```

- [ ] **Step 2: `src/features/CLAUDE.md`**

在 `project-checkup/` 文件清单里追加两条：

```markdown
- `project-checkup/ignore.logic.js` — 豁免的纯函数层：三元组匹配、issue 过滤、已豁免 code 集合、说明文案、`IGNORED.md` 渲染。
- `project-checkup/ignore.js` — 豁免的 IO 层：读写 store + 重渲染 `.claude/optimize/IGNORED.md` + 按维度精确作废指纹缓存（三件事收口在一处，调用方不必知道）。
```

在「常见改动入口」追加：

```markdown
- 要改**「这不是问题」的匹配粒度或 IGNORED.md 的格式** → 改 `project-checkup/ignore.logic.js`（纯函数，动它先看 `.test.js`）；要改**落盘副作用的次序**（store / md / 缓存作废）→ 改 `project-checkup/ignore.js`。
- 要改**豁免在体检里的生效点** → 召回排除在 `audit-engine.logic.js` 的 `excludeIgnoredCandidates`（只对 10 个 audit 维度、省额度），落地前兜底过滤在 `entrypoints/web/optimize-ops.js` 的 `applyIgnores`（覆盖全 17 维）。**两道都要在**：前者省额度但覆盖不全，后者覆盖全但省不了额度。
```

- [ ] **Step 3: `src/capabilities/CLAUDE.md`**

把「流程二：单轮分类（`llm-classify`）」那段里的归因列表改为：

```markdown
→ 归结 `{data, reason:'exhausted'|'aborted'|'timeout'|'unparsable'|null}`。其中 `aborted` 是**外部中止**（调用方传了 `signal` 且已触发），它排在「先尝试解析」之前，且必须与 `timeout` 分开——超时值得重试，用户中止绝不该重试（否则点中止反而多烧一轮额度）。
```

并在「常见改动入口」追加：

```markdown
- 要**让某个分类调用点支持中止**，就在该调用点传 `signal`（`llm-classify` 已支持，不传即行为不变）；目前只有体检链路的三处传了（`audit-engine` / `check-prompts` / `check-comments`）。
```

- [ ] **Step 4: `docs/ARCHITECTURE.md` —— 核对后确认无需改动**

这一步是**核对**，不是编辑。该文件不维护 store 文件清单，也不维护 HTTP 接口清单（那两份清单分别在 `src/store/CLAUDE.md` 与各 `routes-*.js` 自身），它只写分层约定。本轮新增的两件事都已被现有条款覆盖：

- `features/project-checkup/ignore.js` 用 `fs.writeFileSync` 写用户项目里的 `IGNORED.md` —— §3「持久化」的正当例外第二条已明列「`features/project-optimize`、`features/project-checkup` 写**用户项目**的文件」；
- `store/checkup-ignores.js` 经 `store/index.js` 落盘 —— 正是 §3 的主干要求。

跑一遍该节给出的验证命令，确认新增写盘没有落在例外之外：

Run: `grep -rn "writeFileSync\|appendFileSync" src --include="*.js" | grep -v test | grep -v "^src/store/"`
Expected: 输出里新增的那一条是 `src/features/project-checkup/ignore.js`，落在 §3 例外内；没有其它新增项。

> 若将来 `ARCHITECTURE.md` 补上了接口或 store 清单，再回来登记。现在为它硬造一个章节只会让文档多一处需要同步的地方。

- [ ] **Step 5: 跑全量测试收尾**

Run: `npm test`
Expected: PASS。

---

## 收尾：整体手工验收清单

全部任务完成后，按下表逐项验一遍（这些是自动化测试覆盖不到的）：

- [ ] 体检中切走页面再回来，侧栏标签仍在、面板 loading 恢复、点体检不会被 409 挡住
- [ ] 点「中止体检」后查日志（`logs/`），确认不再出现新的 `判定批次开始` 行
- [ ] 豁免一条 audit 维度的问题两次（两种 code）后重新体检，日志里出现 `按豁免清单剔除候选`
- [ ] 豁免一条 map 维度的问题后重新体检，该问题不再出现且维度 reason 带「已豁免 1 条，本维度分数未重算」
- [ ] `.claude/optimize/IGNORED.md` 内容正确、含备注原文与免改声明
- [ ] 勾选/反选二十次，没有任何非用户触发的折叠或展开
- [ ] 一键修复仍能正确命中所勾选的文件（**这是 `planId` 改动的关键验收**：勾一条、修复后看报告里被改的是不是同一个文件）
- [ ] 顶部按钮主次分明，未体检时「开始体检」为实心
- [ ] holistic 维度的行动计划块样式完好（CSS 清理没误伤）

---

## 附：本计划与 spec 的对应

| spec 章节 | 实现任务 |
|---|---|
| §1.1 忽略键 | Task 3（`sameRule`）、Task 4（`matchesIgnore`） |
| §1.2 存储与 md 渲染、分层 | Task 3、Task 4（`renderIgnoredMd`）、Task 5（`ignore.js`） |
| §1.3 两处生效点 | Task 6（召回排除）、Task 7（兜底过滤） |
| §1.4 缓存失效 | Task 5 Step 1（`dropLlmCache`） |
| §1.5 分数口径 | Task 4（`appendIgnoreNote`）、Task 7（`AUDIT_DIM_IDS`） |
| §1.6 交互 | Task 11 |
| §1.7 HTTP 接口 | Task 8 |
| §2 侧栏标签 | Task 12 |
| §3 中止即停额度 | Task 1、Task 2 |
| §4 按钮重做 | Task 13 Step 1-2 |
| §5 勾选上移 | Task 9、Task 10 |
| §6 折叠缺陷 | Task 10 Step 2/3/6/9 |
| §7 改动清单 | 全部任务 |
| §8 测试策略 | Task 1/3/4/6/8/9 的测试步骤 + 收尾验收清单 |
