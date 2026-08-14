# 设置页面（飞书凭证 + 备用 Token 轮换）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git 提交约定**：本计划按 TDD 惯例在每个 Task 末尾附 `git commit` 步骤。但本项目 owner 有「未主动要求不执行 git 操作」的长期准则——执行时若未获授权，**跳过 commit 步骤**、把多个 Task 的改动留在工作区，由 owner 决定何时提交。

**Goal:** 在 web 执行台新增设置页，支持配置飞书 App ID/Secret（热重连长连接）与管理多个备用 `CLAUDE_CODE_OAUTH_TOKEN`（即将耗尽自动切换、标记重置时间、重置后自动切回、前端提醒）。

**Architecture:** 新增 `store/settings.js`（持久化）与 `features/token-rotation.js`（轮换状态机，纯函数 + 有状态胶水）。active token 不落库，由 `pickActive()` 实时计算=偏好最高的可用号，使「重置后切回原账号」自然涌现。飞书凭证经 `settings.json` 落盘，`claude-feishu` 进程 `fs.watch` 热重载 WS。撞墙续跑复用现有 `pending-resume` + `doResume` 骨架。

**Tech Stack:** Node ESM、`@anthropic-ai/claude-agent-sdk`（`options.env` 按次覆盖 token）、`@larksuiteoapi/node-sdk`（`WSClient.close/start`）、`node:test` 单测、无构建静态前端。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `.gitignore` | 改 | 忽略 `settings.json`、`feishu-status.json` |
| `src/store/settings.js` | 建 | 设置持久化：飞书凭证 + token 池 CRUD |
| `src/features/token-rotation.js` | 建 | 轮换引擎：纯函数状态机 + 有状态胶水 + switch-back 定时器 |
| `src/features/token-rotation.test.js` | 建 | 纯函数单测 |
| `src/shared/config.js` | 改 | `getLarkCredentials()`（settings 优先、env 兜底） |
| `src/integrations/claude.js` | 改 | `runClaude` 透传 `env` 到 `query({options.env})` |
| `src/integrations/lark.js` | 改 | `createWsClient(creds, handlers)`、`resetApiClient(creds)` |
| `src/entrypoints/feishu/index.js` | 改 | `startWs()`/`reload()` + 目录 `fs.watch` 热重载 + `feishu-status.json` |
| `src/entrypoints/web/server.js` | 改 | 设置 API、`/api/tokens/status`、起跑注入 token env、`settleRun` 撞墙续跑、启动重排定时器 |
| `public/index.html` | 改 | ⚙ 按钮 + `settingsMask` 弹层 + token 切换横幅 |
| `public/app.css` | 改 | 设置弹层 / token 行 / 状态徽章 / 横幅样式 |
| `public/app.js` | 改 | 设置弹层逻辑 + token CRUD + `/api/tokens/status` 轮询 |

---

## Task 1: settings 存储 + gitignore

**Files:**
- Modify: `.gitignore`
- Create: `src/store/settings.js`

- [ ] **Step 1: 追加 .gitignore 条目**

在 `.gitignore` 末尾追加两行：

```
settings.json
feishu-status.json
```

- [ ] **Step 2: 创建 `src/store/settings.js`**

```js
/**
 * 设置持久化 —— 唯一入口（settings.json）：飞书凭证 + 备用 token 池。
 * 仅 claude-web 写；claude-feishu 只读飞书凭证。含明文密钥 → 已 gitignore。
 */
import { readJson, writeJson } from './index.js';

const FILE = 'settings.json';
const DEFAULTS = { lark: { appId: '', appSecret: '' }, tokens: [] };

export function getSettings() {
  const s = readJson(FILE, DEFAULTS);
  return {
    lark: { ...DEFAULTS.lark, ...(s.lark || {}) },
    tokens: Array.isArray(s.tokens) ? s.tokens : [],
  };
}

export function getLark() {
  return getSettings().lark;
}

export function setLark(appId, appSecret) {
  const s = getSettings();
  s.lark = { appId: appId || '', appSecret: appSecret || '' };
  writeJson(FILE, s);
  return s.lark;
}

export function getTokens() {
  return getSettings().tokens;
}

export function setTokens(tokens) {
  const s = getSettings();
  s.tokens = Array.isArray(tokens) ? tokens : [];
  writeJson(FILE, s);
  return s.tokens;
}

function genId() {
  return 'tk_' + Math.random().toString(36).slice(2, 8);
}

/** 新增一个备用账号（追加到偏好末尾） */
export function addToken(label, token) {
  const tokens = getTokens();
  tokens.push({
    id: genId(),
    label: label || `账号${tokens.length + 1}`,
    token: token || '',
    status: 'healthy',
    resetsAt: null,
    rateLimitType: null,
    utilization: null,
    updatedAt: new Date().toISOString(),
  });
  return setTokens(tokens);
}

/** 局部更新某账号（改名 patch={label}；换 token patch={token}） */
export function updateTokenMeta(id, patch) {
  const tokens = getTokens().map((t) =>
    t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t,
  );
  return setTokens(tokens);
}

export function removeToken(id) {
  return setTokens(getTokens().filter((t) => t.id !== id));
}

/** 按 id 数组重排偏好顺序；未列出的账号补到末尾（防丢） */
export function reorderTokens(ids) {
  const byId = new Map(getTokens().map((t) => [t.id, t]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const t of byId.values()) if (!ids.includes(t.id)) ordered.push(t);
  return setTokens(ordered);
}
```

- [ ] **Step 3: 冒烟验证**

Run:
```bash
node -e "import('./src/store/settings.js').then(m=>{m.setLark('cli_test','sec');console.log(m.getLark());m.addToken('主账号','sk-ant-oat01-abcd1234');console.log(m.getTokens());})"
```
Expected: 打印 `{ appId: 'cli_test', appSecret: 'sec' }` 和含一条 token 的数组（`status:'healthy'`）。随后手动删除生成的 `settings.json`：`rm settings.json`。

- [ ] **Step 4: Commit**（未获授权则跳过，见头部约定）

```bash
git add .gitignore src/store/settings.js
git commit -m "feat(settings): 新增设置持久化 store + gitignore 密钥文件"
```

---

## Task 2: token 轮换纯逻辑 + 单测（TDD）

**Files:**
- Create: `src/features/token-rotation.js`（先只写纯函数导出）
- Test: `src/features/token-rotation.test.js`

