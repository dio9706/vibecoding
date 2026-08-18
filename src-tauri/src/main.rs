// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::Duration;
use tokio::time::timeout;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
#[cfg(not(debug_assertions))]
use tauri::path::BaseDirectory;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

// ── 默认端口 ─────────────────────────────────────────────────────────────────

/// 桌面版后端默认端口；生产版若被占会自动往后探测（9701–9800）。
/// PM2 claude-web / 独立 node server.js 仍使用 3000，两者天然错开。
const DEFAULT_BACKEND_PORT: u16 = 9701;
/// 后端就绪探测预算：80 × 500ms = 40s。重启开机时系统繁忙 + sidecar 冷启动
///（Node 冷启 + ESM 顶层 await 加载插件 + 飞书 WS 连接）常超 10s，故给足 40s，
/// 避免误报「后端启动失败」（前端 startup-error 另有自愈轮询兜底）。
const BACKEND_READY_MAX_ATTEMPTS: u32 = 80;

// ── 应用状态 ────────────────────────────────────────────────────────────────

struct AppState {
    /// 后端实际监听端口（Rust 唯一权威）：探测到后写入，供 wait_backend_ready、
    /// 托盘 HTTP 调用、frontend invoke('backend_port') 三处读取。
    port: Arc<Mutex<u16>>,
    /// 后端 sidecar 子进程句柄（生产构建）；用于退出时 kill。开发构建下恒为 None。
    #[cfg(not(debug_assertions))]
    backend: Arc<Mutex<Option<CommandChild>>>,
}

// ── Token 相关数据结构 ────────────────────────────────────────────────────────

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

// ── IPC 命令 ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

/// 前端读取后端实际端口（Tauri invoke）：用于 API_BASE 动态拼接，
/// 避免硬编码端口在占用时失效。
#[tauri::command]
fn backend_port(state: tauri::State<AppState>) -> u16 {
    *state.port.lock().unwrap()
}

/// 窗口控制命令：由前端自定义标题栏调用
/// Tauri 自动将当前调用方窗口注入为 webview 参数
#[tauri::command]
fn win_minimize(webview: tauri::WebviewWindow) {
    let _ = webview.minimize();
}

#[tauri::command]
fn win_toggle_maximize(webview: tauri::WebviewWindow) {
    if webview.is_maximized().unwrap_or(false) {
        let _ = webview.unmaximize();
    } else {
        let _ = webview.maximize();
    }
}

#[tauri::command]
fn win_hide(webview: tauri::WebviewWindow) {
    let _ = webview.hide();
}

#[tauri::command]
fn win_is_maximized(webview: tauri::WebviewWindow) -> bool {
    webview.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn win_start_dragging(webview: tauri::WebviewWindow) {
    let _ = webview.start_dragging();
}

/// 窗口标题 = 当前窗口的项目名（任务栏/Alt-Tab 用它区分多开的项目窗口）。
/// 前端在工作目录变化时调用（无边框窗口没有可见标题栏，标题只在任务栏体现）。
/// 空标题被忽略，避免任务栏出现无名窗口。
#[tauri::command]
fn win_set_title(webview: tauri::WebviewWindow, title: String) {
    let t = title.trim();
    if t.is_empty() {
        return;
    }
    let _ = webview.set_title(t);
}

/// 诊断日志（写 %TEMP%/claude-agent-win.log）：窗口创建链路排障用，release 无控制台。
fn wlog(msg: &str) {
    use std::io::Write;
    let p = std::env::temp_dir().join("claude-agent-win.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", msg);
    }
}

/// 一窗一项目：为指定工作目录开新窗口。
/// **必须是 async command**：同步 command 在主线程执行，而 WebviewWindowBuilder::build() 运行时
/// 建窗要 dispatch 回主线程并等待 → 主线程自等自死锁（当前窗口所有 invoke 随之全失效）。
/// async command 在 tauri async runtime 线程执行，build 的主线程调度不死锁。
/// 上下文经 initialization_script 注入（见 create_app_window_ctx），URL 恒为干净 index.html。
#[tauri::command]
async fn win_new(app: AppHandle, cwd: Option<String>, conv: Option<String>) -> Result<(), String> {
    wlog(&format!("[win_new] called cwd={:?} conv={:?}", cwd, conv));
    match create_app_window_ctx(&app, cwd.as_deref(), conv.as_deref()) {
        Ok(w) => {
            wlog(&format!("[win_new] created label={}", w.label()));
            Ok(())
        }
        Err(e) => {
            wlog(&format!("[win_new] ERROR {}", e));
            Err(e.to_string())
        }
    }
}

