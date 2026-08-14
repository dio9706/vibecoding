# 配置导入导出 + Tauri API 基址修复 + web 端隐藏窗口按钮 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复构建后"获取配置失败"（Tauri 前端 API 基址 + 后端 CORS），新增一键导入/导出配置，web 端隐藏窗口控制按钮。

**Architecture:** 前端零改调用点——在 `app.js` 顶部包裹 `fetch`/`EventSource`，Tauri 环境自动把 `/api/*` 相对路径改写到 `http://127.0.0.1:3000`；后端 `server.js` 加全局 CORS 头 + OPTIONS 预检，并新增 `GET/POST /api/settings/export|import`。导入导出的构造/校验抽成纯函数 `src/store/config-transfer.js`（node --test），整体覆盖写盘复用新增的 `settings.replaceSettings`。CSS 一行修 `[hidden]` 被 `display:flex` 压过的问题。

**Tech Stack:** Node.js（原生 http，ESM，`node:test`）、原生浏览器 JS（经典脚本 `public/app.js`）、Tauri v2、CSS。

**⚠️ 通用注意事项（所有 public/ 与 src/ 文件）：**
- `public/app.js`、`public/index.html`、`public/app.css` 均为 **CRLF** 行尾——编辑时只改目标行，**不要**把整文件转成 LF（会污染 diff/触发无关改动）。
- `public/app.js` 是**经典脚本**（`<script src="/app.js">`，非 module），顶层 `const` 与 `window.xxx =` 同步生效且全文件可见。
- 后端改动后需 `pm2 restart claude-web`（PM2 app 名 `claude-web`，端口 3000）；`claude-feishu` 进程勿动。
- 验证前置：后端须在 `127.0.0.1:3000` 可达（`pm2 restart claude-web` 或 `node server.js`）。

---

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `public/app.css` | web 端隐藏窗口按钮 + 导入导出小节样式 | 改 |
| `src/entrypoints/web/server.js` | 全局 CORS + OPTIONS；导出/导入路由 | 改 |
| `src/store/config-transfer.js` | 纯函数：导出包构造 + 导入校验（唯一真源类型/版本常量） | 建 |
| `src/store/config-transfer.test.js` | config-transfer 单测（node:test） | 建 |
| `src/store/settings.js` | 新增 `replaceSettings`（导入原子整体覆盖写盘） | 改 |
| `src/store/settings.test.js` | replaceSettings 单测（可选，见 Task 4） | 建 |
| `public/app.js` | 顶部 fetch/EventSource 包裹；loadSettings 友好错误；导入导出 UI 逻辑 | 改 |
| `public/index.html` | 基础 tab 新增「导入/导出配置」小节 + 隐藏 file input | 改 |

---

## Task 1: web 端隐藏窗口控制按钮（CSS 一行）

**Files:**
- Modify: `public/app.css`（`.win-controls` 规则附近，约 313 行）

**背景：** `#winControls` 默认带 `hidden` 属性，`app.js` 仅在 Tauri 分支置 `hidden=false`；但 `.win-controls{display:flex}` 特异性盖过 `[hidden]` 的 UA `display:none`，导致 web 端也显示。

- [ ] **Step 1: 在 `.win-controls { display: flex; ... }` 规则之后，紧跟一条更高特异性规则**

在 `public/app.css` 的 `.win-controls { ... }` 块结束的 `}` 之后插入：

```css
      /* web（非 Tauri）模式下 hidden 属性保持生效：特异性盖过上面的 display:flex */
      .win-controls[hidden] { display: none; }
```

- [ ] **Step 2: 手动验证 web 模式隐藏**

Run: `pm2 restart claude-web`（确保后端在跑），浏览器打开 `http://127.0.0.1:3000/`
Expected: 标题栏右侧**无**最小化/最大化/关闭按钮（`#winControls` 保持 `hidden`）。DevTools 里 `getComputedStyle(document.getElementById('winControls')).display` 为 `none`。

- [ ] **Step 3: 提交**

```bash
git add public/app.css
git commit -m "fix: hide window controls in web mode (respect [hidden] over display:flex)"
```

---

## Task 2: 后端全局 CORS + OPTIONS 预检