- [ ] **Step 1: 写失败测试 `src/features/token-rotation.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActive, reduceRateLimit, recoverExpired } from './token-rotation.js';

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

test('pickActive：偏好最高的 healthy 优先', () => {
  const list = [mk({ id: 'a', status: 'exhausted' }), mk({ id: 'b' }), mk({ id: 'c' })];
  assert.equal(pickActive(list).id, 'b');
});

test('pickActive：无 healthy 时退而选 warning', () => {
  const list = [mk({ id: 'a', status: 'exhausted' }), mk({ id: 'b', status: 'warning' })];
  assert.equal(pickActive(list).id, 'b');
});

test('pickActive：全 exhausted 返回 null；空池返回 null', () => {
  assert.equal(pickActive([mk({ id: 'a', status: 'exhausted' })]), null);
  assert.equal(pickActive([]), null);
});

test('reduceRateLimit：allowed_warning 标 warning + 记 utilization/resetsAt，active 切到下一个', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  const { tokens, notice } = reduceRateLimit(
    list, 'a',
    { status: 'allowed_warning', utilization: 0.87, resetsAt: 1800, rateLimitType: 'five_hour' },
    1000,
  );
  assert.equal(tokens[0].status, 'warning');
  assert.equal(tokens[0].utilization, 0.87);
  assert.equal(tokens[0].resetsAt, 1800);
  assert.deepEqual(notice, { kind: 'switch', from: 'a', to: 'b', at: 1000 });
  assert.equal(list[0].status, 'healthy'); // 不改入参
});

test('reduceRateLimit：rejected 标 exhausted + resetsAt，active 切换', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  const { tokens, notice } = reduceRateLimit(list, 'a', { status: 'rejected', resetsAt: 5000 }, 1000);
  assert.equal(tokens[0].status, 'exhausted');
  assert.equal(tokens[0].resetsAt, 5000);
  assert.equal(notice.to, 'b');
});

test('reduceRateLimit：rejected 无 resetsAt 时兜底 now+3600', () => {
  const list = [mk({ id: 'a' })];
  const { tokens } = reduceRateLimit(list, 'a', { status: 'rejected' }, 1000);
  assert.equal(tokens[0].resetsAt, 1000 + 3600);
});

test('reduceRateLimit：allowed 恢复 healthy 并清字段', () => {
  const list = [mk({ id: 'a', status: 'warning', utilization: 0.9, resetsAt: 1800 })];
  const { tokens } = reduceRateLimit(list, 'a', { status: 'allowed' }, 1000);
  assert.equal(tokens[0].status, 'healthy');
  assert.equal(tokens[0].resetsAt, null);
  assert.equal(tokens[0].utilization, null);
});

test('reduceRateLimit：active 未变则 notice 为 null', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  // 对非 active 的 b 发 warning，active 仍是 a → 无切换
  const { notice } = reduceRateLimit(list, 'b', { status: 'allowed_warning', utilization: 0.5 }, 1000);
  assert.equal(notice, null);
});

test('reduceRateLimit：未知 tokenId 原样返回', () => {
  const list = [mk({ id: 'a' })];
  const { tokens, notice } = reduceRateLimit(list, 'zzz', { status: 'rejected' }, 1000);
  assert.equal(tokens, list);
  assert.equal(notice, null);
});

test('recoverExpired：resetsAt<=now 的非 healthy 恢复 healthy', () => {
  const list = [
    mk({ id: 'a', status: 'exhausted', resetsAt: 900 }),
    mk({ id: 'b', status: 'warning', resetsAt: 2000 }),
  ];
  const { tokens, changed } = recoverExpired(list, 1000);
  assert.equal(changed, true);
  assert.equal(tokens[0].status, 'healthy');
  assert.equal(tokens[0].resetsAt, null);
  assert.equal(tokens[1].status, 'warning'); // 未到点不动
});

test('recoverExpired：无到点项 changed=false', () => {
  const list = [mk({ id: 'a', status: 'exhausted', resetsAt: 5000 })];
  const { changed } = recoverExpired(list, 1000);
  assert.equal(changed, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/features/token-rotation.test.js`
Expected: FAIL —— `Cannot find module './token-rotation.js'` 或导出未定义。

- [ ] **Step 3: 写纯函数实现 `src/features/token-rotation.js`**

```js
/**
 * 备用 Token 轮换引擎。
 * 纯函数（pickActive / reduceRateLimit / recoverExpired）承载状态机，便于单测；
 * 有状态胶水（Task 3）读写 settings 存储并管理 switch-back 定时器。
 * active token 不落库，由 pickActive 实时计算 = 偏好最高的可用号
 * → “重置后切回原账号”自然涌现（主号恢复 healthy 即重新成为 active）。
 */

// —— 纯函数（单测目标）——

/** 偏好最高的可用 token：healthy 优先 → 退 warning → 全 exhausted / 空池返回 null。列表顺序=偏好 */
export function pickActive(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  return list.find((t) => t.status === 'healthy') || list.find((t) => t.status === 'warning') || null;
}

/**
 * 依据某 token 的限流事件推进状态机。纯函数：不改入参，返回新数组 + 可能的切换通知。
 * @param {Array} tokens
 * @param {string} tokenId 发起该 run 用的 token id（限流归因对象）
 * @param {{status:string,resetsAt?:number,rateLimitType?:string,utilization?:number}} info
 * @param {number} nowSec 当前 epoch 秒（显式传入，避免 Date.now 不确定性）
 * @returns {{tokens:Array, notice:(object|null)}}
 */
export function reduceRateLimit(tokens, tokenId, info, nowSec) {
  const list = Array.isArray(tokens) ? tokens : [];
  const idx = list.findIndex((t) => t.id === tokenId);
  if (idx < 0) return { tokens: list, notice: null };
  const before = pickActive(list);
  const t = { ...list[idx] };
  if (info.status === 'allowed') {
    t.status = 'healthy';
    t.resetsAt = null;
    t.utilization = null;
    t.rateLimitType = null;
  } else if (info.status === 'allowed_warning') {
    t.status = 'warning';
    t.utilization = typeof info.utilization === 'number' ? info.utilization : t.utilization ?? null;
    t.resetsAt = info.resetsAt ?? t.resetsAt ?? null;
    t.rateLimitType = info.rateLimitType ?? t.rateLimitType ?? null;
  } else if (info.status === 'rejected') {
    t.status = 'exhausted';
    t.resetsAt = info.resetsAt ?? nowSec + 3600;
    t.rateLimitType = info.rateLimitType ?? t.rateLimitType ?? null;
  } else {
    return { tokens: list, notice: null };
  }
  t.updatedAt = new Date(nowSec * 1000).toISOString();
  const next = list.slice();
  next[idx] = t;
  const after = pickActive(next);
  const notice =
    (before?.id || null) !== (after?.id || null)
      ? { kind: 'switch', from: before?.label || null, to: after?.label || null, at: nowSec }
      : null;
  return { tokens: next, notice };
}

/**
 * Switch-back：把已到重置时刻（resetsAt<=nowSec）的非 healthy token 恢复 healthy。
 * @returns {{tokens:Array, changed:boolean}}
 */
export function recoverExpired(tokens, nowSec) {
  const list = Array.isArray(tokens) ? tokens : [];
  let changed = false;
  const next = list.map((t) => {
    if (t.status !== 'healthy' && typeof t.resetsAt === 'number' && t.resetsAt <= nowSec) {
      changed = true;
      return { ...t, status: 'healthy', resetsAt: null, utilization: null, rateLimitType: null };
    }
    return t;
  });
  return { tokens: next, changed };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/features/token-rotation.test.js`
