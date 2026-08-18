# 原生拖拽转路径 与 迁移 tauri-plugin-opener 设计

**日期**：2026-08-17
**分类**：Tauri 桌面端交互、文件拖拽、系统集成
**概述**：把桌面端文件拖拽从「HTML5 上传副本」切换为「Tauri 原生真实路径」，同时支持文件夹；并将路径打开能力从已废弃的 shell.open 迁移到 tauri-plugin-opener，修复「打开失败：未知错误」。

---

## 1. 背景与根因

本次改造起因于两个用户反馈，排查后发现是两条独立的根因链，但改动区域高度重叠，故合并为一个设计。

### 1.1 问题一：拖入文件先产生副本，且文件夹拖不进来

**现象**：桌面端拖文件进输入框，实际是先把文件复制一份到 `.uploads/`，Claude 拿到的是副本路径；拖文件夹则毫无反应。

**根因链**：

1. `src-tauri/src/main.rs:431` 调用了 `.disable_drag_drop_handler()`，关闭 Tauri 的 Webview IDropTarget 拦截
2. 因此 `tauri://drag-drop` 事件**永不 emit**，`public/js/tauri-init.js:245-251` 的监听器与 `public/js/chat.js:16-20` 的回调是**死代码**
3. 拖拽退化为 WebView2 的 HTML5 路线：`composer.js:119 handleDrop` → `composer.js:95 uploadDropped` → `POST /api/upload` → `routes-files.js:63` 在 `.uploads/` 写副本 → 返回副本绝对路径
4. 文件夹在 HTML5 路线下 `dataTransfer.files` 为空，`handleDrop` 于 `composer.js:123` 直接 return，**静默失败，无任何提示**

**副本方案的隐性代价**：`routes-files.js:202-219` 的 `pruneUploads()` 会清理 `.uploads` 顶层 mtime 超过 7 天的文件，历史会话里的附件路径届时集体失效。

**代码自相矛盾之处**：`composer.js:120` 的注释写「Tauri 模式下 dataTransfer.files 为空」，这是 `disable_drag_drop_handler()` **之前**的事实。加上该调用后 files 不再为空，HTML5 路线复活、Tauri 路线失效，注释与现实相反，会误导后续维护者。

### 1.2 问题二：点击消息里的路径 chip 提示「打开失败：未知错误」

**根因链**（已逐环从 `tauri-plugin-shell-2.3.5` 源码确认）：

1. `src-tauri/tauri.conf.json` **没有 `plugins` 段** → shell 插件的 `open` 配置取默认值 `ShellAllowlistOpen::Unset`
2. `tauri-plugin-shell-2.3.5/src/lib.rs:151-152`：`Unset` 等同 `Flag(true)`，套用内置正则 `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`
3. `chat.js:1013` 传入的是 `C:/Users/DELL/Desktop` 这类本地路径，不匹配这个**只认 URL** 的正则
4. `tauri-plugin-shell-2.3.5/src/scope.rs:209-215` 抛 `Error::Validation`
5. `tauri-plugin-shell-2.3.5/src/error.rs` 的 `impl Serialize` 用 `serialize_str` 把错误序列化成**字符串**，所以 JS 侧 `err` 是 string 而非 Error 对象
6. `chat.js:1018` 写的是 `err?.message` —— 对字符串取 `.message` 恒为 `undefined` → 落到字面量 `'未知错误'`

**关键认知**：`capabilities/default.json` 里的 `shell:allow-open` 只放行「这个命令可被调用」，**能开什么路径由插件 scope 正则另行把关**。这是两道独立的闸门，项目只过了第一道。

**旁证**：外链点击是正常的（`https://...` 匹配该正则），只有本地路径失败。目录 chip 同样失败，不止文件。

第 6 步是**独立缺陷**：它把「路径未通过 scope 正则」这条明确信息吞成了「未知错误」，是本 bug 难以定位的直接原因。无论采用何种修法都必须一并修正。

---

## 2. 目标与范围

### 2.1 核心目标

