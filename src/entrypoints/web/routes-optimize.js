/**
 * 项目优化 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 两个体检接口（报告 / 体检 + SSE）+ 四个优化接口（优化 / SSE / 备份列表 / 还原）。
 *
 * 有串行闸的接口一律用 **409** 表示「被挡下」，绝不回 200 加空结果：
 * 前端拿 200 会当成「操作完成但没结果」，把已有报告清空——
 * 用户看到的是自己刚跑出来的分数凭空消失。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { getProjectRecord } from '../../store/optimize.js';
import {
  startCheckup, getCheckupJob, attachCheckupJob,
  startFix, getFixJob, attachFixJob, runRollback,
} from './optimize-ops.js';
import { listBackups } from '../../features/project-optimize/backup.js';

const BUSY_MSG = '该项目正在体检或优化中，请稍候';

/** 开一条 SSE 通道 */
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

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
      const out = await startCheckup(dir, { force: !!data.force });
      // 串行闸挡下：409 而不是 200 + 空报告。前端拿 200 会当成「体检完成但没结果」，
      // 把已有的报告清空——用户看到的是自己刚跑出来的分数凭空消失。
      if (out.busy) {
        return sendJson(res, 409, { error: BUSY_MSG, busy: out.busy });
      }
      sendJson(res, 200, { report: out.report, checkupId: out.checkupId });
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

  openStream(res);
  attachCheckupJob(job, res);
}

// ==== POST /api/optimize/fix {dir, dimensions?, force?} ====
// 四种正常返回：{jobId} 开跑 / {needsConfirm} 工作区脏 / {nothing,blocked} 无可修项 / 409 被占用
function handleFix(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
    // fail-closed：只认字符串数组。传成 'rules' 这种裸字符串时当作没勾任何维度，
    // 而不是把脏形状透传进编排层（它会被原样写进备份 manifest）
    const dimensions = Array.isArray(data.dimensions) ? data.dimensions.map(str).filter(Boolean) : [];

    try {
      const out = await startFix(dir, { dimensions, force: !!data.force });
      if (out.busy) return sendJson(res, 409, { error: BUSY_MSG, busy: out.busy });
      sendJson(res, 200, out);
    } catch (e) {
      logger.warn('optimize', '优化启动失败', { dir, err: e.message });
      sendJson(res, 400, { error: e.message });
    }
  });
}

// ==== GET /api/optimize/fix-stream?jobId= (SSE) ====
function handleFixStream(res, url) {
  const job = getFixJob(str(url.searchParams.get('jobId')));
  if (!job) return sendJson(res, 404, { error: '优化任务不存在或已过期' });

  openStream(res);
  attachFixJob(job, res);
}

// ==== GET /api/optimize/backups?dir=xxx ====
function handleBackups(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  sendJson(res, 200, { backups: listBackups(dir) });
}

// ==== POST /api/optimize/rollback {dir, dirName} ====
function handleRollback(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    const dirName = str(data.dirName);
    if (!dir || !dirName) return sendJson(res, 400, { error: '缺少 dir 或 dirName 参数' });

    try {
      const out = runRollback(dir, dirName);
      if (out.busy) return sendJson(res, 409, { error: BUSY_MSG, busy: out.busy });
      sendJson(res, 200, out);
    } catch (e) {
      logger.warn('optimize', '还原失败', { dir, dirName, err: e.message });
      sendJson(res, 400, { error: e.message });
    }
  });
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
  if (url.pathname === '/api/optimize/fix' && req.method === 'POST') {
    return handleFix(req, res);
  }
  if (url.pathname === '/api/optimize/fix-stream' && req.method === 'GET') {
    return handleFixStream(res, url);
  }
  if (url.pathname === '/api/optimize/backups' && req.method === 'GET') {
    return handleBackups(res, url);
  }
  if (url.pathname === '/api/optimize/rollback' && req.method === 'POST') {
    return handleRollback(req, res);
  }
  return sendJson(res, 404, { error: 'not found' });
}
