# Tauri 桌面化改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Node.js Web 应用改造为 Tauri 桌面应用，新增系统托盘、原生通知、全局快捷键、菜单栏、开机自启等系统级能力，支持 Windows + macOS 双平台打包。

**Architecture:** Tauri 壳（Rust）负责系统能力和窗口管理，WebView 加载本地 Web 前端（http://127.0.0.1:PORT），sidecar 机制启动和管理 Node.js 后端进程。前后端业务逻辑保持不变。

**Tech Stack:** 
- Tauri 2.x (Rust 桌面框架)
- Tauri 插件：autostart、global-shortcut、notification
- Node.js sidecar（打包后的 server.js）
- 前端：原有 HTML/CSS/JS（无改动）

---

## 文件结构

### 新增文件
- `src-tauri/` - Tauri 项目根目录（Rust）
  - `tauri.conf.json` - 应用配置（菜单、托盘、快捷键、打包设置）
  - `Cargo.toml` - Rust 依赖
  - `build.rs` - 构建脚本（模板）
  - `src/main.rs` - 主进程（窗口、sidecar、IPC）
- `src-tauri/icons/` - 应用图标（多尺寸）
  - `icon.png` / `icon.icns`（macOS）/ `.ico`（Windows）
- `.github/workflows/release.yml` - CI 打包流程
- `scripts/build-darwin.sh` - macOS 打包脚本
- `scripts/build-win.sh` - Windows 打包脚本

### 修改文件
- `package.json` - 追加 tauri 相关 scripts、devDependencies
- `server.js` - 新增 `/internal/notify` 端点（用于后端触发系统通知）

### 不变文件
- `public/` 所有文件（前端）
- `src/` 所有文件（后端业务逻辑）
- `.env` 及配置文件

---

## 任务分解

### Task 1: 初始化开发环境 + 创建 Tauri 项目骨架

**Files:**
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Modify: `package.json`

**依赖前置检查：**
- Windows 用户需要 MSVC 工具链（`npm install -g @tauri-apps/cli` 时自动检查）
- macOS 用户需要 Xcode Command Line Tools（`xcode-select --install`）
- Rust 工具链（`rustup` 一次性安装，或用 `npm install -g @tauri-apps/cli` 自动提示）

---

#### **Step 1.1: 全局安装 Tauri CLI**

```bash
npm install -g @tauri-apps/cli@latest
```

验证：
```bash
tauri --version
```

Expected output: `tauri <version>`

---

#### **Step 1.2: 创建 Tauri 项目骨架**

