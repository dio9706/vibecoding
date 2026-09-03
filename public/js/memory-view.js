/**
 * 记忆库面板 v2：已记忆条目 + 会话分析列表。
 * 渲染一律 createElement + textContent（内容来自 LLM，绝不裸写 innerHTML）。
 *
 * 数据来源：GET /api/memory/sessions（单次请求返回 memories/sessions/enabled）
 * 操作接口：
 *   POST /api/memory/settings {enabled}  — 开关闲时提炼
 *   POST /api/memory/extract             — 立即提炼
 *   POST /api/memory/remove  {id}        — 移除记忆条目
 */
import { $ } from './util.js';

// ── 模块级状态 ──────────────────────────────────────────────────────────────
let _memories = [];          // 已提炼的记忆条目（bank.memories）
let _sessions = [];          // 已登记的会话（带 status 字段）
let _unanalyzedPaths = [];   // 扫描到但尚未登记的路径
let _enabled = false;        // settings.enabled（闲时提炼开关）
let _lastExtractAt = 0;      // 上次提炼时间戳
let _extracting = false;     // 立即提炼进行中标记
let _expandedIds = new Set();// 展开 findings 的 session id 集合

const CATEGORY_LABEL = {
  'code-style': '代码风格',
  collaboration: '协作习惯',
  writing: '写作习惯',
  dialogue: '对话风格',
  'tech-pref': '技术偏好',
};

const STATUS_LABEL = {
  analyzed: '已分析',
  pending: '待分析',
  outdated: '已过期',
};

const FINDING_TYPE_LABEL = {
  bug: 'BUG',
  solution: '解法',
  pattern: '模式',
  preference: '偏好',
};

// ── 通用 fetch 封装 ──────────────────────────────────────────────────────────
async function api(path, body) {
  const opts = body !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || '请求失败');
  return d;
}

// ── 数据刷新 ────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const d = await api('/api/memory/sessions');
    _memories = Array.isArray(d.memories) ? d.memories : [];
    _sessions = Array.isArray(d.sessions) ? d.sessions : [];
    _unanalyzedPaths = Array.isArray(d.unanalyzedPaths) ? d.unanalyzedPaths : [];
    _enabled = !!d.enabled;
    _lastExtractAt = d.lastExtractAt || 0;
  } catch {
    // 失败沿用上次渲染，不清空面板
  }
  renderToggle();
  render();
}

// ── 闲时提炼开关（注入 .mem-toolbar） ───────────────────────────────────────
function renderToggle() {
  const toolbar = document.querySelector('.mem-toolbar');
  if (!toolbar) return;

  // 复用已注入的开关节点，避免每次刷新重建
  let wrap = toolbar.querySelector('.mem-toggle-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'mem-toggle-wrap';

    const lbl = document.createElement('span');
    lbl.className = 'mem-toggle-label';
    lbl.textContent = '闲时提炼';

    const onBtn = document.createElement('button');
    onBtn.className = 'mem-toggle-opt';
    onBtn.dataset.val = 'on';
    onBtn.textContent = '开';
    onBtn.title = '在空闲时段自动分析会话、提炼记忆';
    onBtn.onclick = () => toggleEnabled(true);

    const offBtn = document.createElement('button');
    offBtn.className = 'mem-toggle-opt';
    offBtn.dataset.val = 'off';
    offBtn.textContent = '关';
    offBtn.title = '关闭自动提炼';
    offBtn.onclick = () => toggleEnabled(false);

    wrap.appendChild(lbl);
    wrap.appendChild(onBtn);
    wrap.appendChild(offBtn);

    // 插到 toolbar 最前面
    toolbar.insertBefore(wrap, toolbar.firstChild);
  }

  // 更新激活态（不重建节点）
  wrap.querySelectorAll('.mem-toggle-opt').forEach((b) => {
    const isActive = (b.dataset.val === 'on') === _enabled;
    b.classList.toggle('active', isActive);
  });
}

async function toggleEnabled(val) {
  try {
    await api('/api/memory/settings', { enabled: val });
    _enabled = val;
    renderToggle();
    window.toast?.success(val ? '闲时提炼已开启' : '闲时提炼已关闭');
  } catch (e) {
    window.toast?.error(e.message);
  }
}

