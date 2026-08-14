# 设计文档：Tauri 桌面化改造

**日期**：2026-07-21  
**项目**：claude-agent-web-demo → 桌面应用  
**状态**：已批准

---

## 目标

将现有 `claude-agent-web-demo`（Node.js 后端 + 纯静态前端）封装为 Tauri 桌面应用，新增系统级能力：系统托盘、原生通知、全局快捷键、菜单栏、开机自启，支持 Windows + macOS 双平台打包分发。

**核心约束**：前端代码不改，后端（server.js + src/）代码不改，通过 Tauri sidecar 机制驱动 Node.js 进程。

---

## 架构

### 总体架构

```
Tauri 壳（Rust 主进程）
  ├─ 系统级能力：托盘 / 通知 / 快捷键 / 菜单 / 开机自启
  ├─ WebView：加载 http://127.0.0.1:PORT（你的 index.html）
  └─ Sidecar：启动 node server.js（绑 127.0.0.1，不暴露公网）

后端 Sidecar（Node.js 进程，原封不动）
  └─ server.js → src/ → Claude Agent SDK → claude CLI

前端（WebView 内，原封不动）
  └─ public/index.html + app.css + app.js → SSE/HTTP → localhost:PORT
```

### 目录结构（改造后）

```
claude-p-web-demo/
  ├─ src-tauri/                    ← 新增，Tauri 壳
  │  ├─ tauri.conf.json            ← 应用配置（菜单、快捷键、sidecar、图标）
  │  ├─ Cargo.toml                 ← Rust 依赖声明
  │  ├─ build.rs                   ← Tauri 构建脚本（模板，几乎不改）
  │  └─ src/
  │     └─ main.rs                 ← 窗口初始化 + sidecar 启动 + 系统能力注册（~150 行）
  ├─ public/                       ← 前端，不改
  ├─ server.js                     ← 后端入口，不改
  ├─ src/                          ← 后端逻辑，不改
  ├─ package.json                  ← 追加 tauri 相关 scripts
  └─ scripts/build-{win,mac}.sh    ← 跨平台打包脚本（新增）
```

---

## 系统级能力设计

### 1. 系统托盘

- 图标：应用 Logo（深色/浅色各一套，Tauri 自动切换）
- 右键菜单项：
  - **打开**（主窗口显示/置顶）
  - **新建任务**（主窗口置顶并 focus 到输入框）
  - 分隔线
  - **开机自启**（复选框，可切换）
  - 分隔线
  - **退出**（优雅退出，杀掉 sidecar）

### 2. 原生通知

触发场景（由后端产生事件，通过 Tauri IPC 触发）：
- 任务执行完成（包括自动续跑完成）
- 额度耗尽、sidecar 崩溃等错误状态
- 用户发出任务后最小化窗口，完成时弹通知

IPC 路径：
```
后端 server.js → POST /internal/notify（本地内部接口）
→ Tauri main.rs 监听 → tauri::notification::Notification::new().show()
```

### 3. 全局快捷键

| 快捷键 | 行为 |
|--------|------|
| `Ctrl+Shift+P`（Windows）/ `Cmd+Shift+P`（macOS） | 唤起主窗口（从最小化/后台恢复并置顶） |

注册方式：`tauri-plugin-global-shortcut`，应用启动时注册，退出时注销。

### 4. 原生菜单栏

- **macOS**：系统顶部菜单栏
- **Windows**：窗口标题栏下方菜单（可选，默认不显示）

菜单结构：
```
应用名
  └─ 关于...
文件
  ├─ 新建任务          Cmd/Ctrl+N
  └─ 退出              Cmd/Ctrl+Q
窗口
  ├─ 最小化            Cmd/Ctrl+M
  └─ 最大化
帮助
  └─ 查看日志文件夹
```

### 5. 开机自启

- 插件：`tauri-plugin-autostart`
- 入口：托盘菜单「开机自启」复选框
- 状态持久化：写入 `settings.json`（复用现有配置文件）

---

## 启动与退出流程

### 启动流程

```
用户点击图标
  → Tauri 主进程初始化
  → 注册全局快捷键、托盘图标、菜单
  → 启动 Sidecar（node server.js）
  → 等待后端健康检查（GET http://127.0.0.1:PORT/api/ping，最多等 10s，500ms 重试）
  → WebView 打开（加载 http://127.0.0.1:PORT/index.html）
  → 显示主窗口
```

健康检查失败处理：超过 10s 未响应，弹原生 dialog「后端启动失败，请查看日志」，并展示日志路径。

### 退出流程

```
用户点「退出」或系统关闭
  → Tauri 触发 on_window_close_requested
  → 发送 SIGTERM 给 sidecar（node 进程）
  → 等待最多 5s
  → 未退出则 SIGKILL
  → Tauri 主进程退出
```

用户关闭窗口（不是退出）：窗口隐藏（hide），sidecar 继续运行；托盘图标保持，点击可重新显示。

### 后端崩溃恢复

- Tauri 监听 sidecar 进程退出事件
- 自动重启（最多 3 次，间隔 2s、5s、10s）
- 3 次失败后弹原生通知「Claude 后端异常，请手动重启应用」

---

## 打包分发

### 产物

| 平台 | 格式 | 预期体积 |
|------|------|---------|
| Windows | `.exe` NSIS 安装器 + `.msi` | ~60-80MB（含 Node.js runtime） |
| macOS | `.dmg` + `.app` | ~50-70MB |

### Node.js Runtime 打包策略

使用 `@yao-pkg/pkg`（或 `nexe`）将 `server.js` + `node_modules` + Node runtime 打包成单个可执行文件，作为 Tauri sidecar 资源内嵌。

优点：用户无需预装 Node.js。

### 跨平台构建

- Windows 包：在 Windows 上跑 `npm run tauri build`
- macOS 包：在 macOS 上跑（或 GitHub Actions macOS runner）
- CI 配置：`github/workflows/release.yml`（在 tag 推送时自动构建双平台，上传 Releases）

---

## 新增依赖

**Tauri 插件**：
- `tauri-plugin-autostart`：开机自启
- `tauri-plugin-global-shortcut`：全局快捷键
- `tauri-plugin-notification`：原生通知

**构建工具**：
- Rust 工具链（`rustup`，一次性安装）
- `@tauri-apps/cli`：Tauri 命令行
- `@yao-pkg/pkg` 或 `nexe`：打包 Node sidecar

---

## 不改动的范围

- `public/` 前端所有文件
- `server.js` 及 `src/` 目录所有文件
- `package.json` 依赖（仅追加 devDependencies）
- `.env` 及所有运行时配置文件

---

## 风险与注意事项

1. **Node sidecar 打包体积**：含 Node runtime 约 50MB，可接受。若将来需优化可考虑 Bun runtime 替代。
2. **macOS 公证（Notarization）**：macOS 需要 Apple Developer 账号签名公证，否则用户需手动「允许运行」。首期可跳过，二期补充。
3. **端口冲突**：3000 端口若被占用，后端启动失败。后续可改为随机端口，Tauri 从 sidecar stdout 读取实际端口。
4. **Windows 杀毒误报**：未签名的 `.exe` 可能触发 Defender，建议后期添加代码签名证书。
5. **PM2 与 Tauri 共存**：若用户同时用 PM2 跑旧版 `server.js`，端口会冲突。桌面版启动前需检查端口占用。
