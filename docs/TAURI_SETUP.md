# Tauri 开发环境设置

## 前置条件

| 工具 | 检查命令 | 安装方式 |
|------|---------|---------|
| Node.js v20+ | `node -v` | https://nodejs.org |
| Rust | `rustc --version` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| MSVC（Windows）| `rustc --version` 正常即可 | Visual Studio Build Tools → Desktop development with C++ |
| Xcode CLI（macOS）| `xcode-select -p` | `xcode-select --install` |

---

## 第一次启动（开发模式）

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式（首次编译 5-10 分钟）
npm run tauri:dev
```

Tauri 桌面窗口打开后，会尝试通过 sidecar 启动 Node.js 后端。
若 sidecar 不可用（开发模式正常现象），会自动降级到系统 node。

### 手动启动后端（如自动启动失败）

```bash
# 另开一个终端
node server.js
```

然后在 Tauri 窗口按 `F5`/`Ctrl+R` 刷新即可。

---

## 日常开发工作流

### 修改前端代码 (`public/`)

保存后在 Tauri 窗口按 `F5` 刷新，或等 live-reload 自动触发。

### 修改后端代码 (`server.js` / `src/`)

手动重启后端进程（不需要重启 Tauri）：

```bash
# Windows
taskkill /F /IM node.exe
node server.js

# macOS / Linux
pkill -f "node server.js"
node server.js
```

### 修改 Rust 代码 (`src-tauri/src/main.rs`)

停止 `tauri dev`，重新 `npm run tauri:dev`（会增量编译，通常 1-2 分钟）。

---

## 常见问题

### 1. "Rust toolchain not found"

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# 重开终端后验证
rustc --version
```

### 2. Windows：缺少 MSVC 工具链

下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)，
勾选「**Desktop development with C++**」组件。

### 3. 端口 3000 被占用

```bash
# Windows
netstat -ano | findstr :3000
taskkill /F /PID <pid>

# macOS
lsof -i :3000
kill -9 <pid>
```

### 4. 首次编译超慢（>15 分钟）

Rust 首次全量编译所有依赖。后续增量编译只需 1-3 分钟。
若内存 <4GB，编译会明显变慢，建议增大虚拟内存或使用 CI 编译。

### 5. macOS Gatekeeper 拦截

首次运行未签名的 .app 时，右键 → 「打开」→「仍要打开」即可。
二期添加 Apple Developer 签名后会消除此提示。

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+P` (Win) / `Cmd+Shift+P` (Mac) | 从任意应用唤起 Principal 窗口 |
| `Ctrl+N` | 新建任务（菜单栏 File → New Task） |
| 点击「×」关闭窗口 | 最小化到系统托盘（不退出） |
| 托盘右键 → Quit | 完全退出应用 |

---

## 安全配置说明（CSP 与 shell 能力）

> tauri.conf.json / capabilities 都是严格 schema 的 JSON，**不接受任何自定义字段**
> （加 `_comment` 会直接报 `Additional properties are not allowed` 导致构建失败），
> 故把依据记在这里。

### `app.security.csp`

原值为 `null`（完全不设 CSP）。配合 `withGlobalTauri: true` 与 `shell:allow-execute`，
任何一个 XSS（例如渲染模型输出的 markdown 时未消毒）都能直接升级为本机任意代码执行。

收紧的前置条件已经就绪，缺一不可：

1. `public/index.html` 中**没有内联 `<script>`**（已核实为 0），所以 `script-src 'self'` 可行；
2. 全部第三方脚本已改为**随包 vendor**（`public/vendor/`），不再从 jsdelivr 动态 import
   —— 否则 `script-src 'self'` 会把 Tauri API 的加载一并挡掉。

各指令的约束来源：

| 指令 | 为什么这么写 |
|------|--------------|
| `connect-src … http://127.0.0.1:* ws://127.0.0.1:*` | sidecar 端口不固定：默认 9701，冲突时自增；PM2 模式走 3000。写死端口会让后端连不上 |
| `connect-src … ipc: http://ipc.localhost` | Tauri v2 的 IPC 通道，去掉则所有 `invoke` 失效 |
| `style-src 'self' 'unsafe-inline'` | 前端大量使用内联 `style` 属性（CSP3 下由 `style-src-attr` 管辖，需要 `unsafe-inline`） |
| `img-src … data: blob: asset: http://asset.localhost` | 头像/截图走 data 与 blob；`asset:` 是 Tauri 的本地资源协议 |

**改动后必须真机验收**（CSP 违规只在打包后的 webview 里暴露，`npm test` 与浏览器模式都测不到）：
打开 DevTools 控制台确认没有 `Refused to …` 开头的 CSP 报错，并逐一验证聊天发送、
目录选择、托盘菜单跳视图、系统通知。若白屏，先把 `csp` 临时改回 `null` 定位，
再逐条放宽，**不要连 capabilities 一起回退**。

### `shell:allow-execute` 的 `args`

原为 `true`（完全不限制参数）。webview 里任意 JS 都能

```js
invoke('plugin:shell|execute', { program: 'node', args: ['-e', '<任意代码>'], options: { sidecar: true } })
```

拿到本机任意代码执行。实际只需要放行 Rust 侧启动 sidecar 时传的那**一个**参数
（`src-tauri/src/main.rs` 的 `.args([server_js_arg])`，解析结果形如 `$RESOURCE/sidecar/server.js`），
因此收窄为正则 validator：

```
^.*[/\]sidecar[/\]server\.js$
```

已验证：放行 Windows 与 macOS 两种真实路径，拒绝 `-e`、`--eval`、任意其它 `.js`、
后缀欺骗（`server.js.evil`）与命令追加（`server.js; calc`）。
**修改 `main.rs` 的 sidecar 传参时，必须同步检查这条 validator**，否则后端会起不来。
