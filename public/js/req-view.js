/** 需求视图 —— 侧栏需求列表 + 评审设计期文档模式（P1 范围；dev/test 聊天模式与横幅右栏见 Task 10）。
 *  导出 initReqView（绑定入口 + 启动列表轮询）/ openRequirement（打开单个需求）/ refreshReqList（刷新侧栏列表）。 */
import { $, fmtTime, renderMarkdown, dirTail } from './util.js';
import { confirmDialog, promptDialog, textareaDialog } from './ui.js';
import { loadConvs } from './conv-store.js';
import { openConv, createReqConv, isConvRunning } from './chat.js';
import { convSetTitle, convDelete } from './conv-store.js';

let _showView = () => {};

// ---- 侧栏需求列表折叠态（展开态存内存，切页面不保留） ----
const expandedReqs = new Map();  // key: reqId, value: boolean

// ---- 侧栏需求列表状态 ----
let listTimer = null;
let lastList = []; // 上次拉到的 { id,title,phase,updatedAt,busy } 数组（30s 轮询 + 单条详情拉取时局部 patch）
let archivedExpanded = false; // 「已归档」折叠组展开态，默认收起
let discardedExpanded = false; // 「已废弃」折叠组展开态，默认收起

// ---- 当前打开的需求详情状态 ----
let currentReqId = null;
let currentReq = null; // 最近一次 GET get 的完整记录（含 devDocLatest）
// 世代号：openRequirement 每次调用自增。loadAndRenderReq / busy 轮询 tick 在各自的网络
// await 之后都要核对这个值——防止「点开需求 A（慢响应）后又点开需求 B」时，A 姗姗来迟的
// 响应把视图翻回 A、顺带清掉用户在 B 里刚打的补充说明草稿。
let reqEpoch = 0;
let busyTimer = null; // 3s 轮询：仅在打开的需求 busy 非空时存在
let wasBusy = false; // 上一次已知的 busy 状态：true→false 的边沿用于回到最新版
let docOverride = null; // { v, content } | null：用户手动切到非最新版本时的展示态
let supplementHistoryExpanded = false;
// 补充说明草稿：busy 轮询 / 版本页签切换 / 历史折叠都会触发 renderReqPage 整页重建，
// 若草稿只是 renderSupplementBox 内的局部变量，每次重建都会悄悄清空用户还没提交的输入。
// 提到模块级持久化，重建时原样回填；仅在「打开另一个需求」或「提交成功」时才清空。
let supplementDraftText = '';
let supplementPendingFiles = []; // [{ name, path: string|null }]，path 待上传完成才回填
let archiveNoteDraft = ''; // 归档备注草稿：同 supplementDraftText 思路，busy/轮询触发的整页重建不清空

const PHASE_META = {
  review: { label: '评审', cls: 'review' },
  dev: { label: '开发', cls: 'dev' },
  test: { label: '测试', cls: 'test' },
  archiving: { label: '归档中', cls: 'archiving' },
  archived: { label: '已归档', cls: 'archiving' },
  discarded: { label: '已废弃', cls: 'discarded' },
};

// ---- 需求钉住状态（localStorage 持久化） ----
let reqPinnedIds = new Set();
const REQ_PINNED_LS_KEY = 'claude_req_pinned';

function loadReqPinned() {
  try {
    const stored = localStorage.getItem(REQ_PINNED_LS_KEY) || '';
    reqPinnedIds = new Set(stored.split(',').filter((id) => id.trim()));
  } catch {
    reqPinnedIds = new Set();
  }
}

function saveReqPinned() {
  try {
    localStorage.setItem(REQ_PINNED_LS_KEY, Array.from(reqPinnedIds).join(','));
  } catch {}
}

function isReqPinned(reqId) {
  return reqPinnedIds.has(reqId);
}

function _toggleReqPin(reqId, shouldPin) {
  if (shouldPin) reqPinnedIds.add(reqId);
  else reqPinnedIds.delete(reqId);
  saveReqPinned();
  renderReqList();
  window.toast.success(shouldPin ? '已钉住' : '已取消钉住');
}

/** req 面板当前是否为激活视图：直接查 DOM（showView 把非激活 panel-page 置 hidden），
 *  避免额外向 app.js 要一个 isActive 回调。 */
function isReqViewActive() {
  const p = document.querySelector('.panel-page[data-view="req"]');
  return !!p && !p.hidden;
}

// ============================================================
// 侧栏需求列表
// ============================================================

// ---- 需求右键菜单 ----
const _reqCtxMenu = (() => {
  const el = document.createElement('div');
  el.className = 'req-ctx-menu';
  el.hidden = true;
  el.innerHTML =
    '<button class="ctx-item" id="reqCtxPin"></button>' +
    '<button class="ctx-item ctx-danger" id="reqCtxDiscard">废弃</button>';
  document.body.appendChild(el);
  return el;
})();
let _ctxReqId = null;

function _hideReqCtxMenu() {
  _reqCtxMenu.hidden = true;
  _ctxReqId = null;
}

function _showReqCtxMenu(x, y, reqId, isPinned) {
  _ctxReqId = reqId;
  _reqCtxMenu.querySelector('#reqCtxPin').textContent = isPinned ? '取消钉住' : '钉住';
  _reqCtxMenu.hidden = false;
  const mw = _reqCtxMenu.offsetWidth;
  const mh = _reqCtxMenu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  _reqCtxMenu.style.left = (x + mw > vw ? vw - mw - 6 : x) + 'px';
  _reqCtxMenu.style.top = (y + mh > vh ? vh - mh - 6 : y) + 'px';
}

_reqCtxMenu.querySelector('#reqCtxPin').addEventListener('click', () => {
  if (!_ctxReqId) return;
  _toggleReqPin(_ctxReqId, !isReqPinned(_ctxReqId));
  _hideReqCtxMenu();
});

_reqCtxMenu.querySelector('#reqCtxDiscard').addEventListener('click', () => {
  if (!_ctxReqId) return;
  const id = _ctxReqId;
  _hideReqCtxMenu();
  _reqDiscard(id);
});

document.addEventListener('click', (e) => {
  if (!_reqCtxMenu.hidden && !_reqCtxMenu.contains(e.target)) _hideReqCtxMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') _hideReqCtxMenu();
});

async function _reqDiscard(reqId) {
  const ok = await confirmDialog({
    title: '废弃需求',
    message: '确认要废弃这个需求吗？已废弃的需求仅保留记录，无法恢复。',
    confirmText: '废弃',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/req/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '废弃失败');
    window.toast.success('已废弃');
    await refreshReqList();
  } catch {
    window.toast.error('网络错误');
  }
}

/** 供 app.js 视图切换时调用，立即重渲需求列表（不走网络） */
export function renderReqListLocal() {
  renderReqList();
}

export function initReqView({ showView }) {
  loadReqPinned();
  _showView = showView;
  $('#sidebarNewReq')?.addEventListener('click', createNewRequirement);
  if (listTimer) clearInterval(listTimer); // 防重复调用叠加多个定时器
  listTimer = setInterval(refreshReqList, 30000);
  // 为 chat.js 的 run 钩子注册侧栏树更新回调
  window._updateReqList = updateReqListDisplay;
}

export async function refreshReqList() {
  let r;
  try {
    r = await fetch('/api/req/list');
  } catch {
    return; // 网络异常：沿用上次已渲染的列表，不清空侧栏
  }
  if (!r.ok) return; // HTTP 错误（如后端瞬时抖动）：同上，不能把 lastList 清空
  try {
    const { requirements } = await r.json();
    // 兜底：后端若漏返 sessions（版本不一致/字段回退），保留上一轮的会话树而不是整体抹掉。
    // 会话树的渲染只认 sessions，一旦这里变成 undefined，展开着的子会话行会凭空消失。
    const prev = new Map(lastList.map((x) => [x.id, x]));
    lastList = (requirements || []).map((x) =>
      x.sessions ? x : { ...x, sessions: prev.get(x.id)?.sessions || [] },
    );
  } catch {
    return; // 响应体解析失败：同上
  }
  renderReqList();
}

/** 用单个需求的最新详情就地更新侧栏缓存（打开/轮询/保存后都会触发），
 *  避免等下一次 30s 轮询才反映刚刚发生的阶段/busy 变化。 */
function patchListEntry(data) {
  const idx = lastList.findIndex((r) => r.id === data.id);
  const entry = {
    id: data.id,
    title: data.title,
    phase: data.phase,
    updatedAt: data.updatedAt,
    busy: !!data.busy,
    sessions: data.sessions || [], // 打开需求时补充 sessions 信息
  };
  if (idx >= 0) lastList[idx] = entry;
  else lastList.unshift(entry);
  lastList.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  renderReqList();
}

