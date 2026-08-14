# 系统托盘菜单增强设计文档

**日期：** 2026-07-21  
**功能：** 系统托盘新增菜单项，支持快速导航和账号切换  
**技术栈：** Tauri v2 (Rust) + Node.js HTTP API + 原生 HTML/JS

---

## 1. 功能概述

当前系统托盘仅包含"退出"菜单项。本设计通过在托盘菜单添加 4 个新功能项，支持用户无需打开主窗口即可快速导航和切换账号：

| 菜单项 | 功能 | 行为 |
|--------|------|------|
| **需求/故障** | 打开主窗口并跳转到需求/故障页 | 需要有效账号；无有效账号则提示 |
| **访问日志** | 打开主窗口并跳转到访问日志页 | 需要有效账号；无有效账号则提示 |
| **设置** | 打开主窗口并跳转到设置页 | 无条件打开 |
| **切换账号** | 二级菜单，列出所有已配置的账号 | 点击后后台静默切换，不打开窗口 |
| **退出** | 退出应用 | 原功能 |

---

## 2. 菜单视觉设计

### 2.1 菜单结构

```
┌─────────────────────────────────┐
│  需求/故障                      │
│  访问日志                        │
│  设置                            │
├─────────────────────────────────┤  ← 分隔线
│  切换账号                   ➤   │  → 子菜单箭头
│    ✓ 账号A (当前活跃账号)       │
│      账号B                      │
│      账号C                      │
├─────────────────────────────────┤
│  退出                            │
└─────────────────────────────────┘
```

### 2.2 账号显示规则

- **当前活跃账号**：使用 ✓ 符号前缀标记，例如 `✓ 账号A`
- **非活跃账号**：无标记或用空格对齐，例如 `  账号B`
- 账号标签使用 `settings.json` 中存储的用户定义名称

---

## 3. 交互流程

### 3.1 右键托盘图标 → 菜单弹出

**Rust 端处理：**

1. 用户右键托盘图标
2. `on_menu_event` 触发前，调用 `rebuild_tray_menu()` 函数
3. `rebuild_tray_menu()` 执行：
   - HTTP GET `/api/tokens/list` → 拉取所有账号列表 + 当前活跃账号 ID
   - 遍历账号，为每个账号生成 `MenuItem`，活跃账号前加 ✓ 标记
   - 使用 `MenuItem::submenu()` 创建二级菜单
   - 重建并更新 TrayIcon 菜单
4. 菜单显示给用户

**网络超时处理：** 如果 GET `/api/tokens/list` 超时（> 2 秒），菜单仍然显示，但"切换账号"项禁用，提示"账号列表加载中..."

---

### 3.2 点击导航菜单项（需求/故障、访问日志、设置）

**Rust 端检查逻辑：**

```
用户点击菜单项
  ↓
检查当前活跃账号是否有效
  ├─ 有效 ✅
  │  ├─ 调用 show_main_window()
  │  ├─ 通过 IPC emit_to() 发送 showView 事件给前端
  │  └─ 前端接收后调用 showView('tasks'|'logs'|'settings')
  │
  └─ 无效 ❌（仅对需求/故障、访问日志）
     └─ 显示桌面通知："请先配置账号"（1-2 秒后消失）
```

**前端 IPC 监听：**

在 `public/app.js` 中扩展监听，接收 `showView` IPC 事件：

```javascript
window.addEventListener('tauri://showView', (event) => {
    const view = event.detail.payload;
    showView(view); // 复用现有 showView() 函数
});
```

---

### 3.3 点击二级菜单中的账号

**Rust 端处理：**

```
用户点击账号项（如 "账号B"）
  ↓
Rust 调用 HTTP POST /api/tokens/switch { id: 'token-xyz' }
  ├─ 成功 ✅
  │  ├─ 在 API 响应中获取新账号标签
  │  ├─ 显示 1-2 秒的托盘气泡提示："已切换到账号 B"
  │  └─ 下次右键菜单时，菜单已更新为新活跃账号
  │
  └─ 失败 ❌
     └─ 显示错误提示："切换失败: {error message}"
```

**注意：** 账号切换不自动打开主窗口，用户在托盘看到提示后可自行决定是否打开。

---

## 4. HTTP API 端新增接口

### 4.1 GET /api/tokens/list

**请求：** 无参数

**响应示例：**