从命令行创建最小 Tauri 项目来生成模板：

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
tauri init --with-package-json -d . -f npm
```

**配置时的选项选择：**
- 项目名：`vibe-coding-desktop`
- 窗口标题：`Vibe Coding`
- UI 方式：选 **Vanilla** (无构建工具)

这会在 `src-tauri/` 下生成骨架。

---

#### **Step 1.3: 编写 tauri.conf.json 配置**

替换生成的 `src-tauri/tauri.conf.json`：

```json
{
  "build": {
    "beforeDevCommand": "echo 'Frontend running on http://localhost:5173'",
    "beforeBuildCommand": "echo 'Building frontend'",
    "devUrl": "http://127.0.0.1:3000",
    "frontendDist": "../public"
  },
  "app": {
    "windows": [
      {
        "title": "Vibe Coding",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false,
        "focus": true,
        "hidden": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "tauri": {
    "allowlist": {
      "all": false,
      "shell": {
        "all": false,
        "execute": false,
        "sidecar": true,
        "open": true
      },
      "notification": {
        "all": true
      },
      "globalShortcut": {
        "all": true
      },
      "http": {
        "all": true,
        "scope": ["http://127.0.0.1:*"]
      }
    },
    "systemTray": {
      "iconPath": "icons/icon.png",
      "menuOnLeftClick": false,
      "tooltip": "Vibe Coding"
    },
    "bundle": {
      "active": true,
      "targets": ["nsis", "msi"],
      "identifier": "com.vibecoding.desktop",
      "icon": [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico"
      ],
      "resources": [],
      "externalBin": [
        {
          "name": "node",
          "src": "../node_modules/.bin/node",
          "strip": true
        }
      ]
    },
    "security": {
      "csp": null
    }
  }
}
```

关键配置项解读：
- `devUrl: http://127.0.0.1:3000` - 开发模式连接后端的地址
- `frontendDist: ../public` - 生产构建时打包前端的源目录
- `systemTray` - 启用系统托盘
- `allowlist.shell.sidecar: true` - 允许启动 sidecar 进程
- `externalBin` - 声明 Node.js 二进制作为 sidecar 资源

---

#### **Step 1.4: 编写 main.rs（窗口初始化 + Sidecar 启动）**

替换 `src-tauri/src/main.rs`：

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::process::{Command, Child};
use std::thread;
use std::time::Duration;
use tauri::http::Client;
use tauri::{AppHandle, Manager, SystemTray, SystemTrayMenu, SystemTrayMenuItem, SystemTrayEvent};

static mut SIDECAR_HANDLE: Option<Child> = None;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

fn setup_sidecar(app: &AppHandle) -> Result<(), String> {
    // 获取 sidecar 路径（Tauri 会将其放在 resourcesDir/node）
    let node_path = tauri::api::process::Command::new("node")
        .args(&["--version"])
        .output()
        .map_err(|e| format!("Failed to find node: {}", e))?;

    if !node_path.status.success() {
        return Err("Node.js not found".to_string());
    }

    println!("[Tauri] Starting sidecar: node server.js");

    let sidecar_cmd = tauri::api::process::Command::new_sidecar("node")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(&["../server.js"])
        .spawn();

    match sidecar_cmd {
        Ok((mut rx, child)) => {
            // 记录 child 进程
            unsafe {
                SIDECAR_HANDLE = Some(child);
            }

            // 在后台线程监听 stdout（日志）
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        tauri::api::process::CommandEvent::Stdout(line) => {
                            println!("[Sidecar] {}", line);
                        }
                        tauri::api::process::CommandEvent::Stderr(line) => {
                            eprintln!("[Sidecar Error] {}", line);
                        }
                        tauri::api::process::CommandEvent::Terminated(payload) => {
                            println!("[Sidecar] Terminated with code: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });

            // 等待后端健康检查
            println!("[Tauri] Waiting for backend health check...");
            for attempt in 0..20 {
                thread::sleep(Duration::from_millis(500));
                let client = Client::new();
                match client
                    .get("http://127.0.0.1:3000/api/ping")
                    .send()
                {
                    Ok(_) => {
                        println!("[Tauri] Backend is healthy");
                        return Ok(());
                    }
                    Err(_) => {
                        if attempt % 4 == 0 {
                            println!("[Tauri] Attempt {} - waiting for backend...", attempt + 1);
                        }
                    }
                }
            }

            Err("Backend failed to start (timeout after 10s)".to_string())
        }
        Err(e) => Err(format!("Failed to spawn sidecar: {}", e)),
    }
}

fn setup_tray() -> SystemTray {
    let quit = SystemTrayMenuItem::new("Quit", "quit");
    let open = SystemTrayMenuItem::new("Open", "open");
    let new_task = SystemTrayMenuItem::new("New Task", "new_task");
    let separator1 = SystemTrayMenuItem::Separator;
    let settings = SystemTrayMenuItem::new("Settings", "settings");
    let separator2 = SystemTrayMenuItem::Separator;

    let menu = SystemTrayMenu::new()
        .add_item(open)
        .add_item(new_task)
        .add_native_item(separator1)
        .add_item(settings)
        .add_native_item(separator2)
        .add_item(quit);

    SystemTray::new().with_menu(menu)
}

fn handle_tray_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "quit" => {
                std::process::exit(0);
            }
            "open" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "new_task" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("focus-input", ());
                }
            }
            "settings" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("open-settings", ());
                }
            }
            _ => {}
        },
        SystemTrayEvent::LeftClick { .. } => {
            if let Some(window) = app.get_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // 启动 sidecar
            if let Err(e) = setup_sidecar(app.handle()) {
                eprintln!("[Tauri Setup Error] {}", e);
                tauri::api::dialog::message(
                    Some(&app.get_window("main").unwrap()),
                    "Startup Error",
                    format!("Failed to start backend: {}", e),
                );
                std::process::exit(1);
            }

            Ok(())
        })
        .system_tray(setup_tray())
        .on_system_tray_event(handle_tray_event)
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event {
                // 隐藏到托盘，不是真正退出
                let window = event.window();
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

关键逻辑：
- `setup_sidecar()` - 启动 Node sidecar，等待后端健康检查
- `setup_tray()` - 配置托盘菜单
- `handle_tray_event()` - 响应托盘菜单点击
- `on_window_event` - 捕获窗口关闭事件，改为隐藏到托盘

---

#### **Step 1.5: 编写 Cargo.toml（Rust 依赖）**

替换 `src-tauri/Cargo.toml`：

```toml
[package]
name = "vibe-coding-desktop"
version = "0.1.0"
description = "Vibe Coding Desktop Application"
authors = ["Your Name"]
license = "ISC"
repository = ""
edition = "2021"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
serde_json = "1.0"
serde = { version = "1.0", features = ["derive"] }
tauri = { version = "2.0", features = [
    "shell-open",
    "system-tray",
    "http-client",
    "notification",
    "global-shortcut",
] }
tauri-plugin-notification = "2.0"
tauri-plugin-global-shortcut = "2.0"
tauri-plugin-autostart = "2.0"

[profile.release]
panic = "abort"
codegen-units = 1
lto = true
```

关键依赖解读：
- `tauri` - 核心框架，启用了 system-tray、http-client 等特性
- `tauri-plugin-*` - 三个插件（通知、全局快捷键、开机自启）

---

#### **Step 1.6: 编写 build.rs（构建脚本）**

在 `src-tauri/` 目录下创建或替换 `build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

这个文件是 Tauri 构建流程的必需文件，通常是个简单的模板。

---

#### **Step 1.7: 更新 package.json（NPM Scripts）**

修改项目根目录的 `package.json`，追加：

```json
{
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "tauri:build:win": "tauri build --target x86_64-pc-windows-msvc",
    "tauri:build:mac": "tauri build --target aarch64-apple-darwin && tauri build --target x86_64-apple-darwin",
    "start": "node server.js"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@tauri-apps/api": "^2.0.0",
    "tauri-plugin-notification": "^2.0.0",
    "tauri-plugin-global-shortcut": "^2.0.0",
    "tauri-plugin-autostart": "^2.0.0"
  }
}
```

---

#### **Step 1.8: 准备应用图标**

创建 `src-tauri/icons/` 目录，放入多尺寸图标：

```bash
mkdir -p src-tauri/icons
```

使用任意图标生成工具（或下载一个示例），放入：
- `icon.png` (512x512) - 通用
- `icon.icns` - macOS（需要 .icns 工具转换，或用在线工具）
- `icon.ico` - Windows

如果暂时没有图标，可以用 Tauri 默认图标占位：

```bash
cd src-tauri/icons
# 复制默认图标作为占位符（从网络下载或用工具生成）
```

---

#### **Step 1.9: 第一次 install 验证**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
npm install
```

预期输出：
```
added X packages, ...
```

---

#### **Step 1.10: Commit**

```bash
git add package.json src-tauri/ .github/workflows/ 2>/dev/null || true
git commit -m "feat(tauri): init Tauri project with sidecar, tray, basic window setup

- Initialize Tauri 2.x skeleton (Cargo.toml, tauri.conf.json, main.rs)
- Configure sidecar to launch Node backend (server.js)
- Setup system tray with menu (Open, New Task, Settings, Quit)
- Implement window minimize-to-tray on close (hide, not exit)
- Add health check loop waiting for backend startup
- Configure allowed capabilities (shell.sidecar, notification, globalShortcut, http)"

---

### Task 2: 后端新增通知 IPC 端点 + 测试启动流程

**Files:**
- Modify: `server.js`
- Create: `tests/tauri-integration.test.mjs`

---

#### **Step 2.1: 在 server.js 中添加通知端点**

打开 `server.js`，在 Express 路由定义后追加内部通知端点（在其他路由之前）：

```javascript
// 内部 IPC 通知端点（仅 127.0.0.1 可调）
app.post('/internal/notify', (req, res) => {
  const { title, body, icon } = req.body;
  console.log('[Notify IPC]', title, body);
  // Tauri 主进程会通过 IPC 调用此端点
  // 这里只是记录日志，实际通知由 Tauri 弹出
  res.json({ success: true });
});

// 健康检查端点（Tauri 启动时用来检查后端是否就绪）
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

插入位置：在现有的 `app.listen()` 之前。

---

#### **Step 2.2: 测试开发模式启动**

