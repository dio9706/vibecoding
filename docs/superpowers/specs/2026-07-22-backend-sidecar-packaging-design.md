# 后端分发打包：Node 运行时 + 后端代码作为 Tauri Sidecar

- 日期：2026-07-22
- 状态：待用户 review
- 主目标平台：**Windows x64**（`x86_64-pc-windows-msvc`）。macOS 作为文档化扩展点，本次不实现。

## 1. 背景与目标

当前 `src-tauri/src/main.rs` 用 `StdCommand::new("node").arg("server.js")` **裸启动系统 node**，依赖目标机器已装 Node 且 `node` 在 PATH 上、且当前工作目录恰为项目根。这对分发（把安装包发给没有开发环境的用户）是不可用的。

目标：把 **Node 运行时** 与 **后端代码/依赖** 一并打进安装包，`main.rs` 改用 `tauri_plugin_shell` 以 **sidecar** 方式启动后端，使安装包在**干净的 Windows 机器**上开箱即用。

### 成功标准（验收）

在一台**未装 Node、没有本仓库**的干净 Windows 用户账户上：

1. 安装 NSIS/MSI → 应用启动。
2. 后端 sidecar 由**随包 node** 拉起，`http://127.0.0.1:3000/api/ping` 正常响应，前端 UI 正常加载。
3. 所有运行时数据写入 `%APPDATA%\com.claudeagent.desktop\`（settings.json、tasks.json、event-log.jsonl、saved-dirs.json、用户自定义 `scripts/` 等），**不向 `Program Files` 只读目录写入**。
4. 从托盘"退出"后，任务管理器中**不残留 node.exe 孤儿进程**。

## 2. 选定方案：真 node 二进制作 sidecar + 后端作 resource（方案 A）

对比过三条路线：

- **方案 A（选定）**：随包一个真实 `node.exe` 作 sidecar，后端 `server.js`/`src/`/生产版 `node_modules` 作 Tauri resource。对 ESM、整棵本地模块图、以及 `@anthropic-ai/claude-agent-sdk` 运行时自解压 Bun 二进制（`extractFromBunfs`）完全兼容，运行时行为与现状 `node server.js` 一致。代价是体积（node ≈ 80MB + node_modules）与一个构建期打包步骤。
- **方案 B（弃）**：pkg/@yao-pkg/pkg 或 Node SEA 编成单个自包含 exe。对 ESM + SDK 运行时向文件系统自解压二进制极其脆弱，高风险高调试成本。
- **方案 C（弃）**：esbuild 打单文件 JS + node sidecar。SDK 二进制资产仍需随包，收益有限。

## 3. 架构与数据流

```
┌─────────────────────────── 安装包 (NSIS/MSI) ───────────────────────────┐
│  claude-agent-desktop.exe        (Tauri 主进程 / WebView)                │
│  binaries/node-x86_64-pc-windows-msvc.exe   (externalBin → sidecar)     │
│  $RESOURCE/sidecar/                                                     │
│      server.js  src/**  node_modules/**  package.json  public/**        │
└─────────────────────────────────────────────────────────────────────────┘
                         │ 启动时
                         ▼
   app.shell().sidecar("node")
       .args([ <$RESOURCE>/sidecar/server.js ])
       .current_dir( %APPDATA%\com.claudeagent.desktop )   ← 可写数据目录 = cwd
       .env("APP_DATA_DIR", <同上>)                        ← 修正 store 的 __dirname 相对写入
       .env("PORT", "3000")
       .spawn()  → (rx, child)
                         │
        ┌────────────────┴─────────────────┐
        │ rx：抽干 stdout/stderr → 日志文件 │
        │ child：存入 AppState，退出时 kill │
        └───────────────────────────────────┘
                         │ HTTP :3000
                         ▼
              wait_backend_ready() /api/ping  → emit "backend-ready"
```

关键点：后端有两类"写路径"，语义不同，必须分别修正后统一落到同一个可写目录：

| 数据 | 现状解析方式 | 打包后问题 | 修正手段 |
|---|---|---|---|
| store 数据文件（settings/tasks/event-log/saved-dirs 等，见 `src/store/index.js`） | `__dirname` 相对（代码目录上两级） | 代码在只读 `$RESOURCE` → 写失败 | 读 `APP_DATA_DIR` env（Rust 注入） |
| 用户自定义 action 脚本目录（`config.scripts.dir`，默认 `scripts`） | `process.cwd()` 相对 | cwd 不确定 | sidecar `current_dir = 数据目录` |

两者最终都落在 `%APPDATA%\com.claudeagent.desktop\`。

## 4. 组件级改动清单

### 4.1 Rust 侧 `src-tauri/`

**Cargo.toml**：新增依赖
```toml
tauri-plugin-shell = "2.0"
```

**src/main.rs**：
- 注册插件：`.plugin(tauri_plugin_shell::init())`。
- `AppState`：把 `node_pid: Arc<Mutex<Option<u32>>>` 换成 `backend: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>`，以便退出时 kill。
- 新 `start_backend(app: &AppHandle)`：
  - `let data_dir = app.path().app_data_dir()?;` → `fs::create_dir_all(&data_dir)`。
  - `let server_js = app.path().resolve("sidecar/server.js", BaseDirectory::Resource)?;`
  - `let (rx, child) = app.shell().sidecar("node")?.args([server_js]).current_dir(&data_dir).env("APP_DATA_DIR", &data_dir).env("PORT", "3000").spawn()?;`
  - `tauri::async_runtime::spawn`：`while let Some(ev) = rx.recv().await { … }` 把 `Stdout/Stderr` 落到 `data_dir/logs/backend.log`（保留现有 println 风格）。
  - 把 `child` 存进 `AppState`。
  - 保留现有 `wait_backend_ready()`（HTTP `/api/ping` 轮询）与 `backend-ready` / `startup-error` 事件语义不变。
- **开发 vs 生产**：`#[cfg(debug_assertions)]` 下**保留** `node server.js`（系统 node、实时源码，`tauri dev` 迭代快）；`#[cfg(not(debug_assertions))]` 走 sidecar。（可后续统一，若你更希望 dev 也走 sidecar，需在 `binaries/` 常驻 node 并每次改 JS 后重新 stage——默认不采用。）
- **进程生命周期**：托盘"退出"当前是 `std::process::exit(0)`，会跳过 Drop → sidecar 可能成孤儿。改为：退出前先取出 `AppState.backend` 并 `child.kill()`，再退出；并在 `RunEvent::Exit` 兜底 kill 一次。

**tauri.conf.json**：
```jsonc
"bundle": {
  "externalBin": ["binaries/node"],          // 实际文件 binaries/node-x86_64-pc-windows-msvc.exe
  "resources": {
    "sidecar/": ""                            // 将 src-tauri/sidecar/** 保留结构复制到 $RESOURCE/sidecar/**
  }
}
```
（`resources` 精确 glob 语法在实现计划里最终敲定，语义为：staging 目录整棵进入 `$RESOURCE/sidecar/`。）

**capabilities/default.json**：新增
```json
{ "identifier": "shell:allow-execute",
  "allow": [{ "name": "binaries/node", "sidecar": true, "args": true }] }
```

**.gitignore**（`src-tauri/`）：忽略生成物 `binaries/`、`sidecar/`。

### 4.2 后端侧（最小外科手术）

**src/store/index.js**：`DATA_DIR` 优先读 env，dev 回退现状
```js
const DATA_DIR = process.env.APP_DATA_DIR
  ? process.env.APP_DATA_DIR
  : path.join(__dirname, '..', '..');
// 确保存在（打包首启时目录为空）
fs.mkdirSync(DATA_DIR, { recursive: true });
```
- 首启数据目录为空：各 store 的 `readJson(name, fallback)` 天然返回 fallback，settings.json 等在首次写入时创建，**无需额外 seeding**。

其余后端代码**不改**。`server.js` 里 `join(process.cwd(), config.scripts.dir)` 与 `script-runner.js` 的 `path.join(config.scripts.dir, …)` 都靠 sidecar `current_dir` 落到数据目录，语义自洽。

### 4.3 构建流水线 `scripts/`

新增 `scripts/prepare-sidecar.sh`（并在 `build-win.sh` / `build-win.bat` 的 `tauri build` 之前调用）：
1. **准备 node 二进制**：优先复制本机 `node`（当前 v24.11.1）或从 nodejs.org 下载 pin 的 Node 24.x Windows x64，落到 `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`。
2. **准备后端 staging**：清空并重建 `src-tauri/sidecar/`，把 `server.js`、`src/`、`package.json`、`public/` 复制进去；在其中执行 `npm ci --omit=dev`（或从根 `node_modules` 裁剪生产依赖）生成随包 `node_modules`。
3. 由 `tauri build` 按 4.1 的 `externalBin` + `resources` 打进安装包。

Node 版本 **pin 到 24.x**（与开发一致；SDK 要求 `>=18`，满足）。

## 5. 错误处理

- 沿用现有非致命策略：sidecar 启动失败 → 打日志 + emit `startup-error`，不崩主进程。
- `wait_backend_ready()` 10s 超时逻辑不变。
- `child.kill()` 失败仅记日志。

## 6. 测试计划

1. **本地构建**：跑 `scripts/build-win.sh`，产出 NSIS/MSI。
2. **干净环境验收**：在无 Node 的 Windows 用户账户（或干净 VM）安装并启动，逐条核对 §1 的 4 条成功标准。
3. **进程核对**：任务管理器确认启动后出现 `node.exe` 子进程、退出后消失（无孤儿）。
4. **数据落点核对**：确认数据文件出现在 `%APPDATA%\com.claudeagent.desktop\`，`Program Files` 目录无写入。
5. **回归**：`tauri dev`（debug）仍走系统 node、行为不变。

## 7. 已知限制 / 超本次范围（仅记录，不修）

- **python 动作**：`config.scripts.pythonBin='python'`，运行 `.py` action 仍需目标机装 python。
- **FRONTEND_DIR / BACKEND_DIR**：默认硬编码 `C:\Users\DELL\Desktop\...`，分发到他机不存在；需用户经 env/settings 配置。
- **claude 订阅登录**：SDK 复用本机 Claude Code 登录（`~/.claude`）；目标机需自行登录。
- **macOS**：需提供 `node-aarch64-apple-darwin` / `node-x86_64-apple-darwin`、签名与公证、sidecar 执行 entitlement。仅作扩展点。

## 8. 待用户确认的默认决策

（用户在澄清阶段未逐项作答，以下为按推荐所定默认，可在 review 时推翻）

1. 打包方式 = **方案 A**。
2. **纳入** DATA_DIR 最小改动（`APP_DATA_DIR` env）。
3. 主目标 = **Windows x64**；macOS 仅文档化。
4. dev 保留系统 node，仅 **生产** 走 sidecar。
5. 随包 Node 版本 **pin 24.x**。
