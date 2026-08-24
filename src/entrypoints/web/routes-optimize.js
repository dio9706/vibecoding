/**
 * 项目优化 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 阶段一只有两个只读接口：取上次报告、跑一次静态体检。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { runStaticCheckup } from '../../features/project-checkup/index.js';
import { getProjectRecord, saveCheckup } from '../../store/optimize.js';

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

// ==== POST /api/optimize/checkup {dir} ====
function handleCheckup(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });

    let report;
    try {
      report = runStaticCheckup(dir);
    } catch (e) {
      logger.warn('optimize', '体检失败', { dir, err: e.message });
      return sendJson(res, 400, { error: e.message });
    }

    saveCheckup(dir, report);
    sendJson(res, 200, { report });
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
  return sendJson(res, 404, { error: 'not found' });
}
