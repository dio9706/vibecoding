# 后端 Sidecar 打包分发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Node 运行时与后端代码作为 Tauri sidecar/resource 打进 Windows 安装包，`main.rs` 改用 `tauri_plugin_shell` 启动 sidecar，使安装包在无 Node 的干净机器上开箱即用。

**Architecture:** 随包一个真实 `node.exe`（externalBin，按 target-triple 命名），后端 `server.js`+`src/`+生产 `node_modules`+`public/` 作为 resource（staging 到 `src-tauri/resources/sidecar/`）。生产构建下 Rust 用 `app.shell().sidecar("node").args([<resource>/sidecar/server.js])`，cwd 设为 `%APPDATA%\com.claudeagent.desktop`，并注入 `APP_DATA_DIR` env 让后端把数据写到该可写目录；开发构建保留系统 `node server.js`。

**Tech Stack:** Tauri v2、tauri-plugin-shell 2.0、Rust、Node.js 24.x（ESM）、NSIS/MSI。

**基线约定：**
- 项目根：`C:\Users\DELL\Desktop\claude-p-web-demo`（下称"项目根"）。所有 `node`/`npm` 命令在项目根执行；`cargo` 命令在 `src-tauri/` 执行。
- 当前分支：`feat/config-import-export`（工作区有无关改动，**每个 commit 只 `git add` 本任务涉及的文件**，勿 `git add -A`）。
- 目标 triple 固定 `x86_64-pc-windows-msvc`。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/store/index.js` | 修改 | `DATA_DIR` 优先读 `APP_DATA_DIR` env |
| `src/store/index.test.js` | 新建 | 验证 `DATA_DIR` env 覆盖 |
| `src-tauri/Cargo.toml` | 修改 | 新增 `tauri-plugin-shell` 依赖 |
| `src-tauri/src/main.rs` | 修改 | 注册 shell 插件、sidecar 启动、进程生命周期 kill |
| `scripts/prepare-sidecar.mjs` | 新建 | 构建期 stage node 二进制 + 后端代码 + 生产依赖 |
| `src-tauri/tauri.conf.json` | 修改 | `externalBin` + `resources` |
| `src-tauri/capabilities/default.json` | 修改 | `shell:allow-execute` sidecar 权限 |
| `src-tauri/.gitignore` | 修改 | 忽略 `binaries/`、`resources/` 生成物 |
| `package.json` | 修改 | `tauri:dev` / `tauri:build:win` 调 prepare-sidecar |

---

## Task 1: 后端 —— DATA_DIR 支持 APP_DATA_DIR（TDD）

**Files:**
- Test: `src/store/index.test.js`（新建）
- Modify: `src/store/index.js:15-17`

- [ ] **Step 1: 写失败测试**

新建 `src/store/index.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('dataPath 在设置 APP_DATA_DIR 时以其为根，并自动创建目录', async () => {
  const tmp = path.join(os.tmpdir(), `cad-store-test-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.APP_DATA_DIR = tmp;

  // 查询串做 ESM 缓存打散，确保模块顶层用最新 env 求值
  const mod = await import(`./index.js?case=env-${process.pid}`);

  assert.strictEqual(mod.dataPath('settings.json'), path.join(tmp, 'settings.json'));
  assert.ok(fs.existsSync(tmp), 'DATA_DIR 应被创建');

  delete process.env.APP_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/store/index.test.js`
Expected: FAIL —— 当前 `dataPath` 忽略 `APP_DATA_DIR`，返回的是项目根路径，`strictEqual` 断言不通过。

- [ ] **Step 3: 实现**

把 `src/store/index.js` 第 15-17 行：

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据目录 = 项目根（src/store 往上两级）
const DATA_DIR = path.join(__dirname, '..', '..');
```

替换为：

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据目录：优先 APP_DATA_DIR（打包后由 Tauri 注入的可写目录）；否则回退项目根（开发态）
const DATA_DIR = process.env.APP_DATA_DIR
  ? process.env.APP_DATA_DIR
  : path.join(__dirname, '..', '..');
// 打包首启时该目录可能不存在，确保创建
fs.mkdirSync(DATA_DIR, { recursive: true });
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/store/index.test.js`
Expected: PASS（1 test passed）。

- [ ] **Step 5: 提交**

```bash
git add src/store/index.js src/store/index.test.js
git commit -m "feat(store): DATA_DIR 支持 APP_DATA_DIR 环境变量覆盖"
```

---

## Task 2: Rust —— 新增 tauri-plugin-shell 依赖

**Files:**
- Modify: `src-tauri/Cargo.toml:19-24`

- [ ] **Step 1: 加依赖**

在 `src-tauri/Cargo.toml` 的 `tauri-plugin-autostart = "2.0"` 之后新增一行：

```toml
tauri-plugin-shell = "2.0"
```

（放在 `# 系统级能力插件` 分组内即可，紧跟 `tauri-plugin-autostart = "2.0"` 下方。）

- [ ] **Step 2: 拉取并类型检查**

Run（在 `src-tauri/` 下）：`cargo check`
Expected: 编译通过（新增依赖被下载编译；此时尚未使用，可能有 unused 警告，可忽略）。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build(tauri): 新增 tauri-plugin-shell 依赖"
```

---

## Task 3: Rust —— sidecar 启动 + 生命周期管理

**Files:**
- Modify: `src-tauri/src/main.rs`（imports、AppState、start_backend、setup 调用点、quit 处理、plugin 注册、入口 run）

> 说明：开发构建（`debug_assertions`）保留系统 `node server.js`；生产构建走随包 node sidecar。

- [ ] **Step 1: 调整 import**

把 `src-tauri/src/main.rs` 第 4 行：

```rust
use std::process::{Command as StdCommand, Stdio};
```

替换为（仅 dev 用到，gate 掉避免 release 未用警告）：

```rust
#[cfg(debug_assertions)]
use std::process::{Command as StdCommand, Stdio};
```

在第 17 行 `use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};` 之后新增：

```rust
use tauri::path::BaseDirectory;
use tauri_plugin_shell::ShellExt;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
```

- [ ] **Step 2: 改 AppState**

把第 21-24 行：

```rust
struct AppState {
    /// Node.js 后端进程 PID（用于日志/监控；进程本身由 OS 级联清理）
    node_pid: Arc<Mutex<Option<u32>>>,
}
```

替换为：

```rust
struct AppState {
    /// 后端 sidecar 子进程句柄（生产构建）；用于退出时 kill。开发构建下恒为 None。
    #[cfg(not(debug_assertions))]
    backend: Arc<Mutex<Option<CommandChild>>>,
    /// 开发构建占位（保持 struct 非空、manage 调用一致）
    #[cfg(debug_assertions)]
    _dev: (),
}
```

- [ ] **Step 3: 重写后端启动函数**

把第 88-114 行整段（注释 `// ── 后端进程管理 ──…` 到 `start_backend` 函数结束的 `}`）替换为：

```rust
// ── 后端进程管理 ──────────────────────────────────────────────────────────────

/// 启动后端：开发=系统 node（实时源码）；生产=随包 node sidecar。
fn start_backend(app: &AppHandle) {
    #[cfg(debug_assertions)]
    {
        let _ = app; // dev 不用 app
        start_backend_dev();
    }
    #[cfg(not(debug_assertions))]
    start_backend_prod(app);
}

#[cfg(debug_assertions)]
fn start_backend_dev() {
    match StdCommand::new("node")
        .arg("server.js")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            println!("[Tauri][dev] Node.js backend started (pid: {})", child.id());
            std::mem::forget(child);
        }
        Err(e) => {
            eprintln!("[Tauri][dev] Could not start node (maybe already running?): {}", e);
        }
    }
}

#[cfg(not(debug_assertions))]
fn start_backend_prod(app: &AppHandle) {
    use std::io::Write;

    // 1. 可写数据目录：%APPDATA%\com.claudeagent.desktop
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[Tauri] Cannot resolve app_data_dir: {}", e);
            return;
        }
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::create_dir_all(data_dir.join("logs"));

    // 2. 随包后端入口（$RESOURCE/sidecar/server.js）
    let server_js = match app.path().resolve("sidecar/server.js", BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[Tauri] Cannot resolve sidecar/server.js: {}", e);
            return;
        }
    };

    // 3. 组装并启动 node sidecar
    let sidecar = match app.shell().sidecar("node") {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("[Tauri] Cannot create node sidecar: {}", e);
            return;
        }
    };

    let (mut rx, child) = match sidecar
        .args([server_js.to_string_lossy().to_string()])
        .current_dir(data_dir.clone())
        .env("APP_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("PORT", "3000")
        .spawn()
    {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[Tauri] Failed to spawn node sidecar: {}", e);
            return;
        }
    };

    println!("[Tauri] Backend sidecar started (pid: {})", child.pid());
    *app.state::<AppState>().backend.lock().unwrap() = Some(child);

    // 4. 抽干 stdout/stderr → 追加到 logs/backend.log（release 无控制台，落文件便于排障）
    let log_path = data_dir.join("logs").join("backend.log");
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let bytes = match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => b,
                _ => continue,
            };
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = f.write_all(&bytes);
            }
        }
    });
}

/// 退出前终止后端 sidecar（生产构建）。开发构建为 no-op。
#[cfg(not(debug_assertions))]
fn kill_backend(app: &AppHandle) {
    if let Some(child) = app.state::<AppState>().backend.lock().unwrap().take() {
        let _ = child.kill();
    }
}
#[cfg(debug_assertions)]
fn kill_backend(_app: &AppHandle) {}
```

- [ ] **Step 4: 改 setup 中的启动调用点**

把第 467-485 行整段：

```rust
            // ② 启动 Node.js 后端（非阻塞）
            if let Some(pid) = start_backend() {
                *app.state::<AppState>().node_pid.lock().unwrap() = Some(pid);

                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let ready = wait_backend_ready();
                    if let Some(w) = handle.get_webview_window("main") {
                        if ready {
                            let _ = w.emit("backend-ready", ());
                        } else {
                            let _ = w.emit(
                                "startup-error",
                                "Backend did not respond within 10s",
                            );
                        }
                    }
                });
            }
```

替换为：

```rust
            // ② 启动后端（dev=系统 node / release=随包 node sidecar），非阻塞
            start_backend(app.handle());

            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let ready = wait_backend_ready();
                    if let Some(w) = handle.get_webview_window("main") {
                        if ready {
                            let _ = w.emit("backend-ready", ());
                        } else {
                            let _ = w.emit("startup-error", "Backend did not respond within 10s");
                        }
                    }
                });
            }
```

- [ ] **Step 5: quit 处理先 kill 后端**

把第 410-412 行：

```rust
                    "quit" => {
                        std::process::exit(0);
                    }
```

替换为：

```rust
                    "quit" => {
                        kill_backend(&app);
                        std::process::exit(0);
                    }
```

- [ ] **Step 6: 注册 shell 插件**

在第 457 行 `.plugin(tauri_plugin_notification::init())` 之后新增一行：

```rust
        .plugin(tauri_plugin_shell::init())
```

- [ ] **Step 7: 改 manage 初值 + 入口 run 兜底 kill**

把第 452-454 行：

```rust
        .manage(AppState {
            node_pid: Arc::new(Mutex::new(None)),
        })
```

替换为：

```rust
        .manage(AppState {
            #[cfg(not(debug_assertions))]
            backend: Arc::new(Mutex::new(None)),
            #[cfg(debug_assertions)]
            _dev: (),
        })
```

把第 524-525 行：

```rust
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

替换为：

```rust
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                kill_backend(app_handle);
            }
        });