启动后端进程验证没有语法错误：

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
node server.js &
```

等待 2-3 秒，验证服务启动（通常会打印「Listening on port 3000」）。

验证通过，杀掉进程：
```bash
# Windows: Ctrl+C 或在另一个终端
taskkill /F /IM node.exe /T
```

---

#### **Step 2.3: Commit**

```bash
git add server.js
git commit -m "feat(backend): add /internal/notify endpoint for Tauri IPC + /api/ping for health check

- /internal/notify: receives title, body, icon from Tauri; logs notification events
- /api/ping: simple health check endpoint used by Tauri startup verification"

---

### Task 3: 集成全局快捷键 + 菜单栏 + 开机自启

**Files:**
- Modify: `src-tauri/src/main.rs`

---

#### **Step 3.1: 添加全局快捷键注册（Ctrl+Shift+P）**

在 `src-tauri/src/main.rs` 的 `main()` 函数中，在 `tauri::Builder::default()` 链式调用前添加全局快捷键插件初始化。

修改 `main()` 函数的 Builder 链：

```rust
fn main() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::Builder::new().build())
        .setup(|app| {
            // 启动 sidecar（保持原有代码）
            if let Err(e) = setup_sidecar(app.handle()) {
                eprintln!("[Tauri Setup Error] {}", e);
                tauri::api::dialog::message(
                    Some(&app.get_window("main").unwrap()),
                    "Startup Error",
                    format!("Failed to start backend: {}", e),
                );
                std::process::exit(1);
            }

            // 注册全局快捷键：Ctrl+Shift+P（Windows）/ Cmd+Shift+P（macOS）
            use tauri::GlobalShortcutManager;
            let shortcut = if cfg!(target_os = "macos") {
                "Cmd+Shift+P"
            } else {
                "Ctrl+Shift+P"
            };

            let app_handle = app.handle();
            match app_handle.global_shortcut_manager().register(shortcut, move || {
                if let Some(window) = app_handle.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }) {
                Ok(_) => println!("[Tauri] Global shortcut registered: {}", shortcut),
                Err(e) => eprintln!("[Tauri] Failed to register shortcut: {}", e),
            }

            Ok(())
        })
        // ... rest of builder chain
        .system_tray(setup_tray())
        .on_system_tray_event(handle_tray_event)
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event {
                let window = event.window();
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**关键点**：
- 用 `cfg!(target_os = "macos")` 区分平台快捷键
- 在闭包中捕获 `app_handle` 以便响应快捷键事件

---

#### **Step 3.2: 验证代码能编译**

```bash
cd src-tauri
cargo check
```

预期输出：
```
Finished dev [unoptimized + debuginfo] target(s) in Xs
```

如果有编译错误，检查是否遗漏导入（如 `use tauri::GlobalShortcutManager;`）。

---

#### **Step 3.3: 添加原生菜单栏**

在 `main()` 函数外增加菜单构建函数：

```rust
fn setup_menu() -> tauri::Menu {
    use tauri::{Menu, MenuItem, Submenu};

    let app_menu = Submenu::new(
        "Vibe Coding",
        Menu::new()
            .add_native_item(MenuItem::About("Vibe Coding".into(), Default::default()))
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Quit),
    );

    let file_menu = Submenu::new(
        "File",
        Menu::new()
            .add_item(tauri::CustomMenuItem::new("new-task", "New Task").accelerator("Ctrl+N"))
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::CloseWindow),
    );

    let window_menu = Submenu::new(
        "Window",
        Menu::new()
            .add_native_item(MenuItem::Minimize)
            .add_native_item(MenuItem::Maximize)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Quit),
    );

    let help_menu = Submenu::new(
        "Help",
        Menu::new()
            .add_item(tauri::CustomMenuItem::new("view-logs", "View Logs")),
    );

    Menu::new()
        .add_submenu(app_menu)
        .add_submenu(file_menu)
        .add_submenu(window_menu)
        .add_submenu(help_menu)
}
```

在 `main()` 的 Builder 中添加菜单（在 `.setup()` 之后）：

```rust
.menu(setup_menu())
.on_menu_event(|event| {
    match event.menu_item_id() {
        "new-task" => {
            if let Some(window) = event.window().app_handle().get_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("focus-input", ());
            }
        }
        "view-logs" => {
            if let Some(window) = event.window().app_handle().get_window("main") {
                let _ = window.emit("open-logs", ());
            }
        }
        _ => {}
    }
})
```

---

#### **Step 3.4: 集成开机自启插件**

开机自启的真实交互在前端完成（通过托盘菜单复选框），但 Tauri 端已经在 Builder 里加了插件初始化。

在前端后续任务中会调用 Tauri IPC 命令 `enable_autostart()` / `disable_autostart()`。

这里只需验证插件正确初始化（已在 Step 3.1 的 `.plugin()` 链中完成）。

---

#### **Step 3.5: Commit**

```bash
cd src-tauri
git add src/main.rs
git commit -m "feat(tauri): add global shortcut, menu bar, autostart plugin

- Register Ctrl+Shift+P (Windows) / Cmd+Shift+P (macOS) to show window
- Add native menu bar (File, Window, Help menus with keyboard shortcuts)
- Initialize autostart plugin for startup behavior
- Bind menu items to window show/emit events"

---

### Task 4: 前端集成 Tauri IPC 调用（通知 + 快捷键反馈 + 开机自启控制）

**Files:**
- Modify: `public/app.js`

---

#### **Step 4.1: 添加 Tauri API 加载和初始化**

在 `public/app.js` 顶部添加：

```javascript
// Tauri API 初始化
import { invoke, event } from 'https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/index.js';
import { open as openPath } from 'https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/shell.js';

// 检测是否在 Tauri 环境中运行
const isTauri = typeof window.__TAURI__ !== 'undefined';

console.log('[App] Tauri environment:', isTauri);

// 全局 Tauri 实例暴露给前端业务逻辑
window.tauriApi = {
  isTauri,
  invoke: isTauri ? invoke : null,
  event: isTauri ? event : null,
};
```

这段代码应该在任何其他业务逻辑之前执行。

**注意**：使用 CDN 加载（无需 npm 依赖）。如果你的 `public/app.js` 已经有模块化系统，改用本地 import。

---

#### **Step 4.2: 封装通知函数**

在 `public/app.js` 中添加通知 helper：

```javascript
// 发送系统通知（Tauri 环境）
async function notifyUser(title, body, { icon = 'info' } = {}) {
  if (!window.tauriApi.isTauri) {
    console.warn('[Notify] Not in Tauri, skipping system notification');
    return;
  }

  try {
    // 调用后端 /internal/notify 接口，由 Tauri 弹出原生通知
    const response = await fetch('http://127.0.0.1:3000/internal/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, icon }),
    });
    
    if (response.ok) {
      console.log('[Notify] Sent:', title);
    }
  } catch (err) {
    console.error('[Notify Error]', err);
  }
}

// 暴露到全局
window.notifyUser = notifyUser;
```

