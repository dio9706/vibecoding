/**
 * 巡检循环 HTTP 接口（单入口子路由范式，对齐 routes-memory.js）。
 *
 * 只服务飞书进程的跨进程调用：循环泵在 web 进程（要读 auto-dev 任务终态判「全修完」），
 * 而 \10001 / \10004 指令在 feishu 进程收，两者靠这两个端点接上。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { readLoop, updateLoop, DEFAULT_LOOP } from '../../store/patrol-loop.js';

// ==== POST /api/patrol/start {openId, chatId, chatType, appToken, tableId, url, reqId} ====
function handleStart(req, res) {
  return withJsonBody(req, res, (d) => {
    const cur = readLoop();
    // 单例：auto-dev 只有一个常驻工作区，两个循环会抢同一个任务分支。
    // 回 409 并带上启动人与时间，调用方据此拼「谁于何时启动」的提示。
    if (cur.active) {
      return sendJson(res, 409, {
        ok: false,
        error: '已有巡检在跑',
        startedAt: cur.startedAt,
        openId: cur.openId,
      });
    }
    const appToken = str(d.appToken);
    const chatId = str(d.chatId);
    const openId = str(d.openId);
    if (!appToken || !chatId || !openId) {
      return sendJson(res, 400, { ok: false, error: 'appToken / chatId / openId 不能为空' });
    }
    updateLoop({
      ...DEFAULT_LOOP,
      active: true,
      openId,
      chatId,
      chatType: str(d.chatType),
      appToken,
      tableId: str(d.tableId) || null,
      url: str(d.url),
      reqId: str(d.reqId) || null,
      startedAt: Date.now(),
      // 置 standby + nextRunAt=0 让下一个 tick 立刻开跑第一轮
      phase: 'standby',
      nextRunAt: 0,
      roundNo: 0,
    });
    logger.info('bug-patrol', '循环已启动', { openId, reqId: str(d.reqId) || null });
    return sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/patrol/stop ====
function handleStop(req, res) {
  return withJsonBody(req, res, () => {
    const cur = readLoop();
    if (!cur.active) return sendJson(res, 200, { ok: true, wasActive: false });
    // 只置 stopping：已入队的修复要跑完（半途截断会在 auto 工作区留下未提交的改动）
    updateLoop({ stopping: true });
    logger.info('bug-patrol', '收到停止指令，等已入队任务跑完', { roundNo: cur.roundNo });
    return sendJson(res, 200, { ok: true, wasActive: true, phase: cur.phase });
  });
}

/**
 * 单入口分发。未命中返回 false，交回 server.js 继续匹配后续路由。
 * @returns {boolean} 是否已受理
 */
export function handlePatrolRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/api/patrol/start' && req.method === 'POST') {
    handleStart(req, res);
    return true;
  }
  if (p === '/api/patrol/stop' && req.method === 'POST') {
    handleStop(req, res);
    return true;
  }
  return false;
}