```

- [ ] **Step 8: 类型检查（开发 + 生产两套 cfg）**

Run（`src-tauri/` 下）：`cargo check`
Expected: 通过（dev 路径编译）。

Run（`src-tauri/` 下）：`cargo check --release`
Expected: 通过（release 路径编译，验证 sidecar 相关代码类型正确）。首次会以 release 模式编译依赖，耗时较长属正常。

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(tauri): 生产构建用 tauri-plugin-shell 启动 node sidecar 并管理生命周期"
```

---

## Task 4: 构建脚本 —— prepare-sidecar.mjs（stage node + 后端 + 依赖）

**Files:**
- Create: `scripts/prepare-sidecar.mjs`

- [ ] **Step 1: 写脚本**

新建 `scripts/prepare-sidecar.mjs`：

```js
#!/usr/bin/env node
/**
 * 构建期：把 Node 运行时与后端代码 stage 到 src-tauri/，供 Tauri sidecar + resources 打包。
 * 用法：
 *   node scripts/prepare-sidecar.mjs             # 完整：node 二进制 + 后端 staging + 生产依赖
 *   node scripts/prepare-sidecar.mjs --node-only  # 仅拷贝 node 二进制（tauri dev 前置，快）
 * 环境变量：
 *   SIDECAR_TARGET_TRIPLE  目标三元组，默认 x86_64-pc-windows-msvc
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const TRIPLE = process.env.SIDECAR_TARGET_TRIPLE || 'x86_64-pc-windows-msvc';
const NODE_ONLY = process.argv.includes('--node-only');

// 1. Node 二进制 → src-tauri/binaries/node-<triple>[.exe]
const binDir = path.join(SRC_TAURI, 'binaries');
fs.mkdirSync(binDir, { recursive: true });
const ext = TRIPLE.includes('windows') ? '.exe' : '';
const nodeTarget = path.join(binDir, `node-${TRIPLE}${ext}`);
fs.copyFileSync(process.execPath, nodeTarget);
console.log(`[prepare-sidecar] node -> ${nodeTarget}`);
console.log(`[prepare-sidecar]   source=${process.execPath} version=${process.version}`);

if (NODE_ONLY) {
  console.log('[prepare-sidecar] --node-only done.');
  process.exit(0);
}

// 2. 后端代码 staging → src-tauri/resources/sidecar/
//    （tauri.conf 用 {"resources/": ""} 将 src-tauri/resources/** 保结构落到 $RESOURCE/**，
//      即 $RESOURCE/sidecar/**；Rust 侧以 "sidecar/server.js" 解析。）
const RES = path.join(SRC_TAURI, 'resources');
const stage = path.join(RES, 'sidecar');
fs.rmSync(RES, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const item of ['server.js', 'package.json', 'package-lock.json', 'src', 'public']) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) {
    console.warn(`[prepare-sidecar] skip missing: ${item}`);
    continue;
  }
  fs.cpSync(from, path.join(stage, item), { recursive: true });
}
console.log('[prepare-sidecar] backend files staged.');

// 3. 生产依赖 → src-tauri/resources/sidecar/node_modules
console.log('[prepare-sidecar] installing production deps (npm ci --omit=dev)...');
execSync('npm ci --omit=dev', { cwd: stage, stdio: 'inherit' });

console.log('[prepare-sidecar] done.');
```