function renderReqList() {
  const el = $('#reqList');
  if (!el) return;
  if (!lastList.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = '';
  const frag = document.createDocumentFragment();

  const appendReqRow = (r) => {
    const rows = makeReqRow(r);
    if (Array.isArray(rows)) {
      rows.forEach(row => frag.appendChild(row));
    } else {
      frag.appendChild(rows);
    }
  };

  // 第 0 层：钉住需求（始终顶部）
  const pinned = lastList.filter((r) => isReqPinned(r.id));
  for (const r of pinned) appendReqRow(r);

  // 第 1 层：活跃需求（评审/开发/测试/归档中）
  const active = lastList.filter(
    (r) => !isReqPinned(r.id) && ['review', 'dev', 'test', 'archiving'].includes(r.phase),
  );
  if (active.length) {
    frag.appendChild(makeReqSectionLabel('本次需求'));
    for (const r of active) appendReqRow(r);
  }

  // 第 2 层：已废弃（折叠组）
  const discarded = lastList.filter((r) => !isReqPinned(r.id) && r.phase === 'discarded');
  if (discarded.length) {
    frag.appendChild(makeDiscardedToggle(discarded.length));
    if (discardedExpanded) for (const r of discarded) appendReqRow(r);
  }

  // 第 3 层：已归档（折叠组）
  const archived = lastList.filter((r) => !isReqPinned(r.id) && r.phase === 'archived');
  if (archived.length) {
    frag.appendChild(makeArchivedToggle(archived.length));
    if (archivedExpanded) for (const r of archived) appendReqRow(r);
  }

  el.appendChild(frag);
}

/** 重渲染侧栏需求列表（供 chat.js run 钩子调用）—— 更新运行灯等状态 */
export function updateReqListDisplay() {
  renderReqList();
}

function makeReqSectionLabel(text) {
  const d = document.createElement('div');
  d.className = 'req-section-label';
  d.textContent = text;
  return d;
}

function makeDiscardedToggle(count) {
  const d = document.createElement('div');
  d.className = 'req-section-label req-discarded-toggle';
  d.textContent = (discardedExpanded ? '▾ ' : '▸ ') + `已废弃（${count}）`;
  d.onclick = () => {
    discardedExpanded = !discardedExpanded;
    renderReqList();
  };
  return d;
}

function makeArchivedToggle(count) {
  const d = document.createElement('div');
  d.className = 'req-section-label req-archived-toggle';
  d.textContent = (archivedExpanded ? '▾ ' : '▸ ') + `已归档（${count}）`;
  d.onclick = () => {
    archivedExpanded = !archivedExpanded;
    renderReqList();
  };
  return d;
}

function makeReqRow(r) {
  const result = [];

  // 主需求行
  const row = document.createElement('div');
  row.className = 'req-item' + (r.id === currentReqId && isReqViewActive() ? ' active' : '');
  row.dataset.reqId = r.id;

  // 折叠箭头（dev/test 阶段且有子会话时显示）
  const isExpandable = (r.phase === 'dev' || r.phase === 'test');
  const isExpanded = expandedReqs.get(r.id) ?? (isExpandable); // dev/test 默认展开

  if (isExpandable) {
    const arrow = document.createElement('span');
    arrow.className = 'req-expand-arrow';
    // 展开态落到 DOM 属性上，箭头由 CSS ::before 旋转同一个字符渲染（带过渡）。
    // 旧写法用 textContent 直接写 ▾/▸，状态只活在 JS 里，CSS 无从感知，
    // 一旦箭头与折叠内容的判定源不一致就会出现「箭头是展开的、下面却空着」。
    arrow.dataset.expanded = isExpanded ? '1' : '0';
    arrow.title = isExpanded ? '点击折叠会话树' : '点击展开会话树';
    arrow.onclick = (e) => {
      e.stopPropagation();
      expandedReqs.set(r.id, !isExpanded);
      renderReqList();
    };
    row.appendChild(arrow);
  } else {
    // 占位符
    const space = document.createElement('span');
    space.style.display = 'inline-block';
    space.style.width = '16px';
    row.appendChild(space);
  }

  if (isReqPinned(r.id)) {
    const pinIc = document.createElement('span');
    pinIc.className = 'req-pin-ic';
    pinIc.title = '已钉住';
    pinIc.innerHTML = '<svg viewBox="0 0 1024 1024" width="11" height="11" fill="currentColor"><path d="M574.4 192l-64 192H320l64-64-128-192 192 64-64 64 192-64zM832 576L640 384l-128 192 128 64-192 320 64-256-64-128 192 64z"/></svg>';
    row.appendChild(pinIc);
  }
  const title = document.createElement('span');
  title.className = 'req-title';
  title.textContent = r.title || '(未命名需求)';
  row.appendChild(title);
  if (r.busy) {
    const spin = document.createElement('span');
    spin.className = 'req-busy-dot';
    spin.title = '处理中';
    row.appendChild(spin);
  }
  const meta = PHASE_META[r.phase] || { label: r.phase, cls: '' };
  const badge = document.createElement('span');
  badge.className = 'req-badge ' + meta.cls;
  badge.textContent = meta.label;
  row.appendChild(badge);
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _showReqCtxMenu(e.pageX, e.pageY, r.id, isReqPinned(r.id));
  });
  row.onclick = () => openRequirement(r.id);
  result.push(row);

  // 展开时渲染子会话树。判定源必须与箭头一致（只看 isExpanded）：
  // 旧写法多带了 sessions.length > 0，而 /api/req/list 一度不返回 sessions，
  // 轮询整体替换 lastList 后子行凭空消失，箭头却仍指着「展开」——用户看到的就是「下拉自动收起、点箭头没反应」。
  // 会话为空时也照常渲染「＋新会话」，否则开发期需求会连新建入口都没有。
  const sessions = r.sessions || [];
  if (isExpandable && isExpanded) {
    for (const session of sessions) {
      result.push(makeSessionRow(session, r.id));
    }
    result.push(makeAddSessionButton(r.id));
  }

  return result.length === 1 ? result[0] : result;
}

/** 生成会话行 DOM 元素：显示会话 kind + 标题 + 运行灯 + 菜单 */
function makeSessionRow(session, reqId) {
  const row = document.createElement('div');
  row.className = 'req-session-row';
  row.dataset.sessionId = session.convId;
  row.dataset.reqId = reqId;

  // 缩进占位
  const indent = document.createElement('span');
  indent.style.display = 'inline-block';
  indent.style.width = '24px';
  row.appendChild(indent);

  // Kind 标记
  const kindIc = document.createElement('span');
  kindIc.className = 'req-session-kind-ic';
  kindIc.title = session.kind;
  if (session.kind === 'main') kindIc.textContent = '⚡';
  else if (session.kind === 'retro') kindIc.textContent = '🔍';
  else kindIc.textContent = '💬';
  row.appendChild(kindIc);

  // 标题
  const title = document.createElement('span');
  title.className = 'req-session-title';
  title.textContent = session.title || '(未命名会话)';
  row.appendChild(title);

  // 运行灯
  if (isConvRunning(session.convId)) {
    const runLight = document.createElement('span');
    runLight.className = 'req-session-run-light';
    runLight.title = '运行中';
    runLight.textContent = '🔴';
    row.appendChild(runLight);
  }

  // 菜单（重命名、删除）- hover 时显示
  const menu = document.createElement('div');
  menu.className = 'req-session-menu';
  menu.style.display = 'none';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'req-session-menu-btn';
  renameBtn.title = '重命名';
  renameBtn.textContent = '✎';
  renameBtn.onclick = (e) => {
    e.stopPropagation();
    renameSession(reqId, session.convId, session.title);
  };
  menu.appendChild(renameBtn);

  // main 会话无删除按钮
  if (session.kind !== 'main') {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'req-session-menu-btn req-session-delete-btn';
    deleteBtn.title = '删除';
    deleteBtn.textContent = '✕';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteSession(reqId, session.convId, session.title);
    };
    menu.appendChild(deleteBtn);
  }

  row.appendChild(menu);

  // hover 时显示菜单
  row.addEventListener('mouseenter', () => {
    menu.style.display = 'flex';
  });
  row.addEventListener('mouseleave', () => {
    menu.style.display = 'none';
  });

  // 点击打开会话
  row.onclick = () => openConv(session.convId);

  return row;
}

/** 「＋新会话」按钮 */
function makeAddSessionButton(reqId) {
  const row = document.createElement('div');
  row.className = 'req-add-session-row';

  const indent = document.createElement('span');
  indent.style.display = 'inline-block';
  indent.style.width = '24px';
  row.appendChild(indent);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'req-add-session-btn';
  btn.textContent = '＋ 新会话';
  btn.onclick = (e) => {
    e.stopPropagation();
    addNewSession(reqId);
  };
  row.appendChild(btn);

  return row;
}