- 桌面端拖入文件 → 直接得到**真实本地绝对路径**，零副本、无 50MB 上限、路径永久有效
- 桌面端拖入**文件夹** → 同样转为路径 chip
- 点击消息中的路径 chip → 在系统文件管理器中**定位并选中**该项，不再报错
- Markdown 查看器的拖拽区在原生拖拽模式下继续可用
- 收窄而非放宽系统调用的安全面

### 2.2 范围外

- Web 模式（浏览器访问 `127.0.0.1:9701`）的拖拽行为**完全不变**，仍走 `/api/upload` 上传副本。浏览器出于安全永远不提供本地绝对路径，这是物理限制，不是实现选择。
- 从浏览器拖来的图片/链接（只有 URL 无本地路径）不在本次处理范围
- `.uploads` 上传链路保留 —— 需求侧 API 文档上传（`req-chat.js:463`）、附件按钮（`req-view.js:2037`）仍在使用，只是**拖拽**不再经过它

### 2.3 已否决的方案

**放宽 shell 的 open scope 正则**（在 `tauri.conf.json` 加 `plugins.shell.open` 自定义正则放行本地路径）：改动最小，但 `open::that_detached()` 在 Windows 上等价于 `start`，`C:\evil.exe` 同样是「本地路径」，放开正则等于给任何 XSS 开一条 RCE 通道。这与 `capabilities/default.json` 的 `description` 中已确立的安全立场（把 `shell:allow-execute` 的 args 从 `true` 收窄，正是为防 XSS→RCE）直接冲突，故否决。

**用 `dataTransfer.items` + `webkitGetAsEntry()` 支持文件夹**：技术上不成立。这条路能拿到目录**结构**，但拿不到**真实绝对路径**——WebView 出于安全只提供文件名与内容。结果只能递归读出内容再逐个上传副本，恰是本次要摆脱的东西。

---

## 3. 架构设计

### 3.1 拖拽总线（新增 `public/js/drag-bus.js`）

移除 `main.rs:431` 的 `.disable_drag_drop_handler()` 后，Tauri 恢复 IDropTarget 拦截，四个 `tauri://drag-*` 事件开始 emit，**webview 内所有 HTML5 文件拖入彻底失效**。全项目有两个文件拖拽区需要迁移（`composer` 与 `markdown-tool`）。

现有的 `tauri-init.js:13-17` 是**单槽位** `_dropCb`，后注册者覆盖前者，两个拖拽区无法共存。因此引入注册制总线：

```js
registerDropZone({ el, onDrop, onDragOver, onDragLeave })
```

总线监听 `tauri://drag-enter` / `drag-over` / `drag-drop` / `drag-leave`（常量见 `public/vendor/tauri/api-event.js:15-33`），按落点分派给命中的区。

三个必须处理的要点：

**坐标换算**：payload 的 `position` 是**物理像素**（`PhysicalPosition`），而 `elementFromPoint` 接受 CSS 像素，必须除以 `window.devicePixelRatio`。Windows 显示缩放 125%/150% 是常见配置，不换算会命中错误元素——这是此类改造最典型的缺陷。

**命中判定**用 `document.elementFromPoint(x, y)?.closest('[data-drop-zone]')`，而非逐个 `getBoundingClientRect()` 比对。前者天然处理元素层叠、容器滚动、面板隐藏三种情况，后者需要各自补逻辑。

**高亮自理**：HTML5 的 `dragover`/`dragleave` 已不可用，拖入高亮改由总线在 `drag-over`/`drag-leave` 时驱动回调。

总线同时挂载到 `window.dragBus`。原因：`markdown-tool.js` 经传统 `<script>` 引入（`index.html:610`），不是 ES module，无法 `import`。

### 3.2 数据流

```
[Tauri 模式]
资源管理器拖入
  → tauri://drag-drop { paths: string[], position: PhysicalPosition }
  → drag-bus 换算坐标 → elementFromPoint 命中拖拽区
  → 分派 onDrop(paths, cssPosition)
      ├─ composer:      POST /api/fs/stat 批量判类型 → insertPathChip(真实路径)
      └─ markdown-tool: GET /api/fs/read → 渲染

[Web 模式] 保持现状
HTML5 drop → dataTransfer.files → POST /api/upload → .uploads 副本路径
```

---

## 4. 组件改动

