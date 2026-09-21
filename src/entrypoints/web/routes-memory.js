/**
 * 记忆库 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-requirements.js）。
 */
import fs from 'node:fs';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { readBank, updateBank, patchMemory, removeMemory } from '../../store/memory-bank.js';
import { getMemoryBankSettings, setMemoryBankSettings } from '../../store/settings.js';
import { selectForInjection, CATEGORY_LABEL } from '../../features/memory-bank/render.js';
import { runOnce, writeRenders, stopOnce, isRunning } from '../../features/memory-bank/index.js';
import { scanForUnanalyzedSessions } from '../../features/memory-bank/scan-sessions.js';

const CATEGORIES = Object.keys(CATEGORY_LABEL);

function budgetInfo(items, settings, now) {
  const { included, truncated } = selectForInjection(items, {
    scope: 'global', now, maxItems: settings.maxItems, maxChars: settings.maxChars,
  });
  return { used: included.length, total: settings.maxItems, truncated };
}

// ==== GET /api/memory/list ====
function handleList(res) {
  const now = Date.now();
  const bank = readBank();
  const settings = getMemoryBankSettings();
  sendJson(res, 200, {
    items: bank.memories,
    unackedCount: bank.memories.filter((i) => !i.acked).length,
    conflictCount: bank.memories.filter((i) => i.status === 'conflict').length,
    budget: budgetInfo(bank.memories, settings, now),
    lastExtractAt: bank.lastExtractAt,
    enabled: settings.enabled,
  });
}

// ==== POST /api/memory/confirm {id, statement?, category?, scope?, inject?} ====
function handleConfirm(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    const patch = { status: 'active', promotedBy: 'manual', acked: true, updatedAt: Date.now() };
    if (data.statement !== undefined) {
      const s = str(data.statement).trim();
      if (!s) return sendJson(res, 400, { error: 'statement 不能为空' });
      patch.statement = s.slice(0, 200);
    }
    if (data.category !== undefined) {
      const c = str(data.category);
      if (!CATEGORIES.includes(c)) return sendJson(res, 400, { error: '未知 category' });
      patch.category = c;
    }
    if (data.scope !== undefined) {
      const sc = str(data.scope);
      if (sc !== 'global' && sc !== 'project') return sendJson(res, 400, { error: '未知 scope' });
      patch.scope = sc;
      if (sc === 'global') patch.projectDir = '';
    }
    if (data.inject !== undefined) patch.inject = data.inject === true;
    if (!readBank().memories.some((m) => m.id === id)) return sendJson(res, 404, { error: '条目不存在' });
    patchMemory(id, patch);
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/memory/reject {id} ====
function handleReject(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    if (!readBank().memories.some((m) => m.id === id)) return sendJson(res, 404, { error: '条目不存在' });
    removeMemory(id);
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/memory/ack {id?, all?} ====
function handleAck(req, res) {
  return withJsonBody(req, res, (data) => {
    if (data.all === true) {
      updateBank((bank) => ({ ...bank, memories: bank.memories.map((m) => ({ ...m, acked: true })) }));
      return sendJson(res, 200, { ok: true });
    }
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 或 all 必须提供其一' });
    patchMemory(id, { acked: true });
    sendJson(res, 200, { ok: true });
  });
}

/**
 * 纯函数。算一条 session 在面板上的展示状态。
 *
 * `missing` 这一档是事故换来的：Phase 1 分析失败会把记录重置为 `pending` 并把 analyzedAt 留在 0，
 * 等待下轮重扫。可一旦源 `.jsonl` 被删（Claude Code 会清理旧会话），
 * `scanForUnanalyzedSessions` 从此再也扫不到这个路径 —— 重试永远不会发生。
 * 实测生产库 91 条 pending 里有 74 条是这种「僵尸」。继续显示「待分析」是在让用户
 * 等一个不会到来的结果，必须如实标注。
 *
 * 反过来，**已分析成功的记录不看文件在不在**：findings 早已入库、仍参与 Phase 2 合成，
 * 源文件被删不影响它，标成 missing 只会让人以为数据丢了。
 *
 * @param {object} s bank 里的 session 记录
 * @param {{running?:boolean, exists?:boolean}} [ctx] running=当前是否有提炼在跑；exists=源文件是否还在
 * @returns {'analyzing'|'pending'|'missing'|'outdated'|'analyzed'}
 */
export function sessionDisplayStatus(s, ctx) {
  const { running = false, exists = true } = ctx || {};
  // bank 里是 analyzing 但当前没有提炼在跑（如重启后残留），降级为正常计算
  if (s?.status === 'analyzing' && running) return 'analyzing';
  const analyzedAt = Number(s?.analyzedAt) || 0;
  if (analyzedAt === 0) return exists ? 'pending' : 'missing';
  if (Number(s?.mtime) > analyzedAt) return 'outdated';
  return 'analyzed';
}

/**
 * 纯函数。从扫描结果里剔除已在 bank 登记过的路径。
 *
 * 前端把这个数组当「扫描到但**尚未登记**的路径」渲染（见 memory-view.js 的 makeUnanalyzedRow，
 * 它硬写一个「待分析」badge）。此前后端返回的是本轮全部待分析路径、混着已登记的，
 * 于是同一个会话在列表里出现两行：一行显示它真实的状态，一行永远写着「待分析」。
 * 实测 28 条扫描结果里有 22 条是这种重影，`totalSessions` 也跟着重复计数。
 *
 * @param {Array<{path:string}>} scanned scanForUnanalyzedSessions 的产出
 * @param {Array<{path:string}>} sessions bank.sessions
 */
export function pickUnregisteredPaths(scanned, sessions) {
  const known = new Set((sessions || []).map((s) => s?.path));
  return (scanned || []).filter((x) => x && !known.has(x.path));
}

/** 源文件是否还在。stat 失败（已删 / 无权限）一律当不在 */
function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 近 30 天窗口，与 scan-sessions 的扫描范围对齐 */
const PANEL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** scope=analyzed 的分页默认值与上限 */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/**
 * 纯函数。把 bank.sessions 归类成「待办」与「已分析」两组，各按 mtime 倒序（最近的在前）。
 *
 * `missing`（源文件已删）两组都不进：它既不是待办（重试永远不会发生），也没有 findings 可看，
 * 留在列表里只会让人以为还有活要干。
 *
 * `exists` 由调用方注入而不是在这里 stat，是为了让本函数可测；同时**只对未分析成功的会话探测** ——
 * 已分析的 findings 早已入库，文件在不在都不改变展示，对 1500+ 条全量 stat 纯属浪费。
 *
 * @param {Array} sessions bank.sessions
 * @param {{running:boolean, cutoff:number, exists:(path:string)=>boolean}} ctx
 * @returns {{pending:Array, analyzed:Array}}
 */
export function groupSessionsForPanel(sessions, ctx) {
  const { running = false, cutoff = 0, exists = () => true } = ctx || {};
  const pending = [];
  const analyzed = [];

  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s) continue;
    if (s.mtime && s.mtime < cutoff) continue;
    const analyzedOk = Number(s.analyzedAt) > 0;
    const status = sessionDisplayStatus(s, { running, exists: analyzedOk ? true : exists(s.path) });
    if (status === 'missing') continue;
    (status === 'analyzed' ? analyzed : pending).push({ ...s, status });
  }

  const byMtimeDesc = (a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0);
  return { pending: pending.sort(byMtimeDesc), analyzed: analyzed.sort(byMtimeDesc) };
}