Expected: PASS —— `tests 11 / pass 11 / fail 0`。

- [ ] **Step 5: Commit**（未获授权则跳过）

```bash
git add src/features/token-rotation.js src/features/token-rotation.test.js
git commit -m "feat(token): 轮换状态机纯逻辑 + 单测"
```

---

## Task 3: token 轮换有状态胶水（附着到同文件）

**Files:**
- Modify: `src/features/token-rotation.js`（在纯函数之后追加）

- [ ] **Step 1: 追加有状态胶水到 `src/features/token-rotation.js` 末尾**

```js
// —— 有状态胶水（读写 settings、switch-back 定时器、切换通知）——
import { getTokens, setTokens } from '../store/settings.js';

let _notice = null; // 最近一次切换通知（供前端消费）
const _timers = new Map(); // tokenId -> setTimeout（switch-back）

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 掩码 token：前 7 位 + … + 末 4 位；过短直接掩码 */
export function maskToken(tok) {
  const s = String(tok || '');
  return s.length <= 8 ? '••••' : s.slice(0, 7) + '…' + s.slice(-4);
}

/** 当前该用哪个 token 起跑：返回 {id, token, label} 或 null（未配置/全 exhausted → 不注入 env） */
export function getActiveToken() {
  const a = pickActive(getTokens());
  return a ? { id: a.id, token: a.token, label: a.label } : null;
}

/** 记入一次限流事件（tokenId=发起 run 的号）；有变更才持久化，随后重排定时器 */
export function noteRateLimit(tokenId, info) {
  if (!tokenId || !info || !info.status) return;
  const cur = getTokens();
  const { tokens, notice } = reduceRateLimit(cur, tokenId, info, nowSec());
  if (JSON.stringify(cur) !== JSON.stringify(tokens)) setTokens(tokens); // 抑制无谓写盘（减少 feishu watch 抖动）
  if (notice) _notice = notice;
  scheduleAllSwitchBacks();
}

/** 前端轮询数据：active + 掩码列表 + 待消费通知 */
export function getStatus() {
  const tokens = getTokens();
  const a = pickActive(tokens);
  return {
    active: a ? { id: a.id, label: a.label } : null,
    tokens: tokens.map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      resetsAt: t.resetsAt ?? null,
      utilization: t.utilization ?? null,
      masked: maskToken(t.token),
    })),
    notice: _notice,
  };
}

export function consumeNotice() {
  _notice = null;
}

/** 为所有非 healthy 且有 resetsAt 的 token 排 switch-back 定时器（幂等；跨重启在 web 入口调一次） */
export function scheduleAllSwitchBacks() {
  for (const t of getTokens()) {
    if (t.status !== 'healthy' && typeof t.resetsAt === 'number') {
      const prev = _timers.get(t.id);
      if (prev) clearTimeout(prev);
      const delay = Math.min(Math.max(0, t.resetsAt * 1000 - Date.now() + 30000), 2 ** 31 - 1);
      _timers.set(
        t.id,
        setTimeout(() => doRecover(), delay),
      );
    }
  }
}

function doRecover() {
  const { tokens, changed } = recoverExpired(getTokens(), nowSec());
  if (!changed) return;
  setTokens(tokens);
  const a = pickActive(tokens);
  _notice = { kind: 'switch', from: null, to: a?.label || null, at: nowSec() }; // 切回通知（good news）
}
```

- [ ] **Step 2: 确认单测仍全绿（未破坏纯函数导出）**

Run: `node --test src/features/token-rotation.test.js`
Expected: PASS —— `pass 11`。

- [ ] **Step 3: 冒烟验证胶水**

Run:
```bash
node -e "import('./src/store/settings.js').then(async s=>{s.setLark('','');s.setTokens([]);s.addToken('主','sk-ant-oat01-aaaa1111');s.addToken('备','sk-ant-oat01-bbbb2222');const tr=await import('./src/features/token-rotation.js');console.log('active',tr.getActiveToken().label);tr.noteRateLimit(s.getTokens()[0].id,{status:'allowed_warning',utilization:0.9,resetsAt:Math.floor(Date.now()/1000)+60});console.log('after warn active',tr.getActiveToken().label);console.log('status',JSON.stringify(tr.getStatus().tokens.map(t=>[t.label,t.status,t.masked])));})"
```
Expected: `active 主` → `after warn active 备`；status 显示主为 `warning`、掩码形如 `sk-ant-…1111`。随后 `rm settings.json`。

- [ ] **Step 4: Commit**（未获授权则跳过）

```bash
git add src/features/token-rotation.js
git commit -m "feat(token): 轮换有状态胶水（选号/记限流/状态/switch-back 定时器）"
```

---

## Task 4: config 凭证读取 + claude env 透传

**Files:**
- Modify: `src/shared/config.js`
- Modify: `src/integrations/claude.js`

- [ ] **Step 1: `src/shared/config.js` 顶部加导入**

在文件顶部（现有 doc 注释之后、`export const config` 之前）加：

