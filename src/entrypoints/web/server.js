/**
 * web 入口 —— HTTP + SSE + 静态托管 + 管理 API。
 * web 恒为本机 owner：聊天直接走 integrations/claude 流式（不经 dispatch，避免流式阻抗）；
 * 目录 / 日志等管理接口走 store/集成。仅监听 127.0.0.1。
 */
import http from 'node:http';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { appendEvent } from '../../store/event-log.js';
import { checkOrigin } from './origin.js';
import { installProcessGuards } from '../../shared/process-guard.js';

// 最后兜底：单个畸形请求不得打死进程（runs 是纯内存的，一崩全灭）。详见 process-guard.js。
installProcessGuards();
import { scheduleAllSwitchBacks } from '../../features/token-rotation.js';
import { recoverPendingAndOrphans } from './run-claude.js';
import { startRequirementPump } from './requirement-ops.js';
import { startAutoDevPump } from '../../plugins/team-tools/auto-dev/index.js';
import { startMemoryBankTicker } from '../../features/memory-bank/index.js';
import {
  handleRunStart,
  handleRunAbort,
  handleRunDecision,
  handleRunSend,
  handleRunMsgWithdraw,
  handleRunMsgNow,
  handleRunSetMode,
  handleRunPending,
  handleRunPendingDismiss,
  handleRunAttach,
} from './routes-run.js';
import {
  handleSettings,
  handleSettingsExport,
  handleSettingsImport,
  handleBotsList,
  handleBotsAdd,
  handleBotsUpdate,
  handleBotsDelete,
  handleTokensStatus,
  handleTokensDismiss,
  handleTokensList,
  handleTokensSwitch,
  handleCredentialsList,
  handleCredentialsAdd,
  handleCredentialsUpdate,
  handleCredentialsDelete,
  handleMcpServersList,
  handleMcpServersAdd,
  handleMcpServersUpdate,
  handleMcpServersDelete,
  handlePluginsList,
  handlePluginsUpdate,
} from './routes-settings.js';
import {
  handleUpload,
  handleScriptUpload,
  handleBrowse,
  handlePickDir,
  handleSaved,
  serveStatic,
  pruneUploads,
  handleFsStat,
  handleFsRead,
} from './routes-files.js';
import { handleRequirementRoutes } from './routes-requirements.js';
import { handleMemoryRoutes } from './routes-memory.js';
import { handleOptimizeRoutes } from './routes-optimize.js';
import { handleConvNotifyRoutes } from './routes-conv-notify.js';
import { startConvNotify } from './conv-notify.js';
import {
  handleLogs,
  handleLogsClear,
  handleTasks,
  handleTaskAction,
  handleHistory,
  handleHistoryDetail,
  handleScripts,
  handleActionsGet,
  handleActionsPost,
  handleActionsPut,
  handleActionsDelete,
  initializeDefaults,
  handleOpenInVibe,
  handlePing,
  handleNotify,
} from './routes-ops.js';