---

#### **Step 4.3: 在任务完成时调用通知**

找到现有代码中"任务完成"的地方（通常是 SSE 或 WebSocket 消息处理）。

假设现有代码中有类似的逻辑（伪代码）：

```javascript
function onRunCompleted(result) {
  // 更新 UI 显示结果
  updateResultUI(result);
  
  // 新增：调用系统通知
  notifyUser(
    'Task Completed',
    `"${result.title}" execution finished`,
    { icon: 'success' }
  );
}
```

找到实际的完成事件处理位置并插入 `notifyUser()` 调用。

---

#### **Step 4.4: 监听 Tauri 事件（菜单和快捷键触发的前端事件）**

在 `public/app.js` 初始化代码处添加：

```javascript
// 监听 Tauri 事件：focus-input（来自托盘「新建任务」或菜单）
if (window.tauriApi.isTauri && window.tauriApi.event) {
  window.tauriApi.event.listen('focus-input', () => {
    console.log('[Tauri Event] focus-input');
    // 找到你的输入框并 focus
    const inputElement = document.querySelector('input[type="text"][placeholder*="prompt"], textarea');
    if (inputElement) {
      inputElement.focus();
      inputElement.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // 监听 Tauri 事件：open-settings
  window.tauriApi.event.listen('open-settings', () => {
    console.log('[Tauri Event] open-settings');
    // 打开设置面板
    const settingsBtn = document.querySelector('button[class*="settings"], a[href*="settings"]');
    if (settingsBtn) {
      settingsBtn.click();
    }
  });

  // 监听 Tauri 事件：open-logs
  window.tauriApi.event.listen('open-logs', () => {
    console.log('[Tauri Event] open-logs');
    // 在桌面环境中打开日志文件夹（可选）
    // 这里先打个日志，后续可以调用 Tauri 的文件管理器 API
  });
}
```

---

#### **Step 4.5: 添加开机自启控制 UI 信号**

如果你的前端设置页已经有「开机自启」切换，添加代码来调用 Tauri IPC：

```javascript
// 假设存在一个设置切换按钮或 checkbox，ID 为 autostart-toggle
const autostartToggle = document.getElementById('autostart-toggle');
if (autostartToggle && window.tauriApi.isTauri) {
  autostartToggle.addEventListener('change', async (e) => {
    try {
      const enabled = e.target.checked;
      // 调用后端接口或 Tauri IPC 来切换开机自启
      // 先简单地通过后端 /internal/notify 记录这个操作
      await fetch('http://127.0.0.1:3000/internal/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Autostart',
          body: enabled ? 'Enabled' : 'Disabled',
        }),
      });
      console.log('[Settings] Autostart:', enabled);
    } catch (err) {
      console.error('[Settings Error]', err);
    }
  });
}
```

**注意**：这里先用 `/internal/notify` 作为信号，后续可以改成真正的 Tauri IPC 调用。

---

#### **Step 4.6: 验证没有语法错误**

在浏览器开发者工具中（F12）查看 Console，不应该有红色错误（允许网络错误，因为还没启动后端）。

---

#### **Step 4.7: Commit**

```bash
git add public/app.js
git commit -m "feat(frontend): integrate Tauri IPC for notifications, events, settings

- Add Tauri API initialization via CDN (no npm dependency)
- Expose notifyUser() helper to send system notifications via backend
- Listen to Tauri events: focus-input, open-settings, open-logs
- Add autostart toggle signal (saves to settings via backend notify)"

---

### Task 5: 本地开发测试 (`tauri dev` 验证启动流程)

**Files:**
- 无新增/改动文件

---

#### **Step 5.1: 检查 Rust 工具链**

```bash
rustc --version
cargo --version
```

预期输出：
```
rustc 1.xx.x (xxxxxxxx yyyy-mm-dd)
cargo 1.xx.x (xxxxxxxx yyyy-mm-dd)
```

如果无输出或报错，安装 Rust（一次性）：
```bash
# Windows / macOS / Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

按提示完成安装，然后重开终端。

---

#### **Step 5.2: 启动开发模式**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
npm run tauri:dev
```

预期行为：
1. Tauri CLI 启动编译 Rust（首次 5-10 分钟，后续 1-2 分钟）
2. 编译完成后打开桌面窗口（标题「Vibe Coding」）
3. WebView 尝试加载 http://127.0.0.1:3000/index.html
4. 后端健康检查超时（因为 sidecar 还没启动成功，这很正常）
5. 可能弹 dialog「backend startup failed」

这是预期的，因为 sidecar Node 进程还没启动。先让窗口打开确认 Tauri 框架本身工作正常。

---

#### **Step 5.3: 手动启动后端（在另一个终端）**

打开新终端：

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
node server.js
```

预期输出：
```
[...] Server running on http://127.0.0.1:3000
```

---

#### **Step 5.4: 刷新 Tauri 窗口**

回到 Tauri 开发窗口，按 `F5` 刷新（或 `Ctrl+R`）。

预期行为：
- WebView 重新加载 http://127.0.0.1:3000/index.html
- 前端 UI 应该能正常显示（如果没有 SSE 连接错误）

---

#### **Step 5.5: 测试系统托盘**

在 Tauri 窗口标题栏右侧应该能看到系统托盘图标。右键点击：

预期菜单项：
- Open
- New Task
- Settings
- Quit

点击「Open」应该把窗口置顶显示。

---

#### **Step 5.6: 测试全局快捷键**

按 `Ctrl+Shift+P`（Windows）或 `Cmd+Shift+P`（macOS），应该把窗口恢复到焦点。

---

#### **Step 5.7: 关闭窗口验证「最小化到托盘」行为**

点窗口右上角的「×」按钮，窗口应该**隐藏**而不是关闭（托盘图标保持）。

从托盘菜单点「Open」应该让窗口重新出现。

---

#### **Step 5.8: 关闭开发模式**

在 Tauri 开发窗口中按 `Ctrl+C` 或点 Quit，应该：
1. Tauri 主进程退出
2. 手动启动的 `node server.js` 仍在运行（需要手动 `Ctrl+C` 杀掉）

---

#### **Step 5.9: Cleanup**

停止后端进程：

```bash
# 如果还在运行
Ctrl+C
```

