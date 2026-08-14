# 配置导入导出 + Tauri API 基址修复 + web 端隐藏窗口按钮

- 日期：2026-07-21
- 状态：设计已通过（用户 "ok"），待写实现计划

## 背景与问题

`claude-p-web-demo` 已用 Tauri 打包为桌面应用（`src-tauri/`）。用户报告三件事：

1. **构建后打开提示"获取配置失败"**（bug，最紧急）。
2. **设置页缺少"一键导入导出所有配置"功能**（新功能）。
3. **web 端（浏览器）运行时，标题栏的最小化/最大化/关闭按钮不应显示**（bug/交互）。

## 根因分析（已定位）

### 问题 1：构建后 API 全部失败

- `tauri.conf.json` 用 `frontendDist: "../public"`，打包应用把前端静态资源打进包里，webview 从 `tauri://localhost`（Windows 上 `http://tauri.localhost`）加载。
- `public/app.js` 中 **33 处 `fetch('/api/…')`** 与 `new EventSource('/api/run…')` 全是**相对路径**，打包后解析成 `http://tauri.localhost/api/…`，到不了后端 `http://127.0.0.1:3000` → 请求全失败。
- 设置页加载失败时 `toast('读取设置失败')`（即用户所述"获取配置失败"）。
- 开发模式下 `devUrl: http://127.0.0.1:3000`，窗口与后端同源，相对路径正常，所以只在**构建后**暴露。
- 附带：`server.js` 当前**没有任何 CORS 头**，即使前端改用绝对基址，跨源（`tauri.localhost` → `127.0.0.1:3000`）也会被浏览器拦截。

### 问题 3：web 端窗口按钮未隐藏

- `index.html` 的 `#winControls` 带 `hidden` 属性，`app.js` 仅在 `isTauri` 分支里 `winControls.hidden = false`。
- 但 `app.css` 有 `.win-controls { display: flex }`，其特异性盖过 `[hidden]` 属性的 UA `display:none` → **两种模式下按钮都显示**。web 端因此错误地显示了窗口控制按钮。
- 同族 bug 已在项目历史出现过（`.messages` 是 flex，`[hidden]` 被压过）。

### 关于打包后端启动（本次不做，仅记录）

`main.rs` 的 `start_backend()` 跑 `node server.js`，但打包后安装目录里没有 `server.js`/`src/`/`node_modules`，且 `node` 未必在 PATH。**"如何随应用打包/启动后端"是独立的更大问题，本次不解决**。本次目标：**当后端在 `127.0.0.1:3000` 可达时（用户用 PM2 或手动 `node server.js` 起后端），构建后的桌面应用前端能正常通信。**

## 方案

### 改动 ①：修复 Tauri API 基址（问题 1）

**前端（`public/app.js` 顶部，任何请求发生前）**：装一层轻量拦截，33 处调用点零改动。

```js
// 文件最顶部，同步执行（早于所有 fetch/EventSource）
const API_BASE = (typeof window.__TAURI_INTERNALS__ !== 'undefined') ? 'http://127.0.0.1:3000' : '';
if (API_BASE) {
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) input = API_BASE + input;
    else if (input instanceof Request && input.url.startsWith('/')) input = new Request(API_BASE + input.url, input);
    return _fetch(input, init);
  };
  const _ES = window.EventSource;
  window.EventSource = function (url, cfg) {
    if (typeof url === 'string' && url.startsWith('/')) url = API_BASE + url;
    return new _ES(url, cfg);
  };
  window.EventSource.prototype = _ES.prototype;
}
```

- 只重写以 `/` 开头的路径；已写全的绝对 URL（如 `http://127.0.0.1:3000/internal/notify`，app.js:3197）不受影响，不会双重前缀。
- web 模式下 `API_BASE === ''`，`window.fetch`/`EventSource` 完全不被包裹，行为不变。

**后端（`server.js`）**：加 CORS。在请求处理最前面（`const url = new URL(...)` 之后）统一设置：

```js
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
```

- 仅监听 `127.0.0.1`（现状不变），不引入外网暴露风险；`*` 足够（无 cookie/凭证）。
- `OPTIONS` 预检直接 204，满足 `application/json` POST 触发的预检。

**友好错误**：设置页加载失败时，区分"后端不可达"与其他错误，提示改为可操作文案，例如「无法连接后端（127.0.0.1:3000），请确认后端已启动」。实现：`loadSettings` catch 时用 `err` 信息判断（TypeError/Failed to fetch → 后端不可达），toast 相应文案。

### 改动 ②：一键导入/导出配置（问题 2）

**范围（默认）**：仅 `settings.json`——飞书凭证（appId/appSecret）+ 备用 token 池（含 token 明文）+ 机器人文案 messages + UI 偏好 uiPrefs。**默认含明文密钥**（满足"一键迁移换机即用"）。

**导出文件格式**（带类型标记便于导入校验）：

```json
{
  "__type": "claude-agent-config",
  "version": 1,
  "exportedAt": "<ISO 时间，由后端 new Date() 生成>",
  "settings": { "lark": {...}, "tokens": [...], "messages": {...}, "uiPrefs": {...} }
}
```

**后端新增两个路由**（`server.js`，紧挨 `/api/settings` 之后注册；`store/settings.js` 复用现有 getter/setter）：

- `GET /api/settings/export`
  - 返回上述完整 JSON（**原始明文**，含 token 值与 appSecret）。
  - 响应头带 `Content-Disposition: attachment; filename="claude-agent-config-<日期>.json"`（前端也会用 Blob 兜底触发下载）。
  - 读取用 `getSettings()`（原始，不掩码）——注意现有 `GET /api/settings` 走的是掩码路径，export 必须走原始路径。