```js
import { getLark } from '../store/settings.js';
```

- [ ] **Step 2: `src/shared/config.js` 末尾追加 `getLarkCredentials()`**

在 `assertLarkConfig` 之后追加：

```js
/** 飞书凭证：settings.json 优先，env 兜底（供 feishu 入口热重载读取） */
export function getLarkCredentials() {
  const s = getLark();
  return {
    appId: s.appId || config.lark.appId || '',
    appSecret: s.appSecret || config.lark.appSecret || '',
  };
}
```

- [ ] **Step 3: `src/integrations/claude.js` 增加 `env` 透传**

在 `runClaude` 的 opts 解构（约 35-57 行）中，`cwd,` 之后加入 `env,`：

```js
  const {
    cwd,
    env,
    permissionMode = 'default',
```

并在 `query({ options: { ... } })` 的展开处（约 71-88 行），紧接 `...(cwd ? { cwd } : {}),` 之后加：

```js
      ...(env ? { env } : {}),
```

同时在函数 JSDoc 里补一行（约在 `@param {string} [opts.cwd]` 之后）：

```js
 * @param {object}   [opts.env]             覆盖子进程环境变量（整体替换语义！须自行 {...process.env,...}）
```

- [ ] **Step 4: 验证语法与导入不成环**

Run: `node -e "import('./src/shared/config.js').then(m=>console.log(typeof m.getLarkCredentials)); import('./src/integrations/claude.js').then(()=>console.log('claude ok'))"`
Expected: 打印 `function` 与 `claude ok`，无循环依赖报错。

- [ ] **Step 5: Commit**（未获授权则跳过）

```bash
git add src/shared/config.js src/integrations/claude.js
git commit -m "feat(config): getLarkCredentials（settings 优先）+ claude env 透传"
```

---

## Task 5: web server 集成（设置 API + token 注入 + 撞墙续跑）

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 追加导入**

在现有 `import { ... } from '../../store/pending-resume.js';` 之后追加：

```js
import {
  getLark,
  setLark,
  addToken,
  updateTokenMeta,
  removeToken,
  reorderTokens,
} from '../../store/settings.js';
import { readJson } from '../../store/index.js';
import {
  getActiveToken,
  noteRateLimit,
  getStatus,
  consumeNotice,
  scheduleAllSwitchBacks,
} from '../../features/token-rotation.js';
```

- [ ] **Step 2: 注册新路由 + 把状态轮询加入访问日志跳过集**

在 `ACCESS_LOG_SKIP` 集合里加入 `'/api/tokens/status'`：

```js
const ACCESS_LOG_SKIP = new Set([
  '/api/tasks',
  '/api/logs',
  '/api/cleanup-log',
  '/api/run/pending',
  '/api/tokens/status',
]);
```

在路由段（`if (url.pathname === '/api/run/pending') ...` 附近）加入三条：

```js
  if (url.pathname === '/api/settings') return handleSettings(req, res);
  if (url.pathname === '/api/tokens/status') return handleTokensStatus(res);
  if (url.pathname === '/api/tokens/dismiss') return handleTokensDismiss(req, res);
```

- [ ] **Step 3: `startClaudeRun` 注入 token env + 归因 + onRateLimit 记账**

在 `startClaudeRun` 内，`let lastRate = null;` 之后加：

```js
  const active = getActiveToken(); // {id, token, label} | null
  run._tokenId = active?.id || null; // 限流归因：记本次用的号
```

把 `const params = {...}` 一行改为（追加 `tokenId`）：

```js
  const params = { session, cwd, model, effort, mode: effectiveMode, convId, resumePendingId, tokenId: run._tokenId };
```

在 `runClaude(prompt, {` 的 opts 里，紧接 `cwd: cwd || undefined,` 之后加一行注入 env（active 为空则不注入，保持现状）：

```js
    ...(active ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: active.token } } : {}),
```

把现有 `onRateLimit` 回调改为（新增 `noteRateLimit`）：

```js
    onRateLimit: (info) => {
      lastRate = info; // 记录最近限流状态，用于额度用尽判定
      if (run._tokenId) noteRateLimit(run._tokenId, info); // 更新 token 池 + 触发切换/定时器
      runRateLimit(run, {
        status: info.status,
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
      });
    },
```

- [ ] **Step 4: 改 `settleRun` —— 撞墙优先用备用号立即续跑**

用下面整体替换现有 `settleRun` 函数（保留其上方注释）：

```js
/** 运行收尾：额度用尽 → 有备用号立即续跑，否则登记待续跑 + 排程 */
function settleRun(run, err, lastRate, params) {
  const rejected = lastRate && lastRate.status === 'rejected'; // 额度耗尽
  const sid = run.session_id || params.session;
  if (rejected && sid && params.convId) {
    const resetsAt = (lastRate && lastRate.resetsAt) || Math.floor(Date.now() / 1000) + 3600;
    // 登记一条待续跑（撞墙号已在 onRateLimit 标记 exhausted）
    const entry = addPending({
      convId: params.convId,
      session_id: sid,
      cwd: params.cwd,
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      resetsAt,
    });
    const backup = getActiveToken(); // 重算：偏好最高的可用号
    if (backup && backup.id !== params.tokenId) {
      // 有健康/warning 备用 → 不等重置，立即续跑（doResume→startClaudeRun 会自动选用备用 token）
      blockRun(run, `⏳ 额度用尽，正在用备用账号「${backup.label || ''}」继续任务…`);
      doResume(entry.id);
    } else {
      // 无可用备用 → 沿用原有等待机制
      const when = new Date(resetsAt * 1000).toLocaleString('zh-CN', { hour12: false });
      scheduleResume(entry);
      blockRun(run, `⏳ 额度用尽，任务已登记：将于 ${when}（token 重置）后自动发送「继续」续跑。`);
    }
    return;
  }
  if (params.resumePendingId) removePending(params.resumePendingId); // 续跑正常收尾 → 清除登记
  if (err) failRun(run, `Agent SDK 执行失败：${err?.message || String(err)}`);
  else finishRun(run);
}
```

- [ ] **Step 5: 新增三个处理函数**

在 `handleRunPending` 函数之后加入：