**Files:**
- Modify: `src/entrypoints/web/server.js`（`http.createServer` 回调开头，约 98-100 行，`const url = new URL(...)` 之后、第一个 `if (url.pathname...)` 之前）

**背景：** 打包后前端源 `tauri.localhost` 跨源请求 `127.0.0.1:3000`，当前无任何 CORS 头会被浏览器拦截；`application/json` POST 会触发 OPTIONS 预检。

- [ ] **Step 1: 在请求回调最前面统一设置 CORS 头 + 处理 OPTIONS**

在 `server.js` 中找到：

```js
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
```

在 `const url = new URL(...)` 这一行**之后**插入：

```js
  // CORS：打包后 Tauri webview（源 tauri.localhost）跨源访问本机后端。
  // 仅监听 127.0.0.1，无外网暴露；无 cookie/凭证，* 足够。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
```

- [ ] **Step 2: 重启后端并验证预检**

Run:
```bash
pm2 restart claude-web
curl -si -X OPTIONS http://127.0.0.1:3000/api/settings -H "Origin: http://tauri.localhost" -H "Access-Control-Request-Method: POST" | head -12
```
Expected: `HTTP/1.1 204 No Content` + 响应头含 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type`。

- [ ] **Step 3: 验证普通 GET 也带 CORS 头**

Run: `curl -si http://127.0.0.1:3000/api/ping | head -8`
Expected: 200 + 响应头含 `Access-Control-Allow-Origin: *`。

- [ ] **Step 4: 提交**

```bash
git add src/entrypoints/web/server.js
git commit -m "feat: add CORS headers + OPTIONS preflight for cross-origin Tauri webview"
```

---

## Task 3: 纯函数模块 config-transfer（TDD）

**Files:**
- Create: `src/store/config-transfer.js`
- Test: `src/store/config-transfer.test.js`

- [ ] **Step 1: 先写失败测试**

创建 `src/store/config-transfer.test.js`：

```js
/**
 * 配置导入导出纯函数单测。
 * buildExport：把 settings 包成带类型/版本标记的导出对象。
 * parseImport：校验导入对象的类型/版本/结构，返回 {ok, settings} | {ok:false, error}。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_TYPE,
  CONFIG_VERSION,
  buildExport,
  parseImport,
} from './config-transfer.js';

test('buildExport：包上类型/版本/时间戳，原样带上 settings', () => {
  const settings = { lark: { appId: 'cli_x' }, tokens: [{ id: 't1' }] };
  const out = buildExport(settings, '2026-07-21T00:00:00.000Z');
  assert.equal(out.__type, CONFIG_TYPE);
  assert.equal(out.version, CONFIG_VERSION);
  assert.equal(out.exportedAt, '2026-07-21T00:00:00.000Z');
  assert.deepEqual(out.settings, settings);
});

test('buildExport：缺省时间戳/缺省 settings 有安全默认', () => {
  const out = buildExport();
  assert.equal(out.exportedAt, null);
  assert.deepEqual(out.settings, {});
});

test('parseImport：合法对象通过并回传 settings', () => {
  const raw = { __type: CONFIG_TYPE, version: CONFIG_VERSION, settings: { tokens: [] } };
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { tokens: [] });
});

test('parseImport：类型不符 → ok:false', () => {
  const r = parseImport({ __type: 'other', version: 1, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /类型/);
});

test('parseImport：版本不符 → ok:false', () => {
  const r = parseImport({ __type: CONFIG_TYPE, version: 999, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /版本/);
});

test('parseImport：settings 缺失/非对象 → ok:false', () => {
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: CONFIG_VERSION }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: CONFIG_VERSION, settings: [] }).ok, false);
});

test('parseImport：非对象/null/数组入参 → ok:false，不抛', () => {
  assert.equal(parseImport(null).ok, false);
  assert.equal(parseImport('x').ok, false);
  assert.equal(parseImport([]).ok, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/config-transfer.test.js`
Expected: FAIL —— 模块 `./config-transfer.js` 不存在（`ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 3: 写最小实现**

创建 `src/store/config-transfer.js`：

```js
/**
 * 配置导入导出的纯函数（无 I/O，可单测）。
 * 唯一真源：导出包的类型标记与版本号。导入前用 parseImport 做结构校验。
 */
export const CONFIG_TYPE = 'claude-agent-config';
export const CONFIG_VERSION = 1;

