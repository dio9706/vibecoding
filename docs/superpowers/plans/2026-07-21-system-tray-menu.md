# 系统托盘菜单增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为系统托盘菜单新增 4 个功能菜单项（需求/故障、访问日志、设置、切换账号），支持快速导航和账号切换。

**Architecture:** 三层架构变更：
1. **Rust 层（Tauri）**：右键菜单弹出时动态拉取账号列表，构建子菜单；菜单项点击时检查账号权限并通过 IPC 触发导航或 HTTP 请求账号切换
2. **HTTP API 层（Node.js）**：新增 `GET /api/tokens/list` 和 `POST /api/tokens/switch` 两个端点，复用现有 token-rotation 函数
3. **前端层（HTML/JS）**：扩展 IPC 监听器，接收来自 Rust 的 `showView` 事件，触发页面导航

**Tech Stack:** Tauri v2 (Rust) + Tokio (async runtime) + Express.js + Tauri IPC API

---

## Phase 1: HTTP API 层 - 新增 Token 管理端点

### Task 1: 新增 GET /api/tokens/list 端点

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 定位 server.js 中的 API 路由定义区域**

打开 `src/entrypoints/web/server.js`，找到现有的 `app.get('/api/settings', ...)` 代码（第 ~558 行），这是新增 API 的参考点。

- [ ] **Step 2: 检查 token-rotation.js 中现有的辅助函数**

打开 `src/features/token-rotation.js`，验证以下导出函数存在：
- `getTokens()` - 返回所有 token 对象数组
- `getActiveTokenId()` - 返回当前活跃 token 的 ID
- `getTokenById(id)` - 返回指定 ID 的 token 对象（如果不存在则需要在下一步编写）

运行：
```bash
grep -n "export function getTokens\|export function getActiveTokenId\|export function getTokenById" src/features/token-rotation.js
```

**预期输出：** 至少看到 `getTokens` 和 `getActiveTokenId` 导出。如果 `getTokenById` 不存在，记住在后续步骤补充。

- [ ] **Step 3: 在 server.js 中新增 GET /api/tokens/list 端点**

在 `app.get('/api/settings', ...)` 下方添加以下代码：

```javascript
// GET /api/tokens/list - 获取所有账号列表 + 当前活跃账号
app.get('/api/tokens/list', (req, res) => {
    try {
        const allTokens = getTokens(); // 从 token-rotation.js 导入的函数
        const activeTokenId = getActiveTokenId();

        const tokenList = allTokens.map(t => ({
            id: t.id,
            label: t.label,
            isActive: t.id === activeTokenId
        }));

        res.json({
            tokens: tokenList,
            activeId: activeTokenId
        });
    } catch (error) {
        console.error('[GET /api/tokens/list] Error:', error);
        res.status(500).json({ error: 'Failed to fetch tokens' });
    }
});
```

- [ ] **Step 4: 确保 token-rotation.js 的导入**

在 `server.js` 顶部的 import 区域，检查是否已导入 `token-rotation.js` 中的函数。如果没有，添加：

```javascript
const { getTokens, getActiveTokenId, switchActiveToken, getTokenById } = require('../features/token-rotation.js');
```

（如果该文件已有导入，跳过此步）

- [ ] **Step 5: 运行服务器并测试 GET /api/tokens/list 端点**

启动开发服务器（在项目根目录运行）：

```bash
npm run dev
```

等待服务启动。在另一个终端窗口测试端点：

```bash
curl http://127.0.0.1:3000/api/tokens/list
```

**预期输出：** 返回一个 JSON 对象，包含 `tokens` 数组和 `activeId` 字符串，例如：

```json
{
  "tokens": [
    { "id": "token-001", "label": "My Token", "isActive": true }
  ],
  "activeId": "token-001"
}
```

- [ ] **Step 6: 提交此步骤**

```bash
git add src/entrypoints/web/server.js
git commit -m "feat: add GET /api/tokens/list endpoint for fetching account list"
```

---