```js
/** 设置读写：GET 一次性加载（凭证掩码 + 飞书连接状态 + token 掩码列表）；POST 分区保存 */
function handleSettings(req, res) {
  if (req.method === 'GET') {
    const { appId, appSecret } = getLark();
    const feishu = readJson('feishu-status.json', { state: 'idle', at: null, error: null });
    const status = getStatus();
    return sendJson(res, 200, {
      lark: {
        appId: appId || '',
        appSecretMasked: appSecret ? '••••••••' + appSecret.slice(-4) : '',
      },
      feishu,
      tokens: status.tokens, // 已掩码
      active: status.active,
    });
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body || '{}');
      } catch {
        data = {};
      }
      if (data.section === 'lark') {
        const appId = (data.appId || '').trim();
        const appSecret = (data.appSecret || '').trim();
        if (!appId || !appSecret) return sendJson(res, 400, { error: 'App ID / Secret 不能为空' });
        if (!/^cli_/.test(appId)) return sendJson(res, 400, { error: 'App ID 通常以 cli_ 开头' });
        setLark(appId, appSecret);
        return sendJson(res, 200, { ok: true });
      }
      if (data.section === 'tokens') {
        try {
          switch (data.action) {
            case 'add':
              if (!(data.token || '').trim()) return sendJson(res, 400, { error: 'token 不能为空' });
              addToken((data.label || '').trim(), data.token.trim());
              break;
            case 'update':
              updateTokenMeta(data.id, cleanTokenPatch(data));
              break;
            case 'remove':
              removeToken(data.id);
              break;
            case 'reorder':
              reorderTokens(Array.isArray(data.ids) ? data.ids : []);
              break;
            default:
              return sendJson(res, 400, { error: '未知 token action' });
          }
        } catch (e) {
          return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
        }
        return sendJson(res, 200, { ok: true, tokens: getStatus().tokens });
      }
      return sendJson(res, 400, { error: '未知 section' });
    });
    return;
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

/** 仅取 update 允许的字段（label / token），避免前端塞入 status 等被篡改 */
function cleanTokenPatch(data) {
  const patch = {};
  if (typeof data.label === 'string') patch.label = data.label.trim();
  if (typeof data.token === 'string' && data.token.trim()) patch.token = data.token.trim();
  return patch;
}

/** token 状态轻量轮询（前端横幅 / 徽标） */
function handleTokensStatus(res) {
  sendJson(res, 200, getStatus());
}

/** 消费切换通知（前端点「知道了」） */
function handleTokensDismiss(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  consumeNotice();
  sendJson(res, 200, { ok: true });
}
```

- [ ] **Step 6: 启动时重排 switch-back 定时器**

在 `server.listen(...)` 回调里，`for (const e of getPending()) ...` 之后加：

```js
  scheduleAllSwitchBacks(); // 恢复 token switch-back 排程（跨重启）
```

- [ ] **Step 7: 语法自检 + 起服务验证 API**

Run（后台起服务）：
```bash
node --env-file=.env src/entrypoints/web/server.js &
sleep 2
curl -s http://127.0.0.1:3000/api/settings
curl -s http://127.0.0.1:3000/api/tokens/status
curl -s -X POST http://127.0.0.1:3000/api/settings -H 'Content-Type: application/json' -d '{"section":"tokens","action":"add","label":"主账号","token":"sk-ant-oat01-demo12345"}'
curl -s http://127.0.0.1:3000/api/tokens/status
kill %1
rm -f settings.json
```
Expected: `/api/settings` 返回含 `lark/feishu/tokens/active` 的 JSON；add 后 `/api/tokens/status` 的 `tokens` 含一条掩码为 `sk-ant-…2345` 的账号，`active.label` 为「主账号」。

> 注：若无 `.env` 也可 `node src/entrypoints/web/server.js`（token 功能不依赖飞书凭证）。

- [ ] **Step 8: Commit**（未获授权则跳过）

```bash
git add src/entrypoints/web/server.js
git commit -m "feat(web): 设置/ token 状态 API + 起跑注入 token + 撞墙用备用号续跑"
```

---

## Task 6: lark 集成 + feishu 凭证热重载

**Files:**
- Modify: `src/integrations/lark.js`
- Modify: `src/entrypoints/feishu/index.js`

- [ ] **Step 1: `src/integrations/lark.js` —— 顶部导入改为带 `getLarkCredentials`**

把 `import { config } from '../shared/config.js';` 改为：

```js
import { config, getLarkCredentials } from '../shared/config.js';
```

- [ ] **Step 2: `src/integrations/lark.js` —— `getClient` 用凭证兜底 + 新增 `resetApiClient`**

把现有 `getClient` 改为：

```js
let _client = null;
/** 懒实例化 API client；凭证取 getLarkCredentials（settings 优先、env 兜底） */
function getClient() {
  if (!_client) {
    const c = getLarkCredentials();
    _client = new Lark.Client({ appId: c.appId, appSecret: c.appSecret });
  }
  return _client;
}

/** 凭证变更后重建 API client（让 sendText 等换新号）；creds 省略则重新读取 */
export function resetApiClient(creds) {
  const c = creds || getLarkCredentials();
  _client = new Lark.Client({ appId: c.appId, appSecret: c.appSecret });
}
```

- [ ] **Step 3: `src/integrations/lark.js` —— `createWsClient` 收显式凭证 + 状态回调**

把现有 `createWsClient` 改为：

```js
/** 创建长连接客户端（入口层 start 用）；creds 省略则读 getLarkCredentials，handlers 挂状态回调 */
export function createWsClient(creds, handlers = {}) {
  const c = creds || getLarkCredentials();
  return new Lark.WSClient({
    appId: c.appId,
    appSecret: c.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: handlers.onReady,
    onError: handlers.onError,
    onReconnecting: handlers.onReconnecting,
    onReconnected: handlers.onReconnected,
  });
}
```

- [ ] **Step 4: 重写 `src/entrypoints/feishu/index.js`**

整体替换为：