// ── 端口探测 ──────────────────────────────────────────────────────────────────

/// 剥掉 Windows 扩展长度路径的 verbatim 前缀（`\\?\` 与 `\\?\UNC\`）。
/// Node.js 在 Windows 下无法正确解析带 `\\?\` 前缀的入口路径（会把盘符 `C:` 当作独立
/// 组件去 lstat，抛 EISDIR 后进程立即退出），因此传给 node 前必须先转成标准路径。
/// 非 verbatim 路径原样返回。
fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest) // \\?\UNC\server\share → \\server\share
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string() // \\?\C:\path → C:\path
    } else {
        p.to_string()
    }
}

/// 从 `start` 开始逐个尝试绑定，返回第一个空闲端口。
/// listener 在 is_ok() 后立即 drop（端口随即释放）；
/// sidecar 在毫秒级后绑定同一端口，单机桌面场景 TOCTOU 竞态概率极低。
fn find_free_port(start: u16, max_tries: u16) -> Option<u16> {
    for port in start..start.saturating_add(max_tries) {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

// ── 后端进程管理 ──────────────────────────────────────────────────────────────

/// 启动后端：开发=系统 node（实时源码，固定 9701）；生产=随包 node sidecar（自动探测空闲端口）。
fn start_backend(app: &AppHandle) {
    #[cfg(debug_assertions)]
    start_backend_dev(app);
    #[cfg(not(debug_assertions))]
    start_backend_prod(app);
}

#[cfg(debug_assertions)]
fn start_backend_dev(app: &AppHandle) {
    use std::io::Write;

    // dev 固定 DEFAULT_BACKEND_PORT：devUrl 是 tauri.conf.json 里的静态字符串，无法运行时更改，
    // 且开发者对本机端口占用负责，不做自动探测。
    let port = DEFAULT_BACKEND_PORT;
    *app.state::<AppState>().port.lock().unwrap() = port;

    // dev 模式日志：写到临时目录，便于排查后端启动问题
    let log_path = std::env::temp_dir().join("claude-agent-dev-backend.log");
    println!("[Tauri][dev] backend log -> {}", log_path.display());
    let log_out = std::fs::OpenOptions::new()
        .create(true).append(true).open(&log_path).ok();
    let log_err = std::fs::OpenOptions::new()
        .create(true).append(true).open(&log_path).ok();

    // 记录一条启动标记
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(f, "\n=== [Tauri][dev] node server.js on port {} (cwd: {:?}) ===",
            port, std::env::current_dir().unwrap_or_default());
    }

    let mut cmd = StdCommand::new("node");
    cmd.arg("server.js").env("PORT", port.to_string());
    if let Some(f) = log_out { cmd.stdout(f); }
    if let Some(f) = log_err { cmd.stderr(f); }
    // CREATE_NO_WINDOW：dev 下 GUI 进程 spawn node 会闪现控制台窗口（prod sidecar 由 plugin-shell 自带此旗标）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    match cmd.spawn() {
        Ok(child) => {
            println!("[Tauri][dev] Node.js backend started on port {} (pid: {})", port, child.id());
            println!("[Tauri][dev] Node log: {}", log_path.display());
            std::mem::forget(child);
        }
        Err(e) => {
            eprintln!("[Tauri][dev] ⚠️  Could not start node (maybe already running?): {}", e);
            eprintln!("[Tauri][dev]    Ensure `node` is in PATH and server.js exists in cwd: {:?}",
                std::env::current_dir().unwrap_or_default());
        }
    }
}

