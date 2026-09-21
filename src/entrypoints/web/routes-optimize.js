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
  startCheckup, getCheckupJob, attachCheckupJob, cancelCheckupJob,
  startFix, getFixJob, attachFixJob, cancelFixJob, runRollback,
  getBusyState, healDeadBusy, getFixPlan,
} from './optimize-ops.js';
import { listBackups } from '../../features/project-optimize/backup.js';
import { getIgnores, addIgnore, removeIgnore } from '../../features/project-checkup/ignore.js';

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

// ==== GET /api/optimize/fix-plan?dir=xxx ====
// 修复计划：每条 issue 一项，带动作与风险标签，供前端做细粒度勾选。
// 没体检过时回空计划而不是 404 —— 前端据此渲染空态，404 会被它当成请求失败
function handleFixPlan(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  sendJson(res, 200, getFixPlan(dir));
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

// ==== GET /api/optimize/ignores?dir=xxx ====
// 「已豁免 N 项」面板的数据源
function handleIgnoreList(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  sendJson(res, 200, { items: getIgnores(dir) });
}

// ==== POST /api/optimize/ignore {dir, dim, code, file, message, note} ====
// 记一条「这不是问题」。note 必填：空备注等于没记录，下次没人知道为什么豁免——
// 前端必填只是第一道，这里是第二道
function handleIgnoreAdd(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    const dim = str(data.dim);
    const code = str(data.code);
    const file = str(data.file);
    const note = str(data.note).trim();
    if (!dir || !dim || !code || !file) {
      return sendJson(res, 400, { error: '缺少 dir / dim / code / file 参数' });
    }
    if (!note) return sendJson(res, 400, { error: '请填写「为什么这不是问题」' });

    try {
      const count = addIgnore(dir, { dim, code, file, message: str(data.message), note });
      return sendJson(res, 200, { ok: true, count });
    } catch (e) {
      logger.warn('optimize', '记录豁免失败', { dir, dim, code, err: e.message });
      return sendJson(res, 400, { error: e.message });
    }
  });
}

// ==== POST /api/optimize/ignore/remove {dir, dim, code, file} ====
// 撤销一条豁免。用 POST 子路径而非 DELETE + body：本文件既有路由全是 GET/POST，
// 且 DELETE 带 body 在部分中间层会被丢弃。与 /api/optimize/checkup/cancel 同一范式
function handleIgnoreRemove(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    const dim = str(data.dim);
    const code = str(data.code);
    const file = str(data.file);
    if (!dir || !dim || !code || !file) {
      return sendJson(res, 400, { error: '缺少 dir / dim / code / file 参数' });
    }
    try {
      const count = removeIgnore(dir, { dim, code, file });
      return sendJson(res, 200, { ok: true, count });
    } catch (e) {
      logger.warn('optimize', '撤销豁免失败', { dir, dim, code, err: e.message });
      return sendJson(res, 400, { error: e.message });
    }
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

// ==== POST /api/optimize/checkup/cancel {checkupId} ====
// 只发停止信号并立即收尾。已完成的维度保留，未完成的标 cancelled
function handleCheckupCancel(req, res) {
  return withJsonBody(req, res, async (data) => {
    const checkupId = str(data.checkupId);
    if (!checkupId) return sendJson(res, 400, { error: '缺少 checkupId 参数' });
    // 找不到一律 404 而不是静默 200：前端据此提示「任务已结束」，
    // 回 200 会让用户以为点停止生效了、然后继续等一个不会来的停止事件
    if (!cancelCheckupJob(checkupId)) return sendJson(res, 404, { error: '体检任务不存在或已结束' });
    sendJson(res, 200, { ok: true });
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
    // items 是计划项 id 数组（`<dim>#<index>`）。fail-closed：只认字符串数组，
    // 脏形状一律当「没传」，退回整维度老行为而不是把脏数据透传进编排层。
    // 真实的 file / line 由 ops 层从落盘报告里取，前端传的下标只是**定位**——
    // 这是安全边界，见 fix-plan.logic.js 的 resolveSelection
    const items = Array.isArray(data.items) ? data.items.map(str).filter(Boolean) : null;
    // risk 不做白名单校验：ops 层的 risksFor 已经 fail-closed，
    // 在这里再列一份白名单等于把同一份词表写两遍（必然漂移）。
    // 默认改成 'all'：风险不再是按钮档位而由勾选决定，档位过滤会和勾选语义打架
    // （用户勾了高风险项却被静默跳过，界面还说修复完成）
    const risk = str(data.risk) || (items ? 'all' : 'low');
    const reportAt = str(data.reportAt);

    try {
      const out = await startFix(dir, { dimensions, items, risk, force: !!data.force, reportAt });
      if (out.busy) return sendJson(res, 409, { error: BUSY_MSG, busy: out.busy });
      // 计划过期：前端据此重拉计划再让用户确认。用 409 而非 400——
      // 这不是请求格式错，是并发导致的状态冲突，前端要走重试路径而不是报错路径
      if (out.stalePlan) {
        return sendJson(res, 409, { error: '体检报告已更新，请重新加载修复计划', stalePlan: true });
      }
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
  if (url.pathname === '/api/optimize/fix-plan' && req.method === 'GET') {
    return handleFixPlan(res, url);
  }
  if (url.pathname === '/api/optimize/busy/heal' && req.method === 'POST') {
    return handleBusyHeal(req, res);
  }
  if (url.pathname === '/api/optimize/ignores' && req.method === 'GET') {
    return handleIgnoreList(res, url);
  }
  // 精确路由排在前：本文件用的是 pathname === 精确比较，理论上不会遮蔽，
  // 但既有代码已为 checkup/cancel 留下同样的顺序约定，保持一致以免下一个人改成前缀匹配时踩坑
  if (url.pathname === '/api/optimize/ignore/remove' && req.method === 'POST') {
    return handleIgnoreRemove(req, res);
  }
  if (url.pathname === '/api/optimize/ignore' && req.method === 'POST') {
    return handleIgnoreAdd(req, res);
  }
  if (url.pathname === '/api/optimize/checkup' && req.method === 'POST') {
    return handleCheckup(req, res);
  }
  // 精确路由排在 checkup-stream 之前：两者都以 /api/optimize/checkup 开头，
  // 顺序反了会被前者遮蔽（server.js 的 findShadowedRoutes 只管顶层路由表，管不到这里）
  if (url.pathname === '/api/optimize/checkup/cancel' && req.method === 'POST') {
    return handleCheckupCancel(req, res);
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
