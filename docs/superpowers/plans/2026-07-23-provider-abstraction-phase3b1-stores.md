# Provider 抽象 · Phase 3b-1（store 层前置：会话消息存储 + 凭证字段）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Phase 3b-2 的 openai run 路由铺两块 store 层地基——应用自持的会话消息存储、凭证条目携带 baseURL/model——全程新增/纯增量，不碰 server.js。

**Architecture:** 遵循仓库既有约定「纯函数承载逻辑（可单测）+ 薄 glue 走 store/index.js 文件锁」。新增 `store/conv-messages.js`（纯 `mergeMessages` + get/append/clear glue）；`store/settings.js` 抽出纯 `makeTokenEntry` 并让 `addToken` 支持 `baseURL/model`。

**Tech Stack:** Node.js ESM；`node:test` + `node:assert/strict`。

## 本期范围（对照 Phase 3b spec）
覆盖 spec 模块 1（凭证条目带 baseURL/model 的存储部分）+ 模块 2（conv-messages 存储）。**不含**：API 端点、`startOpenAiRun`、`handleRunStart` 路由、abort/error（均属 3b-2，触碰 server.js，另起 plan）。

## 文件结构
- Create `src/store/conv-messages.js` — 纯 `mergeMessages(prev,msgs,max)` + `getMessages/appendMessages/clearMessages`。
- Create `src/store/conv-messages.test.js` — 纯函数单测。
- Modify `src/store/settings.js` — 抽出 `makeTokenEntry(...)`（导出、纯）；`addToken` 用它并加 `extra={baseURL,model}` 第 4 参。
- Modify `src/store/settings.test.js` — 追加 `makeTokenEntry` 用例。

---

### Task 1: 会话消息存储 `conv-messages.js`

**Files:**
- Create: `src/store/conv-messages.js`
- Test: `src/store/conv-messages.test.js`

- [ ] **Step 1: 写失败测试** — 写入 `src/store/conv-messages.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, MAX_MESSAGES } from './conv-messages.js';

test('mergeMessages：拼接 prev + msgs', () => {
  const out = mergeMessages([{ role: 'user', content: 'a' }], [{ role: 'assistant', content: 'b' }]);
  assert.deepEqual(out, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
});

test('mergeMessages：超过 max 时保留最近 max 条', () => {
  const prev = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: String(i) }));
  const out = mergeMessages(prev, [{ role: 'user', content: '5' }], 3);
  assert.deepEqual(out.map((m) => m.content), ['3', '4', '5']);
});

test('mergeMessages：非数组入参兜底为空', () => {
  assert.deepEqual(mergeMessages(null, null), []);
  assert.deepEqual(mergeMessages(undefined, [{ role: 'user', content: 'x' }]).map((m) => m.content), ['x']);
});

test('mergeMessages：默认上限为 MAX_MESSAGES（正整数）', () => {
  assert.equal(typeof MAX_MESSAGES, 'number');
  assert.ok(MAX_MESSAGES > 0);
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/store/conv-messages.test.js"` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现** — 写入 `src/store/conv-messages.js`：

```js
/**
 * 应用自持的会话消息存储（per convId 的 AI SDK ModelMessage 数组）。
 * 仅非 Claude provider（openai-compat 等，resume=false，无 Claude JSONL session）使用；
 * Claude 会话历史仍由 Claude Code 的 JSONL/resume 维护，不经这里。
 * 单文件 conv-messages.json = { [convId]: Message[] }，走 store/index.js 文件锁读改写。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'conv-messages.json';
/** 每会话保留最近 N 条（对齐 openai-compat 的 compaction=false，简单截断防膨胀） */
export const MAX_MESSAGES = 200;

/** 纯函数：合并 prev + msgs 并截断到最近 max 条。单测目标。 */
export function mergeMessages(prev, msgs, max = MAX_MESSAGES) {
  const base = Array.isArray(prev) ? prev : [];
  const add = Array.isArray(msgs) ? msgs : [];
  const next = base.concat(add);
  return next.length > max ? next.slice(-max) : next;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 取某会话的消息数组（无则空数组） */
export function getMessages(convId) {
  if (!convId) return [];
  const store = readJson(FILE, {});
  return isPlainObject(store) && Array.isArray(store[convId]) ? store[convId] : [];
}

/** 追加消息并落盘（锁内），返回该会话截断后的最新数组 */
export function appendMessages(convId, msgs) {
  if (!convId || !Array.isArray(msgs) || msgs.length === 0) return getMessages(convId);
  let out = [];
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    store[convId] = mergeMessages(store[convId], msgs);
    out = store[convId];
    return store;
  });
  return out;
}

/** 清空某会话消息（无该会话则不写盘） */
export function clearMessages(convId) {
  if (!convId) return;
  updateJson(FILE, {}, (cur) => {
    const store = isPlainObject(cur) ? cur : {};
    if (!(convId in store)) return undefined;
    delete store[convId];
    return store;
  });
}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/store/conv-messages.test.js"` — Expected: PASS（4 tests，0 fail）。

- [ ] **Step 5: 提交**
```bash
git add src/store/conv-messages.js src/store/conv-messages.test.js
git commit -m "feat(store): 应用自持会话消息存储 conv-messages（非 Claude provider 用）"
```

---

### Task 2: `settings` 凭证条目携带 baseURL/model

**Files:**
- Modify: `src/store/settings.js`（抽出 `makeTokenEntry`；`addToken` 用它 + 加 `extra` 参）
- Test: `src/store/settings.test.js`（追加用例）

- [ ] **Step 1: 写失败测试** — 在 `src/store/settings.test.js` 末尾追加（该文件顶部已 `import ... from './settings.js'`；把导入行改为同时引入 `makeTokenEntry`）：