/** 重命名会话 */
async function renameSession(reqId, convId, currentTitle) {
  const newTitle = await promptDialog({
    title: '重命名会话',
    value: currentTitle,
    placeholder: '会话标题',
    confirmText: '确认',
  });
  if (newTitle == null) return; // 取消
  const trimmed = newTitle.trim();
  if (!trimmed) return window.toast.error('标题不能为空');
  if (trimmed.length > 60) return window.toast.error('标题不能超过 60 字符');
  if (trimmed === currentTitle) return; // 无改动
  try {
    convSetTitle(convId, trimmed);
    // 同步到后端
    const r = await fetch('/api/req/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, convId, title: trimmed }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '重命名失败');
    window.toast.success('已重命名');
    // 必须重拉而非 renderReqList()：会话标题存在 lastList[].sessions 里，
    // 只重渲会拿陈旧缓存重画一遍，用户会看到「改了但没变」。
    await refreshReqList();
  } catch {
    window.toast.error('网络错误');
  }
}

/** 删除会话 */
async function deleteSession(reqId, convId, title) {
  const ok = await confirmDialog({
    title: '删除会话',
    message: `确认删除会话 "${title}" 吗？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    // 从本地存储删除
    convDelete(convId);
    // 同步到后端
    const r = await fetch('/api/req/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, convId }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '删除失败');
    window.toast.success('已删除');
    await refreshReqList(); // 同重命名：会话数据在 lastList 里，须重拉才会消失
  } catch {
    window.toast.error('网络错误');
  }
}

/** 新建子会话 */
async function addNewSession(reqId) {
  const title = await promptDialog({
    title: '新建会话',
    placeholder: '会话标题',
    confirmText: '创建',
  });
  if (title == null) return; // 取消
  const trimmed = title.trim();
  if (!trimmed) return window.toast.error('标题不能为空');
  if (trimmed.length > 60) return window.toast.error('标题不能超过 60 字符');

  try {
    // 获取当前需求详情（含 cwd 和其他信息用于生成 seed）
    const r = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
    const reqData = await r.json();
    if (!r.ok || !reqData) return window.toast.error('获取需求信息失败');

    const req = reqData;
    const cwd = req.projects?.frontend?.dir || req.projects?.backend?.dir || '';

    // 生成种子（后端已有 buildSeedPrompt，但前端调用后端 API 获取）
    let seedText = '';
    try {
      const seedRes = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
      const seedData = await seedRes.json();
      if (seedRes.ok && seedData && seedData.phase === 'dev' || seedData.phase === 'test') {
        // seed 由后端返回（需要在 handleGet 中包含 seed 字段）
        seedText = seedData.seed || '';
      }
    } catch (e) {
      console.warn('获取 seed 失败，将以空 seed 创建', e);
    }

    // 本地创建 conv（子会话，种子为 pending）
    const convId = createReqConv({
      reqId,
      cwd,
      title: trimmed,
      kind: 'sub',
      seedPending: seedText.length > 0,
      seedText: seedText,
    });

    // 后端注册会话
    const sr = await fetch('/api/req/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: reqId,
        convId,
        title: trimmed,
        kind: 'sub',
      }),
    });
    const sd = await sr.json();
    if (!sr.ok) return window.toast.error(sd.error || '创建会话失败');

    window.toast.success('已创建');
    openConv(convId);
    await refreshReqList(); // 同重命名：新会话行要重拉 sessions 才出得来
  } catch (e) {
    window.toast.error('网络错误：' + (e?.message || e));
  }
}

async function createNewRequirement() {
  const title = await promptDialog({
    title: '新建需求',
    placeholder: '需求标题（最多 60 字）',
    confirmText: '创建',
  });
  if (title == null) return; // 取消
  const trimmed = title.trim();
  if (!trimmed) return;
  if (trimmed.length > 60) return window.toast.error('标题不能超过 60 字符');
  try {
    const r = await fetch('/api/req/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '创建失败');
    await refreshReqList();
    openRequirement(d.id);
  } catch {
    window.toast.error('网络错误');
  }
}

// ============================================================
// 需求详情（文档模式）
// ============================================================

export async function openRequirement(id) {
  reqEpoch++; // 新世代：任何仍在飞行中的旧世代响应回来后都会被下面的校验丢弃
  const epoch = reqEpoch;
  await loadAndRenderReq(id, epoch);
}

async function fetchRequirement(id) {
  try {
    const r = await fetch('/api/req/get?id=' + encodeURIComponent(id));
    const data = await r.json().catch(() => null);
    return { ok: r.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * @param {string} id
 * @param {number} [epoch] 发起本次刷新时的世代号；缺省取调用瞬间的 reqEpoch（仅保护本函数
 *   自身这一次网络往返——从 openRequirement 发起的调用会显式传入更早捕获的 epoch，
 *   从而也能感知「往返期间用户已经点开了别的需求」这类更早发生的竞态）。
 */
async function loadAndRenderReq(id, epoch = reqEpoch) {
  const { ok, data } = await fetchRequirement(id);
  if (epoch !== reqEpoch) return; // 过期响应：等待期间已经翻到别的需求，丢弃不渲染
  if (!ok || !data) {
    _showView('req'); // 出错也要能看见提示；成功路径的视图切换按阶段分流，见 applyFetchedReq
    renderReqError((data && data.error) || '需求不存在或加载失败');
    return;
  }
  applyFetchedReq(id, data);
}

/** 落地一次成功的详情拉取：更新缓存态 + 渲染 + 就地刷新侧栏 + 管理 busy 轮询定时器。 */
function applyFetchedReq(id, data) {
  // docgen 202 只代表入队，busy 要等后端泵（5s tick）派发时才写入，窗口期 get 返回 queued=true。
  // 把它合成为 busy 展示，busy 条 / 按钮禁用 / 3s 轮询全部立即生效——否则 202 后立刷拿到
  // busy=null，页面静止在旧态，用户重开需求才能看到「生成中」。
  if (data.phase === 'review' && !data.busy && data.queued) {
    data.busy = { kind: 'docgen', startedAt: null };
  }
  const isFreshOpen = id !== currentReqId;
  if (isFreshOpen) {
    docOverride = null;
    wasBusy = false;
    supplementDraftText = '';
    supplementPendingFiles = [];
    archiveNoteDraft = '';
    // 切到另一个需求：旧需求的 busy 轮询立即失效。不清掉的话 busyTimer 仍非空，
    // 下面「data.busy && !busyTimer」会误判为「已在轮询」而跳过新需求的轮询重建——
    // 双 busy 需求 A→B 场景下，B 将永远等不到轮询（A 的旧定时器只会在下一拍自证失效后清空，
    // 但那之后不会有人再为 B 调 startBusyPolling）。
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
  }
  currentReqId = id;
  currentReq = data;
  patchListEntry(data);

  if (data.phase === 'dev' || data.phase === 'test') {
    // 开发/测试期（Task 10）：寄生进聊天视图，#reqPage 不渲染，也不调 _showView('req')——
    // openRequirementChat 最终调用的 chat.js openConv() 内部会经 _goChat() 切到聊天视图，
    // 无论这次是用户点开需求（本函数首次进入），还是 finalize/dev-done 等「原地刷新」路径
    // 调 loadAndRenderReq 触发，效果一致。
    // 文档模式的 busy 轮询在此阶段没有意义（#reqPage 不再展示），必须显式收掉，否则一个
    // 「评审期 busy→定稿→开发期」的需求会在后台留一个永远不会再被清理的 3s 轮询。
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    openRequirementChat(id, data);
    return;
  }

  _showView('req');
  if (wasBusy && !data.busy) docOverride = null; // 生成刚结束：回到最新版展示
  wasBusy = !!data.busy;
  renderReqPage(data);
  if (data.busy && !busyTimer) startBusyPolling(id);
  if (!data.busy && busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

/**
 * 开发/测试期：确保该需求有寄生 conv 再交给 chat.js 打开——横幅/右栏由 req-chat.js 经
 * bindReqConvHook 挂载（依赖方向 req-view → chat.js，单向，本模块不直接碰 #reqBanner/#reqRail）。
 * record.convId 存在且本地 conv 仍在（用户可能清过 localStorage）才复用，否则新建并回填。
 */
async function openRequirementChat(id, data) {
  try {
    const list = loadConvs();
    let convId = data.convId && list.some((c) => c.id === data.convId) ? data.convId : null;
    if (!convId) {
      // cwd 与后端 pickCwdAndDirs 同序：前端优先，无则后端
      const cwd = data.projects?.frontend?.dir || data.projects?.backend?.dir || '';
      convId = createReqConv({ reqId: id, cwd, session: data.devSession, title: data.title });
      try {
        const r = await fetch('/api/req/conv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, convId }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          window.toast.error(d.error || 'conv 绑定失败，系统任务进度可能不可见');
        }
      } catch {
        window.toast.error('网络错误，conv 绑定失败');
      }
    }
    openConv(convId);
  } catch (e) {
    window.toast.error('打开开发会话失败：' + (e?.message || e));
  }
}

/** busy 期间 3s 轮询：视图已不是 req、已切到别的需求、或世代号已变（currentReqId 恰好
 *  同名但已是「重新打开」的新一轮）都自行停止（不强求外部主动清理）。 */
function startBusyPolling(id) {
  const epoch = reqEpoch; // 本轮轮询归属的世代号
  busyTimer = setInterval(async () => {
    if (!isReqViewActive() || currentReqId !== id || epoch !== reqEpoch) {
      clearInterval(busyTimer);
      busyTimer = null;
      return;
    }
    const { ok, data } = await fetchRequirement(id);
    if (epoch !== reqEpoch) return; // await 期间已翻到别的需求：丢弃这次响应，不渲染
    if (!ok || !data) return; // 瞬时错误：跳过本轮，下次再试
    applyFetchedReq(id, data);
  }, 3000);
}

function renderReqError(msg) {
  const box = $('#reqPage');
  if (!box) return;
  const titleEl = $('#reqPageTitle');
  if (titleEl) titleEl.textContent = '需求';
  box.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'req-error-state';
  el.textContent = msg;
  box.appendChild(el);
}

/** busy 轮询 / 版本页签切换 / 历史折叠都会走这里整页重建 #reqPage —— 这些都不是用户
 *  主动要求「换个上下文」，只是刷新展示，故重建前后要保留滚动位置（否则每次轮询都会把
 *  用户拉到别处看的正文顶回原位）。 */
function renderReqPage(req) {
  const box = $('#reqPage');
  if (!box || !req) return;
  const titleEl = $('#reqPageTitle');
  if (titleEl) titleEl.textContent = req.title || '需求';
  const scrollHost = document.querySelector('.panel-view');
  const savedScroll = scrollHost ? scrollHost.scrollTop : 0;
  box.innerHTML = '';
  if (req.phase === 'review') {
    box.appendChild(renderChipsBar(req));
    const err = renderErrorBanner(req);
    if (err) box.appendChild(err);
    const busyBar = renderBusyBar(req);
    if (busyBar) box.appendChild(busyBar);
    box.appendChild(renderDocArea(req));
    // 首次未生成开发文档前，底部仅有文档区空态的 [生成开发文档] 按钮；生成出 v1 后才出现补充说明框
    //（补充说明是「对已有文档提出调整」，没有文档时提交没有意义，也会让首次流程出现两个入口造成困惑）。
    if ((req.devDoc?.versions || []).length) box.appendChild(renderSupplementBox(req));
  } else if (req.phase === 'archiving') {
    box.appendChild(renderArchivingPage(req));
  } else if (req.phase === 'archived') {
    box.appendChild(renderArchivedPage(req));
  } else if (req.phase === 'discarded') {
    box.appendChild(renderDiscardedPage(req));
  } else {
    // dev/test：由 req-chat.js 接管聊天模式，占位仅在直开的极短窗口内闪现
    box.appendChild(renderPlaceholderBar());
    box.appendChild(renderReadonlyDoc(req));
  }
  if (scrollHost) scrollHost.scrollTop = savedScroll;
}

function renderPlaceholderBar() {
  const bar = document.createElement('div');
  bar.className = 'req-placeholder-bar';
  bar.textContent = '该阶段视图将在下一批交付';
  return bar;
}

function renderReadonlyDoc(req) {
  const box = document.createElement('div');
  box.className = 'req-doc-content req-doc-readonly';
  if (req.devDocLatest) renderMarkdown(box, req.devDocLatest);
  else box.textContent = '暂无开发文档';
  return box;
}

// ---- 归档期：只读芯片条（复用评审期芯片条的展示样式，去掉可点击/编辑入口） ----

// 图标与评审期 makeProjectChip 保持一致：前后端统一 🖥（评审期两个工程从不区分图标），
// 不采用开发/测试期横幅 renderBanner 的 🖥/🗄 区分方案——本视图借用的是评审期芯片条的展示风格。
function renderReadonlyChipsBar(req) {
  const bar = document.createElement('div');
  bar.className = 'req-chips';
  const addChip = (text, title) => {
    const chip = document.createElement('span');
    chip.className = 'req-chip req-chip-readonly';
    chip.textContent = text;
    if (title) chip.title = title;
    bar.appendChild(chip);
  };
  const f = req.projects?.frontend;
  const b = req.projects?.backend;
  if (f) addChip(`🖥 ${dirTail(f.dir)} · ${f.dev ? '开发' : '只读'}`, f.dir);
  if (b) addChip(`🖥 ${dirTail(b.dir)} · ${b.dev ? '开发' : '只读'}`, b.dir);
  if (req.reqDoc) addChip(`📄 ${req.reqDoc.name}`, req.reqDoc.name);
  return bar;
}

// ---- 归档期（phase=archiving）：档案预览 + 备注表单 ----

/** 档案预览：开发文档终稿版次 / 分支数 / BUG 统计，全部从记录字段本地拼装，不调后端新接口 */
function renderArchivePreview(req) {
  const versions = req.devDoc?.versions || [];
  const finalVersion = versions.length ? Math.max(...versions.map((v) => v.v)) : 0;
  const bugs = req.bugs || [];
  const countByStatus = (status) => bugs.filter((b) => b.status === status).length;

  const box = document.createElement('div');
  box.className = 'req-archive-preview';
  const rows = [
    ['开发文档终稿', finalVersion ? `v${finalVersion}` : '（无）'],
    ['分支数', String((req.branches || []).length)],
    ['BUG 处理', `修复 ${countByStatus('fixed')} · 忽略 ${countByStatus('ignored')} · 失败 ${countByStatus('failed')}`],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'req-archive-preview-row';
    const l = document.createElement('span');
    l.className = 'req-archive-preview-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'req-archive-preview-value';
    v.textContent = value;
    row.append(l, v);
    box.appendChild(row);
  }
  return box;
}

function renderArchivingPage(req) {
  const wrap = document.createElement('div');
  wrap.className = 'req-archiving-page';
  wrap.appendChild(renderReadonlyChipsBar(req));

  const hint = document.createElement('div');
  hint.className = 'req-archive-hint';
  hint.textContent = '对话已禁用。请填写本次需求的改动备注/注意事项，确认后归入档案。';
  wrap.appendChild(hint);

  wrap.appendChild(renderArchivePreview(req));

  const label = document.createElement('div');
  label.className = 'req-archive-note-label';
  label.textContent = '改动备注 / 注意事项';
  wrap.appendChild(label);

  const ta = document.createElement('textarea');
  ta.className = 'req-archive-note-textarea';
  ta.placeholder = '本次需求的改动备注、注意事项…（将写入档案，供日后查阅）';
  ta.value = archiveNoteDraft; // 回填持久草稿：同 supplementDraftText 思路
  ta.addEventListener('input', () => {
    archiveNoteDraft = ta.value;
  });
  wrap.appendChild(ta);

  // 按钮行：[优化汇总] 和 [确认归档]
  const btnRow = document.createElement('div');
  btnRow.className = 'req-archive-button-row';

  const retroBtn = document.createElement('button');
  retroBtn.type = 'button';
  retroBtn.className = 'btn req-retro-summary-btn';
  retroBtn.textContent = '✨ 优化汇总';
  retroBtn.onclick = () => startRetroSummary(req.id);
  btnRow.appendChild(retroBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn primary req-archive-confirm-btn';
  confirmBtn.textContent = '📦 确认归档';
  confirmBtn.onclick = () => confirmArchive(req.id, confirmBtn);
  btnRow.appendChild(confirmBtn);

  wrap.appendChild(btnRow);

  return wrap;
}

async function confirmArchive(id, btn) {
  const ok = await confirmDialog({
    title: '确认归档',
    message: '归档后本需求转为只读档案，不可再修改。确认继续？',
    confirmText: '确认归档',
  });
  if (!ok) return;
  if (btn) btn.disabled = true; // 请求在途禁用：防手抖连点触发并发归档（后端 archiving Set 兜底，前端先挡一道）
  let status, d;
  try {
    const r = await fetch('/api/req/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, note: archiveNoteDraft }),
    });
    status = r.status;
    d = await r.json().catch(() => ({}));
  } catch {
    window.toast.error('网络错误');
    if (btn) btn.disabled = false;
    return;
  }
  if (status === 200 && d.ok) {
    window.toast.success('已归档');
    archiveNoteDraft = ''; // 提交成功：清空草稿
    await loadAndRenderReq(id); // 重开：phase 已变 archived，整页替换为只读档案页，无需再手动恢复按钮
    return;
  }
  if (btn) btn.disabled = false; // 失败（如 409 排队中）：恢复可点，允许用户重试
  window.toast.error(d.error || '归档失败');
}

// ---- 优化汇总流程（Task 5）----

/**
 * 启动优化汇总流程：创建 retro 会话 → 打开 → 开始 map-reduce 编排。
 * @param {string} reqId 需求 ID
 */
async function startRetroSummary(reqId) {
  const req = currentReq;
  if (!req || req.phase !== 'archiving') {
    window.toast.error('仅在归档期可启动汇总');
    return;
  }

  // 获取工程目录（前后端优先）
  const cwd = req.projects?.frontend?.dir || req.projects?.backend?.dir || '';

  try {
    // 拉取现有的避坑清单（前后端）
    const existingPitfalls = await fetchExistingPitfalls(
      req.projects?.frontend?.dir,
      req.projects?.backend?.dir
    );

    // 创建 retro 会话（不使用种子，直接喂转录）
    const retroConvId = createReqConv({
      reqId: reqId,
      cwd: cwd,
      session: null,
      title: '优化汇总',
      kind: 'retro',
      seedPending: false,
      seedText: '',
    });

    // 注册到后端
    const r = await fetch('/api/req/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, convId: retroConvId, title: '优化汇总', kind: 'retro' }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      window.toast.error(d.error || '注册会话失败');
      return;
    }

    // 打开 retro 会话
    openConv(retroConvId);

    // 重渲侧栏树
    if (window._updateReqList) window._updateReqList();

    // 启动 map-reduce 编排
    runRetroMapReduce(reqId, retroConvId, cwd, existingPitfalls);
  } catch (e) {
    window.toast.error('启动汇总失败：' + (e?.message || e));
    console.error('[startRetroSummary]', e);
  }
}

/**
 * 拉取指定工程目录的现有避坑清单。
 * @param {string} frontendDir 前端工程目录（可选）
 * @param {string} backendDir 后端工程目录（可选）
 * @returns {Promise<{frontend: string, backend: string}>} 拉到的内容（失败时为空串）
 */
async function fetchExistingPitfalls(frontendDir, backendDir) {
  const result = { frontend: '', backend: '' };

  try {
    // 前端避坑清单
    if (frontendDir) {
      const feRes = await fetch(`/api/req/pitfalls/get?dir=${encodeURIComponent(frontendDir)}`);
      if (feRes.ok) {
        const feData = await feRes.json();
        result.frontend = feData.content || '';
      }
    }

    // 后端避坑清单
    if (backendDir) {
      const beRes = await fetch(`/api/req/pitfalls/get?dir=${encodeURIComponent(backendDir)}`);
      if (beRes.ok) {
        const beData = await beRes.json();
        result.backend = beData.content || '';
      }
    }
  } catch (e) {
    // 失败时静默忽略，不中止流程（可选信息）
    console.warn('[fetchExistingPitfalls]', e?.message);
  }

  return result;
}

/**
 * 执行 map-reduce 汇总流程。
 * map：逐会话拉转录、喂入提示词、收小结。
 * reduce：聚合小结、接收回复、提取标记块。
 * @param {string} reqId 需求 ID
 * @param {string} retroConvId retro 会话 ID
 * @param {string} cwd 工程目录
 * @param {{frontend: string, backend: string}} existingPitfalls 项目现有的前后端避坑清单（可选）
 */
async function runRetroMapReduce(reqId, retroConvId, cwd, existingPitfalls = {}) {
  // 拉取最新需求信息（含 sessions）
  let req;
  try {
    const res = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
    req = await res.json();
    if (!res.ok || !req) {
      window.toast.error('获取需求信息失败');
      return;
    }
  } catch (e) {
    window.toast.error('网络错误：获取需求信息失败');
    console.error(e);
    return;
  }

  const sessions = req.sessions || [];
  // 过滤出有效会话（非 retro，且有 sessionId）
  const validSessions = sessions.filter((s) => s.kind !== 'retro' && s.sessionId);

  if (validSessions.length === 0) {
    window.toast.error('无有效会话可汇总');
    return;
  }

  // ★ MAP 阶段：逐会话拉转录、生成小结
  const mapMessages = [];
  for (let i = 0; i < validSessions.length; i++) {
    const session = validSessions[i];
    const progress = `[${i + 1}/${validSessions.length}]`;

    try {
      // 拉转录
      const histRes = await fetch(
        '/api/history/' +
          encodeURIComponent(session.sessionId) +
          '?cwd=' +
          encodeURIComponent(cwd)
      );
      const hist = await histRes.json();
      if (!histRes.ok || !hist.data?.messages) {
        window.toast.warn(`${progress} 拉转录失败，跳过该会话`);
        continue;
      }

      // 构造转录文本
      let transcript = (hist.data.messages || [])
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n\n');

      // 截断保护：超 30000 字符时首尾各取 15000
      const TRUNCATE_LIMIT = 30000;
      if (transcript.length > TRUNCATE_LIMIT) {
        const truncated = Math.floor(TRUNCATE_LIMIT / 2);
        const ellipsis = `…（已截断 ${transcript.length - TRUNCATE_LIMIT} 字符）…`;
        transcript = transcript.slice(0, truncated) + ellipsis + transcript.slice(-truncated);

        // 提示用户
        window.toast.info(`${progress} 转录已截断，详见 retro 会话消息`);

        // 在 retro 会话里显示截断提示
        addMessage(retroConvId, {
          role: 'system',
          content: `[提示] 会话"${session.title}"转录超 30KB，已截断`,
        });
      }

      // 生成 map 提示词（调用服务端生成或客户端拼装）
      const mapPrompt = buildClientRetroMapPrompt(session.title, transcript, i + 1, validSessions.length);

      // 发送 map 消息到 retro 会话
      await sendMessageToConv(retroConvId, mapPrompt);

      // 等待 run 完成，收集 assistant 回复
      const mapResult = await waitForRunCompletion(retroConvId);
      mapMessages.push({ role: 'assistant', content: mapResult });

      // 单会话小结完成，显示进度
      window.toast.success(`${progress} 会话已处理`);
    } catch (e) {
      window.toast.warn(`${progress} 处理失败：${e?.message || e}`);
      console.error(`[MAP ${i + 1}]`, e);
    }
  }

  if (mapMessages.length === 0) {
    window.toast.error('未能收集任何会话小结，汇总中止');
    return;
  }

  // ★ REDUCE 阶段：聚合分析
  try {
    const reducePrompt = buildClientRetroReducePrompt(mapMessages, existingPitfalls);
    await sendMessageToConv(retroConvId, reducePrompt);

    const reduceResult = await waitForRunCompletion(retroConvId);

    // 保存完整报告到 currentReq.retro
    if (currentReq && currentReq.id === reqId) {
      const { report } = extractPitfallsBlock(reduceResult);
      currentReq.retro = report;
    }

    // 提取标记块
    const { pitfallsText } = extractPitfallsBlock(reduceResult);
    if (!pitfallsText) {
      // 改为正常情况：未提炼出新避坑项（可能都是已知问题），不中止，允许用户跳过或手动添加
      window.toast.info('本次开发未提炼出新避坑项（可能都是已知问题）');
    }

    // 预览确认（即使 pitfallsText 为空也弹出，让用户看到"无新内容"并确认或手动编辑）
    await showPitfallsPreviewDialog(reqId, pitfallsText || '');
  } catch (e) {
    window.toast.error('reduce 阶段失败：' + (e?.message || e));
    console.error('[REDUCE]', e);
  }
}

/**
 * 向会话发送消息（后台发送，不产生用户气泡）。
 * Task 5.4：改为调用真实 API（chat.js 的 sendMessageBackground）。
 * @param {string} convId 会话 ID
 * @param {string} text 消息文本
 * @returns {Promise<void>}
 */
async function sendMessageToConv(convId, text) {
  try {
    const { sendMessageBackground } = await import('./chat.js');
    return await sendMessageBackground(convId, text);
  } catch (err) {
    console.error('Failed to send message to conversation:', err);
    throw err;
  }
}

/**
 * 等待会话的当前 run 完成，返回最后一条 assistant 消息内容。
 * @param {string} convId 会话 ID
 * @returns {Promise<string>} assistant 消息内容
 */
async function waitForRunCompletion(convId) {
  return new Promise((resolve, reject) => {
    const checkCompletion = setInterval(() => {
      const list = loadConvs();
      const conv = list.find((c) => c.id === convId);
      if (!conv) {
        clearInterval(checkCompletion);
        reject(new Error(`Conv ${convId} not found`));
        return;
      }

      // 若当前没有运行中的 run，说明完成了
      if (!isConvRunning(convId) && conv.messages.length > 0) {
        clearInterval(checkCompletion);
        // 找最后一条 assistant 消息
        for (let i = conv.messages.length - 1; i >= 0; i--) {
          if (conv.messages[i].role === 'assistant') {
            resolve(conv.messages[i].content);
            return;
          }
        }
        reject(new Error('No assistant message found'));
      }
    }, 500);

    // 超时保护（5 分钟）
    setTimeout(() => {
      clearInterval(checkCompletion);
      reject(new Error('Timeout waiting for run completion'));
    }, 5 * 60 * 1000);
  });
}

/**
 * 向会话添加系统消息（不通过聊天界面）。
 * @param {string} convId 会话 ID
 * @param {object} msg 消息对象 { role, content, timestamp? }
 */
function addMessage(convId, msg) {
  const list = loadConvs();
  const conv = list.find((c) => c.id === convId);
  if (!conv) return;

  conv.messages.push({
    ...msg,
    timestamp: msg.timestamp || Date.now(),
  });

  // 不调 saveConvs，由上层调用者决定是否保存
}

/**
 * 客户端生成 map 阶段提示词。
 * @param {string} sessionTitle 会话名称
 * @param {string} transcript 会话转录
 * @param {number} sessionIndex 会话序号（1-based）
 * @param {number} totalSessions 总会话数
 * @returns {string} map 提示词
 */
function buildClientRetroMapPrompt(sessionTitle, transcript, sessionIndex, totalSessions) {
  return (
    `【会话 ${sessionIndex}/${totalSessions}】"${sessionTitle || '未命名'}"\n` +
    `以下是该会话的完整对话记录，请简要小结：\n` +
    `1. AI 做了什么\n` +
    `2. 踩过什么坑\n` +
    `3. 用户如何纠正\n\n` +
    `不要展开细节，仅 2-3 句，不含 PITFALLS 块。\n\n` +
    `${transcript}`
  );
}

/**
 * 客户端生成 reduce 阶段提示词。
 * @param {Array<{role: string, content: string}>} mapMessages map 阶段的消息数组
 * @param {{frontend: string, backend: string}} existingPitfalls 项目现有的前后端避坑清单（可选）
 * @returns {string} reduce 提示词
 */
function buildClientRetroReducePrompt(mapMessages, existingPitfalls = {}) {
  const summaries = mapMessages
    .filter((m) => m.role === 'assistant')
    .map((m, i) => `${i + 1}. ${m.content}`)
    .join('\n\n');

  // 拼接现有避坑清单的上下文
  let historicalContext = '';
  if (existingPitfalls.frontend || existingPitfalls.backend) {
    historicalContext = '\n## 项目已知的避坑清单（历史沉淀）\n';
    if (existingPitfalls.frontend) {
      historicalContext += `### 前端\n${existingPitfalls.frontend}\n\n`;
    }
    if (existingPitfalls.backend) {
      historicalContext += `### 后端\n${existingPitfalls.backend}\n\n`;
    }
  }

  return (
    `上述 ${mapMessages.length} 个会话的开发过程你已逐一回顾：\n\n` +
    `${summaries}\n\n` +
    `---\n\n` +
    `请识别这次开发中暴露的 **可复用的规则与坑**。\n\n` +
    `判断标准：\n` +
    `- 若某坑与下述项目历史反复出现 → 重点标注为【高频印证】\n` +
    `- 若是新坑 → 标注为【新增】\n` +
    `- 只出现一次但确实有借鉴价值 → 也可列入，由 dev/qa 筛选余地\n` +
    historicalContext +
    `\n最后，请在回答末尾输出一个固定标记块，格式如下（可为空，但必须包含结构）：\n\n` +
    `\`\`\`\n` +
    `<!-- PITFALLS-BEGIN -->\n` +
    `- [前端] <可执行的避坑规则，带定位信息>\n` +
    `- [后端] <可执行的避坑规则，带定位信息>\n` +
    `<!-- PITFALLS-END -->\n` +
    `\`\`\`\n\n` +
    `标记块之外的全部正文 = 完整回顾报告，标记块之内的条目将被提取、预览确认、写入各工程的 \`.claude/pitfalls.md\`。` +
    `每条避坑项须：\n` +
    `1. 以 [前端] 或 [后端] 前缀标注归属（仅开发工程会被写入）\n` +
    `2. 包含定位信息（文件名/函数名/关键词）\n` +
    `3. 清晰可执行（不泛泛而谈）`
  );
}

/**
 * 从文本中提取 PITFALLS 标记块。
 * @param {string} text 完整回复
 * @returns {object} { report, pitfallsText } 或 { report, pitfallsText: null }
 */
function extractPitfallsBlock(text) {
  const match = text.match(/<!-- PITFALLS-BEGIN -->([\s\S]*?)<!-- PITFALLS-END -->/);

  let report = text;
  let pitfallsText = null;

  if (match) {
    pitfallsText = match[1].trim();
    report = text.replace(/<!-- PITFALLS-BEGIN -->[\s\S]*?<!-- PITFALLS-END -->/, '').trim();
  }

  return { report, pitfallsText };
}

/**
 * 解析避坑条目文本（markdown 列表格式），分前后端。
 * @param {string} pitfallsText 标记块内文本
 * @returns {object} { frontend: [], backend: [], unknown: [] }
 */
function parsePitfallsItems(pitfallsText) {
  if (!pitfallsText) return { frontend: [], backend: [], unknown: [] };

  const items = pitfallsText
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line.length > 0);

  const frontend = [];
  const backend = [];
  const unknown = [];

  for (const item of items) {
    if (item.startsWith('[前端]')) {
      frontend.push(item.replace(/^\[前端\]\s*/, ''));
    } else if (item.startsWith('[后端]')) {
      backend.push(item.replace(/^\[后端\]\s*/, ''));
    } else {
      unknown.push(item);
    }
  }

  return { frontend, backend, unknown };
}