/** 把 settings 包成带类型/版本/时间戳的导出对象 */
export function buildExport(settings, exportedAt) {
  return {
    __type: CONFIG_TYPE,
    version: CONFIG_VERSION,
    exportedAt: exportedAt || null,
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
  };
}

/** 校验导入对象；通过返回 {ok:true, settings}，否则 {ok:false, error} */
export function parseImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '配置文件格式不正确' };
  }
  if (raw.__type !== CONFIG_TYPE) {
    return { ok: false, error: '配置文件类型不匹配' };
  }
  if (raw.version !== CONFIG_VERSION) {
    return { ok: false, error: '配置文件版本不支持' };
  }
  if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) {
    return { ok: false, error: '配置内容缺失' };
  }
  return { ok: true, settings: raw.settings };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/config-transfer.test.js`
Expected: PASS（7 tests，0 fail）。

- [ ] **Step 5: 提交**

```bash
git add src/store/config-transfer.js src/store/config-transfer.test.js
git commit -m "feat: add config-transfer pure functions (buildExport/parseImport) with tests"
```

---

## Task 4: settings.replaceSettings（导入原子写盘）

**Files:**
- Modify: `src/store/settings.js`（在文件末尾、`setUiPrefs` 之后追加）
- Test: `src/store/settings.test.js`（新建；如项目约定不测有 I/O 的 store，可跳过测试，仅保留 Step 3/5，见说明）

**背景：** 导入需一次性覆盖整份 settings（lark/tokens/messages/uiPrefs），走一次文件锁写盘 → 单次 `fs.watch` 触发飞书热重载，避免 4 个 setter 各写一次产生中间态。`normalizeSettings` 已能过滤脏字段。

- [ ] **Step 1: 写失败测试（临时目录隔离）**

创建 `src/store/settings.test.js`：

```js
/**
 * settings.replaceSettings 单测：整体覆盖 + normalize（脏字段被过滤）。
 * 用独立 CWD 指向临时目录，避免污染项目根的 settings.json。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('replaceSettings：整体覆盖并 normalize，未知字段被丢弃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { replaceSettings, getSettings } = await import('./settings.js?ts=' + dir.replace(/\W/g, ''));
    replaceSettings({
      lark: { appId: 'cli_abc', appSecret: 's3cret' },
      tokens: [{ id: 't1', label: 'A', token: 'sk-1' }],
      messages: { welcome: 'hi' },
      uiPrefs: { model: 'opus' },
      bogus: 'should be dropped',
    });
    const s = getSettings();
    assert.equal(s.lark.appId, 'cli_abc');
    assert.equal(s.lark.appSecret, 's3cret');
    assert.equal(s.tokens.length, 1);
    assert.equal(s.messages.welcome, 'hi');
    assert.equal(s.uiPrefs.model, 'opus');
    assert.equal('bogus' in s, false);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

> 说明：`store/index.js` 的 `readJson/updateJson` 以 CWD 相对定位文件；`process.chdir` 到临时目录即可隔离。若实测 `settings.js` 在 import 时缓存了路径导致隔离失败，则删除本测试文件、跳过 Step 1/2/4，仅做 Step 3 实现 + Step 5 提交（replaceSettings 的行为已由 Task 6 的 curl 往返间接覆盖）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/settings.test.js`
Expected: FAIL —— `replaceSettings is not a function`（尚未实现）。

- [ ] **Step 3: 实现 replaceSettings**

在 `src/store/settings.js` 末尾（`setUiPrefs` 函数之后）追加：

```js
/** 整体替换设置（导入用）：对传入对象做 normalize 后单次锁内整体写盘。
 *  一次写盘 → 一次 fs.watch 触发飞书热重载，避免多 setter 的中间态。 */