// ==== GET /api/memory/sessions[?scope=analyzed&offset=&limit=] ====
//
// 默认（无 scope）只回**待办组** + 已分析的计数。面板把「已分析」做成默认收起、点开才拉的分组：
// 实测生产库 1219 条已分析会话连着 findings 有 2.7MB，每次刷新都整份传是页面卡顿的根源。
// scope=analyzed 才按 offset/limit 分页取已分析的那一组。
function handleSessions(res, url) {
  try {
    const bank = readBank();
    const running = isRunning();
    const cutoff = Date.now() - PANEL_WINDOW_MS;
    const { pending, analyzed } = groupSessionsForPanel(bank.sessions, {
      running,
      cutoff,
      exists: fileExists,
    });

    if (str(url?.searchParams.get('scope')) === 'analyzed') {
      const rawOffset = Number(url.searchParams.get('offset'));
      const rawLimit = Number(url.searchParams.get('limit'));
      const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), PAGE_MAX)
        : PAGE_DEFAULT;
      return sendJson(res, 200, {
        ok: true,
        scope: 'analyzed',
        sessions: analyzed.slice(offset, offset + limit),
        total: analyzed.length,
        offset,
        limit,
        hasMore: offset + limit < analyzed.length,
      });
    }

    const settings = getMemoryBankSettings();
    // 内部已过滤 30 天；再剔除已登记的，避免同一会话渲染两行
    const unanalyzedPaths = pickUnregisteredPaths(scanForUnanalyzedSessions(bank), bank.sessions);
    sendJson(res, 200, {
      ok: true,
      sessions: pending,
      unanalyzedPaths,
      totalSessions: pending.length + unanalyzedPaths.length,
      analyzedCount: analyzed.length,
      // v2：记忆条目与设置状态一并返回，前端单次请求获取完整面板数据
      memories: bank.memories || [],
      enabled: settings.enabled,
      lastExtractAt: bank.lastExtractAt,
    });
  } catch (e) {
    logger.error('memory-routes', 'handleSessions 异常', { err: e?.message || String(e) });
    sendJson(res, 500, { ok: false, error: e?.message || String(e) });
  }
}