```js
/**
 * 飞书入口 —— 长连接收消息 → 产出统一 Context → dispatch。
 * 凭证经 settings.json（web 设置页写入）；本进程 fs.watch 目录，凭证变更热重载 WS。
 * 连接状态写 feishu-status.json 供 web 设置页读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, getLarkCredentials } from '../../shared/config.js';
import {
  larkSdk,
  createWsClient,
  resetApiClient,
  sendText,
  addReaction,
  removeReaction,
} from '../../integrations/lark.js';
import { dispatch } from '../../app/dispatch.js';
import { logger } from '../../shared/logger.js';
import { writeJson } from '../../store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..'); // 项目根

let wsClient = null;
let activeCreds = { appId: '', appSecret: '' };

function writeStatus(state, error = null) {
  try {
    writeJson('feishu-status.json', { state, at: new Date().toISOString(), error });
  } catch {
    /* 忽略写盘失败 */
  }
}

const seen = new Set(); // 消息去重（飞书失败会重推）

function roleOf(openId) {
  return openId && config.lark.ownerOpenIds.includes(openId) ? 'owner' : 'guest';
}

async function onMessage(data) {
  const openId = data?.sender?.sender_id?.open_id;
  const chatId = data?.message?.chat_id;
  const messageId = data?.message?.message_id;
  const msgType = data?.message?.message_type;

  logger.info('feishu', '收到消息', { openId, chatId, type: msgType, messageId });

  if (!chatId) return;
  if (messageId && seen.has(messageId)) {
    logger.info('feishu', '重复消息已忽略', { messageId });
    return;
  }
  if (messageId) seen.add(messageId);

  if (msgType !== 'text') {
    await sendText(chatId, '目前只支持文本消息～');
    return;
  }

  let text = '';
  try {
    text = (JSON.parse(data.message.content).text || '').trim();
  } catch {
    text = '';
  }
  if (!text) return;

  const ctx = {
    source: 'feishu',
    user: { id: openId, role: roleOf(openId) },
    text,
    sessionKey: chatId,
    reply: (t) => sendText(chatId, t),
    meta: { messageId, chatId },
  };

  const emojis = config.lark.reactionEmojis;
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const reactionId = await addReaction(messageId, emoji);
  try {
    await dispatch(ctx);
  } finally {
    if (reactionId) await removeReaction(messageId, reactionId);
  }
}

const dispatcher = new larkSdk.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    onMessage(data).catch((e) => logger.error('feishu', '处理失败', { err: e?.message || String(e) }));
  },
});

/** 用当前凭证启动 WS；无凭证则置 failed 并等待设置页写入 */
async function startWs() {
  const creds = getLarkCredentials();
  if (!creds.appId || !creds.appSecret) {
    activeCreds = { appId: '', appSecret: '' };
    writeStatus('failed', '未配置飞书凭证（请在 web 设置页填写）');
    logger.warn('feishu', '未配置凭证，等待设置页写入…');
    return;
  }
  activeCreds = creds;
  resetApiClient(creds);
  wsClient = createWsClient(creds, {
    onReady: () => {
      writeStatus('connected');
      logger.info('feishu', 'WS 已连接');
    },
    onError: (err) => {
      writeStatus('failed', err?.message || String(err));
      logger.error('feishu', 'WS 错误', { err: err?.message || String(err) });
    },
    onReconnecting: () => writeStatus('reconnecting'),
    onReconnected: () => writeStatus('connected'),
  });
  try {
    await wsClient.start({ eventDispatcher: dispatcher });
  } catch (e) {
    writeStatus('failed', e?.message || String(e));
    logger.error('feishu', 'WS 启动失败', { err: e?.message || String(e) });
  }
}

/** 凭证变更则拆旧建新（热重载） */
async function reload() {
  const creds = getLarkCredentials();
  if (creds.appId === activeCreds.appId && creds.appSecret === activeCreds.appSecret) return; // 未变
  logger.info('feishu', '凭证变更 → 热重载 WS');
  try {
    wsClient?.close({ force: true });
  } catch {
    /* 忽略关闭异常 */
  }
  await startWs();
}

// 监听项目根目录，仅对 settings.json 变更做防抖热重载（目录始终存在，规避文件不存在时 fs.watch 抛错）
let watchTimer = null;
try {
  fs.watch(ROOT, (_evt, filename) => {
    if (filename !== 'settings.json') return;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(
      () => reload().catch((e) => logger.error('feishu', '热重载失败', { err: e?.message || String(e) })),
      300,
    );
  });
} catch (e) {
  logger.warn('feishu', 'fs.watch 不可用，改用 5s 轮询兜底', { err: e?.message || String(e) });
  setInterval(() => reload().catch(() => {}), 5000);
}

startWs();

console.log(`\n  飞书 bot 已启动（长连接 + 凭证热重载）`);
console.log(
  `  owner: ${config.lark.ownerOpenIds.length ? config.lark.ownerOpenIds.join(', ') : '(未配置，发条消息看日志里的 open_id 再填 OWNER_OPEN_IDS)'}`,
);
```

- [ ] **Step 5: 验证（无凭证时不崩、写 status；配置后热重载）**

Run（无 settings.json、无 env 凭证时应优雅等待，不再 exit(1)）：
```bash
timeout 3 node src/entrypoints/feishu/index.js; cat feishu-status.json
```
Expected: 进程不退出（被 timeout 结束），`feishu-status.json` 为 `{"state":"failed","error":"未配置飞书凭证…"}`。随后 `rm -f feishu-status.json`。

> 真实凭证的热重载（改 settings.json → 看 `feishu-status.json` 变 `connected`）列为手动验证项。

- [ ] **Step 6: Commit**（未获授权则跳过）

```bash
git add src/integrations/lark.js src/entrypoints/feishu/index.js
git commit -m "feat(feishu): 凭证热重载 WS + 连接状态落盘 feishu-status.json"
```

---

## Task 7: 设置页前端（弹层 + token CRUD + 状态轮询）

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.css`
- Modify: `public/app.js`

- [ ] **Step 1: `public/index.html` —— topbar 加 ⚙ 按钮**

在 `<button class="btn" id="logBtn">访问日志</button>` 之后加：

```html
        <button class="btn" id="settingsBtn" title="设置">⚙<span class="badge-dot" id="settingsBadge" hidden></span></button>
```

- [ ] **Step 2: `public/index.html` —— 加 token 切换横幅（放在 pendingBanner 之后）**

在 `<div class="pending-banner" id="pendingBanner" hidden></div>` 之后加：

```html
      <div class="token-banner" id="tokenBanner" hidden></div>