export function replaceSettings(next) {
  return updateSettings((s) => {
    const n = normalizeSettings(next);
    s.lark = n.lark;
    s.tokens = n.tokens;
    s.messages = n.messages;
    s.uiPrefs = n.uiPrefs;
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/settings.test.js`
Expected: PASS（1 test）。若按 Step 1 说明跳过，则本步略过。

- [ ] **Step 5: 提交**

```bash
git add src/store/settings.js src/store/settings.test.js
git commit -m "feat: add settings.replaceSettings for atomic whole-config import"
```

---

## Task 5: 后端导出/导入路由

**Files:**
- Modify: `src/entrypoints/web/server.js`
  - import 区（约 57-67 行的 `store/settings.js` 解构）加 `getSettings`、`replaceSettings`
  - import 新模块 `config-transfer.js`
  - 路由注册区（约 130 行 `/api/settings` 之后）加两条路由
  - 处理函数（`handleSettings` 之后，约 653 行）加 `handleSettingsExport` / `handleSettingsImport`

- [ ] **Step 1: 扩充 import**

将 `server.js` 中：

```js
import {
  getLark,
  setLark,
  addToken,
  updateTokenMeta,
  removeToken,
  reorderTokens,
  setMessages,
  getUiPrefs,
  setUiPrefs,
} from '../../store/settings.js';
```

改为（追加 `getSettings`、`replaceSettings`）：

```js
import {
  getLark,
  setLark,
  addToken,
  updateTokenMeta,
  removeToken,
  reorderTokens,
  setMessages,
  getUiPrefs,
  setUiPrefs,
  getSettings,
  replaceSettings,
} from '../../store/settings.js';
```

并在 `import { listMessages, sanitizeMessages } from '../../shared/messages.js';` 一行**之后**新增：

```js
import { buildExport, parseImport } from '../../store/config-transfer.js';
```

- [ ] **Step 2: 注册两条路由**

在 `server.js` 找到：

```js
  if (url.pathname === '/api/settings') return handleSettings(req, res);
```

在其**之后**插入（放在 `/api/settings` 精确匹配之后即可，无前缀冲突）：

```js
  if (url.pathname === '/api/settings/export') return handleSettingsExport(req, res);
  if (url.pathname === '/api/settings/import') return handleSettingsImport(req, res);
```

- [ ] **Step 3: 实现两个处理函数**

在 `handleSettings(...)` 函数的结束 `}`（约 653 行）**之后**插入：

```js
/** 导出全部配置（原始明文，含 token 值与 App Secret）。 */
function handleSettingsExport(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const payload = buildExport(getSettings(), new Date().toISOString());
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claude-agent-config-${date}.json"`);
  res.writeHead(200);
  res.end(JSON.stringify(payload, null, 2));
}

/** 导入配置：校验类型/版本后整体覆盖写盘，重排 token 定时器。 */
function handleSettingsImport(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let raw;
    try {
      raw = JSON.parse(body || '{}');
    } catch {
      return sendJson(res, 400, { error: '配置文件格式不正确（非合法 JSON）' });
    }
    const parsed = parseImport(raw);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    try {
      replaceSettings(parsed.settings);
      // 导入的 token 可能带 rateLimited 的 resetsAt → 重排到点恢复定时器
      scheduleAllSwitchBacks();
    } catch (e) {
      return sendJson(res, 500, { error: '导入失败：' + (e?.message || e) });
    }
    logger.info('web', '配置已导入', { tokens: (parsed.settings.tokens || []).length });
    return sendJson(res, 200, { ok: true });
  });
}
```

> 备注：`scheduleAllSwitchBacks`、`logger`、`sendJson` 均已在 `server.js` 顶部导入/定义（`sendJson` 为文件内工具函数）。

- [ ] **Step 4: 重启并验证导出**

Run:
```bash
pm2 restart claude-web
curl -s http://127.0.0.1:3000/api/settings/export | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('type=',j.__type,'ver=',j.version,'hasSettings=',!!j.settings,'tokensIsArray=',Array.isArray(j.settings.tokens))})"
```
Expected: `type= claude-agent-config ver= 1 hasSettings= true tokensIsArray= true`。（若有 token，导出含明文 `token` 字段——可另 `... .tokens[0].token` 目视确认为完整值而非掩码。）

- [ ] **Step 5: 验证导入（合法 + 非法）**

Run（先导出到文件再原样导回，验证幂等 200）：
```bash
curl -s http://127.0.0.1:3000/api/settings/export -o /tmp/cfg.json
curl -s -X POST http://127.0.0.1:3000/api/settings/import -H "Content-Type: application/json" --data-binary @/tmp/cfg.json
echo
curl -s -X POST http://127.0.0.1:3000/api/settings/import -H "Content-Type: application/json" -d '{"__type":"wrong","version":1,"settings":{}}'
```
Expected: 第一条返回 `{"ok":true}`；第二条返回 `{"error":"配置文件类型不匹配"}`（HTTP 400）。

- [ ] **Step 6: 提交**

```bash
git add src/entrypoints/web/server.js
git commit -m "feat: add /api/settings/export and /api/settings/import endpoints"
```

---

## Task 6: 前端 API 基址包裹（fetch + EventSource）

**Files:**
- Modify: `public/app.js`（文件**最顶部**，现有第 1 行 `// ===...` 注释块之前）

