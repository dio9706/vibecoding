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
import { loadAppEnv } from './src/shared/load-env.js';

// 必须在任何业务模块之前完成 —— shared/config.js 在**模块求值时**就读 process.env，
// 而静态 import 一律先于本行执行。所以下面全部改用动态 import，顺序才是真的顺序。
// 少了这一步就会重演 2026-08-26：`node server.js`（package.json 的 start，不带 --env-file）
// 起来的进程读不到 .env，飞书靠 store 里的机器人配置照样能跑，
// 只有依赖纯环境变量的埋点统计在运行期报「缺少 TRACKING_DB_*」。详见 shared/load-env.js。
loadAppEnv();

const { ready } = await import('./src/entrypoints/web/server.js');
await ready;
await import('./src/entrypoints/feishu/index.js');