### 4.1 输入框（`public/js/composer.js` + `public/js/chat.js`）

按 `window.tauriApi?.isTauri` 分叉：Tauri 注册到拖拽总线走真实路径，Web 保留 HTML5 + 上传副本。

三处配套修改：

- **目录判定改为真实 stat**。`composer.js:145` 现在用「路径最后一段不含 `.` 即视为目录」的启发式，会把 `README`、`Dockerfile`、`LICENSE` 误判成文件夹。改为调用 `/api/fs/stat`。
- **图片缩略图改走 asset 协议**。现在用 `URL.createObjectURL(file)` 生成 blob 预览，原生路径下已无 File 对象，改用 `convertFileSrc()`（`chat.js:920-933` 已有 `toWebviewUrl` 封装可复用）。工作区未提交的 `Cargo.toml` 的 `protocol-asset` feature 正是此项的前置依赖，两件事在此合流。
- **摘除 DOM 拖拽监听**。`chat.js:2674-2681` 的 `dragover`/`dragleave`/`drop` 在 Tauri 下不再触发，必须移除。留着就是新一批永不执行的死代码——问题一的成因正是如此。同理清理 `composer.js:120` 那条已与现实相反的注释。

`uploadDropped()` 与 `handleDrop()` 保留，供 Web 模式使用。

### 4.2 Markdown 查看器（`public/js/markdown-tool.js`）

`openFile(file)` 拆为两个入口：

- `openFileByPath(absPath)` —— Tauri 模式，经 `/api/fs/read` 取内容
- `openFileObject(file)` —— Web 模式，保持现有 `file.text()` 实现

注意：`setupDragDrop()`（:82-99）当前用 `dataTransfer.files[0]`，在原生拖拽开启后必须改注册到总线。

`state.currentFile.path` 的语义从「文件名」变为「绝对路径」，连带三处修正——这三处都是「只有文件名、没有真实路径」造成的既有缺陷，改造后自然消解：