### Task 2: 新增 POST /api/tokens/switch 端点

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 在 server.js 中新增 POST /api/tokens/switch 端点**

在 `GET /api/tokens/list` 下方添加以下代码：

```javascript
// POST /api/tokens/switch - 切换活跃账号
app.post('/api/tokens/switch', (req, res) => {
    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({ error: 'Token ID is required' });
        }

        // 查验 token 是否存在
        const token = getTokenById(id);
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }

        // 执行切换
        switchActiveToken(id);

        res.json({
            success: true,
            label: token.label,
            message: `已切换到账号 ${token.label}`
        });
    } catch (error) {
        console.error('[POST /api/tokens/switch] Error:', error);
        res.status(500).json({ error: error.message });
    }
});
```

- [ ] **Step 2: 补充 getTokenById 函数（如果不存在）**

运行检查：

```bash
grep -n "export function getTokenById" src/features/token-rotation.js
```

如果没有输出，打开 `src/features/token-rotation.js`，在 `getTokens()` 或 `getActiveTokenId()` 函数后添加：

```javascript
export function getTokenById(id) {
    const tokens = getTokens();
    return tokens.find(t => t.id === id) || null;
}
```

- [ ] **Step 3: 运行服务器并测试 POST /api/tokens/switch 端点**

假设已有至少两个 token（通过前面的 `curl /api/tokens/list` 查看），测试切换：

```bash
# 首先查看当前的活跃账号
curl http://127.0.0.1:3000/api/tokens/list

# 然后尝试切换到另一个账号（将 "token-002" 替换为实际的 token ID）
curl -X POST http://127.0.0.1:3000/api/tokens/switch \
  -H "Content-Type: application/json" \
  -d '{"id": "token-002"}'
```

**预期输出（成功）：**

```json
{
  "success": true,
  "label": "token-002 的标签",
  "message": "已切换到账号 ..."
}
```

**预期输出（失败 - ID 不存在）：**

```json
{
  "error": "Token not found"
}
```

- [ ] **Step 4: 再次查询列表，确认活跃账号已更改**

```bash
curl http://127.0.0.1:3000/api/tokens/list
```

应该看到不同的账号被标记为 `isActive: true`。

- [ ] **Step 5: 提交此步骤**

```bash
git add src/entrypoints/web/server.js src/features/token-rotation.js
git commit -m "feat: add POST /api/tokens/switch endpoint and getTokenById helper"
```

---

## Phase 2: 前端层 - 扩展 IPC 事件监听

### Task 3: 在前端添加 tauri://showView IPC 事件监听

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 定位 public/app.js 中的现有 IPC 监听代码**

打开 `public/app.js`，搜索 `window.addEventListener('tauri://` 或 `listen('` 来找到现有的 IPC 监听代码。根据探索报告，应该在第 143-162 行附近有 `focus-input`, `open-settings`, `open-logs` 等事件监听。

- [ ] **Step 2: 在现有 IPC 监听后添加 showView 事件监听**

找到最后一个 `window.addEventListener('tauri://...` 或相关 IPC 监听代码，在其后添加：

```javascript
// 接收来自 Rust 的 showView 事件，用于托盘菜单导航
window.addEventListener('tauri://showView', (event) => {
    const view = event.detail.payload;
    if (['chat', 'settings', 'tasks', 'logs'].includes(view)) {
        showView(view);
    }
});
```

**说明：**
- `event.detail.payload` 包含 Rust 端通过 `app.emit("showView", viewName)` 发送的视图名称
- 验证 view 名称有效性后直接调用现有的 `showView()` 函数（该函数已在第 2153-2184 行定义）
- 支持的视图：`chat`（主对话）、`settings`（设置）、`tasks`（需求/故障）、`logs`（访问日志）

- [ ] **Step 3: 验证现有 showView() 函数的签名**

搜索 `function showView(name)` 并确认其实现与上述事件监听代码兼容：

```bash
grep -n "function showView" public/app.js
```