- [ ] **Step 2: 运行验证**

Run（项目根）：`node scripts/prepare-sidecar.mjs`
Expected: 结尾打印 `[prepare-sidecar] done.`；生成：
- `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`
- `src-tauri/resources/sidecar/server.js`、`.../src/`、`.../public/`、`.../node_modules/`、`.../package.json`

Run（项目根）验证关键产物存在：`ls -l src-tauri/binaries/node-x86_64-pc-windows-msvc.exe && ls src-tauri/resources/sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
Expected: 两个路径都存在（node 二进制 + SDK 已装入 staging）。

- [ ] **Step 3: 提交（只提交脚本，产物被 .gitignore 于 Task 6 忽略）**

```bash
git add scripts/prepare-sidecar.mjs
git commit -m "build: 新增 prepare-sidecar 构建脚本（stage node 运行时+后端+生产依赖）"
```

---

## Task 5: 配置 —— tauri.conf.json externalBin + resources

**Files:**
- Modify: `src-tauri/tauri.conf.json:31-41`

> 前置：Task 4 已生成 `binaries/` 与 `resources/sidecar/`，此配置才能被后续构建正确校验。

- [ ] **Step 1: 改 bundle 配置**

把 `src-tauri/tauri.conf.json` 的 `bundle` 段（第 31-41 行）：

```json
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