**背景：** 打包后前端跑在 `tauri.localhost`，相对路径 `/api/*` 到不了后端。包裹层只在 Tauri 环境把 `/` 开头路径改写到 `127.0.0.1:3000`；web 环境 `API_BASE=''`，完全不包裹。

- [ ] **Step 1: 在 app.js 顶部插入同步包裹层**

在 `public/app.js` 的**第一行之前**插入以下代码块（保持文件其余部分不变，注意 CRLF）：

```js
      // ============================================================
      // API 基址修复（打包 Tauri webview 源为 tauri.localhost，
      // 相对路径 /api/* 到不了本机后端；此处统一改写到 127.0.0.1:3000。
      // web 模式 API_BASE='' → 不包裹，行为不变。必须早于所有请求执行。）
      // ============================================================
      const API_BASE = (typeof window.__TAURI_INTERNALS__ !== 'undefined') ? 'http://127.0.0.1:3000' : '';
      if (API_BASE) {
        const _origFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          if (typeof input === 'string' && input.startsWith('/')) {
            input = API_BASE + input;
          } else if (input instanceof Request && input.url.startsWith('/')) {
            input = new Request(API_BASE + input.url, input);
          }
          return _origFetch(input, init);
        };
        const _OrigES = window.EventSource;
        const PatchedES = function (url, cfg) {
          if (typeof url === 'string' && url.startsWith('/')) url = API_BASE + url;
          return new _OrigES(url, cfg);
        };
        PatchedES.prototype = _OrigES.prototype;
        PatchedES.CONNECTING = _OrigES.CONNECTING;
        PatchedES.OPEN = _OrigES.OPEN;
        PatchedES.CLOSED = _OrigES.CLOSED;
        window.EventSource = PatchedES;
      }

```

> 说明：只改写以 `/` 开头的路径；已写全的绝对 URL（如 `http://127.0.0.1:3000/internal/notify`）不匹配、不受影响，无双重前缀。`const API_BASE` 在经典脚本顶层全文件可见（供后续 loadSettings 错误判断等复用，非必需）。

- [ ] **Step 2: web 模式回归验证（不受影响）**

Run: 浏览器打开 `http://127.0.0.1:3000/`，DevTools Console 执行 `typeof API_BASE, API_BASE`
Expected: `"string" ""`（web 下为空串）；页面聊天/设置正常加载（Network 面板请求仍走相对路径、同源、200）。

- [ ] **Step 3: 语法自检（无 Tauri 也能查）**

Run: `node --check public/app.js`
Expected: 无输出（语法通过）。

- [ ] **Step 4: 提交**

```bash
git add public/app.js
git commit -m "fix: rewrite /api and EventSource paths to 127.0.0.1:3000 under Tauri"
```

---

## Task 7: 设置加载失败友好提示

**Files:**
- Modify: `public/app.js`（`loadSettings` 的 catch，约 2535-2538 行）

- [ ] **Step 1: 区分"后端不可达"与其他错误**

将 `public/app.js` 中：

```js
      async function loadSettings() {
        let d;
        try {
          d = await (await fetch('/api/settings')).json();
        } catch {
          toast('读取设置失败');
          return;
        }
```

改为：

```js
      async function loadSettings() {
        let d;
        try {
          d = await (await fetch('/api/settings')).json();
        } catch (e) {
          const msg = String(e && e.message || e);
          toast(/failed to fetch|networkerror|load failed/i.test(msg)
            ? '无法连接后端（127.0.0.1:3000），请确认后端已启动'
            : '读取设置失败');
          return;
        }
```

- [ ] **Step 2: 语法自检**