/**
 * 显示避坑条目预览确认框。
 * 用户可编辑/删除条目，最后确认才会写盘。
 * @param {string} reqId 需求 ID
 * @param {string} pitfallsText 标记块内原始文本
 */
async function showPitfallsPreviewDialog(reqId, pitfallsText) {
  const { frontend, backend, unknown } = parsePitfallsItems(pitfallsText);

  // 检查目标工程是否存在且可写
  const req = currentReq;
  if (!req) {
    window.toast.error('无法读取需求信息');
    return;
  }

  const frontendDir = req.projects?.frontend?.dir;
  const backendDir = req.projects?.backend?.dir;
  const frontendDev = req.projects?.frontend?.dev;
  const backendDev = req.projects?.backend?.dev;

  // 构造预览文本（带前后端分类与工程校验）
  const previewLines = [];

  if (frontend.length > 0) {
    if (!frontendDir) {
      previewLines.push(`[⚠️ 前端工程缺失，以下条目将丢弃]`);
      frontend.forEach((item) => previewLines.push(`- [前端] ${item}`));
    } else if (!frontendDev) {
      previewLines.push(`[⚠️ 前端工程为只读，以下条目将丢弃]`);
      frontend.forEach((item) => previewLines.push(`- [前端] ${item}`));
    } else {
      previewLines.push(`[✓ 前端工程] 将写入 ${frontendDir}/.claude/pitfalls.md`);
      frontend.forEach((item) => previewLines.push(`- ${item}`));
    }
    previewLines.push('');
  }

  if (backend.length > 0) {
    if (!backendDir) {
      previewLines.push(`[⚠️ 后端工程缺失，以下条目将丢弃]`);
      backend.forEach((item) => previewLines.push(`- [后端] ${item}`));
    } else if (!backendDev) {
      previewLines.push(`[⚠️ 后端工程为只读，以下条目将丢弃]`);
      backend.forEach((item) => previewLines.push(`- [后端] ${item}`));
    } else {
      previewLines.push(`[✓ 后端工程] 将写入 ${backendDir}/.claude/pitfalls.md`);
      backend.forEach((item) => previewLines.push(`- ${item}`));
    }
    previewLines.push('');
  }

  if (unknown.length > 0) {
    previewLines.push(`[⚠️ 警告] 以下条目无 [前端]/[后端] 前缀，将被忽略`);
    unknown.forEach((item) => previewLines.push(`- ${item}`));
    previewLines.push('');
  }

  const previewText = previewLines.join('\n');

  // 弹出可编辑的 textareaDialog
  const edited = await textareaDialog({
    title: '预览避坑条目（可编辑）',
    message: '确认后将写入工程的 .claude/pitfalls.md',
    value: previewText,
    placeholder: '可删除不需要的行或修改内容',
    confirmText: '确认写盘',
    cancelText: '取消',
  });

  if (edited === null) {
    // 用户取消
    window.toast.info('已取消，条目未保存');
    return;
  }

  // 用户确认，解析编辑后的内容
  const { frontend: frontendFinal, backend: backendFinal } = parsePitfallsItems(edited);

  // 写盘
  await submitPitfalls(reqId, frontendFinal, backendFinal, frontendDir, backendDir, frontendDev, backendDev);
}

