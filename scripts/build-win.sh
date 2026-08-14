#!/bin/bash
# Windows x86_64 build script (run in Git Bash or WSL)
set -e

echo "[Build] Windows x86_64 build starting..."

# 检查 Rust 工具链
if ! command -v rustc &> /dev/null; then
  echo "[Error] Rust toolchain not found. Install from https://rustup.rs/"
  exit 1
fi
echo "[Build] Rust: $(rustc --version)"

# 添加目标三元组（幂等，已有不报错）
rustup target add x86_64-pc-windows-msvc 2>/dev/null || true

# 清理旧的构建产物（可选，首次可跳过加速）
if [ "${1}" = "--clean" ] && [ -d "src-tauri/target" ]; then
  echo "[Build] Cleaning previous build..."
  rm -rf src-tauri/target
fi

# 执行构建
echo "[Build] Running: npm run tauri:build:win"
npm run tauri:build:win

# 找到并展示产物
BUNDLE_DIR="src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
if [ -d "$BUNDLE_DIR" ]; then
  echo ""
  echo "[Build] Build succeeded!"
  echo "[Build] Artifacts:"
  find "$BUNDLE_DIR" \( -name "*.exe" -o -name "*.msi" \) | while read f; do
    size=$(du -h "$f" 2>/dev/null | cut -f1 || echo "?")
    echo "  [$size]  $f"
  done
else
  echo "[Error] Bundle directory not found: $BUNDLE_DIR"
  exit 1
fi