Run: `node --check public/app.js`
Expected: 无输出。

- [ ] **Step 3: 手动验证（可选）**

在 web 模式下临时停后端（`pm2 stop claude-web`）→ 打开设置 → 应弹「无法连接后端…」；随后 `pm2 restart claude-web` 恢复。
Expected: 提示为可操作文案而非笼统"读取设置失败"。

- [ ] **Step 4: 提交**

```bash
git add public/app.js
git commit -m "feat: friendlier error when backend unreachable on settings load"
```

---

## Task 8: 前端导入/导出 UI

**Files:**
- Modify: `public/index.html`（基础 tab `data-tab="basic"` 区块内，约 147 行 `</div>` 之前，即"需求/故障处理项目"小节之后）
- Modify: `public/app.js`（新增 `bindConfigTransfer()` 并在设置初始化处调用）
- Modify: `public/app.css`（导入导出小节的警示样式；如复用现有 `.set-sec` 可最小化）

- [ ] **Step 1: 在基础 tab 末尾新增「导入/导出配置」小节**

在 `public/index.html` 基础 tab 内、"需求/故障处理项目"小节（约 133-147 行）的 `</div>` **之后**、基础 tab 容器的收尾 `</div>`（148 行）**之前**插入：

```html
  <!-- 导入 / 导出配置 -->
  <div class="set-sec">
    <div class="set-sec-head">
      <span class="sec-label">导入 / 导出配置</span>
    </div>
    <div class="cfg-warn">⚠️ 导出文件含明文密钥（Claude token、飞书 App Secret），请妥善保管，勿外传。</div>
    <div class="set-actions" style="justify-content:flex-start;gap:10px;">
      <button class="btn" id="cfgExportBtn">导出配置</button>
      <button class="btn" id="cfgImportBtn">导入配置</button>
      <input type="file" id="cfgImportFile" accept="application/json,.json" hidden />
    </div>
    <div style="font-size:11px;color:var(--faint);margin-top:2px;padding:0 2px;">
      导出：飞书凭证 + Claude 账号池 + 机器人文案 + 界面偏好。导入将<strong>覆盖</strong>当前全部配置。
    </div>
  </div>
```

- [ ] **Step 2: 加警示样式**

在 `public/app.css` 末尾追加：

```css
      .cfg-warn {
        font-size: 12px;
        color: var(--red, #e5484d);
        background: rgba(229, 72, 77, 0.08);
        border: 1px solid rgba(229, 72, 77, 0.25);
        border-radius: 8px;
        padding: 8px 10px;
        margin: 4px 0 8px;
      }
```

- [ ] **Step 3: 在 app.js 实现绑定逻辑**

在 `public/app.js` 的 `loadSettings` 函数**之后**（约 2561 行 `}` 之后）新增：

```js
      // 导入 / 导出配置：导出走 Blob 下载；导入选文件→前端校验→确认→POST→reload
      function bindConfigTransfer() {
        const exportBtn = document.getElementById('cfgExportBtn');
        const importBtn = document.getElementById('cfgImportBtn');
        const fileInput = document.getElementById('cfgImportFile');
        if (!exportBtn || !importBtn || !fileInput) return;
        if (exportBtn._bound) return; // 防重复绑定
        exportBtn._bound = true;

        exportBtn.addEventListener('click', async () => {
          try {
            const r = await fetch('/api/settings/export');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const date = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = 'claude-agent-config-' + date + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast('配置已导出');
          } catch (e) {
            toast('导出失败：' + (e && e.message || e));
          }
        });

        importBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = ''; // 允许再次选同一文件
          if (!file) return;
          let raw;
          try {
            raw = JSON.parse(await file.text());
          } catch {
            toast('配置文件格式不正确');
            return;
          }
          if (!raw || raw.__type !== 'claude-agent-config') {
            toast('配置文件类型不匹配');
            return;
          }
          if (!confirm('导入将覆盖当前全部配置（飞书凭证 / 账号池 / 文案 / 偏好），确定继续？')) return;
          try {
            const r = await fetch('/api/settings/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(raw),
            });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
            toast('导入成功，正在重新加载…');
            setTimeout(() => location.reload(), 800);
          } catch (e) {
            toast('导入失败：' + (e && e.message || e));
          }
        });
      }
```