```

- [ ] **Step 3: `public/index.html` —— 加设置弹层（放在「访问日志弹层」之后）**

```html
    <!-- 设置弹层 -->
    <div class="mask" id="settingsMask" hidden>
      <div class="modal">
        <div class="head">
          <h3>设置</h3>
          <button class="close" id="settingsClose">✕</button>
        </div>
        <div class="body">
          <div class="set-sec">
            <div class="set-sec-head">
              <span class="sec-label">飞书凭证</span>
              <span class="feishu-state" id="feishuState">—</span>
            </div>
            <label class="set-field">App ID
              <input id="larkAppId" placeholder="cli_xxxxxxxxxxxx" autocomplete="off" />
            </label>
            <label class="set-field">App Secret
              <input id="larkAppSecret" type="password" placeholder="留空则不改动" autocomplete="new-password" />
            </label>
            <div class="set-actions">
              <button class="btn primary" id="larkSaveBtn">保存并重连</button>
            </div>
          </div>

          <div class="pop-divider"></div>

          <div class="set-sec">
            <div class="set-sec-head">
              <span class="sec-label">Claude 账号（备用 token）</span>
              <span class="active-token" id="activeToken">—</span>
            </div>
            <div class="token-list" id="tokenList"></div>
            <div class="token-add">
              <input id="tokenLabel" placeholder="名称，如 备用A" autocomplete="off" />
              <input id="tokenValue" placeholder="sk-ant-oat01-…" autocomplete="off" />
              <button class="btn" id="tokenAddBtn">＋ 添加</button>
            </div>
          </div>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: `public/app.css` —— 追加样式（文件末尾）**

```css
/* ---- 设置页 ---- */
.set-sec { margin-bottom: 4px; }
.set-sec-head { display: flex; align-items: center; justify-content: space-between; margin: 6px 0; }
.set-field { display: block; font-size: 12px; color: var(--faint); margin: 8px 0; }
.set-field input {
  display: block; width: 100%; margin-top: 4px; box-sizing: border-box;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--fg); font-size: 13px;
}
.set-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.feishu-state { font-size: 12px; }
.feishu-state.ok { color: #37b24d; }
.feishu-state.warn { color: #f08c00; }
.feishu-state.bad { color: #e03131; }
.active-token { font-size: 12px; color: var(--faint); }

.token-list { display: flex; flex-direction: column; gap: 6px; }
.token-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg);
}
.token-row .drag { cursor: grab; color: var(--faint); user-select: none; }
.token-row.dragging { opacity: 0.5; }
.token-row .t-label { font-weight: 600; font-size: 13px; }
.token-row .t-mask { color: var(--faint); font-size: 12px; font-family: monospace; }
.token-row .t-badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; }
.t-badge.healthy { background: rgba(55,178,77,.15); color: #37b24d; }
.t-badge.warning { background: rgba(240,140,0,.15); color: #f08c00; }
.t-badge.exhausted { background: rgba(224,49,49,.15); color: #e03131; }
.token-row .t-reset { font-size: 11px; color: var(--faint); }
.token-row .spacer { flex: 1; }
.token-row .t-act { cursor: pointer; color: var(--faint); background: none; border: none; font-size: 13px; }
.token-row .t-act:hover { color: var(--fg); }
.token-add { display: flex; gap: 6px; margin-top: 8px; }
.token-add input {
  flex: 1; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--fg); font-size: 12px;
}

/* token 切换横幅（沿用 pending-banner 布局风格） */
.token-banner {
  padding: 8px 14px; background: rgba(240,140,0,.12); color: #f08c00;
  font-size: 13px; display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid var(--line);
}
.token-banner .spacer { flex: 1; }
.token-banner button { background: none; border: 1px solid currentColor; color: inherit; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
```

> 说明：`--bg/--fg/--faint/--line` 为项目既有 CSS 变量；若命名不同，执行时以 `app.css` 顶部 `:root` 实际变量名为准替换。

- [ ] **Step 5: `public/app.js` —— 追加设置页逻辑（在 “系统文件夹选择框” 事件段之后、模型 UI 之前的空当处，或文件事件绑定区）**

