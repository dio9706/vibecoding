# Provider 抽象 · Phase 1（契约地基 + Claude 适配）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 Provider 契约与注册表，把现有 `runClaude` 适配为 `claude-agent` provider，并让 web 主 run 经 provider 调用——全程行为零变化。

**Architecture:** 绞杀者第一步。新增 `src/providers/`（纯注册表工厂 + Claude 适配器，带 capabilities 描述符）；`integrations/claude.js` 的 `runClaude` 原样保留，`claude-agent` provider 通过依赖注入包住它（便于单测、不碰 SDK）。web 主 run 的调用点从 `runClaude(prompt, opts)` 换成 `providers.get('claude-agent').run(prompt, opts).done`，opts 逐字不变。规范化的 `{input, hooks}` 拆分与能力降级留到 Phase 3（由真实第二个 provider 定形，避免只对着 Claude 设计而跑偏）。

**Tech Stack:** Node.js ESM（`type: module`）、`node:test` + `node:assert/strict`（仓库现有单测风格，见 `token-rotation.test.js`）、`@anthropic-ai/claude-agent-sdk`。

---

## 本期范围（对照 spec）

本 plan 只覆盖 spec `2026-07-22-provider-abstraction-design.md` 的：
- 模块 1「Provider 契约」——注册表 + `capabilities` 描述符（run 签名 Phase 1 先用透传，Phase 3 规范化）。
- 模块 2「Claude 实现」——以**适配器**方式实现（不物理搬动 `claude.js`，降低 import churn 与回归风险）。
- 迁移步骤 1「包壳」+ 只切换**主 web run** 一个调用点验证契约。

**不在本期**（各自后续成 plan）：
- **Phase 2 plan**：`token-rotation` → `credential-pool`（加 `providerId`）、env 注入移入编排层、迁移其余 6 处 `runClaude` 调用方、`run-orchestrator` 抽取。
- **Phase 3 plan**：`openai-compat` provider + `agent-loop`（引入 `ai` 包）、`{input, hooks}` 规范化契约与能力降级。

## 文件结构

- Create `src/providers/registry.js` — 纯注册表工厂 `createRegistry()`（register/get/has/list），无内置 provider，可独立单测。
- Create `src/providers/registry.test.js` — registry 纯函数单测。
- Create `src/providers/claude-agent.js` — `createClaudeAgentProvider(runFn)` 工厂 + `claudeAgentProvider` 实例 + `CLAUDE_CAPABILITIES`。
- Create `src/providers/claude-agent.test.js` — 适配器单测（注入假 runFn，不碰 SDK）。
- Create `src/providers/index.js` — 默认注册表：注册内置 `claude-agent`，导出 `register/get/has/list`。
- Create `src/providers/index.test.js` — 验证默认注册表含 `claude-agent` 且能力全开。
- Modify `src/entrypoints/web/server.js` — 顶部加 providers import；`startClaudeRun` 内主 run 调用点改走 provider。

---

### Task 1: 纯注册表工厂 `createRegistry`

**Files:**
- Create: `src/providers/registry.js`
- Test: `src/providers/registry.test.js`

- [ ] **Step 1: 写失败测试**

写入 `src/providers/registry.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './registry.js';

const fakeProvider = (id) => ({
  id,
  capabilities: { agentic: false },
  run: () => ({ done: Promise.resolve(), abort() {} }),
});

test('register 后 get 返回同一 provider', () => {
  const r = createRegistry();
  const p = fakeProvider('x');
  r.register(p);
  assert.equal(r.get('x'), p);
});

test('get 未知 id 抛错', () => {
  const r = createRegistry();
  assert.throws(() => r.get('nope'), /未知 provider/);
});

test('has 反映注册状态', () => {
  const r = createRegistry();
  assert.equal(r.has('x'), false);
  r.register(fakeProvider('x'));
  assert.equal(r.has('x'), true);
});

test('list 返回 id + capabilities', () => {
  const r = createRegistry();
  r.register(fakeProvider('x'));
  assert.deepEqual(r.list(), [{ id: 'x', capabilities: { agentic: false } }]);
});

test('register 校验 provider 形状', () => {
  const r = createRegistry();
  assert.throws(() => r.register({ id: 'x' }), /run 函数/);
  assert.throws(() => r.register({ run() {} }), /string id/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/providers/registry.test.js`
Expected: FAIL（`Cannot find module './registry.js'` 或导入错误）。