应看到类似 `2153:let activeView = 'chat';` 附近有 `function showView(name)` 定义。

- [ ] **Step 4: 手动验证语法**

在编辑器中检查新增代码是否有语法错误（括号、引号匹配等）。如果使用 VS Code，应该没有红色波浪线提示。

- [ ] **Step 5: 运行前端应用并检查浏览器控制台**

启动应用（如果未启动）：

```bash
npm run dev
```

打开应用窗口，按 F12 打开开发者工具（DevTools），转到 Console 标签。如果没有报错，说明代码加载成功。

- [ ] **Step 6: 提交此步骤**

```bash
git add public/app.js
git commit -m "feat: add tauri://showView IPC event listener for menu navigation"
```

---

## Phase 3: Rust 层（Tauri） - 动态菜单构建和菜单事件处理

### Task 4: 准备 Rust 端辅助数据结构和导入

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 检查 main.rs 中的现有导入**

打开 `src-tauri/src/main.rs`，检查顶部导入区域。需要确保以下依赖已导入：

```bash
grep -n "use std::time::Duration\|use tokio\|use serde\|use reqwest" src-tauri/src/main.rs
```

如果缺少，在 main.rs 顶部的 `use` 块添加：

```rust
use std::time::Duration;
use tokio::time::timeout;
use serde::{Deserialize, Serialize};
```

- [ ] **Step 2: 检查项目是否已依赖 reqwest（HTTP 客户端）**

查看 `src-tauri/Cargo.toml`：

```bash
grep -n "reqwest" src-tauri/Cargo.toml
```

如果没有 reqwest，在 `[dependencies]` 添加：

```toml
reqwest = { version = "0.11", features = ["json"] }
```

然后运行 `cargo build` 确保依赖正确安装。

- [ ] **Step 3: 定义 TokenListResponse 数据结构**

在 main.rs 中，找到其他 struct 定义的位置（通常在 `fn main()` 前），添加：

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Token {
    id: String,
    label: String,
    #[serde(rename = "isActive")]
    is_active: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct TokenListResponse {
    tokens: Vec<Token>,
    #[serde(rename = "activeId")]
    active_id: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct TokenSwitchResponse {
    success: bool,
    label: String,
    message: String,
}
```

- [ ] **Step 4: 定位现有的 setup_tray 函数**

搜索 `fn setup_tray(app: &AppHandle)` 的定义位置（第 123-157 行）。该函数将在后续任务中进行修改。

- [ ] **Step 5: 提交此步骤**

```bash
git add src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat: add Rust dependencies and data structures for token management"
```

---

### Task 5: 实现 rebuild_tray_menu() 异步函数

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 在 setup_tray() 前添加 rebuild_tray_menu() 函数**

找到 `fn setup_tray(app: &AppHandle)` 的定义，在其前面添加以下代码：

```rust
async fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let client = reqwest::Client::new();
    let api_url = "http://127.0.0.1:3000/api/tokens/list";

    // 1. 调用 HTTP API 拉取账号（带 2 秒超时）
    let tokens_response = timeout(
        Duration::from_secs(2),
        client.get(api_url).send()
    )
    .await;

    let (tokens, active_id) = match tokens_response {
        Ok(Ok(response)) => {
            match response.json::<TokenListResponse>().await {
                Ok(body) => (body.tokens, body.active_id),
                Err(_) => {
                    eprintln!("[rebuild_tray_menu] Failed to parse token list response");
                    (vec![], String::new())
                }
            }
        }
        _ => {
            eprintln!("[rebuild_tray_menu] HTTP request timeout or failed");
            (vec![], String::new())
        }
    };

    // 2. 构建菜单项向量
    let mut items = vec![];

    // 功能导航组
    items.push(
        tauri::menu::MenuItem::with_id(app, "nav-tasks", "需求/故障", true, None::<&str>)?
    );
    items.push(
        tauri::menu::MenuItem::with_id(app, "nav-logs", "访问日志", true, None::<&str>)?
    );
    items.push(
        tauri::menu::MenuItem::with_id(app, "nav-settings", "设置", true, None::<&str>)?
    );

    // 分隔线
    items.push(tauri::menu::MenuItem::Separator);

    // 账号管理组（子菜单）
    if !tokens.is_empty() {
        let mut account_items = vec![];
        for token in tokens.iter() {
            let label = if token.id == active_id {
                format!("✓ {}", token.label)
            } else {
                format!("  {}", token.label)
            };
            account_items.push(
                tauri::menu::MenuItem::with_id(
                    app,
                    format!("account-{}", token.id),
                    &label,
                    true,
                    None::<&str>,
                )?
            );
        }

        let account_menu = tauri::menu::Menu::with_items(app, &account_items)?;
        items.push(tauri::menu::MenuItem::new(app, "切换账号", account_menu)?);
    } else {
        // 无账号时，显示禁用的菜单项
        items.push(
            tauri::menu::MenuItem::with_id(app, "no-account", "切换账号（未配置）", false, None::<&str>)?
        );
    }

    // 退出
    items.push(
        tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?
    );

    // 3. 更新 TrayIcon 菜单
    let menu = tauri::menu::Menu::with_items(app, &items)?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(menu)?;
    }

    Ok(())
}
```

- [ ] **Step 2: 验证函数签名和编译**

在项目目录（`src-tauri`）运行：

```bash
cargo check
```

**预期结果：** 编译成功，无错误。如果有错误，检查：
- 括号、花括号是否配对
- Tauri API 版本（v2 使用 `tauri::menu::*`）
- reqwest 依赖是否已添加

- [ ] **Step 3: 提交此步骤**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: implement rebuild_tray_menu async function for dynamic menu construction"
```

