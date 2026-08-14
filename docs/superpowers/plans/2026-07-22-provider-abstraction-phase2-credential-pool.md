# Provider 抽象 · Phase 2a（凭证池按 provider 泛化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给凭证池加上 `providerId` 维度（Claude 默认值），让"每个 provider 独立选号/轮换"成为可能——全程行为保真，Claude 现有行为一字不变。

**Architecture:** 绞杀者第二步（数据地基）。`src/features/token-rotation.js` 的纯函数 `pickActive` 增加可选 `providerId` 过滤；`reduceRateLimit` 把 switch 通知限定在被限流 token 所属 provider 内；`src/store/settings.js` 的 `normalizeSettings` 幂等回填 `providerId:'claude-agent'`；glue 的 `getActiveToken/getActiveTokenId` 增加 `providerId` 参数（默认 `'claude-agent'`）。不迁移任何 `runClaude` 调用方（那留到 Phase 3 接 OpenAI 时一并做），不改 provider 契约。

**Tech Stack:** Node.js ESM（`type: module`）、`node:test` + `node:assert/strict`。

---

## 本期范围（对照 spec 模块 3）

覆盖 spec `2026-07-22-provider-abstraction-design.md` 模块 3「凭证池泛化」的**数据模型与选号逻辑**部分：`providerId` 字段 + 按 provider 的 `pickActive`/迁移回填。

**不在本期**（后续）：
- 文件重命名 `token-rotation.js → credential-pool.js`：延后到 Phase 3 调用方迁移时一并做，避免现在为改名引入 compat shim 的额外 churn。**本期保留文件名**（模块职责虽已泛化，命名滞后是有意的绞杀者中间态）。
- 迁移 7 处 `runClaude`/`claudeAuthOpts` 调用方到 provider 注册表 → Phase 3。
- 非 Claude 凭证的 env/认证注入方式（OpenAI 用 baseURL/apiKey 而非 `CLAUDE_CODE_OAUTH_TOKEN`）→ Phase 3（届时 OpenAI provider 自己消费其凭证）。
- `doRecover` 的 switch 通知按 provider 细分（当前全局计算；Claude-only 下无影响）→ Phase 3 follow-up。

## 关键兼容性契约（务必保持）

- `pickActive(tokens)`（省略 providerId）= 跨所有 provider 选号 = **现有行为**，现存 14 个测试必须继续通过。
- `pickActive(tokens, providerId)` = 仅在该 provider 内选号；**缺 `providerId` 字段的旧 token 视为 `'claude-agent'`**（防回填前的裸数据）。
- `getActiveToken()` / `getActiveTokenId()`（无参）→ 默认 `'claude-agent'`；因 `normalizeSettings` 回填后所有现存 token 都是 `claude-agent`，结果与现在完全一致。
- `claudeAuthOpts()` 签名与行为不变（内部改用 `getActiveToken('claude-agent')`）。

## 文件结构

- Modify `src/features/token-rotation.js` — `pickActive` 加 providerId 过滤；`reduceRateLimit` 按 provider 限定通知；`getActiveToken`/`getActiveTokenId` 加 providerId 默认参；`getStatus` 输出附带 providerId。
- Modify `src/features/token-rotation.test.js` — 追加 providerId 相关用例；`mk` 支持 providerId。
- Modify `src/store/settings.js` — `normalizeSettings` 回填 providerId（并 `export`）；`addToken` 加 providerId 参数。
- Create `src/store/settings.test.js` — 测 `normalizeSettings` 的回填/幂等（纯函数，不碰真实文件）。

---

### Task 1: `pickActive` 增加 providerId 过滤

**Files:**
- Modify: `src/features/token-rotation.js`（`pickActive` 函数，约 12-15 行）
- Test: `src/features/token-rotation.test.js`（`mk` 辅助 + 追加用例）

- [ ] **Step 1: 写失败测试**

首先把测试文件顶部的 `mk` 辅助改为支持 providerId。找到：

```js
const mk = (o) => ({
  id: o.id,
  label: o.label || o.id,
  token: o.token || ('sk-ant-oat01-' + o.id),
  status: o.status || 'healthy',
  resetsAt: o.resetsAt ?? null,
  rateLimitType: o.rateLimitType ?? null,
  utilization: o.utilization ?? null,
  updatedAt: '2026-01-01T00:00:00.000Z',
});
```

改为（新增一行 `providerId`）：

