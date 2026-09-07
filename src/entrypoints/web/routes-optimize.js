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
  startFix, getFixJob, attachFixJob, cancelFixJob, runRollback,
  getBusyState, healDeadBusy,
} from './optimize-ops.js';
import { listBackups } from '../../features/project-optimize/backup.js';

const BUSY_MSG = '该项目正在体检或优化中，请稍候';

/**
 * 心跳间隔。
 *
 * 为什么必须有：体检的最后一段是整体评估，它跑一次只读 agent、实测 6.3 分钟，
 * 期间 SSE 通道**一个字节都不发**。中间层（桌面端 webview、反向代理、某些 NAT）
 * 会把长时间静默的连接当死连接掐掉，而服务端此时还以为订阅者在，
 * `done` 事件就发进了一条已断的管子——用户看到的是永远转圈。
 *
 * 20s 远小于常见的 60s 空闲阈值；注释行（以 `:` 开头）不会触发任何 EventSource 事件，
 * 对前端完全透明。
 */
const SSE_HEARTBEAT_MS = 20_000;

/** 开一条 SSE 通道（含心跳保活） */
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // 连接已断，靠下面的 close 清理；这里不能抛（会变成未捕获异常打挂进程）
      clearInterval(timer);
    }
  }, SSE_HEARTBEAT_MS);
  // 必须清：不清的话每条断开的 SSE 都留下一个永久定时器，
  // 长跑进程里会攒成泄漏
  res.on('close', () => clearInterval(timer));
}

// ==== GET /api/optimize/report?dir=xxx ====
function handleReport(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  const rec = getProjectRecord(dir);
  sendJson(res, 200, {
    report: rec?.lastCheckup || null,
    history: rec?.history || [],
    // busy 带 jobId 与 alive，前端据此决定「重连 SSE」还是「请求解锁」。
    // 没有它，用户切走再回来就只能看到 loading 消失、点体检被 409 挡住
    busy: getBusyState(dir),
  });
}

// ==== POST /api/optimize/busy/heal {dir} ====
// 释放已死的占用记录。ops 层会校验「任务不在本进程注册表里」才真放，
// 所以这个端点无法打断正在跑的任务
function handleBusyHeal(req, res) {
  withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
    return sendJson(res, 200, healDeadBusy(dir));
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

// ==== POST /api/optimize/fix {dir, dimensions?, risk?, force?} ====
// 四种正常返回：{jobId} 开跑 / {needsConfirm} 工作区脏 / {nothing,blocked} 无可修项 / 409 被占用
function handleFix(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
    // fail-closed：只认字符串数组。传成 'rules' 这种裸字符串时当作没勾任何维度，
    // 而不是把脏形状透传进编排层（它会被原样写进备份 manifest）
    const dimensions = Array.isArray(data.dimensions) ? data.dimensions.map(str).filter(Boolean) : [];
    // risk 不做白名单校验：ops 层的 risksFor 已经 fail-closed 到只做低风险，
    // 在这里再列一份白名单等于把同一份词表写两遍（必然漂移）
    const risk = str(data.risk) || 'low';

    try {
      const out = await startFix(dir, { dimensions, risk, force: !!data.force });
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

// ==== POST /api/optimize/fix/cancel {jobId} ====
// 只发停止信号，不回滚。已落盘的改动保留，用户可另行走 rollback
function handleFixCancel(req, res) {
  return withJsonBody(req, res, async (data) => {
    const jobId = str(data.jobId);
    if (!jobId) return sendJson(res, 400, { error: '缺少 jobId 参数' });
    // 找不到 job 一律回 404 而不是静默 200：前端据此提示「任务已结束」，
    // 回 200 会让用户以为点停止生效了、然后继续等一个不会来的停止事件
    if (!cancelFixJob(jobId)) return sendJson(res, 404, { error: '优化任务不存在或已结束' });
    sendJson(res, 200, { ok: true });
  });
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
  if (url.pathname === '/api/optimize/busy/heal' && req.method === 'POST') {
    return handleBusyHeal(req, res);
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
  if (url.pathname === '/api/optimize/fix/cancel' && req.method === 'POST') {
    return handleFixCancel(req, res);
  }
  if (url.pathname === '/api/optimize/backups' && req.method === 'GET') {
    return handleBackups(res, url);
  }
  if (url.pathname === '/api/optimize/rollback' && req.method === 'POST') {
    return handleRollback(req, res);
  }
  return sendJson(res, 404, { error: 'not found' });
}