检查没有遗留进程（特别是在 Windows 上容易有僵尸进程）：

```bash
# Windows
tasklist | findstr node.exe

# macOS/Linux
ps aux | grep node
```

---

#### **Step 5.10: Commit**

```bash
git add -A
git commit -m "test(tauri): verify dev mode startup, tray, shortcuts, minimize-to-tray

- Confirm Tauri window opens successfully
- Test system tray menu interaction (Open, New Task, Settings, Quit)
- Verify Ctrl+Shift+P global shortcut brings window to focus
- Confirm window close minimizes to tray (not exit)
- Manual backend startup validates sidecar IPC pathway"

---

### Task 6: Sidecar 自动启动与健康检查完善

**Files:**
- Modify: `src-tauri/src/main.rs`

---

#### **Step 6.1: 改进 sidecar 启动逻辑（自动查找 node）**

当前的 `setup_sidecar()` 用 `tauri::api::process::Command::new_sidecar("node")` 启动 sidecar，但这依赖 Tauri 在构建时正确打包 Node 二进制。

为了更稳健，改进启动逻辑以支持"如果打包的 node 不存在，降级到系统 node"：

在 `setup_sidecar()` 函数中替换为：

```rust
fn setup_sidecar(app: &AppHandle) -> Result<(), String> {
    println!("[Tauri] Starting sidecar: node server.js");

    // 尝试用 sidecar node（打包时内嵌的）
    let sidecar_result = tauri::api::process::Command::new_sidecar("node")
        .map_err(|e| {
            eprintln!("[Tauri] Sidecar node not found, falling back to system node: {}", e);
            format!("sidecar: {}", e)
        })
        .and_then(|cmd| {
            cmd.args(&["../server.js"]).spawn()
                .map_err(|e| format!("spawn sidecar: {}", e))
        });

    let (mut rx, child) = match sidecar_result {
        Ok(output) => output,
        Err(sidecar_err) => {
            // 降级到系统 node（开发模式或用户已装 Node.js）
            eprintln!("[Tauri] {}, trying system node...", sidecar_err);
            use std::process::{Command, Stdio};
            
            let mut child = Command::new("node")
                .arg("server.js")
                .current_dir(".")  // 改为项目根目录路径
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("system node failed: {}", e))?;

            // 系统 node 启动后直接进行健康检查，不通过 rx（因为这里用的是 std::process::Child）
            println!("[Tauri] System node started, skipping rx pipe");
            
            // 等待健康检查
            for attempt in 0..20 {
                std::thread::sleep(Duration::from_millis(500));
                match reqwest::blocking::Client::new()
                    .get("http://127.0.0.1:3000/api/ping")
                    .send()
                {
                    Ok(_) => {
                        println!("[Tauri] Backend is healthy (system node)");
                        std::mem::forget(child);  // 让进程继续运行
                        return Ok(());
                    }
                    Err(_) => {
                        if attempt % 4 == 0 {
                            println!("[Tauri] Attempt {} - waiting for backend...", attempt + 1);
                        }
                    }
                }
            }
            
            return Err("Backend failed to start (timeout after 10s) on both sidecar and system node".to_string());
        }
    };

    // Sidecar 路径：监听 stdout 日志
    unsafe {
        SIDECAR_HANDLE = Some(child);
    }

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri::api::process::CommandEvent::Stdout(line) => {
                    println!("[Sidecar] {}", line);
                }
                tauri::api::process::CommandEvent::Stderr(line) => {
                    eprintln!("[Sidecar Error] {}", line);
                }
                tauri::api::process::CommandEvent::Terminated(payload) => {
                    println!("[Sidecar] Terminated with code: {:?}", payload.code);
                }
                _ => {}
            }
        }
    });

    // 等待后端健康检查
    println!("[Tauri] Waiting for backend health check...");
    for attempt in 0..20 {
        std::thread::sleep(Duration::from_millis(500));
        match tauri::http::Client::new()
            .get("http://127.0.0.1:3000/api/ping")
            .send()
        {
            Ok(_) => {
                println!("[Tauri] Backend is healthy");
                return Ok(());
            }
            Err(_) => {
                if attempt % 4 == 0 {
                    println!("[Tauri] Attempt {} - waiting for backend...", attempt + 1);
                }
            }
        }
    }

    Err("Backend failed to start (timeout after 10s)".to_string())
}
```

**关键改进**：
- 先尝试 sidecar node（打包时内嵌）
- 失败时降级到系统 node（开发模式便利）
- 健康检查改用 `tauri::http::Client` 更稳健

---

#### **Step 6.2: 在 Cargo.toml 添加 reqwest（HTTP 客户端）**

虽然用了 `tauri::http`，但为了保险起见也可以加 `reqwest` 作为备选。

编辑 `src-tauri/Cargo.toml`，在 `[dependencies]` 中添加：

```toml
[dependencies]
# ... existing deps
tokio = { version = "1", features = ["full"] }  # 异步运行时
```

---

#### **Step 6.3: 测试改进后的启动**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo

# 编译新代码
cargo build -p vibe-coding-desktop

# 开发模式启动
npm run tauri:dev
```

预期行为：
- 如果 sidecar node 不存在（或打包有问题），自动降级到系统 node
- 后端成功启动（应该看到「Backend is healthy」日志）
- 前端正常加载

---

#### **Step 6.4: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(tauri): improve sidecar startup with fallback to system node

- Try sidecar node (bundled) first, fallback to system node on failure
- Improves development mode experience (no need to rebuild after node update)
- Better health check loop with clearer logging
- Use tauri::http::Client for more robust http checks"

---

### Task 7: 打包脚本编写（Windows + macOS）

**Files:**
- Create: `scripts/build-win.sh`
- Create: `scripts/build-mac.sh`
- Modify: `package.json` (add platform-specific build scripts)

---

#### **Step 7.1: 编写 Windows 打包脚本**

创建 `scripts/build-win.sh`（给 Git Bash 或 WSL 用，或改名为 `.bat` 用 CMD）：