---

### Task 6: 实现辅助函数（has_active_token, switch_account_api, show_tray_notification）

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 在 rebuild_tray_menu() 后添加 has_active_token() 函数**

```rust
fn has_active_token() -> bool {
    // 简单实现：检查 settings.json 中是否存在 activeTokenId
    // 或通过快速 HTTP 调用 /api/tokens/status 检查
    // 为了避免每次都网络调用，优先读本地 settings.json
    
    use std::fs;
    use std::path::PathBuf;

    if let Ok(settings_path) = std::env::var("SETTINGS_PATH") {
        if let Ok(content) = fs::read_to_string(&settings_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(tokens) = json.get("tokens").and_then(|t| t.as_array()) {
                    return !tokens.is_empty() && 
                           json.get("activeTokenId").and_then(|id| id.as_str()).is_some();
                }
            }
        }
    }

    false
}
```

- [ ] **Step 2: 在 has_active_token() 后添加 switch_account_api() 函数**

```rust
async fn switch_account_api(token_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = "http://127.0.0.1:3000/api/tokens/switch";

    let request_body = serde_json::json!({
        "id": token_id
    });

    match client
        .post(url)
        .json(&request_body)
        .send()
        .await
    {
        Ok(response) => {
            match response.json::<TokenSwitchResponse>().await {
                Ok(body) => {
                    if body.success {
                        Ok(body.label)
                    } else {
                        Err("Switch failed".to_string())
                    }
                }
                Err(e) => Err(format!("Failed to parse response: {}", e)),
            }
        }
        Err(e) => Err(format!("HTTP request failed: {}", e)),
    }
}
```

- [ ] **Step 3: 在 switch_account_api() 后添加 show_tray_notification() 函数**

```rust
#[cfg(target_os = "windows")]
fn show_tray_notification(app: &AppHandle, message: String, _duration_secs: u64) {
    // Windows: 使用 tauri::api::notification::Notification（桌面通知）
    use tauri::api::notification::Notification;
    
    let _ = Notification::new(app.config().tauri.bundle.identifier.clone())
        .title("Vibe Coding")
        .body(&message)
        .show();
}

#[cfg(target_os = "macos")]
fn show_tray_notification(app: &AppHandle, message: String, _duration_secs: u64) {
    // macOS: 同样使用桌面通知
    use tauri::api::notification::Notification;
    
    let _ = Notification::new(app.config().tauri.bundle.identifier.clone())
        .title("Vibe Coding")
        .body(&message)
        .show();
}

#[cfg(target_os = "linux")]
fn show_tray_notification(_app: &AppHandle, message: String, _duration_secs: u64) {
    // Linux: 可选，打印到 stderr 或通过 dbus 发送通知
    eprintln!("[Tray Notification] {}", message);
}
```