/**
 * 实际写盘 pitfalls。
 * @param {string} reqId 需求 ID
 * @param {Array<string>} frontendItems 前端避坑条目
 * @param {Array<string>} backendItems 后端避坑条目
 * @param {string} frontendDir 前端工程目录
 * @param {string} backendDir 后端工程目录
 * @param {boolean} frontendDev 前端工程是否开发态
 * @param {boolean} backendDev 后端工程是否开发态
 */
async function submitPitfalls(reqId, frontendItems, backendItems, frontendDir, backendDir, frontendDev, backendDev) {
  try {
    const res = await fetch('/api/req/pitfalls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: reqId,
        frontend: frontendDev ? frontendItems : [],
        backend: backendDev ? backendItems : [],
      }),
    });

    if (res.ok) {
      const total = (frontendDev ? frontendItems.length : 0) + (backendDev ? backendItems.length : 0);
      window.toast.success(`已写入 ${total} 条避坑规则`);
    } else {
      const d = await res.json().catch(() => ({}));
      window.toast.error('写盘失败：' + (d.error || res.statusText));
    }
  } catch (e) {
    window.toast.error('写盘异常：' + (e?.message || e));
    console.error('[submitPitfalls]', e);
  }
}

// ---- 归档期（phase=archived）：只读档案页 ----