// ── 主体渲染（memories + sessions） ─────────────────────────────────────────
function render() {
  const el = $('#memBody');
  if (!el) return;

  const frag = document.createDocumentFragment();

  // ---- 已记忆区段 ----
  const memCount = _memories.length;
  frag.appendChild(makeSectionLabel(`已记忆（${memCount}）`));

  if (memCount === 0) {
    frag.appendChild(makeHint('还没有提炼出记忆。开启闲时提炼或点击「立即提炼」。'));
  } else {
    for (const m of _memories) {
      frag.appendChild(makeMemoryRow(m));
    }
  }

  // ---- 待分析会话区段 ----
  const totalSessions = _sessions.length + _unanalyzedPaths.length;
  frag.appendChild(makeSectionLabel(`待分析会话（${totalSessions}）`));

  if (totalSessions === 0) {
    frag.appendChild(makeHint('暂无会话记录。'));
  } else {
    // 已登记的 sessions
    for (const s of _sessions) {
      frag.appendChild(makeSessionRow(s));
    }
    // 扫描到但未登记的路径（纯展示，待下次提炼处理）
    for (const p of _unanalyzedPaths) {
      frag.appendChild(makeUnanalyzedRow(p));
    }
  }

  el.innerHTML = '';
  el.appendChild(frag);
}

// ── 记忆条目行 ──────────────────────────────────────────────────────────────
function makeMemoryRow(m) {
  const row = document.createElement('div');
  row.className = 'mem-memory-item';

  const body = document.createElement('div');
  body.className = 'mem-memory-body';

  if (m.category) {
    const cat = document.createElement('span');
    cat.className = 'mem-memory-cat';
    cat.textContent = CATEGORY_LABEL[m.category] || m.category;
    body.appendChild(cat);
  }

  const text = document.createElement('span');
  text.className = 'mem-memory-text';
  text.textContent = m.statement || '（无内容）';
  body.appendChild(text);

  if (m.reasoning) {
    const reason = document.createElement('span');
    reason.className = 'mem-memory-reasoning';
    reason.textContent = m.reasoning;
    body.appendChild(reason);
  }

  row.appendChild(body);

  // [移除] 按钮
  const rm = document.createElement('button');
  rm.className = 'mem-act mem-remove-btn';
  rm.textContent = '移除';
  rm.title = '从记忆库删除这条记忆';
  rm.onclick = async () => {
    rm.disabled = true;
    rm.textContent = '移除中…';
    try {
      await api('/api/memory/remove', { id: m.id });
      window.toast?.success('已移除');
      await refresh();
    } catch (e) {
      window.toast?.error(e.message);
      rm.disabled = false;
      rm.textContent = '移除';
    }
  };
  row.appendChild(rm);

  return row;
}

// ── 会话行（已登记） ─────────────────────────────────────────────────────────
function makeSessionRow(s) {
  const row = document.createElement('div');
  row.className = 'mem-session-item';

  const header = document.createElement('div');
  header.className = 'mem-session-header';
  header.style.cursor = 'pointer';

  const arrow = document.createElement('span');
  arrow.className = 'mem-session-arrow';
  arrow.textContent = _expandedIds.has(s.id) ? '▾' : '▸';

  const path = document.createElement('span');
  path.className = 'mem-session-path';
  path.textContent = shortPath(s.path || s.id);
  path.title = s.path || '';

  const statusBadge = document.createElement('span');
  statusBadge.className = 'mem-session-status mem-session-status--' + (s.status || 'pending');
  statusBadge.textContent = STATUS_LABEL[s.status] || s.status;

  header.appendChild(arrow);
  header.appendChild(path);
  header.appendChild(statusBadge);
  row.appendChild(header);

  // findings 展开区
  const findings = Array.isArray(s.findings) ? s.findings : [];
  if (findings.length > 0) {
    const detail = document.createElement('div');
    detail.className = 'mem-session-findings';
    detail.hidden = !_expandedIds.has(s.id);

    for (const f of findings) {
      detail.appendChild(makeFindingRow(f));
    }
    row.appendChild(detail);

    header.onclick = () => {
      if (_expandedIds.has(s.id)) {
        _expandedIds.delete(s.id);
        arrow.textContent = '▸';
        detail.hidden = true;
      } else {
        _expandedIds.add(s.id);
        arrow.textContent = '▾';
        detail.hidden = false;
      }
    };
  } else {
    // 无 findings：不可展开
    header.style.cursor = 'default';
  }

  return row;
}