- **`handleHistoryClick()`（:409-422）**：当前实现是拿**已打开文件的内容**重新构造一个 `File` 再 `openFile`，即点击历史项只是重渲染当前文件，无法真正重开历史文件。有了绝对路径后可直接 `openFileByPath(path)`。这是本次改造的直接收益点。
- **`exportHtml()`（:453）**：`a.download = path.replace('.md', '.html')`，绝对路径含 `\` 与 `:`，直接作为下载文件名会失败，须改取 basename。
- **`renderContent()`（:170）**：`fileName.textContent = path` 会从短文件名变成长路径，需要截断展示。

顺带修正 `exportHtml():437` 把 `path` 未转义插入 `<title>` 的既有 XSS 隐患——属于「改到之处顺手修」，不扩大范围。

### 4.3 后端新增接口（`src/entrypoints/web/routes-files.js`）

在 `server.js` 的 `serveStatic` 兜底行之前注册两条路由：

**`POST /api/fs/stat`** —— 请求 `{ paths: string[] }`，响应 `{ results: [{ path, kind: 'file'|'dir'|'missing', size, mtime }] }`。

设计为批量而非单条，因为一次拖拽可能带入数十个文件，逐个请求过于碎片化。

**`GET /api/fs/read?path=`** —— 响应 `{ content, size, mtime }`。约束：

- 扩展名白名单：仅 `.md` / `.markdown`
- 大小上限 10MB（在服务端拦截，避免读完整个文件才拒绝）
- 必须是 regular file（拒绝目录与符号链接指向的特殊文件）
- `path` 参数须经 `src/entrypoints/web/input.js:32` 的 `str()` 归一（fail-closed）

**安全说明（须知悉后再采纳）**：本后端**无 token / session 鉴权**，唯一防线是 `origin.js:31-56` 的 Origin 白名单，且 `origin.js:53` 对**无 Origin 头的请求直接放行**——意味着本机任意进程用 curl 即可调用。因此 `/api/fs/read` 客观上新增了「读取本机任意 `.md` 文件」的能力。

判断依据：现存的 `/api/dirs/browse`（`routes-files.js:111-126`，无路径白名单，可枚举任意目录）与 `/api/open-in-vibe`（`routes-ops.js:332-361`，接受任意路径并 `execFile` 拉起编辑器）已提供同级或更强的能力，本次新增未实质抬高攻击面。此为**判断而非事实**，若不认可，替代方案是改走 asset 协议读取（复用 `assetProtocol.scope` 白名单），代价是需放宽 CSP 的 `connect-src` 且 Web 模式仍需另一套实现。

### 4.4 迁移 tauri-plugin-opener

**Rust 侧**：

- `src-tauri/Cargo.toml` 增加 `tauri-plugin-opener = "2"`
- `src-tauri/src/main.rs` 增加 `.plugin(tauri_plugin_opener::init())`
- **不可移除 shell 插件**：sidecar 启动依赖 `shell:allow-execute`（`capabilities/default.json:25-34` 那条带 validator 的规则）。仅替换 open 能力。

**权限**：`capabilities/default.json:35` 的 `"shell:allow-open"` 替换为 `"opener:default"`。

`opener:default` = `allow-open-url` + `allow-reveal-item-in-dir` + `allow-default-urls`（URL 限 `http`/`https`/`mailto`/`tel`）。**不含 `allow-open-path`**，故不存在「打开任意本地可执行文件」的通道。这比现状的 `shell:allow-open` 严格更窄，是本方案的净安全收益。

**JS 侧 vendor**（本项目无自动化 vendor 脚本，为手工流程）：

1. `npm i -D @tauri-apps/plugin-opener`
2. 复制 `node_modules/@tauri-apps/plugin-opener/dist-js/index.js` → `public/vendor/tauri/plugin-opener.js`
3. 首行 import 说明符由裸包名改为 `./api-core.js`（CSP 已收紧为 `script-src 'self'`，裸说明符与远程 import 均不可用，见 `docs/TAURI_SETUP.md:126-129`）

**调用点**：

- `tauri-init.js:50`：`openPath` 换为 opener 的 `revealItemInDir` 与 `openUrl`，`window.tauriApi` 暴露为语义化的 `{ revealPath, openUrl }`
- **`tauri-init.js:84` 与 `:88` 两处 fallback `invoke('plugin:shell|open', ...)` 必须同步改为 `invoke('plugin:opener|open_url', ...)`**，否则撤下 `shell:allow-open` 后外链 fallback 会静默失效。实施时以 vendor 产物中的实际 invoke 字符串为准核对（预期为 `plugin:opener|open_url` / `plugin:opener|reveal_item_in_dir`）。
- `chat.js:1005-1019 handlePathChipClick`：移除「截取父目录」逻辑，直接 `revealItemInDir(path)`。除语义更准（定位并选中而非仅打开父目录）外，还规避了根目录、结尾带分隔符等边界情况。

**目录 chip 的行为变更（有意为之）**：现状点击目录 chip 是**进入**该目录（`chat.js:975` 的 `title` 写「点击打开目录」）。改用 `revealItemInDir` 后变为**在父目录中选中它**。

保持「进入目录」需要 `opener:allow-open-path`，而该权限同时打开了「用默认程序打开任意路径」的能力——`.exe` / `.bat` / `.lnk` 会被直接执行，正是 2.3 否决方案的同一个 RCE 通道。两害相权，接受这一行为退化，并同步把 `chat.js:975` 的 `title` 改为「点击在文件夹中定位」，避免提示与实际不符。

若后续确需「进入目录」，正确做法是新增一个 Rust 侧受限命令（内部固定调用 `explorer.exe <dir>` 并校验入参确为目录），而非放开通用 open-path。本次不做。

**错误提取修正**（`chat.js:1018`，独立于修法均须执行）：

```js
const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
```

Tauri 命令 reject 时传回的是序列化后的字符串，`err?.message` 恒为 `undefined`。

### 4.5 assetProtocol scope 放宽（`src-tauri/tauri.conf.json`）

`allow` 从 `["$HOME/**"]` 放宽至 `["**"]`（全盘），保留现有 `deny`（`$HOME/.ssh/**`、`$HOME/.aws/**`、`$HOME/.gnupg/**`）。

`**` 能否在 Windows 下匹配跨盘符路径需实施时实测确认；若不生效，退化为按盘符枚举（`C:/**`、`D:/**` …）。

理由：改用真实路径后，拖入的图片可能位于 `$HOME` 之外（D 盘、外接盘）。scope 不放宽时缩略图会**静默**降级为文件 chip（`makeImageElement` 的 `img.onerror` 兜底），无任何报错，表现为「图片预览莫名失效」，排查成本高。

---

## 5. 错误处理

| 场景 | 处理 |
|---|---|
| 拖入路径已不存在 | `/api/fs/stat` 返回 `kind:'missing'`，chip 以警示样式插入，不静默丢弃 |
| `/api/fs/stat` 请求失败 | 降级为按扩展名启发式判定图标，仍插入 chip（保证拖拽不因后端抖动而完全失效） |
| Markdown 读取超限/扩展名不符 | 后端返回明确错误文案，前端 toast 原样展示 |
| `revealItemInDir` 失败 | 按 4.4 的修正提取真实错误串展示，禁止再出现「未知错误」 |
| opener vendor js 加载失败 | 沿用 `tauri-init.js:51-53` 的既有降级：`console.warn` 且不影响窗口控制 |

原则：**不得静默失败**。问题一中「拖文件夹毫无反应」正是静默 return 造成的。

---

## 6. 验证要点

自动化测试无法覆盖原生拖拽（需真实 OS 拖放操作），以下为**必须实机验证**的清单：

1. 拖入单个文件 → chip 显示真实路径，`.uploads` 目录**无新增文件**
2. 拖入文件夹 → chip 显示 📁 与真实路径
3. 拖入多选文件（含中文名、空格、无扩展名文件如 `Dockerfile`）→ 图标判定正确
4. 拖入 D 盘图片 → 缩略图正常显示（验证 4.5 的 scope 放宽）
5. **Windows 显示缩放设为 150%** 下重复 1-3 → 验证坐标换算（3.1 的核心风险点）
6. 拖到 Markdown 查看器区域 → 正确分派，不误入输入框
7. 点击消息中的文件 chip → 资源管理器打开并**选中**该文件
8. 点击目录 chip → 在父目录中定位选中（注意这是 4.4 所述的**有意行为变更**，不是缺陷）
9. 点击外链 → 系统浏览器打开（验证 `opener:default` 的 `allow-default-urls` 覆盖 https）
10. **`settings-panel.js:161-205` 的 token 排序拖拽仍正常** —— 该处使用 webview 内部 HTML5 DnD，理论上不经 OLE drop target 故不受影响，但这是**推断而非验证**，必须实测
11. Web 模式（浏览器开 `127.0.0.1:9701`）拖拽行为无变化
12. Markdown 历史项点击 → 真正重新打开该文件（验证 4.2 的缺陷修复）

---

## 7. 变更文件清单

| 文件 | 变更类型 |
|---|---|
| `src-tauri/src/main.rs` | 移除 `.disable_drag_drop_handler()`；注册 opener 插件 |
| `src-tauri/Cargo.toml` | 新增 `tauri-plugin-opener`（`protocol-asset` 已在工作区） |
| `src-tauri/tauri.conf.json` | 放宽 `assetProtocol.scope.allow` |
| `src-tauri/capabilities/default.json` | `shell:allow-open` → `opener:default` |
| `public/js/drag-bus.js` | **新增**：拖拽总线 |
| `public/vendor/tauri/plugin-opener.js` | **新增**：手工 vendor |
| `public/js/tauri-init.js` | 移除单槽位 `_dropCb`；openPath → revealItemInDir/openUrl；修两处 fallback |
| `public/js/composer.js` | Tauri/Web 分叉；`insertPathChip` 接真实 stat 与 asset 缩略图 |
| `public/js/chat.js` | 摘除 DOM 拖拽监听；`handlePathChipClick` 改 reveal；修错误提取 |
| `public/js/markdown-tool.js` | 拆双入口；注册总线；修 history/export/展示三处 |
| `src/entrypoints/web/routes-files.js` | **新增** `/api/fs/stat`、`/api/fs/read` |
| `src/entrypoints/web/server.js` | 注册两条新路由 |
| `package.json` | 新增 `@tauri-apps/plugin-opener` devDependency |
