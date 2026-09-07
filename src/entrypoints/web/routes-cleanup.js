/**
 * 会话清理 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 设计见 docs/superpowers/specs/2026-09-04-session-cleanup-design.md
 *
 * 三个端点全部按 ?cwd= 定位对应 project 的历史目录（与 /api/history 一致），
 * 空 cwd = 服务自身目录。删除是**物理删除**（不可恢复），故 execute 要求 confirmed=true，
 * 并排除 active-runs 中正在运行的 session（安全兜底）。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import {
  getHistoryDir,
  countHistorySessions,
  previewCleanup,
  deleteHistorySessions,
} from '../../store/history.js';
import { listActiveRuns } from '../../store/active-runs.js';
import { appendEvent } from '../../store/event-log.js';

/** 从 query / body 归一出清理时间窗参数（range 优先，其次自定义日期） */
function pickWindow(src) {
  const win = {};
  if (src.range !== undefined && src.range !== null && src.range !== '') {
    win.range = Number(src.range);
  }
  const fromDate = str(src.fromDate);
  const toDate = str(src.toDate);
  if (fromDate) win.fromDate = fromDate;
  if (toDate) win.toDate = toDate;
  return win;
}

/** 正在运行的 run 对应的 session_id 集合——这些会话可能正被写入，清理时必须跳过 */
function runningSessionIds() {
  return listActiveRuns()
    .map((e) => e.session_id)
    .filter((id) => typeof id === 'string' && id);
}

// ==== GET /api/cleanup/stats?cwd= ====
async function handleStats(url, res) {
  const cwd = str(url.searchParams.get('cwd'));
  try {
    const totalCount = await countHistorySessions(cwd);
    sendJson(res, 200, { cwd, totalCount, historyDir: getHistoryDir(cwd) });
  } catch (e) {
    logger.error('cleanup-routes', 'stats 异常', { err: e?.message || String(e) });
    sendJson(res, 200, { error: '目录不可用', cwd, totalCount: 0 });
  }
}

// ==== GET /api/cleanup/preview?cwd=&range= | &fromDate=&toDate= ====
async function handlePreview(url, res) {
  const cwd = str(url.searchParams.get('cwd'));
  const win = pickWindow({
    range: url.searchParams.get('range'),
    fromDate: url.searchParams.get('fromDate'),
    toDate: url.searchParams.get('toDate'),
  });
  try {
    const r = await previewCleanup(cwd, win);
    sendJson(res, 200, r);
  } catch (e) {
    logger.error('cleanup-routes', 'preview 异常', { err: e?.message || String(e) });
    sendJson(res, 500, { error: e?.message || String(e) });
  }
}

// ==== POST /api/cleanup/execute {cwd?, range? | fromDate?,toDate?, confirmed} ====
async function handleExecute(req, res) {
  return withJsonBody(req, res, async (data) => {
    if (data.confirmed !== true) return sendJson(res, 400, { error: '未确认（confirmed 必须为 true）' });
    const cwd = str(data.cwd);
    const win = pickWindow(data);
    // 无有效时间窗直接拒绝，避免「空条件误删全部」的歧义（parseCleanupWindow 内部也 fail-closed）
    if (win.range === undefined && !win.fromDate && !win.toDate) {
      return sendJson(res, 400, { error: '未提供时间范围' });
    }
    try {
      const protectedIds = runningSessionIds();
      const r = await deleteHistorySessions(cwd, { ...win, protectedIds });
      const remainingCount = await countHistorySessions(cwd);
      // 审计：物理删除记入 event-log，便于事后追溯
      appendEvent({
        type: 'session-cleanup',
        cwd,
        window: win,
        deletedCount: r.deletedCount,
        skippedCount: r.skippedCount,
        freedBytes: r.freedBytes,
        remainingCount,
      });
      sendJson(res, 200, {
        deletedCount: r.deletedCount,
        skippedCount: r.skippedCount,
        freedBytes: r.freedBytes,
        remainingCount,
      });
    } catch (e) {
      logger.error('cleanup-routes', 'execute 异常', { err: e?.message || String(e) });
      sendJson(res, 500, { error: e?.message || String(e) });
    }
  });
}

/** 清理路由单入口：按 pathname + method 分发 */
export function handleCleanupRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/api/cleanup/stats' && method === 'GET') return handleStats(url, res);
  if (pathname === '/api/cleanup/preview' && method === 'GET') return handlePreview(url, res);
  if (pathname === '/api/cleanup/execute' && method === 'POST') return handleExecute(req, res);
  return sendJson(res, 404, { error: 'not found' });
}
