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
import { matchRouteFrom, findShadowedRoutes } from './route-match.js';
import { installProcessGuards } from '../../shared/process-guard.js';

// 最后兜底：单个畸形请求不得打死进程（runs 是纯内存的，一崩全灭）。详见 process-guard.js。
installProcessGuards();
import { scheduleAllSwitchBacks } from '../../capabilities/token-rotation.js';
import { recoverPendingAndOrphans } from './run-claude.js';
import { startRequirementPump } from './requirement-ops.js';
import { startAutoDevPump } from '../../plugins/team-tools/auto-dev/index.js';
import { startMemoryBankTicker } from '../../features/memory-bank/index.js';
import { startProjectMapIdleTicker } from './project-map-ops.js';
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
  handleConvCompact,
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
import { handleGitStatus, handleGitBranches, handleGitCheckout } from './routes-git.js';
import { handleRequirementRoutes } from './routes-requirements.js';
import { handleMemoryRoutes } from './routes-memory.js';
import { handleCleanupRoutes } from './routes-cleanup.js';
import { handleOptimizeRoutes } from './routes-optimize.js';
import { healAllBusyOnStartup } from './optimize-ops.js';
import { handleProjectMapRoutes } from './routes-project-map.js';
import { handleConvNotifyRoutes } from './routes-conv-notify.js';
import { startConvNotify } from './conv-notify.js';
import {
  handleLogs,
  handleLogsClear,
  handleBotLogs,
  handleBotLogsClear,
  handleTasks,
  handleTaskAction,
  handleHistory,
  handleHistoryDetail,
  handleScripts,
  handleActionsGet,
  handleActionPresetsGet,
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
  '/api/bot-logs', // 面板打开即请求；不排除的话「看日志」这个动作本身就在刷日志
  '/api/bot-logs/clear',
  '/api/run/pending',
  '/api/tokens/status',
  '/api/memory/list',
  '/api/conv-notify/inbox', // 前端 5s 一轮询，每会话每小时 720 次 appendFileSync
  '/api/conv-notify/sync', // 同上，会话快照心跳
]);

/**
 * 路由表 —— **按顺序**匹配的数组。加端点只往这张表里加一行，不再动请求处理函数。
 *
 * 为什么是数组而不是 Map：匹配顺序有语义。`/api/history` 的精确匹配必须先于
 * `/api/history/` 的前缀匹配；`/api/credentials` 的 GET/POST 必须先于
 * `/api/credentials/` 的 PUT/DELETE。Map 表达不了顺序，而拆成「精确 Map + 前缀数组」
 * 又要额外论证两者之间的优先级，反而更容易错。
 * 59 条线性字符串比较对本地服务可忽略 —— 原实现同样是 59 个顺序 if。
 *
 * 为什么每条都包一层箭头函数：现有 handler 的签名**并不统一**，有 `(req,res)`、
 * `(res)`、`(url,res)`、`(req,res,url)`，还有 `(res,url)`（handleActionsGet 独一份）。
 * 在表里做适配，就不必为了统一签名去改 30 多个 handler 和它们的测试。
 *
 * 约定：`path` 精确匹配，`prefix` 前缀匹配，`method` 可选（缺省=不限方法）；
 * handler 返回 `false` 表示「这条我不处理」，匹配继续往后走 ——
 * conv-notify 的子路由表用到这一点（它未命中时不自行 404）。
 */
