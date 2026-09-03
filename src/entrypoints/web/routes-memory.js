/**
 * 记忆库 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-requirements.js）。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { readBank, updateBank, patchMemory, removeMemory } from '../../store/memory-bank.js';
import { getMemoryBankSettings, setMemoryBankSettings } from '../../store/settings.js';
import { selectForInjection, CATEGORY_LABEL } from '../../features/memory-bank/render.js';
import { runOnce, writeRenders } from '../../features/memory-bank/index.js';
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

// ==== GET /api/memory/sessions ====
function handleSessions(res) {
  try {
    const bank = readBank();
    const settings = getMemoryBankSettings();
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000; // 近 30 天
    const sessions = bank.sessions
      .filter((s) => !s.mtime || s.mtime >= cutoff) // 过滤超过 30 天的
      .map((s) => {
        let status = s.status; // 优先使用 bank 里的 status（如 analyzing）
        if (status !== 'analyzing') {
          if (!s.analyzedAt || s.analyzedAt === 0) {
            status = 'pending';
          } else if (s.mtime > s.analyzedAt) {
            status = 'outdated';
          } else {
            status = 'analyzed';
          }
        }
        return { ...s, status };
      });
    const unanalyzedPaths = scanForUnanalyzedSessions(bank); // 内部已过滤 30 天
    const analyzedCount = sessions.filter((s) => s.status === 'analyzed').length;
    sendJson(res, 200, {
      ok: true,
      sessions,
      unanalyzedPaths,
      totalSessions: sessions.length,
      analyzedCount,
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
  sendJson(res, 202, { ok: true });
  runOnce({ cwd: process.cwd() }).catch((e) =>
    logger.error('memory-routes', '手动提炼异常', { err: e?.message || String(e) }));
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
  if (pathname === '/api/memory/sessions' && method === 'GET') return handleSessions(res);
  if (pathname === '/api/memory/settings' && method === 'POST') return handleSettings(req, res);
  if (pathname === '/api/memory/list' && method === 'GET') return handleList(res);
  if (pathname === '/api/memory/confirm' && method === 'POST') return handleConfirm(req, res);
  if (pathname === '/api/memory/reject' && method === 'POST') return handleReject(req, res);
  if (pathname === '/api/memory/ack' && method === 'POST') return handleAck(req, res);
  if (pathname === '/api/memory/remove' && method === 'POST') return handleRemove(req, res);
  if (pathname === '/api/memory/extract' && method === 'POST') return handleExtract(req, res);
  if (pathname === '/api/memory/export' && method === 'GET') return handleExport(url, res);
  return sendJson(res, 404, { error: 'not found' });
}
