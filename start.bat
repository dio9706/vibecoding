@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 启动 Principal（PM2 守护）===
pm2 start ecosystem.config.cjs
pm2 save
pm2 list
echo.
echo web:   http://127.0.0.1:3000
echo 飞书:  principal-feishu（长连接）
echo 看日志: pm2 logs
pause
