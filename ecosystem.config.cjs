/**
 * PM2 进程守护配置 —— 守护 web + 飞书两个入口，崩溃自动重启。
 *
 * 用法（本机已装 PM2）：
 *   pm2 start ecosystem.config.cjs     启动并守护（或双击 start.bat）
 *   pm2 stop  ecosystem.config.cjs     停止（或 stop.bat）
 *   pm2 restart ecosystem.config.cjs   重启
 *   pm2 logs                           看日志
 *   pm2 save && pm2 startup            配置开机自启
 *
 * 注意：用 PM2 托管前，先手动停掉自己 node 起的实例，避免端口 3000 / 飞书长连接冲突。
 */
// 统一数据目录：让 PM2 的 web/feishu 与桌面版(Tauri)读写同一份 store，
// 这样桌面版 GUI 改的动作配置/凭证，飞书 bot 立即生效（否则两者各读各的库）。
// 值 = 桌面版 app_data_dir()（Windows：%APPDATA%\<identifier>）。
// 改了本文件后必须让 PM2 重新读取 env：`pm2 restart ecosystem.config.cjs --update-env`
// （或 `pm2 delete all && pm2 start ecosystem.config.cjs`）。
const APP_DATA_DIR = 'C:\\Users\\DELL\\AppData\\Roaming\\com.claudeagent.desktop';

module.exports = {
  apps: [
    {
      name: 'claude-web',
      // 纯 web 入口（不连飞书）；用根 server.js 会与 claude-feishu 双起飞书长连接。
      script: './web.js',
      // web 进程同样需要 .env：OWNER_OPEN_IDS / TRIAGE_OWNER_OPEN_ID / FRONTEND_DIR 等
      // 都被 web 侧读取（auto-dev 泵、任务分析、角色判定）。此前只有 claude-feishu 加了
      // --env-file，web 进程里 config.lark.ownerOpenIds 恒为空数组，依赖白名单的判定静默失效。
      node_args: '--env-file=.env',
      cwd: __dirname,
      // 钉死 3000，避免继承到桌面版 sidecar 的 9701 端口导致 EADDRINUSE 崩溃循环。
      env: { APP_DATA_DIR, PORT: '3000' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
    },
    {
      name: 'claude-feishu',
      script: './feishu.js',
      // 飞书入口需要 .env 里的凭证；Node 20+ 用 --env-file 加载
      node_args: '--env-file=.env',
      cwd: __dirname,
      env: { APP_DATA_DIR },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
    },
  ],
};
