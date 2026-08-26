/**
 * 项目优化 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 阶段一只有两个只读接口：取上次报告、跑一次静态体检。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { getProjectRecord } from '../../store/optimize.js';
import { startCheckup, getCheckupJob, attachCheckupJob } from './optimize-ops.js';

// ==== GET /api/optimize/report?dir=xxx ====
function handleReport(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  const rec = getProjectRecord(dir);
  sendJson(res, 200, {
    report: rec?.lastCheckup || null,
    history: rec?.history || [],
  });
}

// ==== POST /api/optimize/checkup {dir, force?} ====
// 静态维度同步出结果；LLM 维度若要冷跑则标 analyzing 并附 checkupId，让前端接 SSE 等回填
function handleCheckup(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });

    try {
      const { report, checkupId } = await startCheckup(dir, { force: !!data.force });
      sendJson(res, 200, { report, checkupId });
    } catch (e) {
      logger.warn('optimize', '体检失败', { dir, err: e.message });
      sendJson(res, 400, { error: e.message });
    }
  });
}

// ==== GET /api/optimize/checkup-stream?checkupId= (SSE) ====
function handleCheckupStream(res, url) {
  const job = getCheckupJob(str(url.searchParams.get('checkupId')));
  // 任务不在了就回 404 而不是开一条空 SSE：EventSource 对非 200 会置 CLOSED 不再重连，
  // 前端据此收手；开空流则会让它一直重连一条永远没有事件的通道。
  if (!job) return sendJson(res, 404, { error: '体检任务不存在或已过期' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  attachCheckupJob(job, res);
}

/** 项目优化路由单入口：按 pathname + method 分发 */
export function handleOptimizeRoutes(req, res, url) {
  if (url.pathname === '/api/optimize/report' && req.method === 'GET') {
    return handleReport(res, url);
  }
  if (url.pathname === '/api/optimize/checkup' && req.method === 'POST') {
    return handleCheckup(req, res);
  }
  if (url.pathname === '/api/optimize/checkup-stream' && req.method === 'GET') {
    return handleCheckupStream(res, url);
  }
  return sendJson(res, 404, { error: 'not found' });
}
