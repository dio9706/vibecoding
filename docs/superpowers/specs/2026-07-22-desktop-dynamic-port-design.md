# 桌面版后端端口改为 9701 + 启动时自动探测空闲端口

- 日期：2026-07-22
- 状态：设计已通过（用户选定「方案 A」），待写实现计划
- 范围：**仅 Tauri 桌面版**（dev + 打包 release）。PM2 的 `claude-web` / 独立 `node server.js` 不在本次范围，仍走 3000。

## 1. 背景与目标

桌面版（Tauri）内置后端当前**硬编码 3000 端口**：

- `src-tauri/src/main.rs`：`start_backend_prod` 注入 `.env("PORT", "3000")`；`wait_backend_ready` 轮询 `http://127.0.0.1:3000/api/ping`；托盘 `rebuild_tray_menu` / `has_active_token` / `switch_account_api` 调 `http://127.0.0.1:3000/api/tokens/*`。
- `src-tauri/tauri.conf.json`：`devUrl: http://127.0.0.1:3000`。
- `public/app.js`：Tauri 模式下 `API_BASE = 'http://127.0.0.1:3000'`（硬编码），随后包裹 `fetch`/`EventSource` 把相对路径改写到该基址。

问题：3000 端口过于常用，易与其它服务（含本机 PM2 `claude-web`）冲突；一旦被占，后端起不来且无回退。

**目标**：
1. 桌面版默认端口改为 **9701**。
2. 生产版启动时若 9701 被占，**自动往后探测**下一个空闲端口。
3. 端口变动后，**Rust 与前端 `API_BASE` 都能正确指向实际端口**。

### 成功标准（验收）
1. 干净环境启动桌面版（release）：后端落在 9701，`/api/ping` 正常，前端 UI 与托盘账号菜单正常。
2. 预先占用 9701（如临时起一个监听 9701 的服务）后启动：后端自动落到 9702（或下一个空闲端口），前端/托盘仍正常。
3. `tauri dev`：后端在 9701（固定），前端同源加载正常。
4. PM2 `claude-web` 不受影响，仍在 3000；桌面版与 web 台端口天然错开、可共存。

## 2. 选定方案：Rust 探测并作为端口唯一权威（方案 A）

对比过两条路线：

- **方案 A（选定）**：Rust 在拉起 node sidecar **之前**从 9701 起用 `TcpListener::bind` 逐个探测，拿到第一个空闲端口，经 `PORT` env 传给 node（node 只照单监听、不自行回退）。Rust 把该端口存入 `AppState`，供 `wait_backend_ready`、托盘 HTTP 调用使用，并新增 `backend_port` 命令供前端 `invoke` 读取。
  - 优点：端口只有一个权威源（Rust）；无需解析 sidecar stdout；前端/托盘启动即可拿到端口；改动集中在 Rust + 前端顶部 + 配置。
  - 缺点：探测→释放 socket→node 绑定之间存在毫秒级 TOCTOU 窗口（单机桌面几乎不可能撞上）；标准 `node server.js` 不获得探测能力（超出本次范围，无影响）。
- **方案 B（弃）**：node 自己 `listen` 并在 `EADDRINUSE` 时 +1 重试，成功后把最终端口打到 stdout，Rust 解析。无竞态且顺带让 `npm start` 具备探测能力，但引入「端口未知」的启动握手（托盘首次构建、`backend_port` 命令、前端都要等 stdout 那行到达），移动部件更多。本次范围（仅桌面版）下收益不抵复杂度。

## 3. 端口策略

- 默认端口 **9701**。
- **生产版（release）**：从 9701 起自动探测，占用则 +1，范围 **9701–9800（100 个）**；全部占满 → emit `startup-error`「无法找到可用端口（9701–9800）」，不崩主进程（沿用现有非致命策略）。
- **开发版（debug）**：固定 **9701**，**不探测**。理由：`devUrl` 是 `tauri.conf.json` 里的静态字符串，无法在运行时随探测结果改变；webview 从 `devUrl` 同源加载，dev 端口冲突属开发者自理。
- PM2 `claude-web` 与独立 `node server.js`：**不改**，仍默认 3000。

## 4. 组件级改动清单

### 4.1 Rust 侧 `src-tauri/src/main.rs`

- **`AppState` 增加端口字段**（dev 与 prod 都需要，供 `backend_port` 命令与 `wait_backend_ready` 读取）：
  - 新增 `port: Arc<Mutex<u16>>`（或 `Arc<AtomicU16>`），两种 cfg 下都存在。
  - `manage(AppState { .. })` 初始化 `port` 为 `0`（未定），`start_backend` 内写入实际值。
- **新增 `find_free_port(start: u16, max_tries: u16) -> Option<u16>`**：
  ```rust
  for port in start..start.saturating_add(max_tries) {
      if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
          return Some(port); // listener 在此 drop → 端口释放
      }
  }
  None
  ```
- **`start_backend_prod(app)`**：
  - `let port = find_free_port(9701, 100)`；`None` → `log_line` + `emit("startup-error", ...)` + return。
  - sidecar `.env("PORT", port.to_string())`（替换原 `"3000"`）。
  - 写入 `*app.state::<AppState>().port.lock().unwrap() = port;`。
