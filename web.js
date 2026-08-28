/**
 * web-only 启动器（PM2 principal-web 用）：只起 HTTP + SSE 执行台，不连飞书。
 * 飞书长连接由独立的 principal-feishu(feishu.js) 承担 —— 避免同一套 PM2 里
 * server.js（一体化 web+飞书）与 feishu.js 双起飞书长连接、事件重复处理。
 * 注：根 server.js 仍是「桌面版 / 独立一体化」入口，供 Tauri sidecar 使用，本文件不影响它。
 */
import './src/entrypoints/web/server.js';
