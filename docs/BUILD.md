# 编译与构建指南

本项目由三部分组成，只有 Tauri 桌面壳需要真正的"编译"：

| 部分 | 技术 | 是否需要编译 |
|------|------|-------------|
| 后端 | Node.js（`server.js` + `src/`） | 否，直接运行 |
| 前端 | 静态文件（`public/`） | 否，无构建步骤，静态托管 |
| 桌面壳 | Tauri（`src-tauri/`，Rust） | 是，仅打包桌面版时需要 |

## 前置条件

| 工具 | 检查命令 | 说明 |
|------|---------|------|
| Node.js v20+ | `node -v` | 所有模式必需 |
| Rust | `rustc --version` | 仅桌面版需要，https://rustup.rs |
| MSVC 工具链（Windows） | `rustc --version` 正常即可 | Visual Studio Build Tools → Desktop development with C++ |
| Xcode CLI（macOS） | `xcode-select -p` | `xcode-select --install` |

## 一、Web 模式（无需编译）

```bash
npm install
npm start          # 即 node server.js，浏览器访问 http://localhost:3000
```

## 二、桌面版开发模式

```bash
npm run tauri:dev
```

内部先执行 `node scripts/prepare-sidecar.mjs --node-only`（仅拷贝 node 二进制），再启动 `tauri dev`。
首次编译约 5-10 分钟（下载并编译 Rust 依赖），后续增量约 1-2 分钟。

## 三、桌面版生产构建

> ⚠️ 只能在目标平台上构建：`prepare-sidecar.mjs` 拷贝的是宿主机 node 二进制，
> 跨平台/跨架构构建会被脚本主动拦截报错。

### Windows（x86_64）

```bash
# 方式 1：npm script（推荐）
npm run tauri:build:win

# 方式 2：Git Bash / WSL 脚本（支持 --clean 清理旧产物）
npm run build:release:win        # 即 bash scripts/build-win.sh
bash scripts/build-win.sh --clean

# 方式 3：CMD / PowerShell
scripts\build-win.bat
```

产物位置：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`（`.exe` 安装器 + `.msi`）

### macOS（universal：Intel + Apple Silicon）

```bash
npm run tauri:build:mac          # 或 npm run build:release:mac
```

产物位置：`src-tauri/target/universal-apple-darwin/release/bundle/`（`.dmg`）

### 构建时 sidecar 打包了什么

`scripts/prepare-sidecar.mjs`（`tauri:build:win` 会自动执行）将后端 stage 进 Tauri 包：

1. 宿主机 node 二进制 → `src-tauri/binaries/node-<triple>.exe`
2. `server.js`、`package.json`、`package-lock.json`、`src/`、`public/` → `src-tauri/resources/sidecar/`（自动剥离 `*.test.js` 测试文件）
3. 在 staging 目录执行 `npm ci --omit=dev` 安装生产依赖

## 四、运行测试

```bash
npm test           # node --test "src/**/*.test.js"
```

## 相关文档

- [Tauri 开发环境设置与常见问题](TAURI_SETUP.md)（Rust 安装、端口占用、Gatekeeper 等）
- [应用分发指南](DISTRIBUTION.md)（GitHub Actions 自动打包、版本发布流程）