- `POST /api/settings/import`
  - body = 导出文件 JSON。
  - 校验：`__type === 'claude-agent-config'` 且 `version === 1` 且 `settings` 为对象；否则 400「配置文件格式不正确」。
  - 应用：整体覆盖写入 `settings.json`。实现用 `store/settings.js` 现有 setter 组合：`setLark` / `setTokens` / `setMessages` / `setUiPrefs`（各自做 normalize，脏字段被过滤，天然防坏数据）。token 池 import 时保留原始结构（含 id/label/token/status 等），用 `setTokens(payload.settings.tokens)` 整体覆盖。
  - 应用后调用 `scheduleAllSwitchBacks()` 重排 token 到点恢复定时器（import 可能带 rateLimited 的 resetsAt）。
  - 飞书凭证热重载：`claude-feishu` 进程已 `fs.watch` 根目录 `settings.json`，覆盖写盘自动触发，无需额外动作。
  - 返回 `{ ok: true }`，失败 500 + 错误信息。

**前端 UI（设置页「基础设置」tab，`index.html` `data-tab="basic"` 区块内）**：新增一个「导入 / 导出配置」小节：

- 说明文字（标红/警示样式）：「⚠️ 导出文件含明文密钥（Claude token、飞书 App Secret），请妥善保管，勿外传。」
- 按钮「导出配置」：`fetch('/api/settings/export')` → `blob()` → `URL.createObjectURL` + 动态 `<a download>` 触发下载。文件名 `claude-agent-config-YYYY-MM-DD.json`。
- 按钮「导入配置」：触发隐藏 `<input type="file" accept="application/json">` → 读文件 `text()` → `JSON.parse` → 前端先校验 `__type` → `confirm('导入将覆盖当前所有配置（飞书凭证/账号池/文案/偏好），确定继续？')` → `POST /api/settings/import` → 成功后 toast「导入成功，请重新加载」并 `location.reload()`。
- 解析失败/校验失败：toast「配置文件格式不正确」。

**Tauri 下载兼容性**：`<a download>` 由 WebView2 原生下载支持，可用；文件选择用标准 `<input type=file>`，两端通用。若后续实测 WebView2 下载受限，再降级到 Tauri dialog/fs 插件（本次不预先引入）。

### 改动 ③：web 端隐藏窗口按钮（问题 3）

`app.css` 新增一条：

```css
.win-controls[hidden] { display: none; }
```

- 特异性 `(0,2,0)` 盖过 `.win-controls { display:flex }` `(0,1,0)`。
- web 模式：`hidden` 保持 true → 隐藏；Tauri：app.js 置 `hidden=false` → `[hidden]` 选择器不命中 → `display:flex` 生效 → 正常显示。零 JS 改动。

## 涉及文件

| 文件 | 改动 |
| --- | --- |
| `public/app.js` | 顶部加 API_BASE + fetch/EventSource 包裹；基础 tab 加导入导出按钮的 JS 逻辑；设置加载失败友好提示 |
| `public/index.html` | 基础 tab 内新增「导入/导出配置」小节 + 隐藏 file input |
| `public/app.css` | `.win-controls[hidden]{display:none}`；导入导出小节样式（复用现有 `.set-sec` 等） |
| `src/entrypoints/web/server.js` | 统一 CORS 头 + OPTIONS 204；新增 `GET /api/settings/export`、`POST /api/settings/import` |
| `src/store/settings.js` | 如需：export 复用 `getSettings()`；import 复用 setter（可能无需改动，仅调用） |

## 不做（明确排除）

- **打包后端的启动/分发**（`start_backend` 在安装目录找不到 server.js）——独立大问题，另议。
- 导入导出**不含** action-configs.json / user-vars.json / saved-dirs.json / .env（默认仅 settings.json；用户可后续扩展）。
- 不做导出脱敏（默认含明文，靠 UI 警示 + 用户自行保管）。
- 不引入 Tauri fs/dialog 插件（先用 Blob + file input）。

## 测试策略

- **改动③（CSS）**：手动，浏览器打开 `public/index.html`（web 模式）确认无窗口按钮；Tauri dev 确认有。
- **改动①（API 基址）**：单元层面——`window.fetch` 包裹的路径改写逻辑可抽成纯函数 `resolveApiUrl(input, base)` 加 node --test（`/api/x`→`base+/api/x`、绝对 URL 不变、非 `/` 开头不变）。CORS：`curl -X OPTIONS` 验证 204 + 头；`curl` 带 `Origin` 验证响应头。构建后需真机验证（手动项）。
- **改动②（导入导出）**：
  - 后端：`curl /api/settings/export` 校验返回含 `__type`/`version`/明文 token；`curl -X POST /api/settings/import` 传合法/非法 body 验证 200/400；import 后 `curl /api/settings` 确认新值 + `settings.json` 落盘。
  - import 校验与 payload→setter 映射可抽纯函数加单测（合法/缺 `__type`/版本不符/settings 非对象）。
  - 前端交互手动验证（导出下载、导入确认→reload）。

## 验证前置

后端需在 `127.0.0.1:3000` 可达（PM2 `claude-web` 或 `node server.js`）。改后端后 `pm2 restart claude-web`；前端为静态实时读盘（web 模式刷新即可，Tauri 构建后需重新 build 或 dev 热加载）。