function renderArchivedPage(req) {
  const wrap = document.createElement('div');
  wrap.className = 'req-archived-page';

  const meta = document.createElement('div');
  meta.className = 'req-archived-meta';
  meta.textContent = `归档时间：${fmtTime(req.archive?.archivedAt)}`;
  wrap.appendChild(meta);

  // 备注不再单独渲染一块：buildArchiveSummary 已把它写进 summary 的「## 备注」节，
  // 这里的 markdown 正文渲染已经包含，重复展示是信息冗余。
  const content = document.createElement('div');
  content.className = 'req-doc-content';
  renderMarkdown(content, req.archive?.summary || '（无档案内容）');
  wrap.appendChild(content);

  return wrap;
}

function renderDiscardedPage(req) {
  const wrap = document.createElement('div');
  wrap.className = 'req-discarded-page';
  const meta = document.createElement('div');
  meta.className = 'req-archived-meta';
  meta.textContent = '此需求已废弃，仅保留记录供查阅。';
  wrap.appendChild(meta);
  const content = document.createElement('div');
  content.className = 'req-doc-content';
  renderMarkdown(content, req.devDocLatest || req.archive?.summary || '（无内容）');
  wrap.appendChild(content);
  return wrap;
}

// ---- 评审期：顶部芯片条 ----

function renderChipsBar(req) {
  const bar = document.createElement('div');
  bar.className = 'req-chips';
  bar.appendChild(makeProjectChip(req, 'frontend', req.projects?.frontend));
  bar.appendChild(makeProjectChip(req, 'backend', req.projects?.backend));
  bar.appendChild(makeReqDocChip(req, req.reqDoc));

  // 功能标签 chip（仅在 devDoc 至少有一版后才显示——docgen 完成才有标签）
  if (req.devDoc?.versions?.length) {
    bar.appendChild(makeFeatureTagChip(req));
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn req-edit-config-btn';
  editBtn.textContent = '✏️ 编辑配置';
  editBtn.onclick = () => openConfigModal(req);
  bar.appendChild(editBtn);
  return bar;
}

// 三处 chip 点击都统一传本次渲染闭包里的 req（而非读取模块级 currentReq）——
// 保证弹层打开的永远是「用户当前正看着的这份数据」，不受后续异步刷新提前改写 currentReq 影响。
function makeProjectChip(req, key, p) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'req-chip' + (p ? '' : ' req-chip-empty');
  if (p) {
    chip.textContent = `🖥 ${dirTail(p.dir)} · ${p.dev ? '开发' : '只读'}`;
    chip.title = p.dir;
  } else {
    chip.textContent = key === 'frontend' ? '＋ 前端工程' : '＋ 后端工程';
  }
  chip.onclick = () => openConfigModal(req);
  return chip;
}

function makeReqDocChip(req, reqDoc) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'req-chip' + (reqDoc ? '' : ' req-chip-empty');
  chip.textContent = reqDoc ? `📄 ${reqDoc.name}` : '＋ 需求文档';
  if (reqDoc) chip.title = reqDoc.name;
  chip.onclick = () => openConfigModal(req);
  return chip;
}

/** 功能模块标签 chip：展示模式 + 编辑模式 */
function makeFeatureTagChip(req) {
  const chip = document.createElement('div');
  chip.className = 'req-chip req-chip--tag';
  chip.dataset.reqId = req.id;

  function renderTagChip(tag) {
    chip.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'req-chip__label';
    label.textContent = `功能模块：${tag || '未识别'}`;
    chip.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'req-chip__edit';
    editBtn.title = '修改功能模块标签';
    editBtn.textContent = '✏️';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      showTagEditMode(tag);
    };
    chip.appendChild(editBtn);
  }

  function showTagEditMode(currentTag) {
    chip.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'req-chip__input';
    input.type = 'text';
    input.value = currentTag || '';
    input.placeholder = '如：宝宝辅食';
    input.maxLength = 20;
    chip.appendChild(input);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'req-chip__save';
    saveBtn.textContent = '保存';
    saveBtn.onclick = async () => {
      const newTag = input.value.trim();
      try {
        const res = await fetch('/api/req/feature-tag', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: req.id, tag: newTag }),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => '未知错误');
          throw new Error(err);
        }
        renderTagChip(newTag || null);
      } catch (e) {
        // 显示错误不离开编辑模式
        input.style.borderColor = 'red';
        input.title = e.message;
        window.toast?.error('保存失败：' + e.message);
      }
    };
    chip.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'req-chip__cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => renderTagChip(currentTag);
    chip.appendChild(cancelBtn);

    input.focus();
    input.select();
  }

  renderTagChip(req.featureTag);
  return chip;
}

// ---- 评审期：错误条 / busy 进度条 ----

function renderErrorBanner(req) {
  const last = (req.history || []).at(-1);
  if (!last || !/失败|被拒|中断/.test(last.event)) return null;
  const bar = document.createElement('div');
  bar.className = 'req-error-banner';
  const text = document.createElement('span');
  text.textContent = last.event;
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn danger';
  retryBtn.textContent = '重试';
  retryBtn.onclick = () => runDocgen(req.id);
  bar.append(text, retryBtn);
  return bar;
}

function renderBusyBar(req) {
  if (!req.busy) return null;
  const bar = document.createElement('div');
  bar.className = 'req-busy-bar';
  const spin = document.createElement('span');
  spin.className = 'req-busy-spin';
  const text = document.createElement('span');
  // busy 条每 3s 随轮询整页重建，据 startedAt 现算已运行时长，让「生成中」有可见进度、不显得假死。
  // docgen 需实际读工程 + 生成长文档，大型工程或遇账号限流时耗时可达十几分钟，故明确提示可离开。
  const startedAt = req.busy.startedAt;
  const mins = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 60000)) : 0;
  const elapsed = startedAt ? `（已运行 ${mins} 分钟）` : '';
  text.textContent = `⚙ 开发文档生成中…${elapsed} 首次生成需实际阅读工程代码，通常几分钟、大型工程更久，可先离开，完成后回来查看。`;
  bar.append(spin, text);
  return bar;
}