```js
const mk = (o) => ({
  id: o.id,
  providerId: o.providerId, // 不传即 undefined（模拟回填前旧数据）
  label: o.label || o.id,
  token: o.token || ('sk-ant-oat01-' + o.id),
  status: o.status || 'healthy',
  resetsAt: o.resetsAt ?? null,
  rateLimitType: o.rateLimitType ?? null,
  utilization: o.utilization ?? null,
  updatedAt: '2026-01-01T00:00:00.000Z',
});
```

然后在文件末尾追加三个用例：

```js
test('pickActive：providerId 过滤——只在该 provider 内选号', () => {
  const list = [
    mk({ id: 'c1', providerId: 'claude-agent', status: 'exhausted' }),
    mk({ id: 'o1', providerId: 'openai-compat', status: 'healthy' }),
    mk({ id: 'c2', providerId: 'claude-agent', status: 'healthy' }),
  ];
  assert.equal(pickActive(list, 'claude-agent').id, 'c2');
  assert.equal(pickActive(list, 'openai-compat').id, 'o1');
});

test('pickActive：省略 providerId 时跨所有 provider（向后兼容）', () => {
  const list = [mk({ id: 'a', status: 'exhausted' }), mk({ id: 'b' })];
  assert.equal(pickActive(list).id, 'b');
});

test('pickActive：缺 providerId 字段的旧数据按 claude-agent 处理', () => {
  const list = [mk({ id: 'a' })]; // 无 providerId
  assert.equal(pickActive(list, 'claude-agent').id, 'a');
  assert.equal(pickActive(list, 'openai-compat'), null); // 不属于 openai
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test "src/features/token-rotation.test.js"`
Expected: 新增的 provider 过滤用例 FAIL（当前 `pickActive` 忽略第二参、`pickActive(list,'openai-compat')` 仍返回 a），既有用例仍 PASS。

- [ ] **Step 3: 写最小实现**

在 `src/features/token-rotation.js` 中找到：

```js
export function pickActive(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  return list.find((t) => t.status === 'healthy') || list.find((t) => t.status === 'warning') || null;
}
```

改为：

```js
/** 偏好最高的可用 token：healthy 优先 → 退 warning → 全 exhausted / 空池返回 null。列表顺序=偏好。
 *  providerId 给定时仅在该 provider 内选（缺字段的旧 token 视为 claude-agent）；省略则跨所有 provider（向后兼容）。 */
export function pickActive(tokens, providerId) {
  let list = Array.isArray(tokens) ? tokens : [];
  if (providerId != null) list = list.filter((t) => (t.providerId || 'claude-agent') === providerId);
  return list.find((t) => t.status === 'healthy') || list.find((t) => t.status === 'warning') || null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test "src/features/token-rotation.test.js"`
Expected: 全部 PASS（原 14 + 新 3 = 17 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/features/token-rotation.js src/features/token-rotation.test.js
git commit -m "feat(credential): pickActive 支持按 providerId 选号（向后兼容）"
```

---

### Task 2: `reduceRateLimit` 把 switch 通知限定在同一 provider 内

**Files:**
- Modify: `src/features/token-rotation.js`（`reduceRateLimit` 函数体，约 25-58 行）
- Test: `src/features/token-rotation.test.js`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `src/features/token-rotation.test.js` 末尾追加：

```js
test('reduceRateLimit：switch 通知限定在同一 provider 内（不会误切到别的 provider）', () => {
  const list = [
    mk({ id: 'c1', providerId: 'claude-agent' }),
    mk({ id: 'o1', providerId: 'openai-compat' }),
  ];
  // 限流 claude 唯一号 → 该 provider 内无备用 → to 为 null，且绝不跳到 openai 的 o1
  const { notice } = reduceRateLimit(list, 'c1', { status: 'rejected', resetsAt: 5000 }, 1000);
  assert.equal(notice.from, 'c1');
  assert.equal(notice.to, null);
});

