@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 停止 claude 本地执行台 ===
pm2 stop ecosystem.config.cjs
pm2 list
pause
