# Stalled Mid-Stream 新会话自动恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 Claude Agent SDK 遭遇「Response stalled mid-stream」错误且同 session 重试耗尽后，自动开一个全新会话（不带 `resume`）用原始 prompt 重试，而不是直接失败报错，行为等同于用户手动「新开会话」。

**Architecture:** 在 `settleRun`（收尾函数）里增加 stalled 错误检测分支：检测到 stalled 错误且未曾尝试过新会话（`!params.freshSessionAttempt`）时，调 `blockRun` 显示"新会话续跑中"提示，然后以原始 prompt + 无 session 起一个新 run；新 run 的 `params` 带 `freshSessionAttempt: true` 防止无限循环。`params` 里补充 `prompt` 字段（原本未传），供收尾时取用。

**Tech Stack:** Node.js ESM，`node:test` 单测框架，已有的 `runs.js` / `active-runs.js` store。

---

## 文件影响范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/entrypoints/web/run-claude.js` | 修改 | 核心：`params` 加 `prompt`/`freshSessionAttempt`；`settleRun` 新增 stalled 分支 |
| `src/entrypoints/web/run-claude.test.js` | 新建 | 测试 `isStalledError` 工具函数 + `settleRun` stalled 分支行为 |

> `src/integrations/claude.js` **不改动**（保留 3 次同 session 重试，这是快速网络闪断恢复，有价值）

---

## Task 1：提取 `isStalledError` 工具函数并为其写测试

**Files:**
- Modify: `src/entrypoints/web/run-claude.js`
- Create: `src/entrypoints/web/run-claude.test.js`

### 背景
把 stalled 判断逻辑提取成一个纯函数，方便单测，也方便 `settleRun` 调用。

- [ ] **Step 1: 在 `run-claude.js` 末尾导出 `isStalledError`**

在文件末尾（`recoverPendingAndOrphans` 函数之后）添加：

```js
/** 判断错误是否为「流式响应中断」类型（stalled mid-stream）。提取为纯函数便于单测。 */
export function isStalledError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('stalled') || msg.includes('mid-stream');
}
```

- [ ] **Step 2: 新建测试文件并写针对 `isStalledError` 的失败测试**

创建 `src/entrypoints/web/run-claude.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStalledError } from './run-claude.js';

// --- isStalledError ---

test('isStalledError: 包含 stalled 的错误返回 true', () => {
  assert.equal(isStalledError(new Error('Response stalled mid-stream')), true);
});

test('isStalledError: 包含 mid-stream 的错误返回 true', () => {
  assert.equal(isStalledError(new Error('API Error: Response stalled mid-stream. The response above may be incomplete.')), true);
});

test('isStalledError: 普通错误返回 false', () => {
  assert.equal(isStalledError(new Error('Permission denied')), false);
});

test('isStalledError: null / undefined 不抛出，返回 false', () => {
  assert.equal(isStalledError(null), false);
  assert.equal(isStalledError(undefined), false);
});

test('isStalledError: 字符串错误也能识别', () => {
  assert.equal(isStalledError('Claude Code returned an error result: API Error: Response stalled mid-stream'), true);
});
```

- [ ] **Step 3: 运行测试确认失败（函数还未导出时）**

```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
node --test src/entrypoints/web/run-claude.test.js 2>&1 | head -20
```

期望：因 `isStalledError is not a function` 类错误而失败（或 5 个用例全红）。

- [ ] **Step 4: 运行测试确认全部通过**

```bash
node --test src/entrypoints/web/run-claude.test.js 2>&1
```