// ---- 评审期：文档区（空态 / 版本页签 / 总结 / 正文 / 定稿） ----

/**
 * 格式化 docgen 耗时（毫秒 → "2m 35s" 或 "45s"）
 */
function formatDocgenDuration(ms) {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function renderDocArea(req) {
  const box = document.createElement('div');
  box.className = 'req-doc-area';
  const versions = req.devDoc?.versions || [];
  if (!versions.length) {
    box.appendChild(renderDocEmptyState(req));
    // 空态也要展示通知选项：用户须在点「生成」之前就能勾上，否则首次生成完成的通知收不到
    if (req.phase === 'review') box.appendChild(renderNotifyOption(req));
    return box;
  }

  const latestV = Math.max(...versions.map((v) => v.v));
  const activeV = docOverride && versions.some((v) => v.v === docOverride.v) ? docOverride.v : latestV;
  const activeEntry = versions.find((v) => v.v === activeV);
  const showingLatest = activeV === latestV && !docOverride;
  const content = showingLatest ? req.devDocLatest ?? '' : docOverride?.content ?? '';

  const tabsBar = document.createElement('div');
  tabsBar.className = 'req-doc-tabs-bar';
  for (const v of versions) {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = 'req-doc-vtab' + (v.v === activeV ? ' active' : '');
    tabBtn.textContent = 'v' + v.v;
    tabBtn.onclick = () => selectDocVersion(req, v.v, latestV);
    tabsBar.appendChild(tabBtn);
  }
  if (req.phase === 'review' && showingLatest) {
    const finalizeBtn = document.createElement('button');
    finalizeBtn.type = 'button';
    finalizeBtn.className = 'btn primary req-finalize-btn';
    finalizeBtn.textContent = '✓ 定稿，进入开发期';
    finalizeBtn.disabled = !!req.busy;
    finalizeBtn.onclick = () => startFinalizeFlow(req.id);
    tabsBar.appendChild(finalizeBtn);
  }
  box.appendChild(tabsBar);

  if (activeEntry?.summary) {
    const sum = document.createElement('div');
    sum.className = 'req-doc-summary';
    const label = document.createElement('div');
    label.className = 'req-doc-summary-label';
    label.textContent = '📝 摘要';
    const body = document.createElement('div');
    body.className = 'req-doc-summary-body';
    renderMarkdown(body, activeEntry.summary);
    sum.append(label, body);
    box.appendChild(sum);
  }

  // 统计信息（仅最新版本，若有耗时数据则显示）
  if (showingLatest && activeEntry?.ms) {
    const stats = document.createElement('div');
    stats.className = 'req-doc-stats';
    const timeStr = formatDocgenDuration(activeEntry.ms);
    const inputK = ((activeEntry.inputTokens || 0) / 1000).toFixed(1);
    const outputK = ((activeEntry.outputTokens || 0) / 1000).toFixed(1);
    stats.textContent = `耗时 ${timeStr} · 输入 ${inputK}k tokens · 输出 ${outputK}k tokens`;
    box.appendChild(stats);
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'req-doc-content';
  renderMarkdown(contentEl, content);
  box.appendChild(contentEl);

  // 通知选项（仅评审期显示）
  if (req.phase === 'review') box.appendChild(renderNotifyOption(req));

  return box;
}

/** 通知选项行（仅评审期调用）：勾选后生成完成时经机器人推送。空态与有版本两个分支共用。 */
function renderNotifyOption(req) {
  const notifyBox = document.createElement('div');
  notifyBox.className = 'req-notify-option';
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.id = `notify-chk-${req.id}`;
  chk.className = 'pretty-check';
  chk.checked = !!req.notifyBotId;
  const label = document.createElement('label');
  label.htmlFor = `notify-chk-${req.id}`;
  label.className = 'req-notify-label';
  label.textContent = '完成后通过机器人通知我';
  const dropdown = document.createElement('select');
  dropdown.className = 'req-notify-dropdown';
  dropdown.hidden = !req.notifyBotId;
  dropdown.onchange = () => {
    saveNotifyBotId(req.id, dropdown.value || null);
  };
  chk.onchange = () => {
    dropdown.hidden = !chk.checked;
    if (!chk.checked) {
      saveNotifyBotId(req.id, null);
    } else if (!dropdown._bots) {
      // 首次勾选时异步加载机器人列表
      loadBotsForNotify(dropdown, req.notifyBotId);
    }
  };
  notifyBox.append(chk, label, dropdown);
  // 初始加载：若已配置则立即填充机器人列表
  if (req.notifyBotId) {
    loadBotsForNotify(dropdown, req.notifyBotId);
  }
  return notifyBox;
}

/**
 * 加载机器人列表填充下拉（仅加载一次，缓存在 dropdown._bots）
 * @param {HTMLSelectElement} dropdown
 * @param {string|null} selectedBotId - 当前选中的 bot id（用于还原选中态）
 */
async function loadBotsForNotify(dropdown, selectedBotId) {
  if (dropdown._bots) return; // 已加载过，直接使用缓存
  try {
    const r = await fetch('/api/bots');
    const d = await r.json();
    const bots = (d.bots || []).filter((b) => b.enabled !== false);
    dropdown._bots = bots;
    dropdown.innerHTML = '';
    if (!bots.length) {
      const opt = document.createElement('option');
      opt.textContent = '（暂无可用机器人，请先在设置中创建）';
      opt.value = '';
      dropdown.appendChild(opt);
      return;
    }
    for (const bot of bots) {
      const opt = document.createElement('option');
      opt.value = bot.id;
      opt.textContent = bot.name || `机器人 ${bot.id}`;
      if (bot.id === selectedBotId) opt.selected = true;
      dropdown.appendChild(opt);
    }
    // 若未选中任何，默认选第一个并立即保存（父级 req.id 通过 dropdown 的 onchange 机制获取）
    if (!selectedBotId && bots.length) {
      dropdown.selectedIndex = 0;
      // 触发 onchange 以保存默认选中值
      dropdown.dispatchEvent(new Event('change'));
    }
  } catch (e) {
    window.toast?.error('加载机器人列表失败');
  }
}

/**
 * 保存 notifyBotId 到后端需求记录
 * @param {string} reqId
 * @param {string|null} botId
 */
async function saveNotifyBotId(reqId, botId) {
  try {
    const r = await fetch('/api/req/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, notifyBotId: botId }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast?.error(d.error || '保存失败');
    // 静默成功（不弹 toast，避免频繁通知）
  } catch {
    window.toast?.error('网络错误');
  }
}

async function selectDocVersion(req, v, latestV) {
  if (v === latestV) {
    docOverride = null;
    renderReqPage(currentReq);
    return;
  }
  try {
    const r = await fetch(`/api/req/doc?id=${encodeURIComponent(req.id)}&v=${v}`);
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '读取版本失败');
    docOverride = { v, content: d.content };
    renderReqPage(currentReq);
  } catch {
    window.toast.error('网络错误');
  }
}

function renderDocEmptyState(req) {
  const wrap = document.createElement('div');
  wrap.className = 'req-doc-empty';
  const hint = document.createElement('div');
  hint.className = 'req-doc-empty-hint';
  hint.textContent = '尚未生成开发文档。配置好工程目录与需求文档后，点击下方按钮生成。';
  wrap.appendChild(hint);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn primary';
  btn.textContent = '生成开发文档';
  btn.disabled = !!req.busy;
  btn.onclick = () => runDocgen(req.id);
  wrap.appendChild(btn);
  return wrap;
}

async function runDocgen(id) {
  try {
    const r = await fetch('/api/req/docgen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json();
    if (r.status === 202) {
      window.toast.success('已开始生成开发文档');
      await loadAndRenderReq(id);
      return;
    }
    window.toast.error(d.error || '生成失败');
  } catch {
    window.toast.error('网络错误');
  }
}

// ---- 评审期：定稿 ----

async function startFinalizeFlow(id) {
  const ok = await confirmDialog({
    title: '定稿',
    message: '定稿后配置与文档冻结，将建需求分支并自动开始开发。确认继续？',
    confirmText: '定稿',
  });
  if (!ok) return;
  await finalizeAttempt(id, false);
}

async function finalizeAttempt(id, force) {
  let status, d;
  try {
    const r = await fetch('/api/req/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, force }),
    });
    status = r.status;
    d = await r.json();
  } catch {
    window.toast.error('网络错误');
    return;
  }
  if (status === 200 && d.ok) {
    window.toast.success(`已定稿（分支 ${d.branch}）`);
    await loadAndRenderReq(id); // 重开该需求：phase 已变为 dev，自动转入聊天模式（确保 conv 存在并回填 convId）
    return;
  }
  if (d.warn === 'dirty') {
    const proceed = await confirmDialog({
      title: '工程存在未提交改动',
      message: `以下工程有未提交改动，强制定稿将在当前状态上建分支：\n${(d.dirs || []).join('\n')}`,
      confirmText: '强制定稿',
      danger: true,
    });
    if (proceed) await finalizeAttempt(id, true);
    return;
  }
  window.toast.error(d.error || '定稿失败');
}

// ---- 评审期：配置弹层 ----

function projRowHtml(key, label) {
  return (
    `<div class="req-proj-row" data-key="${key}">` +
    `<span class="req-proj-label">${label}</span>` +
    `<input class="req-proj-dir" placeholder="工程目录，如 C:\\path\\to\\project" autocomplete="off" />` +
    `<button type="button" class="btn dir-pick-btn req-proj-pick" title="选择文件夹">选择</button>` +
    `<label class="req-proj-dev-label"><input type="checkbox" class="pretty-check req-proj-dev" /> 开发工程</label>` +
    `<button type="button" class="btn req-proj-clear">清除</button>` +
    `</div>`
  );
}

function openConfigModal(req) {
  // 仅评审期可编辑；chips 条本身也只在评审期渲染，此处保留守卫防御非常规调用路径。
  if (!req || req.phase !== 'review') return;
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal req-config-modal">' +
    '<div class="head"><h3>需求配置</h3><button class="close">✕</button></div>' +
    '<div class="body">' +
    '<div class="sec-label">工程</div>' +
    projRowHtml('frontend', '前端工程') +
    projRowHtml('backend', '后端工程') +
    '<div class="sec-label" style="margin-top:16px;">需求文档</div>' +
    '<div class="req-doc-tabs">' +
    '<button type="button" class="req-doc-tab-btn active" data-tab="text">粘贴文本</button>' +
    '<button type="button" class="req-doc-tab-btn" data-tab="file">上传文件</button>' +
    '</div>' +
    '<div class="req-doc-tab-panel" data-panel="text">' +
    '<textarea class="req-doc-textarea" rows="8" placeholder="粘贴需求文档全文…"></textarea>' +
    '</div>' +
    '<div class="req-doc-tab-panel" data-panel="file" hidden>' +
    '<input type="file" class="req-doc-file-input" />' +
    '<div class="req-doc-file-status"></div>' +
    '</div>' +
    '</div>' +
    '<div class="confirm-foot"><button class="btn cancel">取消</button><button class="btn primary save">保存</button></div>' +
    '</div>';
  document.body.appendChild(mask);

  // 回填工程行现值
  for (const key of ['frontend', 'backend']) {
    const p = req.projects?.[key];
    if (!p) continue;
    const row = mask.querySelector(`.req-proj-row[data-key="${key}"]`);
    row.querySelector('.req-proj-dir').value = p.dir;
    row.querySelector('.req-proj-dev').checked = !!p.dev;
  }
  // 目录「选择」/「清除」：复用 /api/dirs/pick 原生对话框（与设置页机器人项目文件夹同一模式）
  mask.querySelectorAll('.req-proj-row').forEach((row) => {
    const dirInput = row.querySelector('.req-proj-dir');
    const pickBtn = row.querySelector('.req-proj-pick');
    pickBtn.addEventListener('click', async () => {
      pickBtn.disabled = true;
      try {
        const r = await (await fetch('/api/dirs/pick')).json();
        if (r.path) dirInput.value = r.path;
        else if (r.error) window.toast.error(r.error);
      } catch {
        window.toast.error('调用系统对话框失败');
      } finally {
        pickBtn.disabled = false;
      }
    });
    row.querySelector('.req-proj-clear').addEventListener('click', () => {
      dirInput.value = '';
      row.querySelector('.req-proj-dev').checked = false;
    });
  });

  // 需求文档：文本/文件 tab 切换
  let docFileResult = null; // { name, path } | null，仅上传成功后才有值
  const tabBtns = [...mask.querySelectorAll('.req-doc-tab-btn')];
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      mask.querySelectorAll('.req-doc-tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== btn.dataset.tab));
    });
  });
  const fileInput = mask.querySelector('.req-doc-file-input');
  const fileStatus = mask.querySelector('.req-doc-file-status');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    docFileResult = null;
    fileStatus.textContent = '上传中…';
    try {
      const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
      const d = await r.json();
      if (!d.path) throw new Error(d.error || '上传失败');
      docFileResult = { name: d.name || file.name, path: d.path };
      fileStatus.textContent = '已选择：' + docFileResult.name;
    } catch (e) {
      fileStatus.textContent = '';
      window.toast.error('上传失败：' + (e?.message || e));
    }
  });

  const close = () => mask.remove();
  mask.querySelector('.close').addEventListener('click', close);
  mask.querySelector('.cancel').addEventListener('click', close);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });

  mask.querySelector('.save').addEventListener('click', async () => {
    const projects = {};
    for (const key of ['frontend', 'backend']) {
      const row = mask.querySelector(`.req-proj-row[data-key="${key}"]`);
      const dir = row.querySelector('.req-proj-dir').value.trim();
      projects[key] = dir ? { dir, dev: row.querySelector('.req-proj-dev').checked } : null;
    }
    const payload = { id: req.id, projects };
    const activeTab = tabBtns.find((b) => b.classList.contains('active'))?.dataset.tab;
    if (activeTab === 'text') {
      const text = mask.querySelector('.req-doc-textarea').value.trim();
      if (text) payload.reqDoc = { name: '需求文档.md', text };
    } else if (docFileResult) {
      payload.reqDoc = docFileResult;
    }
    try {
      const r = await fetch('/api/req/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) return window.toast.error(d.error || '保存失败');
      close();
      window.toast.success('配置已保存');
      await loadAndRenderReq(req.id);
    } catch {
      window.toast.error('网络错误');
    }
  });
}