- [ ] **Step 4: 在设置初始化处调用 bindConfigTransfer**

在 `public/app.js` 中找到 `loadSettings()` 的调用点（打开设置面板时会调用；搜索 `loadSettings(`）。在**每次打开设置视图**执行 `loadSettings()` 的相邻位置补一行 `bindConfigTransfer();`（该函数自带 `_bound` 幂等守卫，多次调用安全）。

Run（定位调用点）: `grep -n "loadSettings()" public/app.js`
Expected: 找到调用点（如 `showView('settings')` 分支或 `settingsBtn` 点击）。在其后加 `bindConfigTransfer();`。

- [ ] **Step 5: 语法自检**

Run: `node --check public/app.js`
Expected: 无输出。

- [ ] **Step 6: 手动验证（web 模式）**

Run: `pm2 restart claude-web`，浏览器打开 → ⚙ 设置 → 基础设置 tab
Expected:
1. 见「导入 / 导出配置」小节 + 红色警示条 + 两个按钮。
2. 点「导出配置」→ 浏览器下载 `claude-agent-config-YYYY-MM-DD.json`，内容含 `__type/version/settings`（明文 token）。
3. 点「导入配置」→ 选刚下载的文件 → 弹确认框 → 确定 → toast「导入成功」→ 页面 reload → 设置值不变（幂等）。
4. 选一个非法 JSON 文件 → toast「配置文件格式不正确」，不 reload。

- [ ] **Step 7: 提交**

```bash
git add public/index.html public/app.js public/app.css
git commit -m "feat: config import/export UI in settings basic tab"
```

---

## Task 9: 全量回归 + 构建后真机验证

**Files:** 无（验证任务）

- [ ] **Step 1: 跑全部单测**

Run: `node --test src/**/*.test.js`（或按现有约定逐个：`node --test src/store/config-transfer.test.js src/store/settings.test.js src/store/pending-resume.test.js src/store/runs.test.js src/store/history.test.js src/features/token-rotation.test.js`）
Expected: 全部 PASS（新增 config-transfer 7 + settings 1，与既有 19 合计）。

- [ ] **Step 2: web 模式端到端手测清单**

- 窗口按钮：web 下不显示（Task 1）。
- 设置读写：飞书凭证 / token / 文案 / 基础默认值均正常（回归，未破坏）。
- 导入导出：往返幂等（Task 8）。

- [ ] **Step 3: 构建后真机验证（Tauri）**

Run:
```bash
# 确保后端在跑
pm2 restart claude-web
# 构建 Windows 桌面应用
npm run tauri:build:win
```
安装/运行产物后：
Expected:
1. 打开应用**不再**提示"获取配置失败"/"读取设置失败"（Task 2/6 生效，API 打到 127.0.0.1:3000）。
2. 设置页正常加载飞书状态 / token 列表 / 文案。
3. 聊天流式（EventSource）正常。
4. 桌面模式下窗口按钮正常显示（Task 1 仅影响 web）。
5. 导出能下载文件（WebView2 原生下载）；导入能覆盖并 reload。

> 若 Step 3 出现"后端未启动"提示：说明打包应用未能自起后端（`start_backend` 在安装目录找不到 server.js）——属已知排除项，手动 `node server.js` 或 PM2 起后端后重试。该"打包后端分发"问题另议。

- [ ] **Step 4: 最终提交（如有验证期微调）**

```bash
git add -A
git commit -m "chore: config import/export + tauri api base fix verified"
```

---

## 自检记录（写作后）

- **Spec 覆盖**：① API 基址 → Task 2(后端CORS)+Task6(前端包裹)+Task7(友好错误)；② 导入导出 → Task3(纯函数)+Task4(replaceSettings)+Task5(后端路由)+Task8(前端UI)；③ web 隐藏按钮 → Task1。打包后端分发=明确排除。全覆盖。
- **占位符**：无 TBD/TODO；每个代码步给出完整代码。
- **类型一致**：`CONFIG_TYPE='claude-agent-config'`/`version=1` 在 config-transfer（真源）、server 校验、前端预校验三处一致；`replaceSettings`/`buildExport`/`parseImport`/`bindConfigTransfer` 命名前后一致；`getSettings`/`setTokens` 等复用 settings.js 既有导出。