const ROUTES = [
  { path: '/api/run/start', h: (req, res) => handleRunStart(req, res) },
  { path: '/api/run/abort', h: (req, res) => handleRunAbort(req, res) },
  { path: '/api/run/decision', h: (req, res) => handleRunDecision(req, res) },
  { path: '/api/run/send', h: (req, res) => handleRunSend(req, res) },
  { path: '/api/run/msg/withdraw', h: (req, res) => handleRunMsgWithdraw(req, res) },
  { path: '/api/run/msg/now', h: (req, res) => handleRunMsgNow(req, res) },
  { path: '/api/run/set-mode', h: (req, res) => handleRunSetMode(req, res) },
  { path: '/api/run/pending', h: (req, res) => handleRunPending(res) },
  { path: '/api/run/pending/dismiss', h: (req, res) => handleRunPendingDismiss(req, res) },
  { path: '/api/run', h: (req, res, url) => handleRunAttach(url, res) },
  { path: '/api/conversation/compact', method: 'POST', h: (req, res) => handleConvCompact(req, res) },
  { path: '/api/history', h: (req, res, url) => handleHistory(url, res) },
  // 前缀必须排在上面的精确匹配之后
  { prefix: '/api/history/', h: (req, res, url) => handleHistoryDetail(url, res) },
  { path: '/api/upload', h: (req, res, url) => handleUpload(req, res, url) },
  { path: '/api/fs/stat', h: (req, res) => handleFsStat(req, res) },
  { path: '/api/fs/read', h: (req, res, url) => handleFsRead(url, res) },
  { path: '/api/dirs/browse', h: (req, res, url) => handleBrowse(url, res) },
  { path: '/api/dirs/pick', h: (req, res) => handlePickDir(res) },
  { path: '/api/dirs/saved', h: (req, res) => handleSaved(req, res) },
  { path: '/api/git/status', h: (req, res, url) => handleGitStatus(url.searchParams.get('cwd') || '', res) },
  { path: '/api/git/branches', h: (req, res, url) => handleGitBranches(url.searchParams.get('cwd') || '', url.searchParams.get('refresh') || '', res) },
  { path: '/api/git/checkout', method: 'POST', h: (req, res, url) => handleGitCheckout(url.searchParams.get('cwd') || '', req, res) },
  { path: '/api/logs', h: (req, res) => handleLogs(res) },
  { path: '/api/logs/clear', h: (req, res) => handleLogsClear(req, res) },
  { path: '/api/bot-logs', h: (req, res) => handleBotLogs(res) },
  { path: '/api/bot-logs/clear', h: (req, res) => handleBotLogsClear(req, res) },
  { path: '/api/tasks', h: (req, res) => handleTasks(res) },
  { path: '/api/tasks/action', h: (req, res) => handleTaskAction(req, res) },
  // 返回 false 时继续往后匹配（见表头说明）
  { prefix: '/api/conv-notify/', h: (req, res, url) => handleConvNotifyRoutes(req, res, url) },
  { prefix: '/api/req/', h: (req, res, url) => handleRequirementRoutes(req, res, url) },
  { prefix: '/api/memory/', h: (req, res, url) => handleMemoryRoutes(req, res, url) },
  { prefix: '/api/cleanup/', h: (req, res, url) => handleCleanupRoutes(req, res, url) },
  { prefix: '/api/optimize/', h: (req, res, url) => handleOptimizeRoutes(req, res, url) },
  { prefix: '/api/project-map/', h: (req, res, url) => handleProjectMapRoutes(req, res, url) },
  { path: '/api/settings', h: (req, res) => handleSettings(req, res) },
  { path: '/api/settings/export', h: (req, res) => handleSettingsExport(req, res) },
  { path: '/api/settings/import', h: (req, res) => handleSettingsImport(req, res) },
  { path: '/api/tokens/status', h: (req, res) => handleTokensStatus(res) },
  { path: '/api/tokens/list', h: (req, res) => handleTokensList(res) },
  { path: '/api/tokens/switch', h: (req, res) => handleTokensSwitch(req, res) },
  { path: '/api/tokens/dismiss', h: (req, res) => handleTokensDismiss(req, res) },
  { path: '/api/credentials', method: 'GET', h: (req, res) => handleCredentialsList(res) },
  { path: '/api/credentials', method: 'POST', h: (req, res) => handleCredentialsAdd(req, res) },
  { prefix: '/api/credentials/', method: 'PUT', h: (req, res, url) => handleCredentialsUpdate(req, res, url) },
  { prefix: '/api/credentials/', method: 'DELETE', h: (req, res, url) => handleCredentialsDelete(req, res, url) },
  { path: '/api/plugins', method: 'GET', h: (req, res) => handlePluginsList(res) },
  { prefix: '/api/plugins/', method: 'PUT', h: (req, res, url) => handlePluginsUpdate(req, res, url) },
  { path: '/api/mcp-servers', method: 'GET', h: (req, res) => handleMcpServersList(res) },
  { path: '/api/mcp-servers', method: 'POST', h: (req, res) => handleMcpServersAdd(req, res) },
  { prefix: '/api/mcp-servers/', method: 'PUT', h: (req, res, url) => handleMcpServersUpdate(req, res, url) },
  { prefix: '/api/mcp-servers/', method: 'DELETE', h: (req, res, url) => handleMcpServersDelete(req, res, url) },
  { path: '/api/bots', method: 'GET', h: (req, res) => handleBotsList(res) },
  { path: '/api/bots', method: 'POST', h: (req, res) => handleBotsAdd(req, res) },
  { prefix: '/api/bots/', method: 'PUT', h: (req, res, url) => handleBotsUpdate(req, res, url) },
  { prefix: '/api/bots/', method: 'DELETE', h: (req, res, url) => handleBotsDelete(req, res, url) },
  // 注意参数顺序是 (res, url)，与相邻 handler 都不同 —— 表内适配的价值就在这
  // 必须排在 /api/actions 之前？不必：路径不同且无前缀遮蔽关系，但放一起便于阅读
  { path: '/api/action-presets', method: 'GET', h: (req, res) => handleActionPresetsGet(res) },
  { path: '/api/actions', method: 'GET', h: (req, res, url) => handleActionsGet(res, url) },
  { path: '/api/actions', method: 'POST', h: (req, res) => handleActionsPost(req, res) },
  { prefix: '/api/actions/', method: 'PUT', h: (req, res, url) => handleActionsPut(req, res, url) },
  { prefix: '/api/actions/', method: 'DELETE', h: (req, res, url) => handleActionsDelete(req, res, url) },
  { path: '/api/scripts/upload', h: (req, res, url) => handleScriptUpload(req, res, url) },
  { path: '/api/scripts', h: (req, res) => handleScripts(res) },
  { path: '/api/ping', h: (req, res) => handlePing(res) },
  { path: '/api/open-in-vibe', h: (req, res) => handleOpenInVibe(req, res) },
  { path: '/internal/notify', h: (req, res) => handleNotify(req, res) },
];