- [ ] **Step 4: 确保 serde_json 已导入**

在 main.rs 顶部检查是否已有 `use serde_json;`，如果没有添加。

- [ ] **Step 5: 编译检查**

```bash
cargo check
```

预期：成功编译。

- [ ] **Step 6: 提交此步骤**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: implement helper functions for token checking and account switching"
```

---

### Task 7: 修改 setup_tray() 函数 - 集成 rebuild_tray_menu() 和处理右键菜单事件

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 打开现有的 setup_tray() 函数**

找到 `fn setup_tray(app: &AppHandle)` 定义（约第 123-157 行），准备进行修改。

- [ ] **Step 2: 替换整个 setup_tray() 函数**

删除原有的 `fn setup_tray(app: &AppHandle) -> tauri::Result<()> { ... }` 函数，用以下新实现替代：

```rust
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let app_handle = app.clone();

    // 初始化时，异步构建菜单
    tauri::async_runtime::spawn(async move {
        if let Err(e) = rebuild_tray_menu(&app_handle).await {
            eprintln!("[setup_tray] Failed to rebuild initial menu: {}", e);
        }
    });

    let mut builder = TrayIconBuilder::new()
        .tooltip("Vibe Coding")
        .show_menu_on_left_click(false)
        .on_menu_event({
            let app = app.clone();
            move |app, event| {
                let app = app.clone();
                match event.id.as_ref() {
                    "nav-tasks" => {
                        if has_active_token() {
                            show_main_window(&app);
                            let _ = app.emit_all("showView", "tasks");
                        } else {
                            show_tray_notification(&app, "请先配置账号".to_string(), 2);
                        }
                    }
                    "nav-logs" => {
                        if has_active_token() {
                            show_main_window(&app);
                            let _ = app.emit_all("showView", "logs");
                        } else {
                            show_tray_notification(&app, "请先配置账号".to_string(), 2);
                        }
                    }
                    "nav-settings" => {
                        show_main_window(&app);
                        let _ = app.emit_all("showView", "settings");
                    }
                    id if id.starts_with("account-") => {
                        let token_id = id.strip_prefix("account-").unwrap().to_string();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match switch_account_api(&token_id).await {
                                Ok(label) => {
                                    show_tray_notification(
                                        &app,
                                        format!("已切换到账号 {}", label),
                                        2,
                                    );
                                    // 重建菜单，使新账号显示 ✓ 标记
                                    if let Err(e) = rebuild_tray_menu(&app).await {
                                        eprintln!("[setup_tray] Failed to rebuild menu after switch: {}", e);
                                    }
                                }
                                Err(e) => {
                                    show_tray_notification(
                                        &app,
                                        format!("切换失败: {}", e),
                                        3,
                                    );
                                }
                            }
                        });
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    builder.build(app)?;
    Ok(())
}
```

**注意：**
- 如果现有 setup_tray 已有其他自定义逻辑，需要小心合并
- 使用 `app.emit_all("showView", viewName)` 而非 `app.emit()`，确保前端能收到
- 账号切换放在异步块中避免阻塞菜单

- [ ] **Step 3: 检查是否存在 show_main_window() 函数**

搜索现有代码中是否定义了 `show_main_window()` 函数：

```bash
grep -n "fn show_main_window" src-tauri/src/main.rs
```

如果不存在，在 `setup_tray()` 前添加：

```rust
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
```

- [ ] **Step 4: 编译检查**

```bash
cargo check
```

预期：编译成功。如果有错误，检查：
- `TrayIconEvent`, `MouseButton` 等类型是否导入
- 闭包的所有权是否正确（`move` 关键字的位置）

- [ ] **Step 5: 手动检查菜单项 ID 一致性**

验证 `on_menu_event` 中处理的 ID 与 `rebuild_tray_menu()` 中生成的 ID 一致：
- 导航项：`nav-tasks`, `nav-logs`, `nav-settings` ✓
- 账号前缀：`account-{id}` ✓
- 分隔符和禁用项：无需在 event 中处理 ✓

- [ ] **Step 6: 提交此步骤**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: integrate menu event handling and dynamic menu rebuilding in setup_tray"
```

---

### Task 8: 修改 setup_tray() 调用 - 在菜单弹出时重建菜单

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 在 on_menu_event 回调开始时添加菜单重建**

当前 `on_menu_event` 在菜单事件到来时处理。要在**菜单弹出时**（即右键前）重建菜单，需要 hook 右键事件，但 Tauri v2 的 TrayIcon API 可能不直接支持。

**替代方案：** 在每次菜单点击时重建（实际上已经在账号切换时做了，但导航菜单项也应该重建一次以确保新鲜）。

修改 `on_menu_event` 中的导航项处理，在点击前重建菜单：

```rust
let app = app.clone();
tauri::async_runtime::spawn(async move {
    // 在处理导航前，先重建菜单以获取最新账号列表
    let _ = rebuild_tray_menu(&app).await;
    
    if has_active_token() {
        show_main_window(&app);
        let _ = app.emit_all("showView", "tasks");
    } else {
        show_tray_notification(&app, "请先配置账号".to_string(), 2);
    }
});
```

更新后的导航菜单项处理代码（替换 Task 7 中的 `"nav-tasks"` 等）：

```rust
"nav-tasks" => {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = rebuild_tray_menu(&app).await;
        if has_active_token() {
            show_main_window(&app);
            let _ = app.emit_all("showView", "tasks");
        } else {
            show_tray_notification(&app, "请先配置账号".to_string(), 2);
        }
    });
}
"nav-logs" => {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = rebuild_tray_menu(&app).await;
        if has_active_token() {
            show_main_window(&app);
            let _ = app.emit_all("showView", "logs");
        } else {
            show_tray_notification(&app, "请先配置账号".to_string(), 2);
        }
    });
}
"nav-settings" => {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = rebuild_tray_menu(&app).await;
        show_main_window(&app);
        let _ = app.emit_all("showView", "settings");
    });
}
```

- [ ] **Step 2: 编译检查**

```bash
cargo check
```

预期：编译成功。

- [ ] **Step 3: 运行应用并手动测试**

```bash
npm run dev
```

等待应用启动。右键托盘图标，查看菜单是否显示正确（需求/故障、访问日志、设置、切换账号、退出）。

- [ ] **Step 4: 测试菜单点击**

尝试点击"设置"菜单项，主窗口应该打开并跳转到设置页。

- [ ] **Step 5: 提交此步骤**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: rebuild tray menu before handling navigation menu actions"
```

---

## Phase 4: 集成测试与验证

### Task 9: 端到端测试 - 完整流程验证

**Files:**
- Test: 手动/集成测试（无特定文件）

- [ ] **Step 1: 启动完整应用**

```bash
npm run dev
```

等待 Tauri 应用启动，确认主窗口和托盘都可见。

- [ ] **Step 2: 测试菜单基础显示**

右键托盘图标，验证菜单显示以下项：
- ✅ 需求/故障
- ✅ 访问日志
- ✅ 设置
- ✅ 切换账号（带子菜单，如果有多个账号）
- ✅ 退出

**预期结果：** 菜单正常显示。

- [ ] **Step 3: 测试导航菜单项 - 有效账号**

前提：确保已配置至少一个有效账号（在设置中）。

右键菜单 → 点击"需求/故障"：
- ✅ 主窗口打开（如果隐藏）
- ✅ 自动跳转到 tasks 页（显示需求/故障任务列表）

重复测试"访问日志"和"设置"菜单项。

**预期结果：** 菜单点击后，窗口打开并正确导航到对应页面。

- [ ] **Step 4: 测试导航菜单项 - 无效账号**

前提：删除或禁用所有账号（临时移除 settings.json 中的 tokens）。

右键菜单 → 点击"需求/故障"：
- ✅ 不打开主窗口
- ✅ 显示通知："请先配置账号"

重复测试"访问日志"。点击"设置"应该仍然打开窗口（无条件）。

**预期结果：** 需求/故障、访问日志被禁用，但设置仍可打开。

- [ ] **Step 5: 测试账号切换**

前提：设置中配置至少 2 个账号。

右键菜单 → 切换账号 → 点击另一个账号：
- ✅ 主窗口**不打开**（后台静默切换）
- ✅ 显示通知："已切换到账号 {label}"，1-2 秒后消失
- ✅ 再次右键菜单，新账号前应显示 ✓ 标记

**预期结果：** 账号成功切换，菜单更新。

- [ ] **Step 6: 测试菜单权限检查（账号切换后）**

在上一步切换账号后，点击"需求/故障"应该仍然工作（指向新账号）。

**预期结果：** 导航菜单项在切换账号后仍然有效。

- [ ] **Step 7: 测试错误场景**

临时停止后端服务（Ctrl+C 停止 `npm run dev` 中的 Node.js 部分），再次右键菜单：
- ✅ 菜单仍然显示
- ✅ "切换账号"项禁用或显示"加载中..."
- ✅ 点击导航菜单项时可能超时，但应有相应提示

**预期结果：** 应用在网络故障时优雅降级，不崩溃。

- [ ] **Step 8: 验证 IPC 事件在前端正确接收**

打开浏览器开发者工具（F12）→ Console，点击"需求/故障"菜单项，应该看到：
- 前端收到 IPC 事件：`tauri://showView`
- 页面转换到 tasks 视图

可选：在 `public/app.js` 的 IPC 监听中添加 `console.log()` 以验证事件接收。

**预期结果：** IPC 事件正确传递和处理。

- [ ] **Step 9: 性能测试**

连续右键菜单 5 次，观察菜单弹出延迟。由于菜单重建涉及 HTTP 调用（2 秒超时），预计延迟不应超过 2.5 秒。

**预期结果：** 菜单弹出响应及时。

- [ ] **Step 10: 提交测试日志（可选）**

如果进行了多项测试，可创建一个测试报告文件（例如 `TESTING.md`），记录测试结果。不提交此文件到 git（仅供参考）。

- [ ] **Step 11: 最终提交**

```bash
git status  # 检查是否有未提交的改动
```

如果所有改动都已提交，输出应为 `nothing to commit`。

---

## 总结与后续

所有任务完成后，系统托盘菜单增强功能已经完全实现：

✅ **后端 API**：新增 `GET /api/tokens/list` 和 `POST /api/tokens/switch` 端点
✅ **Rust 端**：动态菜单构建、账号管理、通知提示
✅ **前端**：IPC 事件监听和页面导航

### 验收标准

- [ ] 右键托盘显示新菜单（5 个顶级项 + 子菜单）
- [ ] 当前活跃账号显示 ✓ 标记
- [ ] 导航菜单项（需求/故障、日志、设置）点击后打开窗口并跳转
- [ ] 无有效账号时，需求/故障和访问日志提示"请先配置账号"
- [ ] 设置无条件打开
- [ ] 点击账号可后台静默切换，显示 1-2 秒通知
- [ ] 菜单在 HTTP 超时时优雅处理（不卡顿）
- [ ] IPC 事件正确传递到前端，前端页面导航无误

### 后续可选扩展

- 添加账号健康状态图标（⚠️, ❌）在菜单中显示
- 支持键盘快捷键快速切换账号（Alt+1, Alt+2...）
- 账号列表搜索功能（若账号数量很多）
