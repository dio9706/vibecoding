@echo off
REM Windows x86_64 build script (CMD / PowerShell)
setlocal enabledelayedexpansion

echo [Build] Windows x86_64 build starting...

REM 检查 Rust 工具链
rustc --version >nul 2>&1
if errorlevel 1 (
  echo [Error] Rust toolchain not found. Install from https://rustup.rs/
  exit /b 1
)
for /f "tokens=*" %%i in ('rustc --version') do echo [Build] Rust: %%i

REM 清理旧的构建产物（传入 --clean 参数时执行）
if "%1"=="--clean" (
  if exist "src-tauri\target" (
    echo [Build] Cleaning previous build...
    rmdir /s /q "src-tauri\target"
  )
)

REM 执行构建
echo [Build] Running: npm run tauri:build:win
call npm run tauri:build:win
if errorlevel 1 (
  echo [Error] Build failed
  exit /b 1
)

REM 展示产物
set BUNDLE_DIR=src-tauri\target\x86_64-pc-windows-msvc\release\bundle
if exist "%BUNDLE_DIR%" (
  echo.
  echo [Build] Build succeeded^^!
  echo [Build] Artifacts:
  for /r "%BUNDLE_DIR%" %%f in (*.exe *.msi) do (
    echo   %%f
  )
) else (
  echo [Error] Bundle directory not found: %BUNDLE_DIR%
  exit /b 1
)

endlocal