// ── 单条 finding 行 ──────────────────────────────────────────────────────────
function makeFindingRow(f) {
  const row = document.createElement('div');
  row.className = 'mem-finding-item';

  if (f.type) {
    const badge = document.createElement('span');
    badge.className = 'mem-finding-type mem-finding-type--' + f.type;
    badge.textContent = FINDING_TYPE_LABEL[f.type] || f.type;
    row.appendChild(badge);
  }

  const summary = document.createElement('span');
  summary.className = 'mem-finding-summary';
  summary.textContent = f.summary || '';
  row.appendChild(summary);

  return row;
}

// ── 未登记路径行 ─────────────────────────────────────────────────────────────
function makeUnanalyzedRow(p) {
  const row = document.createElement('div');
  row.className = 'mem-session-item mem-unanalyzed-item';

  const arrow = document.createElement('span');
  arrow.className = 'mem-session-arrow';
  arrow.textContent = '▸';
  arrow.style.visibility = 'hidden'; // 占位，不可展开

  const path = document.createElement('span');
  path.className = 'mem-session-path';
  path.textContent = shortPath(p);
  path.title = p;

  const badge = document.createElement('span');
  badge.className = 'mem-session-status mem-session-status--pending';
  badge.textContent = '待分析';

  row.appendChild(arrow);
  row.appendChild(path);
  row.appendChild(badge);
  return row;
}

// ── 辅助构建函数 ─────────────────────────────────────────────────────────────
function makeSectionLabel(text) {
  const d = document.createElement('div');
  d.className = 'mem-section-label';
  d.textContent = text;
  return d;
}

function makeHint(text) {
  const d = document.createElement('div');
  d.className = 'mem-hint';
  d.textContent = text;
  return d;
}

/** 取路径末段文件名供展示，保留可读性 */
function shortPath(p) {
  if (!p) return '（未知路径）';
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 初始化记忆库面板。
 * app.js 每次切换到 memory 视图时调用（onclick 重绑定无副作用）。
 */
export function initMemoryPanel() {
  refresh();

  // 立即提炼按钮
  const extractBtn = $('#memExtractBtn');
  if (extractBtn) {
    extractBtn.onclick = async () => {
      if (_extracting) return;
      _extracting = true;
      extractBtn.disabled = true;
      extractBtn.textContent = '提炼中…';
      try {
        await api('/api/memory/extract', {});
        window.toast?.info('已开始提炼，稍后自动刷新');
        // 后台异步；等待约 15s 后刷新
        setTimeout(async () => {
          _extracting = false;
          extractBtn.disabled = false;
          extractBtn.textContent = '立即提炼';
          await refresh();
        }, 15000);
      } catch (e) {
        window.toast?.error(e.message);
        _extracting = false;
        extractBtn.disabled = false;
        extractBtn.textContent = '立即提炼';
      }
    };
  }

  // 导出按钮（保留原有行为）
  const exportBtn = $('#memExportBtn');
  if (exportBtn) {
    exportBtn.onclick = () => { window.open('/api/memory/export?format=json', '_blank'); };
  }
}

/**
 * 静默轮询红点（顶栏徽标）。面板打开时跳过。
 * 兼容旧实现：轮询记忆数量，有记忆就亮点。
 */
export async function refreshMemBadge() {
  try {
    const d = await (await fetch('/api/memory/sessions')).json();
    const memCount = Array.isArray(d.memories) ? d.memories.length : 0;
    const badge = $('#memBadge');
    if (badge) badge.hidden = memCount === 0;
  } catch { /* 轮询失败静默忽略 */ }
}