// 访问日志排除项：高频轮询与日志接口本身，避免刷屏
const ACCESS_LOG_SKIP = new Set([
  '/api/tasks',
  '/api/logs',
  '/api/logs/clear',
  '/api/run/pending',
  '/api/tokens/status',
  '/api/memory/list',
  '/api/conv-notify/inbox', // 前端 5s 一轮询，每会话每小时 720 次 appendFileSync
  '/api/conv-notify/sync', // 同上，会话快照心跳
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // CORS：打包后 Tauri webview（源 tauri.localhost）跨源访问本机后端。
  // 白名单制，不可退回 `*`——`*` 会让用户浏览器里任意标签页读到 /api/settings/export
  // 的明文 token 与飞书 appSecret（绑 127.0.0.1 挡不住浏览器内的跨源读取）。详见 origin.js。
  const cors = checkOrigin(req.headers.origin);
  if (cors.allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', cors.allowOrigin);
    res.setHeader('Vary', 'Origin'); // 回显源 → 响应随 Origin 变化，必须声明否则被缓存串源
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  // 非白名单源直接 403：不能只靠「不回 ACAO 让浏览器读不到响应」——
  // 简单请求（text/plain 的 POST）不触发预检，服务端副作用已经发生 → CSRF。
  if (!cors.ok) {
    logger.warn('security', '拒绝非白名单跨源请求', {
      origin: req.headers.origin,
      method: req.method,
      path: url.pathname,
    });
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'origin not allowed' }));
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  // 访问日志：记录有意义的 API 调用（method + path + 状态码 + 耗时）
  if (url.pathname.startsWith('/api/') && !ACCESS_LOG_SKIP.has(url.pathname)) {
    const start = Date.now();
    res.on('finish', () =>
      appendEvent({
        type: 'access',
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - start,
      }),
    );
  }
  if (url.pathname === '/api/run/start') return handleRunStart(req, res);
  if (url.pathname === '/api/run/abort') return handleRunAbort(req, res);
  if (url.pathname === '/api/run/decision') return handleRunDecision(req, res);
  if (url.pathname === '/api/run/send') return handleRunSend(req, res);
  if (url.pathname === '/api/run/msg/withdraw') return handleRunMsgWithdraw(req, res);
  if (url.pathname === '/api/run/msg/now') return handleRunMsgNow(req, res);
  if (url.pathname === '/api/run/set-mode') return handleRunSetMode(req, res);
  if (url.pathname === '/api/run/pending') return handleRunPending(res);
  if (url.pathname === '/api/run/pending/dismiss') return handleRunPendingDismiss(req, res);
  if (url.pathname === '/api/run') return handleRunAttach(url, res);
  if (url.pathname === '/api/history') return handleHistory(url, res);
  if (url.pathname.startsWith('/api/history/')) return handleHistoryDetail(url, res);
  if (url.pathname === '/api/upload') return handleUpload(req, res, url);
  if (url.pathname === '/api/fs/stat') return handleFsStat(req, res);
  if (url.pathname === '/api/fs/read') return handleFsRead(url, res);
  if (url.pathname === '/api/dirs/browse') return handleBrowse(url, res);
  if (url.pathname === '/api/dirs/pick') return handlePickDir(res);
  if (url.pathname === '/api/dirs/saved') return handleSaved(req, res);
  if (url.pathname === '/api/logs') return handleLogs(res);
  if (url.pathname === '/api/logs/clear') return handleLogsClear(req, res);
  if (url.pathname === '/api/tasks') return handleTasks(res);
  if (url.pathname === '/api/tasks/action') return handleTaskAction(req, res);
  if (url.pathname.startsWith('/api/conv-notify/')) {
    // 该子路由未命中时返回 false（不自行 404），此处放行继续往后匹配
    const handled = handleConvNotifyRoutes(req, res, url);
    if (handled !== false) return handled;
  }
  if (url.pathname.startsWith('/api/req/')) return handleRequirementRoutes(req, res, url);
  if (url.pathname.startsWith('/api/memory/')) return handleMemoryRoutes(req, res, url);
  if (url.pathname.startsWith('/api/optimize/')) return handleOptimizeRoutes(req, res, url);
  if (url.pathname === '/api/settings') return handleSettings(req, res);
  if (url.pathname === '/api/settings/export') return handleSettingsExport(req, res);
  if (url.pathname === '/api/settings/import') return handleSettingsImport(req, res);
  if (url.pathname === '/api/tokens/status') return handleTokensStatus(res);
  if (url.pathname === '/api/tokens/list') return handleTokensList(res);
  if (url.pathname === '/api/tokens/switch') return handleTokensSwitch(req, res);
  if (url.pathname === '/api/tokens/dismiss') return handleTokensDismiss(req, res);
  if (url.pathname === '/api/credentials' && req.method === 'GET') return handleCredentialsList(res);
  if (url.pathname === '/api/credentials' && req.method === 'POST') return handleCredentialsAdd(req, res);
  if (url.pathname.startsWith('/api/credentials/') && req.method === 'PUT') return handleCredentialsUpdate(req, res, url);
  if (url.pathname.startsWith('/api/credentials/') && req.method === 'DELETE') return handleCredentialsDelete(req, res, url);
  if (url.pathname === '/api/plugins' && req.method === 'GET') return handlePluginsList(res);
  if (url.pathname.startsWith('/api/plugins/') && req.method === 'PUT') return handlePluginsUpdate(req, res, url);
  if (url.pathname === '/api/mcp-servers' && req.method === 'GET') return handleMcpServersList(res);
  if (url.pathname === '/api/mcp-servers' && req.method === 'POST') return handleMcpServersAdd(req, res);
  if (url.pathname.startsWith('/api/mcp-servers/') && req.method === 'PUT') return handleMcpServersUpdate(req, res, url);
  if (url.pathname.startsWith('/api/mcp-servers/') && req.method === 'DELETE') return handleMcpServersDelete(req, res, url);
  if (url.pathname === '/api/bots' && req.method === 'GET') return handleBotsList(res);
  if (url.pathname === '/api/bots' && req.method === 'POST') return handleBotsAdd(req, res);
  if (url.pathname.startsWith('/api/bots/') && req.method === 'PUT') return handleBotsUpdate(req, res, url);
  if (url.pathname.startsWith('/api/bots/') && req.method === 'DELETE') return handleBotsDelete(req, res, url);
  if (url.pathname === '/api/actions' && req.method === 'GET') return handleActionsGet(res, url);
  if (url.pathname === '/api/actions' && req.method === 'POST') return handleActionsPost(req, res);
  if (url.pathname.startsWith('/api/actions/') && req.method === 'PUT') return handleActionsPut(req, res, url);
  if (url.pathname.startsWith('/api/actions/') && req.method === 'DELETE') return handleActionsDelete(req, res, url);
  if (url.pathname === '/api/scripts/upload') return handleScriptUpload(req, res, url);
  if (url.pathname === '/api/scripts') return handleScripts(res);
  if (url.pathname === '/api/ping') return handlePing(res);
  if (url.pathname === '/api/open-in-vibe') return handleOpenInVibe(req, res);
  if (url.pathname === '/internal/notify') return handleNotify(req, res);
  return serveStatic(url.pathname, res);
});