// ==== POST /api/memory/settings {enabled?, ...} ====
function handleSettings(req, res) {
  return withJsonBody(req, res, (data) => {
    // 只接受 DEFAULTS.memoryBank 中已有的字段，避免注入未知键
    const patch = {};
    if (typeof data.enabled === 'boolean') patch.enabled = data.enabled;
    if (typeof data.nightStart === 'string') patch.nightStart = data.nightStart;
    if (typeof data.nightEnd === 'string') patch.nightEnd = data.nightEnd;
    if (typeof data.minIntervalHours === 'number') patch.minIntervalHours = data.minIntervalHours;
    if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, error: '未提供可更新字段' });
    const updated = setMemoryBankSettings(patch);
    sendJson(res, 200, { ok: true, settings: updated });
  });
}

// ==== POST /api/memory/remove {id} ====
async function handleRemove(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' });
    try {
      removeMemory(id);
      const bank = readBank();
      const settings = getMemoryBankSettings();
      await writeRenders(bank.memories || [], { now: Date.now(), settings, projectDirs: [] });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      logger.error('memory-routes', '删除记忆条目异常', { id, err: e?.message || String(e) });
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
  });
}

/** POST /api/memory/extract：手动提炼。202 立即返回，前端轮询 list（对齐 handleBitable 的长任务范式） */
function handleExtract(req, res) {
  sendJson(res, 202, { ok: true, running: isRunning() });
  if (!isRunning()) {
    runOnce({ cwd: process.cwd() }).catch((e) =>
      logger.error('memory-routes', '手动提炼异常', { err: e?.message || String(e) }));
  }
}

/** POST /api/memory/stop：请求暂停当前提炼（处理完当前会话后停止） */
function handleStop(req, res) {
  if (!isRunning()) return sendJson(res, 200, { ok: true, stopped: false, reason: 'not-running' });
  stopOnce();
  sendJson(res, 200, { ok: true, stopped: true });
}

// ==== GET /api/memory/export?format=json|md ====
function handleExport(url, res) {
  const bank = readBank();
  const byCategory = {};
  for (const it of bank.memories) byCategory[it.category] = (byCategory[it.category] || 0) + 1;
  const payload = {
    schema: 'memory-bank/v2',
    exportedAt: new Date().toISOString(),
    stats: {
      total: bank.memories.length,
      active: bank.memories.filter((i) => i.status === 'active').length,
      byCategory,
    },
    // 全量：含 dormant / candidate / 仅记录组 / 证据链 —— 数字分身要用
    items: bank.memories,
  };
  if (str(url.searchParams.get('format')) === 'md') {
    const lines = ['# 我的开发者档案', '', `导出时间：${payload.exportedAt}`, ''];
    for (const cat of CATEGORIES) {
      const group = bank.memories.filter((i) => i.category === cat);
      if (!group.length) continue;
      lines.push(`## ${CATEGORY_LABEL[cat]}`, '');
      for (const it of group) lines.push(`- ${it.statement}  \`${it.status}\` · 证据 ${it.evidenceCount}`);
      lines.push('');
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(lines.join('\n'));
  }
  sendJson(res, 200, payload);
}

/** 记忆库路由单入口：按 pathname + method 分发 */
export function handleMemoryRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/api/memory/sessions' && method === 'GET') return handleSessions(res, url);
  if (pathname === '/api/memory/settings' && method === 'POST') return handleSettings(req, res);
  if (pathname === '/api/memory/list' && method === 'GET') return handleList(res);
  if (pathname === '/api/memory/confirm' && method === 'POST') return handleConfirm(req, res);
  if (pathname === '/api/memory/reject' && method === 'POST') return handleReject(req, res);
  if (pathname === '/api/memory/ack' && method === 'POST') return handleAck(req, res);
  if (pathname === '/api/memory/remove' && method === 'POST') return handleRemove(req, res);
  if (pathname === '/api/memory/extract' && method === 'POST') return handleExtract(req, res);
  if (pathname === '/api/memory/stop' && method === 'POST') return handleStop(req, res);
  if (pathname === '/api/memory/export' && method === 'GET') return handleExport(url, res);
  return sendJson(res, 404, { error: 'not found' });
}
