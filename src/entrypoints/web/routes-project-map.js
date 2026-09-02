/**
 * 项目地图 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-optimize.js）。
 *
 * 本轮只做三件套：生成（含 SSE 进度）/ 查询 / 语义搜模块。
 * 「模块注入对话」「自动重扫」本轮不做——项目现状没有 conv↔project 映射，见任务说明。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import {
  startMapGen, getMapGenJob, attachMapGenJob, getProjectMap, searchModules,
} from './project-map-ops.js';

const BUSY_MSG = '该项目正在生成地图，请稍候';

/** 开一条 SSE 通道（照抄 routes-optimize.js） */
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

// ==== POST /api/project-map/generate {dir} ====
function handleGenerate(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });

    try {
      const out = startMapGen(dir);
      // 串行闸挡下用 409：前端要能区分「被挡下」和「起跑失败」
      if (out.busy) return sendJson(res, 409, { error: BUSY_MSG, busy: out.busy });
      sendJson(res, 202, out);
    } catch (e) {
      logger.warn('project-map', '生成启动失败', { dir, err: e.message });
      sendJson(res, 400, { error: e.message });
    }
  });
}

// ==== GET /api/project-map/generate-stream?jobId= (SSE) ====
function handleGenerateStream(res, url) {
  const job = getMapGenJob(str(url.searchParams.get('jobId')));
  // 任务不在了就回 404 而不是开一条空 SSE：EventSource 对非 200 会置 CLOSED 不再重连
  if (!job) return sendJson(res, 404, { error: '生成任务不存在或已过期' });

  openStream(res);
  attachMapGenJob(job, res);
}

// ==== GET /api/project-map/get?dir= ====
async function handleGet(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });

  try {
    const map = await getProjectMap(dir);
    if (!map) return sendJson(res, 404, { error: '地图不存在' });
    sendJson(res, 200, map);
  } catch (e) {
    logger.warn('project-map', '读取地图失败', { dir, err: e.message });
    sendJson(res, 500, { error: e.message });
  }
}

// ==== GET /api/project-map/search-modules?dir=&query= ====
async function handleSearchModules(res, url) {
  const dir = str(url.searchParams.get('dir'));
  const query = str(url.searchParams.get('query'));
  if (!dir || !query) return sendJson(res, 400, { error: '缺少 dir 或 query 参数' });

  try {
    const matches = await searchModules(dir, query);
    sendJson(res, 200, { matches });
  } catch (e) {
    // 地图不存在（带 notFound 标记）→ 404；文件损坏等其他异常 → 500（对齐 handleGet）
    logger.warn('project-map', '模块搜索失败', { dir, query, err: e.message });
    sendJson(res, e.notFound ? 404 : 500, { error: e.message });
  }
}

/** 项目地图路由单入口：按 pathname + method 分发 */
export function handleProjectMapRoutes(req, res, url) {
  if (url.pathname === '/api/project-map/generate' && req.method === 'POST') {
    return handleGenerate(req, res);
  }
  if (url.pathname === '/api/project-map/generate-stream' && req.method === 'GET') {
    return handleGenerateStream(res, url);
  }
  if (url.pathname === '/api/project-map/get' && req.method === 'GET') {
    return handleGet(res, url);
  }
  if (url.pathname === '/api/project-map/search-modules' && req.method === 'GET') {
    return handleSearchModules(res, url);
  }
  return sendJson(res, 404, { error: 'not found' });
}
