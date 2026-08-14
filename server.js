/**
 * 桌面版 / 独立启动的一体化入口：同时启动 web 服务器（HTTP + SSE）与飞书长连接。
 * PM2 仍可分开用 claude-web / claude-feishu 各自启动，此文件供 Tauri sidecar 使用。
 *
 * 冷启动顺序（重要）：先 await web 的 ready（listen 完成、/api/ping 可响应），
 * 再加载飞书渠道。飞书 WS 连接常走本地代理（如 127.0.0.1:7897），重启开机时
 * 代理尚未就绪会连接失败并重试，若与 web 同步初始化会阻塞事件循环、拖慢 web 就绪，
 * 导致桌面版 40s 健康检查窗口内 /api/ping 迟迟不响应 → 误报「后端启动失败」。
 * 分两步后，web 秒级就绪，飞书在后台异步连接（失败重试不影响执行台使用）。
 */
import { ready } from './src/entrypoints/web/server.js';

await ready;
await import('./src/entrypoints/feishu/index.js');