test('reduceRateLimit：同 provider 内有备用则切到该 provider 的备用', () => {
  const list = [
    mk({ id: 'c1', providerId: 'claude-agent' }),
    mk({ id: 'c2', providerId: 'claude-agent' }),
    mk({ id: 'o1', providerId: 'openai-compat' }),
  ];
  const { notice } = reduceRateLimit(list, 'c1', { status: 'rejected', resetsAt: 5000 }, 1000);
  assert.equal(notice.to, 'c2'); // 不会跳到 o1
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test "src/features/token-rotation.test.js"`
Expected: 第一个新用例 FAIL（当前 `pickActive(next)` 跨 provider 计算 → after 会选到 `o1` → `notice.to` 为 'o1' 而非 null）。既有用例仍 PASS。

- [ ] **Step 3: 写最小实现**

在 `src/features/token-rotation.js` 的 `reduceRateLimit` 中找到：

```js
  const idx = list.findIndex((t) => t.id === tokenId);
  if (idx < 0) return { tokens: list, notice: null };
  const before = pickActive(list);
```

改为（插入 `pid` 推导，并把 before 限定到该 provider）：

```js
  const idx = list.findIndex((t) => t.id === tokenId);
  if (idx < 0) return { tokens: list, notice: null };
  const pid = list[idx].providerId || 'claude-agent'; // switch 通知按被限流 token 所属 provider 计算
  const before = pickActive(list, pid);
```

再找到本函数后段：

```js
  const next = list.slice();
  next[idx] = t;
  const after = pickActive(next);
```

改为：

```js
  const next = list.slice();
  next[idx] = t;
  const after = pickActive(next, pid);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test "src/features/token-rotation.test.js"`
Expected: 全部 PASS（17 + 2 = 19 tests）。既有 `reduceRateLimit` 用例（mk 无 providerId → pid 为 'claude-agent' → 全部视为 claude-agent，行为等价）仍绿。

- [ ] **Step 5: 提交**

```bash
git add src/features/token-rotation.js src/features/token-rotation.test.js
git commit -m "feat(credential): reduceRateLimit 的切换通知按 provider 隔离"
```

---

### Task 3: `settings.normalizeSettings` 回填 providerId + `addToken` 支持 providerId

**Files:**
- Modify: `src/store/settings.js`（`normalizeSettings` 约 17-28 行导出并回填；`addToken` 约 78-91 行加参数）
- Test: `src/store/settings.test.js`（新建，纯函数测 `normalizeSettings`）

- [ ] **Step 1: 写失败测试**

写入 `src/store/settings.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from './settings.js';

test('normalizeSettings：缺 providerId 的 token 回填 claude-agent', () => {
  const out = normalizeSettings({ tokens: [{ id: 'a', token: 'x', status: 'healthy' }] });
  assert.equal(out.tokens[0].providerId, 'claude-agent');
});

test('normalizeSettings：已有 providerId 不被覆盖（幂等）', () => {
  const out = normalizeSettings({ tokens: [{ id: 'o', providerId: 'openai-compat', token: 'x' }] });
  assert.equal(out.tokens[0].providerId, 'openai-compat');
  // 再归一一次仍不变（幂等）
  assert.equal(normalizeSettings(out).tokens[0].providerId, 'openai-compat');
});

test('normalizeSettings：非数组 tokens 归一为空数组', () => {
  assert.deepEqual(normalizeSettings({ tokens: 'nope' }).tokens, []);
});

test('normalizeSettings：保留 token 其余字段', () => {
  const out = normalizeSettings({ tokens: [{ id: 'a', token: 'x', status: 'warning', utilization: 0.5 }] });
  assert.equal(out.tokens[0].status, 'warning');
  assert.equal(out.tokens[0].utilization, 0.5);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test "src/store/settings.test.js"`
Expected: FAIL（`normalizeSettings` 当前未导出 → 导入报错 / undefined）。

- [ ] **Step 3: 写最小实现**

在 `src/store/settings.js` 中找到：

```js
function normalizeSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    lark: { ...DEFAULTS.lark, ...(s.lark || {}) },
    tokens: Array.isArray(s.tokens) ? s.tokens : [],
```

改为（`export` + 回填 providerId）：

```js
export function normalizeSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    lark: { ...DEFAULTS.lark, ...(s.lark || {}) },
    // 回填 providerId（幂等）：旧 token 无此字段 → 归属 claude-agent；已有值不覆盖
    tokens: (Array.isArray(s.tokens) ? s.tokens : []).map((t) => ({ providerId: 'claude-agent', ...t })),
```

再找到 `addToken`：

```js
export function addToken(label, token) {
  return updateSettings((s) => {
    s.tokens.push({
      id: genId(),
      label: label || `账号${s.tokens.length + 1}`,
      token: token || '',
      status: 'healthy',
```

改为（加 `providerId` 参数与字段）：

```js
export function addToken(label, token, providerId = 'claude-agent') {
  return updateSettings((s) => {
    s.tokens.push({
      id: genId(),
      providerId,
      label: label || `账号${s.tokens.length + 1}`,
      token: token || '',
      status: 'healthy',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test "src/store/settings.test.js"`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/store/settings.js src/store/settings.test.js
git commit -m "feat(store): settings 回填 token providerId + addToken 支持 providerId"
```

---

### Task 4: glue `getActiveToken`/`getActiveTokenId` 加 providerId 参数 + `getStatus` 透出 providerId

**Files:**
- Modify: `src/features/token-rotation.js`（`getActiveToken` 约 97-100、`getStatus` 约 131-146、`getActiveTokenId` 约 169-172）

> 本任务行为保真（无参调用默认 `'claude-agent'`，回填后所有现存 token 即 claude-agent），故不新增单测，靠"全量单测回归 + 语法检查"守护。

- [ ] **Step 1: 改 `getActiveToken`**

找到：

```js
export function getActiveToken() {
  const a = pickActive(_getTokens());
  return a ? { id: a.id, token: a.token, label: a.label } : null;
}
```

改为：

```js
export function getActiveToken(providerId = 'claude-agent') {
  const a = pickActive(_getTokens(), providerId);
  return a ? { id: a.id, token: a.token, label: a.label } : null;
}
```

- [ ] **Step 2: 改 `getActiveTokenId`**

找到：

```js
export function getActiveTokenId() {
  const a = pickActive(_getTokens());
  return a ? a.id : null;
}
```

改为：

```js
export function getActiveTokenId(providerId = 'claude-agent') {
  const a = pickActive(_getTokens(), providerId);
  return a ? a.id : null;
}
```

- [ ] **Step 3: `getStatus` 输出附带 providerId**

在 `getStatus` 里找到 token 映射：

```js
    tokens: tokens.map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      resetsAt: t.resetsAt ?? null,
      utilization: t.utilization ?? null,
      masked: maskToken(t.token),
    })),
```

改为（增加一行 `providerId`）：

```js
    tokens: tokens.map((t) => ({
      id: t.id,
      providerId: t.providerId || 'claude-agent',
      label: t.label,
      status: t.status,
      resetsAt: t.resetsAt ?? null,
      utilization: t.utilization ?? null,
      masked: maskToken(t.token),
    })),
```

- [ ] **Step 4: 语法检查**

Run: `node --check src/features/token-rotation.js`
Expected: 无输出（成功）。

- [ ] **Step 5: 单测回归**

Run: `node --test "src/features/token-rotation.test.js" "src/store/settings.test.js"`
Expected: 全部 PASS（token-rotation 19 + settings 4 = 23 tests，0 fail）。

再抽查未被本期触及的既有单测（逐文件，诚实退出码）：
Run: `node --test "src/providers/*.test.js" src/store/runs.test.js`
Expected: 全部 PASS。

> ⚠️ **不要**用裸 `node --test` 或目录形式 `node --test src/`：裸形式会匹配到仓库根的 `test-*.mjs`（Playwright，需真服务器）→ 挂起；目录形式在本机（Node v24/Win）**静默假绿**（不发现文件却 exit 0）。一律用 glob（引号）或逐文件。已知无关既有问题：`src/store/user-vars.test.js`（本机数据污染失败）、`src/features/action-runner/slot-filler.test.js`（真实联网）——非本期回归。

- [ ] **Step 6: 提交**

```bash
git add src/features/token-rotation.js
git commit -m "feat(credential): getActiveToken/getActiveTokenId 支持 providerId + getStatus 透出"
```

---

## 自检（写完计划后对照 spec 模块 3）

**1. Spec 覆盖**
- providerId 字段（数据模型）：Task 3（settings 回填 + addToken）✅
- 按 provider 选号 `pickActive(providerId)`：Task 1 ✅
- 按 provider 隔离轮换/通知：Task 2（reduceRateLimit）+ Task 4（getActiveToken/getActiveTokenId）✅
- 文件重命名 credential-pool / 迁移调用方 / 非 Claude 认证注入：明确划入 Phase 3，非本期缺口（范围说明已标注）。

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤含完整前后代码；每个命令步骤含预期输出。

**3. 类型/命名一致性**：`pickActive(tokens, providerId)`、`getActiveToken(providerId)`、`getActiveTokenId(providerId)`、providerId 默认 `'claude-agent'`、缺字段回退 `'claude-agent'` 全程一致。

**4. 行为保真验证**：现存 14 个 token-rotation 测试在 Task 1/2 后仍必须全绿（mk 无 providerId → 视为 claude-agent → 等价旧逻辑）；无参 glue 调用默认 claude-agent。

---

## 提交纪律

- 只 `git add` 每个 Task 列出的确切文件路径，**不用 `git add -A`**。
- 每个 Task 结束即提交，小步可回滚。
- 分支：继续留在 `feat/config-import-export`（Phase 1 已在此）。