// 启动自检：新加端点时把顺序放错（精确排在能覆盖它的前缀之后）会导致该端点
// 静默 404 或被错误的 handler 接走。这里让它在启动时就喊出来，而不是等线上排查。
const shadowed = findShadowedRoutes(ROUTES);
if (shadowed.length) {
  for (const s of shadowed) {
    logger.error('routing', '路由被前面的前缀遮蔽，永远不会命中', s);
  }
}

/**
 * 在路由表里找到第一个命中的条目并执行。
 * @returns {boolean} 是否已被某条路由处理（false 时调用方走静态托管兜底）
 */
function routeRequest(req, res, url) {
  let from = 0;
  for (;;) {
    const m = matchRouteFrom(ROUTES, req.method, url.pathname, from);
    if (!m) return false;
    // 子路由表未命中时会回 false，此时不算已处理，从下一条继续匹配
    if (m.route.h(req, res, url) !== false) return true;
    from = m.index + 1;
  }
}

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
  if (routeRequest(req, res, url)) return;
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
    // 体检/优化的占用记录落盘、job 注册表在内存：新进程必然没有在跑的任务，
    // 盘上残留的都是上次进程的尸体。不清的话用户点体检只会反复看到
    // 「该项目正在体检或优化中」，要等一小时才自然解开（见 optimize-ops.js 的详细说明）
    healAllBusyOnStartup();
    scheduleAllSwitchBacks(); // 恢复 token switch-back 排程（跨重启）
    startAutoDevPump(); // 自动开发泵：仅 web 进程执行（feishu 只标记状态），含中断任务恢复
    startRequirementPump(); // 需求工作流串行闸泵：docgen/系统任务出队 + busy 崩溃恢复
    startConvNotify(); // 会话飞书通知：注册 run 终结监听器
    startMemoryBankTicker({ cwd: process.cwd() }); // 记忆库 10 分钟 tick：窗口内才真跑提炼
    startProjectMapIdleTicker(); // 项目地图闲时刷新 10 分钟 tick：凌晨窗口且用户开启才真跑
    resolve();
  });
});