- **`start_backend_dev()`**：`StdCommand::new("node").arg("server.js").env("PORT", "9701")`；并写入 `AppState.port = 9701`（需要 `app` 句柄——`start_backend` 已持有 `app`，把 port 写入下放到 `start_backend` 或给 dev 分支传 `app`）。
- **`wait_backend_ready(port: u16)`**：签名加 `port` 参数，URL 改 `format!("http://127.0.0.1:{}/api/ping", port)`。调用处（`setup` 内 `spawn_blocking`）先从 `AppState.port` 读出端口再传入。
- **托盘 HTTP 调用去硬编码**：`rebuild_tray_menu(app)` 已持有 `app`，改为读 `app.state::<AppState>().port` 拼 URL；`has_active_token` / `switch_account_api` 增加 `port: u16` 参数，由调用处（菜单事件闭包，能拿到 `app`）读取后传入。所有 `http://127.0.0.1:3000/api/tokens/*` 改为 `format!(".../{}/...", port)`。
- **新增命令**：
  ```rust
  #[tauri::command]
  fn backend_port(state: tauri::State<AppState>) -> u16 { *state.port.lock().unwrap() }
  ```
  加入 `invoke_handler(tauri::generate_handler![.. , backend_port])`。自定义命令无需 capability 配置（与现有 `win_*` 命令一致）。

### 4.2 前端 `public/app.js`（顶部 API 基址块）

现状（app.js:7）同步硬编码：
```js
const API_BASE = (typeof window.__TAURI_INTERNALS__ !== 'undefined') ? 'http://127.0.0.1:3000' : '';
```
改为：Tauri 模式下用 `invoke('backend_port')` 解析实际端口。

- `isTauri` 时取同步可用的 invoke：`window.__TAURI__?.core?.invoke ?? ((c,a)=>window.__TAURI_INTERNALS__.invoke(c,a))`。
- 端口解析为一个 promise：
  ```js
  let API_BASE = null;
  const baseReady = invoke('backend_port')
    .then(p => (API_BASE = `http://127.0.0.1:${p}`))
    .catch(() => (API_BASE = 'http://127.0.0.1:9701')); // 兜底
  ```
- `fetch` 包裹改为异步等待端口就绪后再改写（对调用方透明，fetch 本就返回 promise）：
  ```js
  window.fetch = async (input, init) => {
    const base = API_BASE ?? await baseReady;
    if (typeof input === 'string' && input.startsWith('/')) input = base + input;
    else if (input instanceof Request && input.url.startsWith('/')) input = new Request(base + input.url, input);
    return _origFetch(input, init);
  };
  ```
- `EventSource` 构造是同步的、无法在构造器内 await。约束：**应用引导流程需在创建任何 EventSource 之前 `await baseReady`**（run 流式连接都发生在启动引导之后，天然满足）。`PatchedES` 内读取已就绪的 `API_BASE`；若构造时 `API_BASE` 仍为 null（不应发生），记一条 `console.warn` 便于排查。
- web 模式：`isTauri` 为假 → `API_BASE=''`、不包裹 `fetch`/`EventSource`，行为完全不变。

### 4.3 配置 `src-tauri/tauri.conf.json`

- `build.devUrl`：`http://127.0.0.1:3000` → `http://127.0.0.1:9701`。
- `build.beforeDevCommand` 的提示文案：`Frontend running on http://127.0.0.1:9701`（仅文案）。

### 4.4 不改

- `src/entrypoints/web/server.js`：照收 `PORT` env（Rust 注入），默认仍 3000 供 web 台；CORS 逻辑不变。
- PM2 `ecosystem.config.cjs`、`README.md`、`START-HERE.md` 中的 3000 描述（那些是 web 台，本次不动；如需可另议）。

## 5. 错误处理

- 无空闲端口（9701–9800 全占）：`log_line` 记录 + emit `startup-error`，主进程不崩（沿用现状）。
- TOCTOU 竞态导致 node 绑定失败：`wait_backend_ready` 10s 超时 → emit `startup-error`；用户重启即可。作为已知小限制记录，本次不做自动重探/重启。
- 前端 `invoke('backend_port')` 失败：兜底 `9701`（并 `console.warn`）。

## 6. 测试计划

- **单元/纯函数**：
  - Rust `find_free_port`：占用一个端口后断言返回下一个；范围耗尽返回 `None`。（`#[cfg(test)]` 内起临时 `TcpListener` 占位）
  - 前端端口→基址拼接与相对路径改写可抽纯函数 `resolveApiUrl(input, base)` 加 `node --test`（`/api/x`→`base+/api/x`、绝对 URL 不变、非 `/` 开头不变）。
- **真机验证（手动）**：
  1. `tauri dev`：确认后端在 9701、前端加载正常。
  2. release 构建正常启动：后端 9701、`/api/ping` OK、托盘账号菜单 OK。
  3. **占用回退**：先占用 9701（临时监听），再启动 release，确认后端落到 9702，前端 `API_BASE` 与托盘 API 均指向 9702、功能正常。
  4. PM2 `claude-web` 同机运行时启动桌面版，确认互不冲突。

## 7. 涉及文件

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/main.rs` | `AppState.port`；`find_free_port`；`start_backend_prod`/`_dev` 探测+注入+存端口；`wait_backend_ready(port)`；托盘三处去硬编码读 `AppState.port`；新增 `backend_port` 命令并注册 |
| `public/app.js` | 顶部 `API_BASE` 由硬编码改为 `invoke('backend_port')` 解析 + 兜底；`fetch` 包裹异步等待端口；EventSource 引导前置 `await baseReady` 约束 |
| `src-tauri/tauri.conf.json` | `devUrl` → 9701；`beforeDevCommand` 文案 → 9701 |

## 8. 不做（明确排除）

- 不改 PM2 `claude-web` / 独立 `node server.js` 的端口（仍 3000）。
- 不做 dev 模式的端口探测（`devUrl` 静态，固定 9701）。
- 不做 TOCTOU 竞态的自动重探/重启（仅记录 + startup-error）。
- 不做端口跨重启持久化（每次启动重新探测；前端每次向 Rust 询问）。
