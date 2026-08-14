/**
 * 记忆库面板：候选确认 / 已生效 / 冲突 / 休眠。
 * 渲染一律 createElement + textContent（条目内容来自 LLM，绝不用 innerHTML）。
 */
import { $ } from './util.js';
import { confirmDialog, promptDialog } from './ui.js';

const CATEGORY_LABEL = {
  'code-style': '代码风格', collaboration: '协作习惯', writing: '写作习惯',
  dialogue: '对话风格', 'tech-pref': '技术偏好',
};

let _items = [];
let _expanded = new Set();   // 展开证据的条目 id（内存态，切页不保留）
let _showDormant = false;

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || '请求失败');
  return d;
}

function makeAct(label, title, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'mem-act' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.title = title;
  b.onclick = onClick;
  return b;
}

function makeRow(it) {
  const row = document.createElement('div');
  row.className = 'mem-item';

  const body = document.createElement('div');
  body.className = 'mem-item-body';

  const st = document.createElement('span');
  st.className = 'mem-item-statement';
  st.textContent = it.statement;
  body.appendChild(st);

  const meta = document.createElement('span');
  meta.className = 'mem-item-meta';
  const parts = [
    CATEGORY_LABEL[it.category] || it.category,
    it.scope === 'project' ? '本工程' : '全局',
    `证据 ${it.evidenceCount}（${it.evidenceSessions?.length || 0} 个会话）`,
  ];
  if (it.source === 'explicit') parts.push('你明确说过');
  if (!it.inject) parts.push('仅记录');
  if (it.status === 'conflict') parts.push('⚠ 与已有偏好冲突，请裁决');
  if (!it.acked) parts.push('🔴 新');
  meta.textContent = parts.join(' · ');
  body.appendChild(meta);

  if (_expanded.has(it.id)) {
    const ev = document.createElement('pre');
    ev.className = 'mem-evidence';
    ev.textContent = (it.evidence || []).length
      ? it.evidence.map((e) => `[${e.sessionId?.slice(0, 8) || '?'}] ${e.quote}`).join('\n')
      : '（无留存原话）';
    body.appendChild(ev);
  }
  row.appendChild(body);

  row.appendChild(makeAct(_expanded.has(it.id) ? '收起' : '原话', '查看证据原话', '', () => {
    if (_expanded.has(it.id)) _expanded.delete(it.id); else _expanded.add(it.id);
    render();
  }));

  if (it.status !== 'active') {
    row.appendChild(makeAct('✓', '确认并生效', '', async () => {
      try { await api('/api/memory/confirm', { id: it.id }); window.toast.success('已生效'); refresh(); }
      catch (e) { window.toast.error(e.message); }
    }));
  }

  row.appendChild(makeAct('✎', '编辑措辞', '', async () => {
    const v = await promptDialog({ title: '编辑偏好', value: it.statement });
    if (v === null || v.trim() === '') return;
    try { await api('/api/memory/confirm', { id: it.id, statement: v.trim() }); window.toast.success('已保存'); refresh(); }
    catch (e) { window.toast.error(e.message); }
  }));

  row.appendChild(makeAct('✗', '否掉（此后不再提炼这条）', 'danger', async () => {
    const ok = await confirmDialog({
      title: '否掉这条偏好？', message: `「${it.statement}」\n\n否掉后不会再被提炼出来。`, danger: true,
    });
    if (!ok) return;
    try { await api('/api/memory/reject', { id: it.id }); window.toast.success('已否掉'); refresh(); }
    catch (e) { window.toast.error(e.message); }
  }));

  return row;
}

function makeLabel(text) {
  const d = document.createElement('div');
  d.className = 'mem-section-label';
  d.textContent = text;
  return d;
}

function render() {
  const el = $('#memBody');
  if (!el) return;
  el.innerHTML = '';
  const frag = document.createDocumentFragment();

  const groups = [
    ['⚠ 待裁决（冲突）', _items.filter((i) => i.status === 'conflict')],
    ['待确认', _items.filter((i) => i.status === 'candidate')],
    ['已生效', _items.filter((i) => i.status === 'active')],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    frag.appendChild(makeLabel(`${label}（${list.length}）`));
    for (const it of list) frag.appendChild(makeRow(it));
  }

  const dormant = _items.filter((i) => i.status === 'dormant');
  if (dormant.length) {
    const toggle = makeLabel(`${_showDormant ? '▾' : '▸'} 休眠（${dormant.length}）`);
    toggle.style.cursor = 'pointer';
    toggle.onclick = () => { _showDormant = !_showDormant; render(); };
    frag.appendChild(toggle);
    if (_showDormant) for (const it of dormant) frag.appendChild(makeRow(it));
  }

  if (!_items.length) frag.appendChild(makeLabel('还没有提炼出偏好。开启功能后，它会在额度空闲时段自动积累。'));
  el.appendChild(frag);
}

async function refresh() {
  let d;
  try { d = await api('/api/memory/list'); }
  catch { return; }   // 失败沿用上次渲染，不清空面板
  _items = d.items || [];
  const tip = $('#memBudgetTip');
  if (tip) {
    tip.textContent = d.budget?.truncated
      ? `⚠ ${d.budget.truncated} 条因注入预算未生效（已用 ${d.budget.used}/${d.budget.total}）`
      : `已注入 ${d.budget?.used || 0}/${d.budget?.total || 0} 条`;
  }
  render();
  // 打开面板即视为已读——但冲突条目的红点是「待裁决」信号，不是「未读」信号：
  // ack 只清 acked 字段，不会把 status='conflict' 改掉，裁决前必须持续亮红点，
  // 否则用户看一眼就清零，会误以为冲突已处理，实际还晾在那没人管。
  if (d.unackedCount > 0) {
    try { await api('/api/memory/ack', { all: true }); } catch { /* 忽略 */ }
  }
  updateMemBadge(d.conflictCount || 0);
}

export function initMemoryPanel() {
  refresh();
  $('#memExtractBtn').onclick = async () => {
    try {
      await api('/api/memory/extract', {});
      window.toast.info('已开始提炼，稍后刷新查看');
      setTimeout(refresh, 15000);
    } catch (e) { window.toast.error(e.message); }
  };
  $('#memExportBtn').onclick = () => { window.open('/api/memory/export?format=json', '_blank'); };
}

function updateMemBadge(n) {
  const b = $('#memBadge');
  if (b) b.hidden = !n;
}

/** 静默轮询红点。面板已打开时跳过（打开即已读） */
export async function refreshMemBadge() {
  try {
    const d = await (await fetch('/api/memory/list')).json();
    updateMemBadge((d.unackedCount || 0) + (d.conflictCount || 0));
  } catch { /* 忽略轮询失败 */ }
}
