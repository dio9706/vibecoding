# 应用分发指南

## 一、本地手动打包

### Windows（在 Windows 机器上执行）

```bash
# 方式 1：直接 npm script
npm run tauri:build:win

# 方式 2：使用脚本（Git Bash / WSL）
bash scripts/build-win.sh

# 方式 3：CMD 用户
scripts\build-win.bat
```

**产物位置：**
```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
  nsis/   claude-agent-setup.exe   ← NSIS 安装器（推荐分发）
  msi/    claude-agent_*.msi       ← MSI 安装包（可选）
```

**首次编译**：10-15 分钟（下载并编译 Rust 依赖）  
**后续编译**：2-5 分钟（增量编译）

---

### macOS（在 macOS 机器上执行）

```bash
# 方式 1：直接 npm script（universal binary = Intel + Apple Silicon）
npm run tauri:build:mac

# 方式 2：使用脚本
bash scripts/build-mac.sh
```

**产物位置：**
```
src-tauri/target/universal-apple-darwin/release/bundle/
  dmg/   claude-agent_*.dmg   ← 安装镜像（推荐分发）
  macos/ ClaudeAgent.app/     ← 应用包（可直接拖入 Applications）
```

---

## 二、自动打包（GitHub Actions）

推送版本 tag 后，CI 自动在 Windows + macOS 两平台并行构建，并上传到 GitHub Releases。

### 发布新版本

```bash
# 1. 确保代码已全部提交
git status

# 2. 更新版本号（可选，自动更新 package.json + git tag）
npm version patch    # x.x.X +1
npm version minor    # x.X.0 +1
npm version major    # X.0.0 +1

# 3. 推送代码 + tag
git push origin main
git push origin --tags    # 触发 CI
```

### 观察构建进度

打开 GitHub 仓库 → **Actions** 页面 → 找到「Build and Release」工作流。  
两个 job（Windows / macOS）并行运行，总耗时约 10-20 分钟。

### 下载产物

构建完成后，访问 **Releases** 页面即可下载对应平台安装器。

---

## 三、签名与公证（后期补充）

### Windows 代码签名

目前跳过。用户首次运行可能触发 Windows SmartScreen 警告，点「更多信息」→「仍要运行」即可。

后期添加方式：在 CI 中配置 `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` secrets。

### macOS 公证（Notarization）

目前跳过。用户首次运行可能提示"无法验证开发者"，右键→「打开」→「仍要打开」即可。

后期需要：
1. Apple Developer 账号（$99/年）
2. 在 tauri.conf.json 配置 `signingIdentity`
3. CI 中配置证书 secrets

---

## 四、版本规范

遵循 [Semantic Versioning](https://semver.org/)：

- `v1.0.0` — 大版本（不兼容的 API 变更）
- `v1.1.0` — 新功能（向后兼容）
- `v1.1.1` — Bug 修复

首个公开测试版：`v0.1.0`  
生产可用版本：`v1.0.0`