替换为：

```json
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "externalBin": ["binaries/node"],
    "resources": {
      "resources/": ""
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

- [ ] **Step 2: 校验配置 + 二进制被识别**

Run（`src-tauri/` 下）：`cargo check --release`
Expected: 通过（`generate_context!` 读入含 `externalBin` 的配置，`binaries/node-x86_64-pc-windows-msvc.exe` 已存在，不报缺失）。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build(tauri): 声明 node externalBin 与 sidecar resources"
```

---

## Task 6: 配置 —— capability 权限 + .gitignore

**Files:**
- Modify: `src-tauri/capabilities/default.json:5-25`
- Modify: `src-tauri/.gitignore`

- [ ] **Step 1: 加 shell sidecar 权限**

把 `src-tauri/capabilities/default.json` 中 `permissions` 数组的最后一项 `"core:window:allow-is-maximized"` 改为带逗号，并在其后新增权限对象。即把第 24 行：

```json
    "core:window:allow-is-maximized"
  ]
```

替换为：

```json
    "core:window:allow-is-maximized",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "binaries/node", "sidecar": true, "args": true }
      ]
    }
  ]
```

- [ ] **Step 2: 忽略生成物**

把 `src-tauri/.gitignore` 内容：

```
# Generated by Cargo
# will have compiled files and executables
/target/
/gen/schemas
```