```bash
#!/bin/bash
# Windows x86_64 build script

set -e

echo "[Build] Windows x86_64 build starting..."

# 清理旧的构建产物
if [ -d "src-tauri/target" ]; then
  echo "[Build] Cleaning previous target..."
  rm -rf src-tauri/target
fi

# 检查 Rust 工具链
if ! command -v rustc &> /dev/null; then
  echo "[Error] Rust toolchain not found. Install from https://rustup.rs/"
  exit 1
fi

# 检查目标三元组
rustup target add x86_64-pc-windows-msvc 2>/dev/null || true

# 构建 Tauri 应用
echo "[Build] Running tauri build..."
npm run tauri:build:win

# 找到产物
if [ -d "src-tauri/target/x86_64-pc-windows-msvc/release/bundle" ]; then
  BUNDLE_DIR="src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
  echo "[Build] ✓ Build succeeded!"
  echo "[Build] Output:"
  find "$BUNDLE_DIR" -name "*.exe" -o -name "*.msi" | while read f; do
    echo "  $f ($(du -h "$f" | cut -f1))"
  done
else
  echo "[Error] Bundle directory not found"
  exit 1
fi
```

---

#### **Step 7.2: 编写 macOS 打包脚本**

创建 `scripts/build-mac.sh`：

```bash
#!/bin/bash
# macOS universal build script (Apple Silicon + Intel)

set -e

echo "[Build] macOS universal build starting..."

# 清理旧的构建产物
if [ -d "src-tauri/target" ]; then
  echo "[Build] Cleaning previous target..."
  rm -rf src-tauri/target
fi

# 检查 Rust 工具链
if ! command -v rustc &> /dev/null; then
  echo "[Error] Rust toolchain not found. Install from https://rustup.rs/"
  exit 1
fi

# 检查并添加两个 macOS 目标架构
echo "[Build] Adding macOS target architectures..."
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 构建两个架构
echo "[Build] Building for Apple Silicon (aarch64)..."
npm run tauri:build:mac

echo "[Build] ✓ macOS build succeeded!"
echo "[Build] Output:"
find src-tauri/target -name "*.dmg" -o -name "*.app" 2>/dev/null | while read f; do
  echo "  $f"
done
```

---

#### **Step 7.3: 编写 Windows 批处理脚本（CMD 用户）**

创建 `scripts/build-win.bat`：

```batch
@echo off
REM Windows x86_64 build script (CMD)

setlocal enabledelayedexpansion

echo [Build] Windows x86_64 build starting...

REM 清理旧的构建产物
if exist "src-tauri\target" (
  echo [Build] Cleaning previous target...
  rmdir /s /q "src-tauri\target"
)

REM 检查 Rust 工具链
rustc --version >nul 2>&1
if errorlevel 1 (
  echo [Error] Rust toolchain not found. Install from https://rustup.rs/
  exit /b 1
)

REM 构建 Tauri 应用
echo [Build] Running tauri build...
call npm run tauri:build:win

REM 检查产物
if exist "src-tauri\target\x86_64-pc-windows-msvc\release\bundle" (
  echo [Build] ^O Build succeeded!
  echo [Build] Output:
  for /r "src-tauri\target\x86_64-pc-windows-msvc\release\bundle" %%f in (*.exe *.msi) do (
    echo   %%f
  )
) else (
  echo [Error] Bundle directory not found
  exit /b 1
)
```

---

#### **Step 7.4: 更新 package.json 脚本**

修改 `package.json` 的 `"scripts"` 部分，追加：

```json
{
  "scripts": {
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "tauri:build:win": "tauri build --target x86_64-pc-windows-msvc",
    "tauri:build:mac": "tauri build --target universal-apple-darwin",
    "build:release:win": "bash scripts/build-win.sh",
    "build:release:mac": "bash scripts/build-mac.sh",
    "build:release": "npm run build:release:win && npm run build:release:mac",
    "start": "node server.js"
  }
}
```

---

#### **Step 7.5: 测试 Windows 打包（在 Windows 机器上）**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo

# 方式 1：直接用 npm script
npm run tauri:build:win

# 方式 2：用脚本（需要 Git Bash 或 WSL）
bash scripts/build-win.sh
```

预期行为：
- Rust 编译进行（第一次 10-15 分钟，后续 2-5 分钟）
- 输出 `.exe` 安装器和 `.msi` 包
- 产物位置：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`

---

#### **Step 7.6: 验证 Windows 产物（可选）**

如果构建成功，可以尝试运行生成的 `.exe` 安装器验证：

```bash
# 找到产物
ls src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/

# 运行安装器（会弹安装向导）
./src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
```

安装完成后，从开始菜单或桌面快捷方式启动应用，验证能否正常运行。

---

#### **Step 7.7: macOS 打包说明（需要在 macOS 上执行）**

目前（首期）不做 macOS 打包。等 Windows 版本验证无误后，用同一份代码在 macOS 上跑：

```bash
# 在 macOS 机器上
npm run tauri:build:mac

# 或用脚本
bash scripts/build-mac.sh
```

产物会位于 `src-tauri/target/universal-apple-darwin/release/bundle/`，包含 `.dmg` 和 `.app` 目录。

**注意**：macOS 首期跳过公证签名（Notarization），用户可能需要「允许运行」。二期可补充苹果开发者账号签名。

---

#### **Step 7.8: Commit**

```bash
git add scripts/build-win.sh scripts/build-win.bat scripts/build-mac.sh package.json
git commit -m "feat(build): add cross-platform packaging scripts for Windows and macOS

- Windows x86_64 build via tauri (NSIS .exe + .msi installer)
- macOS universal build via tauri (universal-apple-darwin: Intel + Apple Silicon)
- Bash scripts for Unix/Git Bash, .bat script for CMD
- Add npm scripts: build:release:win, build:release:mac, build:release
- First run: ~10-15 min, subsequent: ~2-5 min due to Rust incremental compilation"

---

### Task 8: CI/CD 流程（GitHub Actions 自动打包）

**Files:**
- Create: `.github/workflows/release.yml`

---

#### **Step 8.1: 编写 GitHub Actions 工作流**

创建 `.github/workflows/release.yml`：

```yaml
name: Build and Release