- [ ] **Step 3: 写最小实现**

写入 `src/providers/registry.js`：

```js
/**
 * 纯注册表工厂 —— 内核与模型实现之间的唯一入口。
 * 无内置 provider，便于隔离单测；默认实例在 index.js 组装。
 */
export function createRegistry() {
  const map = new Map();
  return {
    /** 注册 provider（同 id 覆盖，便于测试注入替身）；校验形状 */
    register(provider) {
      if (!provider || typeof provider.id !== 'string')
        throw new Error('register: provider 必须含 string id');
      if (typeof provider.run !== 'function')
        throw new Error('register: provider 必须含 run 函数');
      map.set(provider.id, provider);
      return provider;
    },
    /** 取 provider；未注册即抛（调用方须显式处理未知 provider） */
    get(id) {
      const p = map.get(id);
      if (!p) throw new Error(`未知 provider: ${id}`);
      return p;
    },
    has: (id) => map.has(id),
    /** 列出 { id, capabilities }，供设置页/诊断展示 */
    list: () => [...map.values()].map((p) => ({ id: p.id, capabilities: p.capabilities })),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/providers/registry.test.js`
Expected: PASS（5 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/providers/registry.js src/providers/registry.test.js
git commit -m "feat(providers): 纯注册表工厂 createRegistry"
```

---

### Task 2: Claude-agent provider 适配器

**Files:**
- Create: `src/providers/claude-agent.js`
- Test: `src/providers/claude-agent.test.js`

- [ ] **Step 1: 写失败测试**

写入 `src/providers/claude-agent.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAgentProvider, CLAUDE_CAPABILITIES } from './claude-agent.js';

test('capabilities 八项全开', () => {
  for (const k of [
    'agentic', 'tools', 'fileIO', 'resume',
    'stream', 'permissions', 'rateLimitAware', 'compaction',
  ]) {
    assert.equal(CLAUDE_CAPABILITIES[k], true, `${k} 应为 true`);
  }
});

test('id 为 claude-agent', () => {
  const p = createClaudeAgentProvider(() => Promise.resolve());
  assert.equal(p.id, 'claude-agent');
});

test('run 把 prompt 与 opts 原样透传给 runFn，并返回 { done, abort }', () => {
  let seen = null;
  const p = createClaudeAgentProvider((prompt, opts) => {
    seen = { prompt, opts };
    return Promise.resolve('ok');
  });
  const opts = { cwd: '/tmp', model: 'x' };
  const handle = p.run('hello', opts);
  assert.equal(seen.prompt, 'hello');
  assert.equal(seen.opts, opts); // 同一引用，逐字透传
  assert.ok(handle.done instanceof Promise);
  assert.equal(typeof handle.abort, 'function');
});

test('abort() 调用 opts.abortController.abort()', () => {
  let aborted = false;
  const ac = { abort: () => { aborted = true; } };
  const p = createClaudeAgentProvider(() => Promise.resolve());
  p.run('x', { abortController: ac }).abort();
  assert.equal(aborted, true);
});