先把文件顶部的导入行：
```js
import { normalizeSettings } from './settings.js';
```
改为：
```js
import { normalizeSettings, makeTokenEntry } from './settings.js';
```

然后在文件末尾追加：
```js
test('makeTokenEntry：claude 条目不含 baseURL/model，带默认字段', () => {
  const e = makeTokenEntry({ id: 'k1', token: 'sk-x', providerId: 'claude-agent', index: 0, now: 'T' });
  assert.equal(e.id, 'k1');
  assert.equal(e.providerId, 'claude-agent');
  assert.equal(e.token, 'sk-x');
  assert.equal(e.label, '账号1');
  assert.equal(e.status, 'healthy');
  assert.equal(e.updatedAt, 'T');
  assert.equal('baseURL' in e, false);
  assert.equal('model' in e, false);
});

test('makeTokenEntry：openai 条目携带 baseURL/model 与自定义 label', () => {
  const e = makeTokenEntry({ id: 'o1', token: 'sk-o', providerId: 'openai-compat', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', index: 2, now: 'T' });
  assert.equal(e.providerId, 'openai-compat');
  assert.equal(e.label, 'DeepSeek');
  assert.equal(e.baseURL, 'https://api.deepseek.com');
  assert.equal(e.model, 'deepseek-chat');
});

test('makeTokenEntry：label 缺省按 index 生成（账号N）', () => {
  assert.equal(makeTokenEntry({ id: 'x', token: 't', index: 4, now: 'T' }).label, '账号5');
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/store/settings.test.js"` — Expected: FAIL（`makeTokenEntry` 未导出 → 导入报错）。既有 normalizeSettings 用例暂随之失败（同文件导入错误），实现后恢复。

- [ ] **Step 3: 写最小实现** — 在 `src/store/settings.js` 中找到 `genId` 函数定义之后（约 73-75 行的 `genId` 之后）插入纯函数 `makeTokenEntry`：

```js
/** 纯函数：构造一个 token/凭证条目。openai 条目额外带 baseURL/model；claude 条目不含此二字段。
 *  显式传 id/index/now 以保持纯粹可测（无 random/时间副作用）。 */
export function makeTokenEntry({ id, label, token, providerId = 'claude-agent', baseURL, model, index = 0, now }) {
  return {
    id,
    providerId,
    label: label || `账号${index + 1}`,
    token: token || '',
    ...(baseURL != null ? { baseURL } : {}),
    ...(model != null ? { model } : {}),
    status: 'healthy',
    resetsAt: null,
    rateLimitType: null,
    utilization: null,
    updatedAt: now,
  };
}
```

再找到现有 `addToken`：

```js
export function addToken(label, token, providerId = 'claude-agent') {
  return updateSettings((s) => {
    s.tokens.push({
      id: genId(),
      providerId,
      label: label || `账号${s.tokens.length + 1}`,
      token: token || '',
      status: 'healthy',
      resetsAt: null,
      rateLimitType: null,
      utilization: null,
      updatedAt: new Date().toISOString(),
    });
  }).tokens;
}
```

整体替换为（用 `makeTokenEntry` + 加 `extra` 第 4 参携带 baseURL/model）：

```js
export function addToken(label, token, providerId = 'claude-agent', extra = {}) {
  return updateSettings((s) => {
    s.tokens.push(
      makeTokenEntry({
        id: genId(),
        label,
        token,
        providerId,
        baseURL: extra.baseURL,
        model: extra.model,
        index: s.tokens.length,
        now: new Date().toISOString(),
      }),
    );
  }).tokens;
}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/store/settings.test.js"` — Expected: PASS（原 4 normalizeSettings + 新 3 makeTokenEntry = 7 tests，0 fail）。

- [ ] **Step 5: 语法检查 + 相邻回归** — Run: `node --check src/store/settings.js && node --test "src/store/conv-messages.test.js" "src/store/settings.test.js"` — Expected: `node --check` 无输出；测试全 PASS（conv-messages 4 + settings 7 = 11）。

- [ ] **Step 6: 提交**
```bash
git add src/store/settings.js src/store/settings.test.js
git commit -m "feat(store): 抽出纯 makeTokenEntry + addToken 支持 baseURL/model（openai 凭证）"
```

---

## 自检（对照 Phase 3b spec）
- 模块 2 conv-messages 存储 → Task 1 ✅（含纯 mergeMessages + 截断）。
- 模块 1 凭证条目带 baseURL/model → Task 2 ✅（openai 条目扩展字段；claude 条目不变）。
- API 端点 / startOpenAiRun / handleRunStart 路由 / abort-error → 明确划入 3b-2，非本期缺口。
- **行为保真**：`addToken` 现有 2/3 参调用方（server.js:627 等）不受影响（`extra` 默认 `{}`）；`makeTokenEntry` 产出与旧 addToken 内联对象逐字等价（仅字段顺序无关差异 + 可选 baseURL/model）。

## 占位符扫描：无 TBD；每步含完整代码/命令/预期。
## 命名一致性：`mergeMessages`/`getMessages`/`appendMessages`/`clearMessages`/`MAX_MESSAGES`、`makeTokenEntry`（id/label/token/providerId/baseURL/model/index/now）全程一致。

## 验证命令注意
- 一律引号 glob：`node --test "src/store/conv-messages.test.js"`。**不要**裸 `node --test`（挂在根 Playwright 脚本）或目录形式（Node v24/Win 静默假绿）。

## 提交纪律
- 只 `git add` 每 Task 列出的确切文件，不用 `git add -A`。分支：继续 `feat/config-import-export`。