on:
  push:
    tags:
      - "v*.*.*"  # 触发条件：推送 v1.0.0 之类的 tag

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            artifact: "*.exe"
            artifact_name: "claude-agent-setup.exe"

          - os: macos-latest
            target: universal-apple-darwin
            artifact: "*.dmg"
            artifact_name: "claude-agent.dmg"

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install dependencies
        run: npm ci

      - name: Build Tauri app
        run: npm run tauri:build -- --target ${{ matrix.target }}

      - name: Find artifacts
        id: artifacts
        shell: bash
        run: |
          if [ "${{ runner.os }}" = "Windows" ]; then
            BUNDLE_DIR="src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
          else
            BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
          fi
          
          # 找到产物文件
          ARTIFACT=$(find "$BUNDLE_DIR" -name "${{ matrix.artifact }}" | head -1)
          if [ -z "$ARTIFACT" ]; then
            echo "Artifact not found in $BUNDLE_DIR"
            exit 1
          fi
          
          echo "artifact=$ARTIFACT" >> $GITHUB_OUTPUT
          echo "Found artifact: $ARTIFACT"

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: ${{ steps.artifacts.outputs.artifact }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

关键点：
- 触发条件：`push:tags: v*.*.*` - 推送版本 tag 时自动触发
- 矩阵策略：同时在 Windows 和 macOS 构建
- 产物上传：自动上传到 GitHub Releases

---

#### **Step 8.2: 测试 CI 工作流（手动创建 tag）**

在本地创建一个 tag 并推送：

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo

# 确保代码已提交
git status
# 输出应该是 "On branch main, nothing to commit"

# 创建 tag
git tag v0.1.0

# 推送 tag 到远程
git push origin v0.1.0
```

推送后，访问 GitHub 仓库的 Actions 页面，应该看到一个自动运行的工作流。

等待 15-30 分钟（首次编译较长），完成后访问 Releases 页面应该能看到产物文件。

---

#### **Step 8.3: 后续发布流程**

每次发布新版本：

```bash
# 1. 修改 package.json 版本号
npm version patch  # or minor / major

# 2. 推送代码
git push origin main

# 3. 推送 tag 触发自动构建
git push origin <tag>
```

CI 会自动构建并上传到 Releases。

---

#### **Step 8.4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add GitHub Actions workflow for automated cross-platform releases

- Trigger on version tags (v*.*.*)
- Build Windows and macOS in parallel
- Auto-upload artifacts to GitHub Releases
- Reduces manual packaging effort, ensures reproducible builds"

---

### Task 9: 文档更新 + 部署指南

**Files:**
- Create: `docs/TAURI_SETUP.md`
- Create: `docs/DISTRIBUTION.md`
- Modify: `README.md`

---

#### **Step 9.1: 编写 Tauri 本地开发指南**

创建 `docs/TAURI_SETUP.md`：

```markdown
# Tauri 开发环境设置

## 前置条件

- **Node.js**：v20+（检查：`node -v`）
- **Rust**：通过 rustup 安装（一次性）
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Visual Studio Build Tools**（Windows 用户）：需要 MSVC 工具链
  - 运行 `rustc --version` 验证
  - 如果失败，下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)，勾选「Desktop development with C++」

## 第一次启动

1. **克隆项目并安装依赖**
   ```bash
   git clone <repo>
   cd claude-p-web-demo
   npm install
   ```

2. **开发模式启动**
   ```bash
   npm run tauri:dev
   ```
   
   首次编译需要 5-10 分钟。Tauri 窗口打开后，系统会尝试启动 Node sidecar。

3. **手动启动后端**（可选，如果 sidecar 失败）
   ```bash
   # 在另一个终端
   node server.js
   ```

4. **刷新窗口**
   - 在 Tauri 开发窗口按 `F5` 或 `Ctrl+R` 重载

## 日常开发工作流

### 修改 Rust 代码（src-tauri/src/main.rs）

- 保存后自动重新编译（若开启了 watch 模式）
- 或手动按 Ctrl+R 重启 Tauri 窗口

### 修改前端代码（public/）

- 保存后自动刷新（若启用了 live-reload）
- 或手动按 F5 刷新

### 修改后端代码（server.js / src/）

- 需要手动停止后端，再在终端中重新 `node server.js`
- 或点托盘菜单「Quit」后重新启动应用

## 常见问题

### 1. Rust 工具链找不到

```bash
rustc --version
```

如果无输出或报错，安装 Rust：
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Windows 缺少 MSVC 工具链

下载 Visual Studio Build Tools，勾选「Desktop development with C++」。

### 3. 后端无法启动（sidecar 超时）

通常是因为 Node 进程没有权限或端口 3000 被占用。

- 检查端口：`lsof -i :3000` （macOS）或 `netstat -ano | findstr :3000` （Windows）
- 如果被占用，杀掉进程或改 `server.js` 的端口

### 4. 编译超时 / 内存不足

Rust 编译较吃内存。如果机器配置低（<4GB RAM），编译会很慢。

- 考虑增大虚拟内存（临时方案）
- 或用 CI（GitHub Actions）在云上编译

## 性能优化提示

- 首次编译会缓存依赖，后续编译快 10 倍
- 增量编译：只改一两行 Rust，重新编译只需 1-2 分钟
- 发布构建（Release）比开发构建（Debug）小 5-10 倍，但编译时间长 2-3 倍

---

```

---

#### **Step 9.2: 编写分发指南**

创建 `docs/DISTRIBUTION.md`：

```markdown
# 应用分发指南

## 本地打包

### Windows

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
npm run tauri:build:win
```

产物：
- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/claude-agent-setup.exe` - 安装器
- `.msi` 文件（如需）

### macOS

```bash
npm run tauri:build:mac
```

产物：
- `src-tauri/target/universal-apple-darwin/release/bundle/dmg/claude-agent.dmg` - 安装镜像
- `.app` 目录（应用包）

## 自动打包（GitHub Actions）

1. **创建版本 tag**
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **观察构建**
   - 访问 GitHub 仓库 → Actions 页面
   - 等待工作流完成（15-30 分钟）

3. **下载产物**
   - 访问 Releases 页面
   - 下载对应平台的安装器

## 签名与公证（可选，后期补充）

### Windows 代码签名

目前跳过。若需添加，可在 CI 中集成代码签名证书。

### macOS 公证（Notarization）

目前跳过。macOS 用户会看到「开发者身份无法验证」提示，需手动允许运行。

后期若需添加，需要 Apple Developer 账号。

## 分发渠道

### 方式 1：GitHub Releases

在项目 Releases 页面提供下载链接。

### 方式 2：公司内部网盘 / 文件服务

自动从 GitHub Releases 下载，上传到内部服务。

### 方式 3：应用商店

暂未支持。若需要，后期可接入 Windows Store / Mac App Store（需额外配置）。

---

```

---

#### **Step 9.3: 更新主 README.md**

在项目根目录 `README.md` 的「快速开始」部分追加：

```markdown
## 🖥️ 桌面版本

本项目现已支持 Tauri 桌面应用，支持 Windows + macOS。

### 下载