// ready：listen 完成（即 /api/ping 可响应）后 resolve。
// 一体化入口（根 server.js / sidecar）据此「先让 web 就绪，再挂飞书」，
// 避免飞书 WS 冷启动阻塞 web 就绪（详见根 server.js 注释）。独立 PM2 起 web 时不 await，无副作用。
export const ready = new Promise((resolve) => {
  server.listen(config.web.port, config.web.host, () => {
    console.log(`\n  claude 本地执行台 (web) 已启动`);
    console.log(`  浏览器打开 → http://${config.web.host}:${config.web.port}\n`);
    initializeDefaults().catch((e) =>
      logger.error('initialization', '启动初始化失败', { err: e?.message }),
    );
    pruneUploads(); // 清理旧上传副本
    setInterval(pruneUploads, 24 * 60 * 60 * 1000); // pm2 常驻数周不重启，仅启动清一次会积压
    recoverPendingAndOrphans(); // 孤儿恢复 + 待续跑重排（逻辑见 run-claude.js）
    scheduleAllSwitchBacks(); // 恢复 token switch-back 排程（跨重启）
    startAutoDevPump(); // 自动开发泵：仅 web 进程执行（feishu 只标记状态），含中断任务恢复
    startRequirementPump(); // 需求工作流串行闸泵：docgen/系统任务出队 + busy 崩溃恢复
    startConvNotify(); // 会话飞书通知：注册 run 终结监听器
    startMemoryBankTicker({ cwd: process.cwd() }); // 记忆库 10 分钟 tick：窗口内才真跑提炼
    resolve();
  });
});