```js
      // ==== 设置页（飞书凭证 + 备用 token） ====
      const settingsMask = $('#settingsMask');

      function fmtReset(sec) {
        if (!sec) return '';
        return '重置 ' + new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      }

      async function openSettings() {
        settingsMask.hidden = false;
        await loadSettings();
      }
      function closeSettings() {
        settingsMask.hidden = true;
      }

      async function loadSettings() {
        let d;
        try {
          d = await (await fetch('/api/settings')).json();
        } catch {
          toast('读取设置失败');
          return;
        }
        // 飞书
        $('#larkAppId').value = d.lark?.appId || '';
        $('#larkAppSecret').value = '';
        $('#larkAppSecret').placeholder = d.lark?.appSecretMasked ? d.lark.appSecretMasked + '（留空不改）' : 'App Secret';
        const st = $('#feishuState');
        const map = { connected: ['🟢 连接正常', 'ok'], reconnecting: ['🔴 重连中', 'bad'], failed: ['⚠️ 未连接', 'warn'], idle: ['— 未启动', 'warn'] };
        const [txt, cls] = map[d.feishu?.state] || map.idle;
        st.textContent = txt;
        st.className = 'feishu-state ' + cls;
        st.title = d.feishu?.error || '';
        // token
        $('#activeToken').textContent = d.active ? '当前：' + d.active.label : '当前：默认登录';
        renderTokenList(d.tokens || []);
      }

      function renderTokenList(tokens) {
        const box = $('#tokenList');
        box.innerHTML = '';
        tokens.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.draggable = true;
          row.dataset.id = t.id;
          const badgeText = { healthy: '✓健康', warning: '⚠即将耗尽', exhausted: '⛔耗尽' }[t.status] || t.status;
          const util = typeof t.utilization === 'number' ? ' ' + Math.round(t.utilization * 100) + '%' : '';
          row.innerHTML =
            '<span class="drag" title="拖拽调整优先级">⠿</span>' +
            '<span class="t-badge ' + t.status + '">' + badgeText + util + '</span>' +
            '<span class="t-label"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="t-reset">' + (t.status !== 'healthy' ? fmtReset(t.resetsAt) : '') + '</span>' +
            '<span class="spacer"></span>' +
            '<button class="t-act rename" title="改名">✎</button>' +
            '<button class="t-act del" title="删除">🗑</button>';
          row.querySelector('.t-label').textContent = t.label;
          row.querySelector('.t-mask').textContent = t.masked;
          row.querySelector('.rename').onclick = () => renameToken(t.id, t.label);
          row.querySelector('.del').onclick = () => deleteToken(t.id, t.label);
          bindDrag(row, box);
          box.appendChild(row);
        });
      }

      function bindDrag(row, box) {
        row.addEventListener('dragstart', () => row.classList.add('dragging'));
        row.addEventListener('dragend', async () => {
          row.classList.remove('dragging');
          const ids = [...box.querySelectorAll('.token-row')].map((r) => r.dataset.id);
          await postSettings({ section: 'tokens', action: 'reorder', ids });
          await loadSettings();
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          const dragging = box.querySelector('.dragging');
          if (!dragging || dragging === row) return;
          const rect = row.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          box.insertBefore(dragging, after ? row.nextSibling : row);
        });
      }

      async function postSettings(payload) {
        try {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (!r.ok || d.error) {
            toast(d.error || '保存失败');
            return false;
          }
          return true;
        } catch {
          toast('网络错误');
          return false;
        }
      }

      async function saveLark() {
        const appId = $('#larkAppId').value.trim();
        const appSecret = $('#larkAppSecret').value.trim();
        if (!appId) return toast('请填 App ID');
        if (!appSecret) return toast('请填 App Secret（首次或更换时必填）');
        if (await postSettings({ section: 'lark', appId, appSecret })) {
          toast('已保存，飞书正在重连…');
          setTimeout(loadSettings, 1500); // 稍后刷新连接状态
        }
      }

      async function addTokenUI() {
        const label = $('#tokenLabel').value.trim();
        const token = $('#tokenValue').value.trim();
        if (!token) return toast('请填 token');
        if (await postSettings({ section: 'tokens', action: 'add', label, token })) {
          $('#tokenLabel').value = '';
          $('#tokenValue').value = '';
          await loadSettings();
        }
      }

      async function renameToken(id, cur) {
        const label = prompt('新名称', cur);
        if (label == null) return;
        if (await postSettings({ section: 'tokens', action: 'update', id, label: label.trim() })) await loadSettings();
      }

      async function deleteToken(id, label) {
        if (!(await confirmDialog({ title: '删除账号', message: `确认删除「${label}」？`, danger: true }))) return;
        if (await postSettings({ section: 'tokens', action: 'remove', id })) await loadSettings();
      }

      $('#settingsBtn').addEventListener('click', openSettings);
      $('#settingsClose').addEventListener('click', closeSettings);
      settingsMask.addEventListener('click', (e) => {
        if (e.target === settingsMask) closeSettings();
      });
      $('#larkSaveBtn').addEventListener('click', saveLark);
      $('#tokenAddBtn').addEventListener('click', addTokenUI);
```

- [ ] **Step 6: `public/app.js` —— token 状态轮询（并入 pending 轮询节奏）**

在 `refreshPending();` 与 `setInterval(refreshPending, 15000);`（约 1624-1625 行）之后加：

```js
      // token 轮换状态轮询：横幅提醒 + ⚙ 徽标
      async function refreshTokenStatus() {
        let d;
        try {
          d = await (await fetch('/api/tokens/status')).json();
        } catch {
          return; // 静默重试
        }
        const banner = $('#tokenBanner');
        const badge = $('#settingsBadge');
        const anyBad = (d.tokens || []).some((t) => t.status !== 'healthy');
        badge.hidden = !anyBad && !d.notice;
        if (d.notice && d.notice.kind === 'switch') {
          const to = d.notice.to || '备用账号';
          banner.hidden = false;
          banner.innerHTML =
            '<span></span><span class="spacer"></span><button>知道了</button>';
          banner.querySelector('span').textContent =
            `已切换到账号「${to}」，建议开启新对话继续（当前会话仍可继续）`;
          banner.querySelector('button').onclick = async () => {
            banner.hidden = true;
            await fetch('/api/tokens/dismiss', { method: 'POST' }).catch(() => {});
          };
        } else {
          banner.hidden = true;
        }
      }
      refreshTokenStatus();
      setInterval(refreshTokenStatus, 15000);
```

- [ ] **Step 7: 浏览器手动验证**

Run: `node --env-file=.env src/entrypoints/web/server.js`（或无 env 直接 `node src/entrypoints/web/server.js`），浏览器开 `http://127.0.0.1:3000`：
1. 点 ⚙ → 弹层出现；飞书区显示连接状态；账号区可添加/改名/删除/拖拽排序（掩码显示，无完整 token 泄漏）。
2. 添加两个账号后 `activeToken` 显示第一个；拖拽换序后 `当前` 随之变化。
3. 关服务，`rm -f settings.json feishu-status.json`。

Expected: 交互均生效，网络面板中 `/api/settings`、`/api/tokens/status` 返回正常。

- [ ] **Step 8: Commit**（未获授权则跳过）

```bash
git add public/index.html public/app.css public/app.js
git commit -m "feat(ui): 设置弹层（飞书凭证 + 备用 token）+ token 切换横幅/徽标"
```

---

## 自审记录

- **Spec 覆盖**：① 飞书凭证配置=Task 1/4/6/7；热重连=Task 6（fs.watch + close/start）。② token 池 CRUD=Task 1/5/7；每 run 选号=Task 5 Step 3；即将耗尽切换=Task 2/3（allowed_warning）；撞墙续跑=Task 5 Step 4；重置时间标记=Task 2/3（resetsAt）；自动切回=Task 2/3（recoverExpired + pickActive）；前端提醒=Task 7 Step 6。API 面（GET/POST /api/settings、/api/tokens/status、/api/tokens/dismiss）=Task 5。数据模型/掩码安全=Task 1/3/5。测试策略=Task 2 单测 + 各 Task 手动验证。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型/命名一致性**：`pickActive/reduceRateLimit/recoverExpired/getActiveToken/noteRateLimit/getStatus/consumeNotice/scheduleAllSwitchBacks/maskToken` 在 Task 2/3/5 间一致；settings 导出 `getLark/setLark/getTokens/setTokens/addToken/updateTokenMeta/removeToken/reorderTokens` 在 Task 1/4/5 间一致；token 字段 `{id,label,token,status,resetsAt,rateLimitType,utilization,updatedAt}` 全程一致；run 归因字段 `run._tokenId`/`params.tokenId` 一致。
- **YAGNI**：不做多用户、不做用量图表、不做非飞书 IM、不改 PM2 拓扑。