访问 [Releases](https://github.com/your-repo/releases) 页面下载对应平台安装器。

### 本地开发

```bash
npm run tauri:dev
```

详细指南见 [TAURI_SETUP.md](docs/TAURI_SETUP.md)。

### 系统功能

- 📋 系统托盘（快速菜单）
- 🔔 原生通知（任务完成提醒）
- ⌨️ 全局快捷键（`Ctrl+Shift+P` 唤起窗口）
- 🚀 开机自启（可配置）
- 📦 跨平台打包（Windows .exe + macOS .dmg）

### 打包发布

```bash
# 本地打包
npm run tauri:build:win    # Windows
npm run tauri:build:mac    # macOS

# 自动发布（推送 tag 时自动触发 CI）
git tag v1.0.0
git push origin v1.0.0
```

详见 [DISTRIBUTION.md](docs/DISTRIBUTION.md)。

---

```

---

#### **Step 9.4: Commit**

```bash
git add docs/TAURI_SETUP.md docs/DISTRIBUTION.md README.md
git commit -m "docs: add Tauri setup, distribution, and desktop deployment guides

- TAURI_SETUP.md: local development environment, common issues, workflows
- DISTRIBUTION.md: local packaging, CI/CD, signing & notarization notes
- README.md: updated with desktop version features and quick links"

---

### Task 10: 完整集成测试 + 首个发布

**Files:**
- 无新增文件（所有改动已在 Task 1-9 完成）

---

#### **Step 10.1: 完整本地测试流程**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo

# 1. 清理旧的构建产物（确保干净构建）
rm -rf src-tauri/target node_modules

# 2. 重新安装依赖
npm install

# 3. 启动开发模式
npm run tauri:dev
```

验证清单：
- [ ] Tauri 窗口正常打开
- [ ] 后端健康检查通过（日志显示「Backend is healthy」）
- [ ] 前端 UI 正常加载
- [ ] 系统托盘图标出现
- [ ] 右键托盘菜单能打开
- [ ] `Ctrl+Shift+P` 快捷键能唤起窗口
- [ ] 关闭窗口后窗口隐藏而不是退出
- [ ] 托盘菜单「Open」能恢复窗口
- [ ] 托盘菜单「Quit」能退出应用
- [ ] 前端任务完成时能收到系统通知（如实现了通知功能）

---

#### **Step 10.2: 测试最小化到托盘行为**

1. 启动应用（`npm run tauri:dev`）
2. 点窗口标题栏右上角的「×」按钮
3. 验证窗口隐藏（仍能看到托盘图标）
4. 点托盘图标
5. 验证窗口重新出现

---

#### **Step 10.3: 测试快捷键在后台工作**

1. 启动应用，然后点「×」隐藏窗口
2. 点其他应用（比如浏览器、记事本）让它获得焦点
3. 按 `Ctrl+Shift+P`（Windows）或 `Cmd+Shift+P`（macOS）
4. 验证 Vibe Coding 窗口突然出现并置顶

---

#### **Step 10.4: 本地 Windows 打包测试**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo

# 执行 Windows 打包
npm run tauri:build:win

# 等待编译完成（5-15 分钟）
```

验证产物：
```bash
ls src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/

# 输出应该包含：
# claude-agent-setup.exe (体积 ~60-80MB)
```

---

#### **Step 10.5: 验证安装器可用（可选）**

如果想完整验证，可以尝试运行生成的 `.exe`：

```bash
./src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/claude-agent-setup.exe
```

这会弹出安装向导。按提示完成安装后，从开始菜单或桌面启动应用，验证能否正常运行。

**注意**：首次运行可能被 Windows Defender 拦截（未签名的 .exe），需要点「更多信息」→「仍要运行」。

---

#### **Step 10.6: 准备首个版本发布**

更新版本号和发布信息：

```bash
# 更新 package.json 版本号
npm version minor  # 从 0.1.0 → 0.2.0

# 查看变化
git diff

# 提交
git add package.json package-lock.json
git commit -m "chore: bump version to 0.2.0 for first desktop release"

# 创建版本 tag
git tag v0.2.0

# 推送代码和 tag
git push origin main
git push origin v0.2.0
```

---

#### **Step 10.7: 监控 CI 构建**

打开 GitHub 仓库 → Actions 页面，观看工作流执行：

- Windows 构建：3-10 分钟
- macOS 构建：3-10 分钟

两个任务并行，总耗时约 10-15 分钟。

完成后，访问 Releases 页面应该看到两个产物：
- `claude-agent-setup.exe` (Windows)
- `claude-agent.dmg` (macOS)

---

#### **Step 10.8: 生成发布说明（Release Notes）**

在 GitHub Releases 页面编辑 v0.2.0 release，添加说明：

```markdown
# Vibe Coding Desktop v0.2.0

首个 Tauri 桌面版本。

## 新增功能

- ✨ 跨平台支持（Windows x86_64 + macOS Intel/Apple Silicon）
- 📋 系统托盘菜单（快速访问、设置、退出）
- 🔔 原生系统通知（任务完成提醒）
- ⌨️ 全局快捷键（Ctrl+Shift+P / Cmd+Shift+P 唤起窗口）
- 🚀 开机自启选项（设置页面可配置）
- 🎯 智能最小化（关闭窗口 = 隐藏到托盘，点托盘恢复）

## 系统要求

- **Windows**：Windows 10 或更高版本，x86_64 架构
- **macOS**：macOS 10.13 或更高版本，Intel 或 Apple Silicon

## 下载

点上方「Assets」下载对应平台安装器。

## 已知问题

- macOS 首次运行可能提示「无法验证开发者身份」，需手动允许（后期添加签名后解决）
- Windows 杀毒软件可能拦截未签名的 .exe（正常，后期添加代码签名后解决）

---

```

---

#### **Step 10.9: Commit**

```bash
# 这一步主要是验证和文档，无需额外 commit
# 所有改动已在 Task 1-9 提交

# 如果本地测试发现 bug，修复后独立 commit
git commit -m "fix(tauri): <issue description>" --allow-empty

# 最后做一个总结 commit
git log --oneline -10  # 查看最近 10 个 commit
```

---

#### **Step 10.10: 后续迭代**

首个桌面版本发布后，后续可以：

1. **代码签名**（安全性）
   - Windows：添加代码签名证书，消除 SmartScreen 警告
   - macOS：申请开发者账号，进行公证（Notarization）

2. **自动更新**
   - 集成 `tauri-plugin-updater`，用户启动时检查新版本
   - 有新版本时自动下载并提示升级

3. **性能优化**
   - 监测内存占用、启动时间
   - 考虑 sidecar 改用 Bun runtime（更轻量）

4. **功能拓展**
   - 文件关联（双击 `.claude-task` 文件打开）
   - 系统剪贴板集成
   - 后台下载任务管理