```json
{
  "tokens": [
    {
      "id": "token-001",
      "label": "账号A",
      "isActive": true
    },
    {
      "id": "token-002",
      "label": "账号B",
      "isActive": false
    },
    {
      "id": "token-003",
      "label": "账号C",
      "isActive": false
    }
  ],
  "activeId": "token-001"
}
```

**说明：**
- `id`：Token 的唯一标识符
- `label`：用户在设置中定义的账号标签
- `isActive`：是否为当前活跃账号（冗余字段，便于前端使用）
- `activeId`：当前活跃账号的 ID（单一值）

---

### 4.2 POST /api/tokens/switch

**请求体：**

```json
{
  "id": "token-xyz"
}
```

**响应成功（200）：**

```json
{
  "success": true,
  "label": "账号B",
  "message": "已切换到账号 B"
}
```

**响应失败（400/404）：**

```json
{
  "error": "Token not found"
}
```

**说明：**
- 调用现有 `token-rotation.js` 的 `switchActiveToken(id)` 函数
- 后续 `/api/tokens/status` 轮询会反映新的活跃账号
- 不修改前端应用状态，仅在后台切换

---

## 5. Rust 端实现关键细节

### 5.1 关键函数：rebuild_tray_menu()

**文件：** `src-tauri/src/main.rs`

**伪代码：**

```rust
async fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    // 1. 调用 HTTP API 拉取账号
    let tokens_response = tokio::time::timeout(
        Duration::from_secs(2),
        fetch_http_get("http://127.0.0.1:3000/api/tokens/list")
    )
    .await;

    let (tokens, active_id) = match tokens_response {
        Ok(Ok(response)) => {
            let body: TokenListResponse = response.json().await?;
            (body.tokens, body.active_id)
        }
        _ => {
            // 超时或网络错误：使用缓存或空列表
            (vec![], String::new())
        }
    };

    // 2. 构建菜单项
    let mut items = vec![];

    // 功能导航组
    items.push(MenuItem::with_id(app, "nav-tasks", "需求/故障", true, None)?);
    items.push(MenuItem::with_id(app, "nav-logs", "访问日志", true, None)?);
    items.push(MenuItem::with_id(app, "nav-settings", "设置", true, None)?);

    // 分隔线
    items.push(MenuItem::Separator);

    // 账号管理组（子菜单）
    let mut account_items = vec![];
    for token in tokens.iter() {
        let label = if token.id == active_id {
            format!("✓ {}", token.label)
        } else {
            format!("  {}", token.label) // 两个空格对齐
        };
        account_items.push(
            MenuItem::with_id(app, format!("account-{}", token.id), &label, true, None)?
        );
    }

    if !account_items.is_empty() {
        let account_menu = Menu::with_items(app, &account_items)?;
        items.push(MenuItem::new(app, "切换账号", account_menu)?);
    } else {
        // 无账号时，显示禁用的菜单项
        items.push(MenuItem::with_id(app, "no-account", "切换账号（未配置）", false, None)?);
    }

    // 退出
    items.push(MenuItem::with_id(app, "quit", "退出", true, None)?);

    // 3. 更新 TrayIcon
    let menu = Menu::with_items(app, &items)?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(menu)?;
    }

    Ok(())
}
```

### 5.2 修改 on_menu_event 处理

**文件：** `src-tauri/src/main.rs`

关键处理逻辑：

```rust
.on_menu_event(|app, event| {
    match event.id.as_ref() {
        "nav-tasks" => {
            if has_active_token() {
                show_main_window(app);
                let _ = app.emit("showView", "tasks");
            } else {
                show_notification(app, "请先配置账号");
            }
        }
        "nav-logs" => {
            if has_active_token() {
                show_main_window(app);
                let _ = app.emit("showView", "logs");
            } else {
                show_notification(app, "请先配置账号");
            }
        }
        "nav-settings" => {
            show_main_window(app);
            let _ = app.emit("showView", "settings");
        }
        id if id.starts_with("account-") => {
            let token_id = id.strip_prefix("account-").unwrap().to_string();
            spawn_token_switch(app, token_id);
        }
        "quit" => std::process::exit(0),
        _ => {}
    }
})

fn spawn_token_switch(app: &AppHandle, token_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match switch_account_api(&token_id).await {
            Ok(label) => {
                show_tray_notification(
                    &app,
                    format!("已切换到账号 {}", label),
                    2 // 2 秒后消失
                );
                // 重建菜单，使新账号显示 ✓ 标记
                let _ = rebuild_tray_menu(&app).await;
            }
            Err(e) => {
                show_tray_notification(
                    &app,
                    format!("切换失败: {}", e),
                    3
                );
            }
        }
    });
}
```

