#!/bin/bash
# macOS universal build script (Apple Silicon + Intel)
# Run on a macOS machine
set -e

echo "[Build] macOS universal build starting..."

# 检查运行平台
if [ "$(uname)" != "Darwin" ]; then
  echo "[Error] This script must run on macOS"
  exit 1
fi

# 检查 Rust 工具链
if ! command -v rustc &> /dev/null; then
  echo "[Error] Rust toolchain not found. Install from https://rustup.rs/"
  exit 1
fi
echo "[Build] Rust: $(rustc --version)"

# 检查 Xcode Command Line Tools
if ! xcode-select -p &> /dev/null; then
  echo "[Error] Xcode Command Line Tools not found. Run: xcode-select --install"
  exit 1
fi

# 添加两个 macOS 目标架构（Apple Silicon + Intel）
echo "[Build] Adding macOS target architectures..."
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 清理旧的构建产物（可选）
if [ "${1}" = "--clean" ] && [ -d "src-tauri/target" ]; then
  echo "[Build] Cleaning previous build..."
  rm -rf src-tauri/target
fi

# 执行构建（universal binary = aarch64 + x86_64 合并）
echo "[Build] Running: npm run tauri:build:mac"
npm run tauri:build:mac

# 找到并展示产物
BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
if [ -d "$BUNDLE_DIR" ]; then
  echo ""
  echo "[Build] Build succeeded!"
  echo "[Build] Artifacts:"
  find "$BUNDLE_DIR" \( -name "*.dmg" -o -name "*.app" \) -maxdepth 3 | while read f; do
    echo "  $f"
  done
else
  echo "[Error] Bundle directory not found: $BUNDLE_DIR"
  echo "[Hint]  Check if 'universal-apple-darwin' target is supported by your Tauri version"
  exit 1
fi