期望：`pass 5`，`fail 0`。

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/web/run-claude.js src/entrypoints/web/run-claude.test.js
git commit -m "feat: 提取 isStalledError 工具函数并补测试"
```

---

## Task 2：`params` 补充 `prompt` 与 `freshSessionAttempt` 字段

**Files:**
- Modify: `src/entrypoints/web/run-claude.js:45-64`

### 背景
`settleRun` 收到的 `params` 目前没有 `prompt`，而「开新会话」时需要把原始 prompt 带入新 run。同时需要 `freshSessionAttempt` 标记防止无限循环。

- [ ] **Step 1: 在 `startClaudeRun` 的解构中接收 `freshSessionAttempt`**

找到 `run-claude.js` 第 45 行：

```js
export function startClaudeRun(run, { prompt, cwd, addDirs, session, model, effort, mode, convId, resumePendingId, resumeAttempt = 0 }) {
```

替换为：

```js
export function startClaudeRun(run, { prompt, cwd, addDirs, session, model, effort, mode, convId, resumePendingId, resumeAttempt = 0, freshSessionAttempt = false }) {
```

- [ ] **Step 2: 在 `params` 对象里加入 `prompt` 和 `freshSessionAttempt`**

找到第 64 行：

```js
  const params = { session, cwd, model, effort, mode: effectiveMode, convId, resumePendingId, tokenId: run._tokenId, resumeAttempt };
```

替换为：

```js
  const params = { prompt, session, cwd, model, effort, mode: effectiveMode, convId, resumePendingId, tokenId: run._tokenId, resumeAttempt, freshSessionAttempt };
```

- [ ] **Step 3: 运行已有测试确认没有破坏**

```bash
node --test src/entrypoints/web/run-claude.test.js 2>&1
```

期望：`pass 5`，`fail 0`（测试不涉及此改动，通过即代表没有语法错误）。

- [ ] **Step 4: Commit**

```bash
git add src/entrypoints/web/run-claude.js
git commit -m "feat: run-claude params 补充 prompt 与 freshSessionAttempt 字段"
```

---

## Task 3：`settleRun` 新增 stalled 错误新会话恢复分支

**Files:**
- Modify: `src/entrypoints/web/run-claude.js:212-268`（`settleRun` 函数体）
- Modify: `src/entrypoints/web/run-claude.test.js`（补 settleRun 相关测试）

### 背景
这是核心改动。当 `settleRun` 收到 stalled 错误且 `!params.freshSessionAttempt` 时：
1. 调 `blockRun(run, '...')` 给用户一个友好提示（与限流分支风格一致）
2. 用 `createRun()` + `startClaudeRun(...)` 开一个不带 `session` 的全新 run
3. 新 run 的 `freshSessionAttempt: true`，防止再次触发此分支

- [ ] **Step 1: 写新会话恢复分支的测试（先写失败测试）**

在 `run-claude.test.js` 末尾追加：

```js
// --- settleRun stalled 新会话恢复 ---
// 直接测试 isStalledError 判断的边界，settleRun 是高集成度函数，通过集成验证（Step 5）

test('isStalledError: Claude SDK 实际错误消息格式能识别', () => {
  const realMsg = 'Claude Code returned an error result: API Error: Response stalled mid-stream. The response above may be incomplete.';
  assert.equal(isStalledError(new Error(realMsg)), true);
});

test('isStalledError: 仅含 stalled 不含 mid-stream 也识别', () => {
  assert.equal(isStalledError(new Error('Connection stalled')), true);
});
```

- [ ] **Step 2: 运行确认测试通过（这两个测试已可通过）**

```bash
node --test src/entrypoints/web/run-claude.test.js 2>&1
```

期望：`pass 7`，`fail 0`。

- [ ] **Step 3: 在 `settleRun` 里添加 stalled 恢复分支**

找到 `run-claude.js` 中 `settleRun` 函数，定位到 `rejected` 分支结束后、`removePending` 之前。原始代码约为：

```js
  if (rejected && sid && params.convId) {
    // ... 限流分支（约 225-250 行）...
    return;
  }
  if (params.resumePendingId) removePending(params.resumePendingId); // 续跑正常收尾
```

在 `if (rejected && sid && params.convId)` 块**之后**（`return` 之后的下一行）插入新分支：

```js
  // stalled mid-stream 新会话恢复：同 session 重试耗尽后自动开新会话，等同用户手动「新开会话」
  if (isStalledError(err) && params.convId && !params.freshSessionAttempt) {
    logger.info('web', 'stalled 错误：切换新会话自动重试', { convId: params.convId, prompt: params.prompt?.slice(0, 60) });
    blockRun(run, '⚠️ 连接中断，正在以新会话自动重试…');
    const freshRun = createRun();
    freshRun.convId = params.convId;
    startClaudeRun(freshRun, {
      prompt: params.prompt || '继续',
      cwd: params.cwd,
      session: undefined,          // 不带 resume，等同于新开会话
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      convId: params.convId,
      freshSessionAttempt: true,   // 防止无限循环
    });
    return;
  }
```

完整的 `settleRun` 函数改动后看起来如下（标注新增行）：

```js
function settleRun(run, err, lastRate, params) {
  if (run._settled) {
    logger.warn('web', 'settleRun 重复调用，已忽略', { runId: run.id });
    return;
  }
  run._settled = true;
  removeActiveRun(run.id);
  const rejected = lastRate && lastRate.status === 'rejected';
  const sid = run.session_id || params.session;
  if (rejected && sid && params.convId) {
    // ... 限流分支（不变）...
    return;
  }
  // ↓↓↓ 新增：stalled 新会话恢复分支 ↓↓↓
  if (isStalledError(err) && params.convId && !params.freshSessionAttempt) {
    logger.info('web', 'stalled 错误：切换新会话自动重试', { convId: params.convId, prompt: params.prompt?.slice(0, 60) });
    blockRun(run, '⚠️ 连接中断，正在以新会话自动重试…');
    const freshRun = createRun();
    freshRun.convId = params.convId;
    startClaudeRun(freshRun, {
      prompt: params.prompt || '继续',
      cwd: params.cwd,
      session: undefined,
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      convId: params.convId,
      freshSessionAttempt: true,
    });
    return;
  }
  // ↑↑↑ 新增结束 ↑↑↑
  if (params.resumePendingId) removePending(params.resumePendingId);
  // ... 后续 onSettle / failRun / finishRun（不变）...
}
```

- [ ] **Step 4: 运行单测确认全部通过**

```bash
node --test src/entrypoints/web/run-claude.test.js 2>&1
```

期望：`pass 7`，`fail 0`。

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/web/run-claude.js src/entrypoints/web/run-claude.test.js
git commit -m "feat: stalled mid-stream 自动开新会话重试，避免同 session 卡死"
```

---

## Task 4：集成验证

**Files:**
- 无代码改动，仅验证步骤

### 验证方式

由于 stalled 错误在真实环境下偶发，手动触发需要大任务。可用日志 + 代码审查验证逻辑正确性。

- [ ] **Step 1: 阅读最终改动确认分支不遗漏**

检查以下三点：
1. `settleRun` 的新 stalled 分支位于 `rejected` 分支**之后**（额度耗尽优先处理，不被 stalled 分支吃掉）
2. `freshSessionAttempt: true` 确实传入了新 run 的 `startClaudeRun`
3. `params.prompt || '继续'` 有 fallback（防 prompt 为空时 SDK 报错）

- [ ] **Step 2: 启动服务确认无启动错误**

```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
node src/entrypoints/web/server.js 2>&1 | head -10
```

期望：正常启动，无 `SyntaxError` / `ReferenceError`。若有错误，检查 `isStalledError` 是否被正确调用（记得在 `settleRun` 上方定义或确保函数提升）。

> **注意**：`isStalledError` 是文件末尾的具名 export，JavaScript `function` 声明会提升，但 `export function` 也受益于函数声明提升（与 `const`/`let` 不同），因此在 `settleRun` 里直接调用不会有「先于定义」问题。

- [ ] **Step 3: （可选）模拟 stalled 错误观察日志**

如有测试环境，可临时在 `runClaude` 里把 `maxRetries` 改为 1 并抛出 stalled 错误模拟：

```js
// 临时：让首次调用就抛出 stalled 错误
throw new Error('API Error: Response stalled mid-stream');
```

启动后发起一个 run，预期日志出现：
```
[web] stalled 错误：切换新会话自动重试 { convId: '...', prompt: '...' }
```
且前端 run 状态变为 blocked（`⚠️ 连接中断，正在以新会话自动重试…`），随后新 run 自动启动。

验证完毕后**务必撤销临时改动**。

- [ ] **Step 4: 全量单测通过**

```bash
node --test src/entrypoints/web/run-claude.test.js 2>&1
```

期望：`pass 7`，`fail 0`。

---

## 自检：Spec 覆盖度

| 需求 | 对应 Task |
|------|-----------|
| stalled 错误 3 次重试后不直接报错 | Task 3（`settleRun` 新分支） |
| 自动开新会话（不带 resume） | Task 3（`session: undefined`） |
| 用原始 prompt 重启 | Task 2（`params.prompt`）+ Task 3 |
| 防止无限循环 | Task 2（`freshSessionAttempt`）+ Task 3 |
| 前端有友好提示 | Task 3（`blockRun` 消息） |
| 纯函数可单测 | Task 1（`isStalledError`） |