#[cfg(not(debug_assertions))]
fn start_backend_prod(app: &AppHandle) {
    use std::io::Write;

    // 追加一行诊断信息到 backend.log（release 无控制台，启动期失败也需可见）
    fn log_line(log_path: &std::path::Path, msg: &str) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = writeln!(f, "{}", msg);
        }
    }

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
    let log_path = data_dir.join("logs").join("backend.log");

    // 2. 探测空闲端口（9701–9800）
    let port = match find_free_port(DEFAULT_BACKEND_PORT, 100) {
        Some(p) => p,
        None => {
            let msg = format!(
                "[Tauri] 无法找到可用端口（{}–{}），请关闭占用上述端口的进程后重试",
                DEFAULT_BACKEND_PORT,
                DEFAULT_BACKEND_PORT + 99
            );
            log_line(&log_path, &msg);
            // 向 webview 发送错误（非阻塞：webview 此时可能未就绪，失败忽略）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit("startup-error", msg.clone());
            }
            return;
        }
    };
    // 写入 AppState（唯一权威），供 wait_backend_ready 与托盘读取
    *app.state::<AppState>().port.lock().unwrap() = port;
    log_line(&log_path, &format!("[Tauri] Using backend port {}", port));

    // 3. 随包后端入口（$RESOURCE/sidecar/server.js）
    let server_js = match app.path().resolve("sidecar/server.js", BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            log_line(&log_path, &format!("[Tauri] Cannot resolve sidecar/server.js: {}", e));
            return;
        }
    };

    // Windows 下 Tauri resolve 常返回 \\?\ verbatim 前缀路径（如 \\?\C:\...\server.js），
    // Node.js 的入口解析（resolveMainPath→realpathSync）无法处理该前缀，会把 "C:" 当独立组件
    // lstat → 抛 EISDIR、进程秒退，导致后端起不来、前端一律 Failed to fetch。
    // 这里剥掉 verbatim 前缀，传标准路径给 node。
    let server_js_arg = strip_verbatim_prefix(&server_js.to_string_lossy());
    log_line(&log_path, &format!("[Tauri] sidecar entry = {}", server_js_arg));

    // 4. 组装并启动 node sidecar
    let sidecar = match app.shell().sidecar("node") {
        Ok(cmd) => cmd,
        Err(e) => {
            log_line(&log_path, &format!("[Tauri] Cannot create node sidecar: {}", e));
            return;
        }
    };

    let (mut rx, child) = match sidecar
        .args([server_js_arg])
        .current_dir(data_dir.clone())
        .env("APP_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("PORT", port.to_string())
        .spawn()
    {
        Ok(pair) => pair,
        Err(e) => {
            log_line(&log_path, &format!("[Tauri] Failed to spawn node sidecar: {}", e));
            return;
        }
    };

    println!("[Tauri] Backend sidecar started on port {} (pid: {})", port, child.pid());
    log_line(&log_path, &format!("[Tauri] Backend sidecar started on port {} (pid: {})", port, child.pid()));
    *app.state::<AppState>().backend.lock().unwrap() = Some(child);

    // 5. 抽干 stdout/stderr → 复用同一文件句柄追加到 logs/backend.log
    tauri::async_runtime::spawn(async move {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        while let Some(event) = rx.recv().await {
            let bytes = match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => b,
                _ => continue,
            };
            if let Some(f) = file.as_mut() {
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

/// 阻塞轮询直到后端 /api/ping 响应（在 spawn_blocking 中调用）
fn wait_backend_ready(port: u16) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let url = format!("http://127.0.0.1:{}/api/ping", port);
    for attempt in 0..BACKEND_READY_MAX_ATTEMPTS {
        thread::sleep(Duration::from_millis(500));
        if client.get(&url).send().is_ok() {
            println!("[Tauri] Backend ready on port {} (attempt {})", port, attempt + 1);
            return true;
        }
        if attempt % 4 == 0 {
            println!("[Tauri] Waiting for backend on port {}... attempt {}", port, attempt + 1);
        }
    }
    eprintln!("[Tauri] Backend not ready after 40s (port {})", port);
    false
}

// ── 窗口管理 ──────────────────────────────────────────────────────────────────

/// 已创建窗口计数：首个窗口 label 为 "main"，后续为 "win-2"/"win-3"…（保证唯一）。
static WINDOW_SEQ: AtomicU32 = AtomicU32::new(0);

/// 创建一个应用窗口（单实例架构下多开共用同一后端/托盘，仅多一个 webview 窗口）。
///
/// 刻意**不调用** disable_drag_drop_handler()：保留 Tauri 的 Webview IDropTarget 拦截，
/// 让 tauri://drag-* 事件正常 emit，前端才能拿到拖入项的**真实本地绝对路径**（并支持文件夹）。
/// 曾经调用过它，是为了让 WebView2 保持 SetAllowExternalDrop(true)、走 HTML5 drop——
/// 但那条路只能读到文件内容、拿不到原始路径，只好把文件复制一份到 .uploads 再把副本路径
/// 交给 Claude，且拖文件夹完全无反应（dataTransfer.files 对目录给不出条目）。
///
/// 代价：webview 内 HTML5 drop 的 dataTransfer.files 恒空。所有文件拖拽区必须走
/// public/js/drag-bus.js 的落点分派，不能再绑 DOM drop 事件。
fn create_app_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    create_app_window_ctx(app, None, None)
}

/// cwd/conv：项目上下文（一窗一项目），经 initialization_script 注入全局变量；均 None=默认窗口。
/// URL 恒为干净的 index.html——避免打包版 custom protocol 把 query 当文件名解析失败。
fn create_app_window_ctx(app: &AppHandle, cwd: Option<&str>, conv: Option<&str>) -> tauri::Result<tauri::WebviewWindow> {
    let n = WINDOW_SEQ.fetch_add(1, Ordering::SeqCst);
    let label = if n == 0 { "main".to_string() } else { format!("win-{}", n + 1) };
    wlog(&format!("[create] label={} inject={}", label, cwd.is_some() || conv.is_some()));
    // 初始标题就用项目名（cwd 末段），省掉任务栏先闪一下 "Claude Agent" 再被前端改掉；
    // 前端切目录时再经 win_set_title 更新（见 chat.js refreshDirLabel）。
    let title = cwd
        .and_then(|p| {
            std::path::Path::new(p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Claude Agent".to_string());
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(title.as_str())
    .inner_size(1200.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .resizable(true)
    .fullscreen(false)
    .focused(true)
    .decorations(false)
    .visible(false);  // 防启动白闪：先隐藏，页面加载完成（on_page_load Finished）再显示
    // 项目窗口：页面脚本执行前注入上下文（serde_json 保证字符串转义安全，含反斜杠路径）
    if cwd.is_some() || conv.is_some() {
        let script = format!(
            "window.__PROJECT_CWD__={};window.__PROJECT_CONV__={};",
            serde_json::to_string(&cwd).unwrap_or_else(|_| "null".into()),
            serde_json::to_string(&conv).unwrap_or_else(|_| "null".into()),
        );
        builder = builder.initialization_script(script);
    }
    builder
    .build()
    .map(|w| {
        // 兜底：加载事件异常（如前端资源缺失）时 3s 强制显示，避免窗口永久隐藏无从排查
        let w2 = w.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(3));
            if !w2.is_visible().unwrap_or(true) {
                let _ = w2.show();
                let _ = w2.set_focus();
            }
        });
        w
    })
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/// 托盘/快捷键唤起：显示并聚焦任意一个已有窗口（优先 "main"）；
/// 若所有窗口都已关闭（仅剩托盘），则新建一个。返回被显示/新建的窗口（供后续 emit 定向）。
fn show_main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let w = app.get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    match w {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            Some(w)
        }
        None => match create_app_window(app) {
            Ok(w) => Some(w),
            Err(e) => {
                eprintln!("[Tauri] 无可用窗口且新建失败: {}", e);
                None
            }
        },
    }
}

// ── 系统托盘 ──────────────────────────────────────────────────────────────────

/// 异步函数：重建托盘菜单
/// 1. 从 AppState 读取实际端口
/// 2. 调用 HTTP API 拉取账号列表（2秒超时）
/// 3. 构建菜单项（导航、账号、分隔线等）
/// 4. 更新 TrayIcon 菜单
async fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::PredefinedMenuItem;

    let port = *app.state::<AppState>().port.lock().unwrap();
    let client = reqwest::Client::new();
    let api_url = format!("http://127.0.0.1:{}/api/tokens/list", port);

    // 1. 调用 HTTP API 拉取账号（带 2 秒超时）
    let tokens_response = timeout(
        Duration::from_secs(2),
        client.get(&api_url).send()
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
    let mut menu_items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![
        Box::new(MenuItem::with_id(app, "nav-tasks", "需求/故障", true, None::<&str>)?),
        Box::new(MenuItem::with_id(app, "nav-logs", "访问日志", true, None::<&str>)?),
        Box::new(MenuItem::with_id(app, "nav-settings", "设置", true, None::<&str>)?),
    ];

    // 分隔线
    menu_items.push(Box::new(PredefinedMenuItem::separator(app)?));

    // 账号管理组
    if !tokens.is_empty() {
        for token in tokens.iter() {
            let label = if token.id == active_id {
                format!("✓ {}", token.label)
            } else {
                format!("  {}", token.label)
            };
            menu_items.push(Box::new(
                MenuItem::with_id(
                    app,
                    format!("account-{}", token.id),
                    &label,
                    true,
                    None::<&str>,
                )?
            ));
        }
    } else {
        menu_items.push(Box::new(
            MenuItem::with_id(app, "no-account", "切换账号（未配置）", false, None::<&str>)?
        ));
    }

    // 分隔线
    menu_items.push(Box::new(PredefinedMenuItem::separator(app)?));

    // 退出
    menu_items.push(Box::new(
        MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?
    ));

    // 3. 更新菜单
    let menu_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = menu_items.iter().map(|item| item.as_ref()).collect();
    let menu = Menu::with_items(app, &menu_refs)?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}

/// 检查当前是否有有效的活跃账号
fn has_active_token(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/tokens/list", port);
    match reqwest::blocking::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(1))
        .send()
    {
        Ok(response) => {
            match response.json::<TokenListResponse>() {
                Ok(body) => !body.active_id.is_empty(),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

/// 异步调用 HTTP API 切换账号
async fn switch_account_api(port: u16, token_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/api/tokens/switch", port);

    let request_body = json!({
        "id": token_id
    });

    match client
        .post(&url)
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

/// 跨平台系统通知函数（通过通知插件）
fn show_tray_notification(_app: &AppHandle, message: String, _duration_secs: u64) {
    // Tauri 2.0 中通知由插件提供，简化为日志输出
    // 实际部署时可通过 tauri-plugin-notification 的 send 方法发送
    eprintln!("[Tray Notification] {}", message);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let app_handle = app.clone();

    // 初始化时，异步构建菜单
    tauri::async_runtime::spawn(async move {
        if let Err(e) = rebuild_tray_menu(&app_handle).await {
            eprintln!("[setup_tray] Failed to rebuild initial menu: {}", e);
        }
    });

    // id 必须为 "main"：rebuild_tray_menu() 通过 app.tray_by_id("main") 查找本托盘再 set_menu，
    // 若用 ::new()（自动数字 id）则查找失败 → 菜单永不挂载 → 右键无菜单。
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Claude Agent")
        .show_menu_on_left_click(false)
        .on_menu_event({
            let app_clone = app.clone();
            move |_app_tray, event| {
                let app = app_clone.clone();
                match event.id.as_ref() {
                    // ──── 导航菜单项（需求/故障） ────
                    "nav-tasks" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = rebuild_tray_menu(&app).await;
                            let port = *app.state::<AppState>().port.lock().unwrap();
                            if has_active_token(port) {
                                if let Some(w) = show_main_window(&app) {
                                    let _ = w.emit("show-view", "tasks");
                                }
                            } else {
                                show_tray_notification(&app, "请先配置账号".to_string(), 2);
                            }
                        });
                    }

                    // ──── 导航菜单项（访问日志） ────
                    "nav-logs" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = rebuild_tray_menu(&app).await;
                            let port = *app.state::<AppState>().port.lock().unwrap();
                            if has_active_token(port) {
                                if let Some(w) = show_main_window(&app) {
                                    let _ = w.emit("show-view", "logs");
                                }
                            } else {
                                show_tray_notification(&app, "请先配置账号".to_string(), 2);
                            }
                        });
                    }

                    // ──── 导航菜单项（设置） ────
                    "nav-settings" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = rebuild_tray_menu(&app).await;
                            if let Some(w) = show_main_window(&app) {
                                let _ = w.emit("show-view", "settings");
                            }
                        });
                    }

                    // ──── 账号切换菜单项 ────
                    id if id.starts_with("account-") => {
                        let token_id = id.strip_prefix("account-").unwrap().to_string();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let port = *app.state::<AppState>().port.lock().unwrap();
                            match switch_account_api(port, &token_id).await {
                                Ok(label) => {
                                    show_tray_notification(
                                        &app,
                                        format!("已切换到账号 {}", label),
                                        2,
                                    );
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

                    // ──── 无账号提示菜单项（禁用项，不处理） ────
                    "no-account" => {}

                    // ──── 退出菜单项 ────
                    "quit" => {
                        kill_backend(&app);
                        std::process::exit(0);
                    }

                    _ => {}
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 仅处理左键单击 → 显示主窗口。
            // 右键菜单由系统自动弹出（show_menu_on_left_click(false)），
            // 此处绝不替换菜单，否则右键一闪即消。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 有图标文件时设置，没有（开发环境占位）时跳过
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        // 单实例插件必须最先注册：第二个进程启动时把请求转发给已运行的实例，
        // 由下面的回调「新开一个窗口」而非另起一份后端/托盘，随后新进程自行退出。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 已有实例被再次拉起 → 新建一个窗口（共用同一后端 + 同一托盘）
            if let Err(e) = create_app_window(app) {
                eprintln!("[Tauri] single-instance 新建窗口失败: {}", e);
                // 兜底：至少把现有窗口带到前台
                show_main_window(app);
            }
        }))
        .manage(AppState {
            port: Arc::new(Mutex::new(0)), // 0 = 未确定，start_backend 内写入实际值
            #[cfg(not(debug_assertions))]
            backend: Arc::new(Mutex::new(None)),
        })
        // 防启动白闪的另一半：窗口以 visible(false) 创建，页面加载完成后再显示
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let w = webview.window();
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        // shell 仍保留（sidecar 启动依赖 shell:allow-execute），但「打开」能力改由 opener 承担
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .setup(|app| {
            // ① 主窗口：代码创建（而非 tauri.conf.json windows 数组），首个 label "main"。
            //    见 create_app_window 说明（drag_and_drop / 多窗口 label）。
            create_app_window(app.handle())
                .expect("[Tauri] Failed to create main window");

            // ② 系统托盘（失败不致命，打印警告继续）
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("[Tauri] Tray setup failed: {} (continuing without tray)", e);
            }

            // ③ 启动后端（dev=系统 node 固定 9701 / release=随包 sidecar 自动探测端口），非阻塞
            start_backend(app.handle());

            // ④ 等后端就绪后通知前端；端口从 AppState 读取（start_backend 已写入）
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let port = *handle.state::<AppState>().port.lock().unwrap();
                    let ready = wait_backend_ready(port);
                    if let Some(w) = handle.get_webview_window("main") {
                        if ready {
                            let _ = w.emit("backend-ready", ());
                        } else {
                            let _ = w.emit("startup-error", format!(
                                "Backend did not respond within 40s (port {})", port
                            ));
                        }
                    }
                });
            }

            // ⑤ 全局快捷键 Ctrl+Shift+P (Win/Linux) / Cmd+Shift+P (macOS)
            let shortcut_str = if cfg!(target_os = "macos") {
                "Super+Shift+P"
            } else {
                "Ctrl+Shift+P"
            };

            let handle = app.handle().clone();
            if let Err(e) = app
                .handle()
                .global_shortcut()
                .on_shortcut(shortcut_str, move |_app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_main_window(&handle);
                    }
                })
            {
                eprintln!("[Tauri] Failed to register global shortcut: {}", e);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 点 × 关闭窗口：
            //   - 多窗口时（还有其它可见窗口）→ 真正关闭当前窗口（destroy），像 VSCode/Cursor 关一个页签。
            //   - 最后一个可见窗口 → 隐藏到托盘、不退出（后端与托盘继续常驻）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let other_visible = app
                    .webview_windows()
                    .iter()
                    .filter(|(label, w)| {
                        label.as_str() != window.label() && w.is_visible().unwrap_or(false)
                    })
                    .count();
                if other_visible > 0 {
                    // 还有别的窗口开着 → 直接关闭本窗口（不 prevent_close）
                    // 不做处理，放行默认销毁
                } else {
                    // 最后一个 → 藏到托盘
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            backend_port,
            win_minimize,
            win_toggle_maximize,
            win_hide,
            win_is_maximized,
            win_start_dragging,
            win_set_title,
            win_new,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                kill_backend(app_handle);
            }
        });
}