### 5.3 辅助函数

```rust
fn has_active_token() -> bool {
    // 从本地缓存或 HTTP 快速检查当前是否有活跃账号
    // 可调用 /api/tokens/status 或本地读 settings.json
}

async fn switch_account_api(token_id: &str) -> Result<String, String> {
    // HTTP POST /api/tokens/switch { id: token_id }
    // 返回新账号的 label
}

fn show_tray_notification(app: &AppHandle, message: String, duration_secs: u64) {
    // Windows 通知栏 / 托盘气泡提示
    // duration_secs 后自动消失
}
```

---

## 6. 前端实现细节

### 6.1 IPC 事件监听扩展

**文件：** `public/app.js`

在现有 IPC 监听代码后添加：

```javascript
// 接收来自 Rust 的 showView 事件，用于导航
window.addEventListener('tauri://showView', (event) => {
    const view = event.detail.payload;
    if (['chat', 'settings', 'tasks', 'logs'].includes(view)) {
        showView(view);
    }
});
```

### 6.2 复用现有导航逻辑

- 不需要修改现有 `showView()` 函数
- 不需要修改现有按钮点击处理
- 仅增加 IPC 事件入口点

---

## 7. HTTP API 后端实现细节

### 7.1 新增端点

**文件：** `src/entrypoints/web/server.js`

```javascript
// GET /api/tokens/list
app.get('/api/tokens/list', (req, res) => {
    const allTokens = getTokens(); // 从 settings.json
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
});

// POST /api/tokens/switch
app.post('/api/tokens/switch', (req, res) => {
    const { id } = req.body;
    
    if (!id) {
        return res.status(400).json({ error: 'Token ID is required' });
    }

    try {
        // 调用现有的 token-rotation.js 函数
        const token = getTokenById(id);
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }

        switchActiveToken(id);

        res.json({
            success: true,
            label: token.label,
            message: `已切换到账号 ${token.label}`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
```

### 7.2 复用现有函数

- `getTokens()` → 获取所有 token（已存在于 token-rotation.js）
- `getActiveTokenId()` → 获取当前活跃 token ID（已存在）
- `switchActiveToken(id)` → 切换活跃 token（已存在）

---

## 8. 错误处理与边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户无账号配置 | "切换账号"菜单项禁用；导航菜单显示提示"请先配置账号" |
| HTTP API 超时 | 菜单仍显示，但"切换账号"项禁用，提示"加载中..." |
| 账号切换失败 | 显示错误通知"切换失败: {error}"，菜单不更新 |
| 左键单击托盘（现有功能） | 保持不变，显示/隐藏主窗口 |
| 窗口已打开，点击导航菜单 | 聚焦窗口，跳转到指定页面 |

---

## 9. 测试覆盖

| 测试项 | 预期结果 |
|--------|---------|
| 右键托盘，菜单正常显示 | 菜单显示 5 个顶级项 + 账号二级菜单 |
| 活跃账号显示 ✓ 标记 | 当前活跃账号前显示 ✓，其他无标记 |
| 点击"需求/故障"，有有效账号 | 窗口打开，跳转到 tasks 页 |
| 点击"需求/故障"，无有效账号 | 显示提示，不打开窗口 |
| 点击"设置" | 窗口打开，跳转到 settings 页（无条件） |
| 点击某个账号切换 | 不打开窗口，显示 1-2 秒提示"已切换到..." |
| 切换后再右键菜单 | 菜单已更新，新账号显示 ✓ 标记 |
| 账号切换失败 | 显示错误提示，菜单不变 |

---

## 10. 性能考虑

- **菜单重建频率**：仅在右键弹菜单时触发，不涉及轮询
- **HTTP 超时设置**：2 秒，避免卡顿
- **缓存策略**：如果 API 超时，使用上次成功的菜单快照

---

## 11. 后续扩展

- 可在菜单中添加"账号健康状态"图标（如 ⚠️ warning、❌ exhausted）
- 可添加"新增账号"菜单项直接打开设置页
- 可支持键盘快捷键快速切换账号（e.g., Alt+1、Alt+2）

---

## 总结

本设计通过在 Rust 端动态构建菜单、后端提供两个新的 HTTP 接口、前端扩展 IPC 监听，实现了系统托盘的完整菜单增强功能。核心特性是**动态账号列表**、**智能导航权限检查**和**后台静默切换**。