替换为：

```
# Generated by Cargo
# will have compiled files and executables
/target/
/gen/schemas

# 构建期由 scripts/prepare-sidecar.mjs 生成（勿提交，体积大）
/binaries/
/resources/
```

- [ ] **Step 3: 校验 JSON 合法**

Run（项目根）：`node -e "JSON.parse(require('fs').readFileSync('src-tauri/capabilities/default.json','utf8')); console.log('ok')"`
Expected: 打印 `ok`。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/capabilities/default.json src-tauri/.gitignore
git commit -m "build(tauri): 授予 node sidecar 执行权限并忽略打包生成物"
```

---

## Task 7: 配置 —— package.json 构建脚本接线

**Files:**
- Modify: `package.json:9,12`

- [ ] **Step 1: 让 dev 与 win 构建自动 stage**

把 `package.json` 的第 9 行：

```json
    "tauri:dev": "tauri dev",
```

替换为：

```json
    "tauri:dev": "node scripts/prepare-sidecar.mjs --node-only && tauri dev",
```

把第 12 行：

```json
    "tauri:build:win": "tauri build --target x86_64-pc-windows-msvc",
```

替换为：

```json
    "tauri:build:win": "node scripts/prepare-sidecar.mjs && tauri build --target x86_64-pc-windows-msvc",
```

- [ ] **Step 2: 校验 JSON 合法**

Run（项目根）：`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: 打印 `ok`。

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "build: tauri:dev/build:win 自动执行 prepare-sidecar"
```

---

## Task 8: 集成验证（构建 + 干净环境验收）

> 本任务为验证，不产生 commit。逐条对照设计文档 §1 成功标准。

- [ ] **Step 1: 开发态回归（仍走系统 node）**

Run（项目根）：`npm run tauri:dev`
Expected: 应用启动；控制台出现 `[Tauri][dev] Node.js backend started (pid: ...)`；UI 加载正常；关闭窗口收到 `backend-ready`（无 `startup-error`）。确认后关闭。

- [ ] **Step 2: 生产构建**

Run（项目根）：`bash scripts/build-win.sh`
Expected: 先执行 prepare-sidecar（打印 `done.`），随后 `tauri build` 成功；结尾列出产物路径，`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/` 下有 `.exe`(NSIS) 与 `.msi`。

- [ ] **Step 3: 干净环境安装验收**

在一台**未装 Node、无本仓库**的 Windows 用户账户（或干净 VM）安装 NSIS/MSI 后启动，逐项确认：

1. 应用能启动，UI 正常加载。
2. `http://127.0.0.1:3000/api/ping` 有响应（可在应用内功能触发，或浏览器访问）。
3. 数据文件出现在 `%APPDATA%\com.claudeagent.desktop\`（`settings.json`、`tasks.json`、`event-log.jsonl`、`logs\backend.log` 等），安装目录（`Program Files`）内**无**运行时写入。
4. 任务管理器：启动后存在 `node.exe` 子进程；托盘"退出"后该 `node.exe` **消失**（无孤儿）。

Expected: 四项全部满足。若 §2 ping 不通，先看 `%APPDATA%\com.claudeagent.desktop\logs\backend.log` 定位后端启动错误。

---

## Self-Review（作者自查记录）

- **Spec 覆盖**：方案 A（Task 4/5）；tauri-plugin-shell 启动 sidecar（Task 2/3）；DATA_DIR 迁可写目录（Task 1 + Task 3 注入 env/cwd）；externalBin 命名与 resources 布局（Task 4/5）；capability 权限（Task 6）；构建流水线与 node 版本随本机 24.x（Task 4/7）；dev 保留系统 node（Task 3 cfg 分流）；进程退出 kill（Task 3）。§7 已知限制（python/FRONTEND_DIR/claude 登录/macOS）为设计明示的超范围项，不建任务。
- **Placeholder 扫描**：无 TBD/TODO；每个代码步骤均含完整代码与确切命令、预期输出。
- **类型/命名一致性**：`AppState.backend`、`start_backend`/`start_backend_dev`/`start_backend_prod`/`kill_backend`、`APP_DATA_DIR`、resource 键 `"sidecar/server.js"` 与 staging 目录 `src-tauri/resources/sidecar/` + `{"resources/": ""}` 映射一致；externalBin `binaries/node` 与文件 `node-x86_64-pc-windows-msvc.exe`、capability `name: "binaries/node"` 三处一致。