// ---- 评审期：底部补充说明框 ----

function renderSupplementBox(req) {
  const box = document.createElement('div');
  box.className = 'req-supplement-box';

  const head = document.createElement('div');
  head.className = 'req-supplement-head';
  const count = (req.supplements || []).length;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'req-supplement-history-toggle';
  toggleBtn.textContent = `补充说明历史（${count}）`;
  toggleBtn.onclick = () => {
    supplementHistoryExpanded = !supplementHistoryExpanded;
    renderReqPage(currentReq);
  };
  head.appendChild(toggleBtn);
  box.appendChild(head);

  if (supplementHistoryExpanded && count) {
    const historyEl = document.createElement('div');
    historyEl.className = 'req-supplement-history';
    for (const s of req.supplements.slice().reverse()) historyEl.appendChild(renderSupplementHistoryItem(s));
    box.appendChild(historyEl);
  }

  const ta = document.createElement('textarea');
  ta.className = 'req-supplement-textarea';
  ta.placeholder = '补充说明…';
  ta.value = supplementDraftText; // 回填持久草稿：本函数会被 busy 轮询/版本切换/历史折叠反复调用
  ta.addEventListener('input', () => {
    supplementDraftText = ta.value;
  });
  box.appendChild(ta);

  const chipsRow = document.createElement('div');
  chipsRow.className = 'req-supplement-files';
  // 重渲染后按持久化的 supplementPendingFiles 重建已选/已上传的附件小标签
  for (const entry of supplementPendingFiles) {
    const chip = makeFileChip(entry.name, () => {
      const idx = supplementPendingFiles.indexOf(entry);
      if (idx >= 0) supplementPendingFiles.splice(idx, 1);
    });
    if (!entry.path) chip.classList.add('uploading');
    chipsRow.appendChild(chip);
  }
  box.appendChild(chipsRow);

  const footer = document.createElement('div');
  footer.className = 'req-supplement-footer';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'btn req-attach-btn';
  attachBtn.title = '添加附件';
  attachBtn.textContent = '📎';
  attachBtn.onclick = () => fileInput.click();

  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const f of files) {
      const entry = { name: f.name, path: null };
      supplementPendingFiles.push(entry);
      const chip = makeFileChip(f.name, () => {
        const idx = supplementPendingFiles.indexOf(entry);
        if (idx >= 0) supplementPendingFiles.splice(idx, 1);
      });
      chip.classList.add('uploading');
      chipsRow.appendChild(chip);
      try {
        const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        const d = await r.json();
        if (!d.path) throw new Error(d.error || '上传失败');
        entry.path = d.path;
        entry.name = d.name || f.name;
        chip.classList.remove('uploading');
      } catch (e) {
        const idx = supplementPendingFiles.indexOf(entry);
        if (idx >= 0) supplementPendingFiles.splice(idx, 1);
        chip.remove();
        window.toast.error('文件上传失败：' + (e?.message || e));
      }
    }
  });

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn primary';
  submitBtn.textContent = '提交补充说明';
  submitBtn.onclick = () => submitSupplement(req.id);
  footer.append(attachBtn, fileInput, submitBtn);
  box.appendChild(footer);

  return box;
}

function makeFileChip(name, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'req-file-chip';
  const label = document.createElement('span');
  label.className = 'req-file-chip-name';
  label.textContent = name;
  chip.appendChild(label);
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'req-file-chip-rm';
  rm.title = '移除';
  rm.textContent = '×';
  rm.onclick = () => {
    chip.remove();
    onRemove?.();
  };
  chip.appendChild(rm);
  return chip;
}

function renderSupplementHistoryItem(s) {
  const item = document.createElement('div');
  item.className = 'req-supplement-history-item';
  const time = document.createElement('div');
  time.className = 'req-supplement-history-time';
  time.textContent = fmtTime(s.at);
  const text = document.createElement('div');
  text.className = 'req-supplement-history-text';
  text.textContent = s.text || '(无文字，仅附件)';
  item.append(time, text);
  if ((s.files || []).length) {
    const files = document.createElement('div');
    files.className = 'req-supplement-history-files';
    files.textContent = '附件：' + s.files.map((f) => f.name).join('、');
    item.appendChild(files);
  }
  return item;
}

async function submitSupplement(id) {
  if (supplementPendingFiles.some((f) => !f.path)) {
    // 还有附件在途（上传未完成）：不能提交，否则会静默丢掉这个附件（f.path 为空不会被计入 files）
    return window.toast.error('附件还在上传中，请稍候再提交');
  }
  const text = supplementDraftText.trim();
  const files = supplementPendingFiles.map(({ name, path }) => ({ name, path })); // 走到这里已确认全部有 path
  if (!text && !files.length) return window.toast.error('请输入补充说明或添加附件');
  try {
    const r = await fetch('/api/req/supplement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, files }),
    });
    const d = await r.json();
    if (r.status === 202) window.toast.success('已提交，文档修订中');
    else if (r.status === 200) window.toast.success(d.note || '已记录');
    else return window.toast.error(d.error || '提交失败');
    supplementDraftText = ''; // 提交成功：清空草稿与已选附件
    supplementPendingFiles = [];
    await loadAndRenderReq(id); // 刷新：202 后 get 返回 queued=true，applyFetchedReq 合成 busy 立即亮起「生成中」
  } catch {
    window.toast.error('网络错误');
  }
}