test('abort() 在无 abortController 时不抛', () => {
  const p = createClaudeAgentProvider(() => Promise.resolve());
  assert.doesNotThrow(() => p.run('x', {}).abort());
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/providers/claude-agent.test.js`
Expected: FAIL（`Cannot find module './claude-agent.js'`）。

- [ ] **Step 3: 写最小实现**

写入 `src/providers/claude-agent.js`：

```js
/**
 * Claude Agent Provider —— 把现有 runClaude 适配成 Provider 契约的一员。
 * Phase 1：run 透传 runClaude 的 opts（行为逐字不变，屏蔽 SDK 细节由 claude.js 负责）；
 * 规范化的 { input, hooks } 拆分与能力降级留到 Phase 3（第二个 provider 落地时定形）。
 */
import { runClaude } from '../integrations/claude.js';

/** Claude 能力全开：agent loop / 工具 / 文件读写 / 续接 / 流式 / 交互审批 / 限流上报 / 自动压缩均由 SDK 白送 */
export const CLAUDE_CAPABILITIES = Object.freeze({
  agentic: true,
  tools: true,
  fileIO: true,
  resume: true,
  stream: true,
  permissions: true,
  rateLimitAware: true,
  compaction: true,
});

/**
 * 工厂：注入 runFn 便于单测（默认用真实 runClaude，避免测试触达 SDK/网络）。
 * @param {(prompt:string, opts:object)=>Promise<void>} [runFn]
 */
export function createClaudeAgentProvider(runFn = runClaude) {
  return {
    id: 'claude-agent',
    capabilities: CLAUDE_CAPABILITIES,
    /**
     * @param {string} prompt
     * @param {object} [opts]  与 runClaude 完全一致的选项（Phase 1 透传）
     * @returns {{ done: Promise<void>, abort: () => void }}
     */
    run(prompt, opts = {}) {
      const done = runFn(prompt, opts);
      return { done, abort: () => opts.abortController?.abort() };
    },
  };
}

/** 默认实例（供注册表注册） */
export const claudeAgentProvider = createClaudeAgentProvider();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/providers/claude-agent.test.js`
Expected: PASS（5 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/providers/claude-agent.js src/providers/claude-agent.test.js
git commit -m "feat(providers): claude-agent 适配器包住 runClaude"
```

---

### Task 3: 默认注册表 `index.js` 组装

**Files:**
- Create: `src/providers/index.js`
- Test: `src/providers/index.test.js`

- [ ] **Step 1: 写失败测试**

写入 `src/providers/index.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, has, list } from './index.js';

test('默认注册表含内置 claude-agent', () => {
  assert.equal(has('claude-agent'), true);
  assert.equal(get('claude-agent').id, 'claude-agent');
});

test('claude-agent 能力全开且可 run', () => {
  const p = get('claude-agent');
  assert.equal(p.capabilities.agentic, true);
  assert.equal(typeof p.run, 'function');
});

test('list 至少含 claude-agent 一项', () => {
  assert.ok(list().some((e) => e.id === 'claude-agent'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/providers/index.test.js`
Expected: FAIL（`Cannot find module './index.js'`）。

- [ ] **Step 3: 写最小实现**

写入 `src/providers/index.js`：

```js
/**
 * Provider 默认注册表 —— 内核统一从这里 get(id).run(...)。
 * 新增 provider = 在此 register 一次，内核与调用方无需改动。
 */
import { createRegistry } from './registry.js';
import { claudeAgentProvider } from './claude-agent.js';

const registry = createRegistry();
registry.register(claudeAgentProvider);

// 方法用闭包捕获内部 map（不依赖 this），解构导出安全
export const { register, get, has, list } = registry;
export { registry };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/providers/index.test.js`
Expected: PASS（3 tests）。

- [ ] **Step 5: 全量 provider 测试 + 语法检查**

Run: `node --test "src/providers/*.test.js" && node --check src/providers/index.js`
Expected: `tests 13 / pass 13 / fail 0`，`node --check` 无输出（成功）。

> ⚠️ 验证命令陷阱（Node v24 / Windows 实测）：**目录形式** `node --test src/providers/` 不会发现测试文件，却打印 `pass 1` 并 `exit 0`（**静默假绿**）。必须用 **glob 形式** `node --test "src/providers/*.test.js"`（引号让 node 自己展开、退出码诚实）或逐文件运行。本条对 Phase 2/3 同样适用。

- [ ] **Step 6: 提交**

```bash
git add src/providers/index.js src/providers/index.test.js
git commit -m "feat(providers): 默认注册表注册内置 claude-agent"
```

---

### Task 4: web 主 run 改走 provider（行为零变化）

**Files:**
- Modify: `src/entrypoints/web/server.js`（顶部 import ~第 14 行；`startClaudeRun` 主 run 调用点 353 行与 450 行）

> 说明：主 run 是全项目最易踩坑的路径（交互审批、PreToolUse 强制 ask、插话、看门狗、额度续跑都挂在这），因此本任务**只换调用者、不动任何 opts 与 `.then/.catch` 收尾链**。

- [ ] **Step 1: 加 providers import**

在 `src/entrypoints/web/server.js` 中，找到第 14 行：

```js
import { runClaude } from '../../integrations/claude.js';
```

在其**下方**新增一行（保留原 import 不删——本期其余内部调用暂不迁移，仍可能用到；Phase 2 统一清理）：

```js
import * as providers from '../../providers/index.js';
```

- [ ] **Step 2: 换主 run 调用者**

在 `startClaudeRun` 内，找到第 353 行：

```js
  runClaude(prompt, {
```

改为：

```js
  providers.get('claude-agent').run(prompt, {
```

- [ ] **Step 3: 让收尾链挂到 `.done`**

紧接着找到第 450 行（该调用 opts 对象的结束 `})`，其后跟 `.then(...).catch(...)`）：

```js
  })
    .then(() => settleRun(run, null, lastRate, params))
    .catch((err) => settleRun(run, err, lastRate, params));
```

把结束的 `})` 改为 `}).done`（`.then/.catch` 保持不变，改为链在 `.done` 上）：

```js
  }).done
    .then(() => settleRun(run, null, lastRate, params))
    .catch((err) => settleRun(run, err, lastRate, params));
```

- [ ] **Step 4: 语法检查**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出（成功）。

- [ ] **Step 5: 单测回归（确认未破坏既有测试）**

Run: `node --test "src/providers/*.test.js"`（本期新增，必须 `pass 13 / fail 0`）
再抽查未被本改动触及的既有单测（逐文件，诚实退出码）：`node --test src/store/runs.test.js src/features/token-rotation.test.js src/store/history.test.js src/store/pending-resume.test.js`

> ⚠️ **不要**用裸 `node --test` 或目录形式 `node --test src/`：
> - 裸 `node --test` 会匹配到仓库根的 `test-*.mjs`（Playwright 脚本，需真服务器）→ 挂起。
> - 目录形式在本机（Node v24/Win）是**静默假绿**（不发现文件却 `exit 0`）。
> 一律用 glob（引号）或逐文件。
>
> 已知与本改动无关的既有问题（勿误判为回归）：`src/store/user-vars.test.js` 因读写真实 `user-vars.json` 会被本机残留数据污染而失败；`src/features/action-runner/slot-filler.test.js` 会发起真实 Claude API 调用（联网、数秒）。两者均在改动前即存在（可 `git stash` 复现），非本期引入。

- [ ] **Step 6: 手动回归主 run 关键路径**

前置：`pm2 restart claude-web`（或 `node server.js`）后打开 `http://127.0.0.1:3000`。逐项确认（对照 spec「不破坏」承诺）：

1. 发一条普通消息 → 流式 token 逐字输出（打字机）正常。
2. 让它写文件（如"新建 test.txt 写 hello"）→「询问」模式下弹出**允许/拒绝审批卡**（PreToolUse 强制 ask 未失效）。
3. 点「允许」→ 工具执行、结果回显；点「拒绝」→ 收到"用户拒绝"。
4. 运行中「停止」按钮 → 任务中断（abort 生效）。
5. 运行中追加一条消息（插话/steering）→ 被同一 run 接收续跑。
6. 右下角切模型 / effort → 新 run 生效。
7. 关网页再重开 → 进行中任务自动接回（关窗续跑）。

任一项异常即停止并排查（大概率是 opts 被误改或 `.done` 未正确链接）。

- [ ] **Step 7: 提交**

```bash
git add src/entrypoints/web/server.js
git commit -m "refactor(web): 主 run 经 provider 注册表调用（行为不变）"
```

---

## 自检（写完计划后对照 spec）

**1. Spec 覆盖**
- 模块 1 Provider 契约：Task 1（注册表）+ Task 2（capabilities 描述符）✅；run 规范化签名 → 明确延后 Phase 3（已在范围说明标注）。
- 模块 2 Claude 实现：Task 2 适配器 ✅（以包壳替代物理搬家，理由已注明）。
- 迁移步骤 1 包壳 + 切一个调用点：Task 3 + Task 4 ✅。
- 模块 3/4/5（凭证池、openai-compat、编排抽取）：明确划入 Phase 2/3 plan，非本期缺口。

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码；每个命令步骤含预期输出。

**3. 类型/命名一致性**：`createRegistry`/`register`/`get`/`has`/`list`、`createClaudeAgentProvider`/`claudeAgentProvider`/`CLAUDE_CAPABILITIES`、run 返回 `{ done, abort }` 在 Task 1–4 全程一致；provider id 统一 `'claude-agent'`。

**4. 风险点**：Task 4 的 `.done` 链接与 opts 不动是行为保真的关键；手动回归第 2 步（审批卡）专门覆盖记忆中多次踩坑的权限路径。

---

## 提交纪律

- 只 `git add` 每个 Task 列出的确切文件路径，**不用 `git add -A`**（工作区存在与本期无关的既有改动：`public/app.js`、`server.js` 根启动器、`src-tauri/*` 等，勿一并提交）。
- 每个 Task 结束即提交，保持小步可回滚。
