/** 需求视图 —— 侧栏需求列表 + 评审设计期文档模式（P1 范围；dev/test 聊天模式与横幅右栏见 Task 10）。
 *  导出 initReqView（绑定入口 + 启动列表轮询）/ openRequirement（打开单个需求）/ refreshReqList（刷新侧栏列表）。 */
import { $, fmtTime, renderMarkdown, dirTail, lsSet } from './util.js';
import { confirmDialog, promptDialog, textareaDialog } from './ui.js';
import { loadConvs } from './conv-store.js';
import { openConv, createReqConv, isConvRunning, getCurrentConvId, sendMessageProgrammatically } from './chat.js';
import { convSetTitle, convDelete } from './conv-store.js';
import { startGenerateFlow, resetQuizState, renderQuizPanel, runDocgenDirect } from './req-quiz.js';
import { mountMap } from './req-map.js';
import {
  iconEl, setIconText, PIN_ICON_SVG, FRONTEND_ICON_SVG, BACKEND_ICON_SVG, DOC_ICON_SVG,
  ATTACH_ICON_SVG, REFRESH_ICON_SVG, WAITING_ICON_SVG, SETTINGS_ICON_SVG, EDIT_ICON_SVG,
} from './icons.js';
import { isNetworkError } from './net-error.js';

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
let reportTab = 'doc'; // 评审期双报告页签：'doc' 开发文档 | 'map' 需求地图
let supplementHistoryExpanded = false;
// 补充说明草稿：busy 轮询 / 版本页签切换 / 历史折叠都会触发 renderReqPage 整页重建，
// 若草稿只是 renderSupplementBox 内的局部变量，每次重建都会悄悄清空用户还没提交的输入。
// 提到模块级持久化，重建时原样回填；仅在「打开另一个需求」或「提交成功」时才清空。
let supplementDraftText = '';
let supplementPendingFiles = []; // [{ name, path: string|null }]，path 待上传完成才回填
// 生成前背景（req.prime）草稿：同 supplementDraftText 思路，busy 轮询触发的整页重建不能清空。
// null 表示「本需求还没回填过」，首次渲染时从 req.prime 取值；之后一律以草稿为准，
// 否则 3s 轮询回来的旧 prime 会把用户正在打的字覆盖掉。
let primeDraft = null;
let primeFiles = []; // [{ name, path: string|null }]
let primeSaveTimer = null;
let primeSavedAt = 0; // 上次保存成功的时刻，用于「已保存」微提示
let archiveNoteDraft = ''; // 归档备注草稿：同 supplementDraftText 思路，busy/轮询触发的整页重建不清空
// 需求文档槽位的就地编辑态：null=展示已配置的文档，'link'|'text'=编辑中。
// 与上面几个草稿同理提到模块级——busy 轮询每 3s 触发整页重建，若只活在渲染函数里，
// 用户正在输入链接或粘贴正文时会被一次轮询打回展示态、输入全丢。
let docSlotEdit = null;
let docSlotLinkDraft = '';
let docSlotTextDraft = '';
let cfgSummaryEditing = false; // 文档产出后，右栏配置卡是否处于就地编辑态
// 问卷面板是否占据主栏。点「生成开发文档」时置 true，它同时也是「这一轮生成由用户主动发起」
// 的标记——出题结束的 busy 下降沿据此决定是开面板还是走无歧义降级，不会去接管别处触发的 quizgen。
let quizInlineOpen = false;
let wasBusyKind = null; // 上一次已知的 busy.kind：busy 清空后就取不到了，只能提前记下

// ---- 优化汇总（retro）进度 ----
// map-reduce 全程在前端编排，req.busy 永远不会被写（busy 只由服务端系统任务落盘），
// 所以归档页没有任何进度可看——用户点完「优化汇总」只能靠 toast 猜进度。
// 提到模块级：归档页会因轮询/重渲整页重建，进度不能只活在渲染函数的局部变量里（同 archiveNoteDraft 思路）。
let retroProgress = { phase: 'idle', total: 0, current: 0, title: '', failed: 0, reqId: null };
function setRetroProgress(patch) {
  Object.assign(retroProgress, patch);
  renderRetroProgress(); // 就地更新进度块，不整页重渲——否则会打断用户正在填的归档备注
}
function bumpRetroFailed() {
  retroProgress.failed += 1;
  renderRetroProgress();
}

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
  // 走 util.js 的 lsSet 而不是裸 setItem + 空 catch：写失败（配额满 / 隐私模式）
  // 至少留一行 console.warn，否则「置顶怎么点了没保存」完全无迹可寻。
  lsSet(REQ_PINNED_LS_KEY, Array.from(reqPinnedIds).join(','));
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
  // 只在「需求」tab 激活时才取消隐藏——显隐由 initSidebarSwitch 统一管控，
  // 此处若无条件 el.hidden = false，轮询/rerenderLocal 会覆盖对话模式的隐藏状态，
  // 导致需求列表和对话列表同时出现在侧边栏。
  if (document.querySelector('.switch-btn[data-target="req"]')?.classList.contains('active')) {
    el.hidden = false;
  }
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
    pinIc.innerHTML = PIN_ICON_SVG;
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
  setIconText(renameBtn, EDIT_ICON_SVG);
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
async function loadAndRenderReq(id, epoch = reqEpoch, { allowNav = true } = {}) {
  // allowNav 默认 true 而 applyFetchedReq 默认 false，是刻意相反的：本函数的调用方全是用户手势
  //（点开需求 / 定稿成功 / 归档完成 / 配置保存 / 补充提交），这些必须导航；而 applyFetchedReq
  // 还会被后台 3s 轮询直调，那条路径默认不许导航。新增自动调用方时记得显式传 allowNav:false。
  const { ok, data } = await fetchRequirement(id);
  if (epoch !== reqEpoch) return; // 过期响应：等待期间已经翻到别的需求，丢弃不渲染
  if (!ok || !data) {
    _showView('req'); // 出错也要能看见提示；成功路径的视图切换按阶段分流，见 applyFetchedReq
    renderReqError((data && data.error) || '需求不存在或加载失败');
    return;
  }
  applyFetchedReq(id, data, { allowNav });
}

/** 落地一次成功的详情拉取：更新缓存态 + 渲染 + 就地刷新侧栏 + 管理 busy 轮询定时器。
 *
 * @param {{allowNav?: boolean}} [opts] allowNav=true 表示「这是用户手势触发的」，必须导航到该需求
 *   （点开需求、定稿成功、归档完成等）。默认 false 是给后台 3s busy 轮询用的：那条路径只有在
 *   isReqContextActive() 成立时才允许导航，否则仅就地更新侧栏。两个默认值刻意相反，见
 *   loadAndRenderReq 的 allowNav 默认 true。 */
function applyFetchedReq(id, data, { allowNav = false } = {}) {
  // ★ 两个导航闸门，必须在下面改写 currentReqId 之前算（改写后 onDocPage 恒真，守卫就废了）。
  //   后台 3s 轮询走 allowNav=false，此时：
  //   - onDocPage：用户此刻确实开着本需求的文档页 → phase 推进时跟着走是期望行为
  //   - inThisConv：用户待在本需求的寄生会话里 → 允许把会话切过去接流
  //   两者都不成立 = 用户早点开了别的会话/别的视图，只更新侧栏，绝不把他拽回来
  //   （这是「任务完成后自动切会话」的第二个来源；不能只查 reqEpoch——它仅由
  //    openRequirement 自增，用户点侧栏别的会话根本不改它）。
  const onDocPage = isReqViewActive() && currentReqId === id;
  const inThisConv = !!(data.convId && getCurrentConvId() === data.convId);
  // 允许切换会话：用户在本需求上下文里（文档页或它的会话里）就算，为的是让会话能接上实时流
  const mayTouchConv = allowNav || onDocPage || inThisConv;
  // 允许接管视图。刻意不认 inThisConv：用户在本需求会话里但视图停在设置/任务面板时，
  // 不该被抢视图。反之 onDocPage 必须认——dev/test 期 #reqPage 已不再渲染，把人留在
  // 文档页上等于让他盯着一个空占位（这正是用例③逮到的过严 bug）。
  const mayTakeOverView = allowNav || onDocPage;
  // docgen 202 只代表入队，busy 要等后端泵（5s tick）派发时才写入，窗口期 get 返回 queued=true。
  // 把它合成为 busy 展示，busy 条 / 按钮禁用 / 3s 轮询全部立即生效——否则 202 后立刷拿到
  // busy=null，页面静止在旧态，用户重开需求才能看到「生成中」。
  if (data.phase === 'review' && !data.busy && data.queued) {
    data.busy = { kind: data.queuedKind || 'docgen', startedAt: null };
  }
  const isFreshOpen = id !== currentReqId;
  if (isFreshOpen) {
    docOverride = null;
    wasBusy = false;
    supplementDraftText = '';
    supplementPendingFiles = [];
    archiveNoteDraft = '';
    // 背景草稿归位到「未回填」：下一次渲染会从新需求的 req.prime 取值。
    // 顺带取消在途的防抖保存，否则它会把上一个需求的正文写进这个需求。
    primeDraft = null;
    primeFiles = [];
    if (primeSaveTimer) {
      clearTimeout(primeSaveTimer);
      primeSaveTimer = null;
    }
    resetQuizState(); // 换需求：上一份问卷的答案与游标不该跟过来
    // 同理，配置槽位的就地编辑态、草稿与问卷面板都属于「上一个需求」，不能跟着翻过来
    docSlotEdit = null;
    docSlotLinkDraft = '';
    docSlotTextDraft = '';
    cfgSummaryEditing = false;
    quizInlineOpen = false;
    wasBusyKind = null;
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
    // 由 openRequirementChat 里的 openConv 负责切到聊天视图（仅在允许导航时）。
    // 文档模式的 busy 轮询在此阶段没有意义（#reqPage 不再展示），必须显式收掉，否则一个
    // 「评审期 busy→定稿→开发期」的需求会在后台留一个永远不会再被清理的 3s 轮询。
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    // 用户已经走开（既不在本需求文档页、也不在它的会话里）：只更新侧栏，绝不把他拽过来。
    // 上面的 patchListEntry(data) 已经把最新状态画进侧栏了。
    if (!mayTouchConv) return;
    // nav=false 的情形：用户待在本需求会话里、但视图停在设置/任务面板 —— 会话该切（接流），
    // 视图不该抢。
    openRequirementChat(id, data, { nav: mayTakeOverView });
    return;
  }

  if (!mayTakeOverView) return; // 后台刷新不得把用户从他正在看的东西上拽回需求文档页
  _showView('req');
  if (wasBusy && !data.busy) docOverride = null; // 生成刚结束：回到最新版展示
  wasBusy = !!data.busy;
  settleQuizgen(data);
  renderReqPage(data);
  if (data.busy && !busyTimer) startBusyPolling(id);
  if (!data.busy && busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

/**
 * quizgen 的收尾判定，挂在 busy 的下降沿上。
 *
 * 这是「出题结束了没有」的**唯一**判据：runQuizGen 的两个终态（成功写 quiz.status='ready'，
 * 失败写 quiz=null）都会清 busy。早先前端另用一套 2 分钟超时来判，一超时就把还在跑的
 * quizgen 当成「没找出歧义」，丢掉问卷去发 docgen，而那时后端 busy 未清、docgen 被 409
 * 挡回——界面转两分钟后一切照旧，后台却还在跑。没有超时就没有这个误判。
 *
 * 只在 quizInlineOpen 为真时接管：别处触发的 quizgen 不该把用户拽进问卷。
 */
function settleQuizgen(data) {
  const prevKind = wasBusyKind;
  wasBusyKind = data.busy?.kind || null;
  if (prevKind !== 'quizgen' || data.busy || !quizInlineOpen) return;
  if (data.quiz?.status === 'ready' && data.quiz.questions?.length) return; // 有题：面板自然渲染出来
  // 跑完了却没题 = 没找出歧义或解析失败。这不该挡住生成，直接跳到读代码。
  quizInlineOpen = false;
  runDocgenDirect(data.id, () => loadAndRenderReq(data.id), '未发现明显歧义，直接生成开发文档');
}

/**
 * 「生成开发文档」的统一入口。占面板 → 发起 → 立刻刷新页面，其余交给 busy 轮询。
 *
 * 出题没起来时要把面板收回来，否则 quizInlineOpen 会一直挂着，下一次 quizgen 结束时
 * 会被误认成「这一轮是用户发起的」而自动弹出问卷。
 */
async function beginGenerate(req, forceNewQuiz) {
  const r = await startGenerateFlow({
    req,
    forceNewQuiz,
    onRefresh: () => loadAndRenderReq(req.id),
    onOpenPanel: () => {
      quizInlineOpen = true;
      renderReqPage(currentReq);
    },
  });
  if (r?.failed) {
    quizInlineOpen = false;
    renderReqPage(currentReq);
  }
}

/** 收回问卷面板（取消作答、或答完提交后）。 */
function closeQuizPanel() {
  quizInlineOpen = false;
  resetQuizState();
  if (currentReqId) loadAndRenderReq(currentReqId);
}

/**
 * 开发/测试期：确保该需求有寄生 conv 再交给 chat.js 打开——横幅/右栏由 req-chat.js 经
 * bindReqConvHook 挂载（依赖方向 req-view → chat.js，单向，本模块不直接碰 #reqBanner/#reqRail）。
 * record.convId 存在且本地 conv 仍在（用户可能清过 localStorage）才复用，否则新建并回填。
 *
 * @param {{nav?: boolean}} [opts] nav=false（后台刷新）时只切会话不抢视图，见 openConv 的 nav 说明。
 */
async function openRequirementChat(id, data, { nav = true } = {}) {
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
    openConv(convId, { nav });
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
    // await 期间用户可能已点侧栏切走（那既不改 epoch 也不改 currentReqId，头部的自杀检查逮不到）。
    // applyFetchedReq 的 allowNav 默认 false，其内部闸门会据「用户是否还在本需求上下文」决定
    // 是否导航——这里不再重复判定，只把「这是后台刷新」的语义如实传下去。
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
    box.appendChild(renderWorkbench(req));
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

// ══════════════════════════════════════════════════════════════════════════
// 评审期工作台（双栏）
// plan: docs/superpowers/plans/2026-08-25-req-workbench.md
//
// 主栏永远放「当前阶段的主角」：没有文档时是工程配置（它决定文档正确性），
// 有文档时是文档本身、配置降级为右栏只读树。右栏常驻行动区与辅助信息，
// 顺带把旧版宽屏右侧一千多像素的空白填成有效内容。
// ══════════════════════════════════════════════════════════════════════════

/** 小工具：建元素。本文件其余部分用 createElement 直写，这里高频建节点故收一个。 */
function e(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 配置是否够开工：与后端 pickCwdAndDirs 同判据 —— 任一工程非空 + 有需求文档。 */
function cfgReady(req) {
  const dirs = [req.projects?.frontend?.dir, req.projects?.backend?.dir].filter(Boolean);
  return dirs.length > 0 && !!req.reqDoc;
}

function hasDevDoc(req) {
  return (req.devDoc?.versions || []).length > 0;
}

/** 最后一条历史是否为失败事件（错误条与阶段轨共用同一判据，免得两处说法不一致）。 */
function lastEventFailed(req) {
  const last = (req.history || []).at(-1);
  return !!last && /失败|被拒|中断/.test(last.event);
}

function renderWorkbench(req) {
  const wrap = e('div', 'rqw');
  wrap.appendChild(renderTopBar(req));
  const body = e('div', 'rqw-body');
  body.appendChild(renderMainCol(req));
  body.appendChild(renderSideCol(req));
  wrap.appendChild(body);
  return wrap;
}

// ---- 顶部：元信息 + 三步阶段轨 ----

function renderTopBar(req) {
  const top = e('div', 'rqw-top');

  const meta = e('div', 'rqw-meta');
  meta.appendChild(e('span', 'rqw-phase-badge', '评审期'));
  meta.appendChild(e('span', 'sep', '·'));
  const created = e('span');
  created.append('创建于 ', Object.assign(e('b'), { textContent: fmtTime(req.createdAt) }));
  meta.appendChild(created);
  if (req.reqDoc) {
    meta.appendChild(e('span', 'sep', '·'));
    const doc = e('span');
    doc.append('需求文档 ', Object.assign(e('b'), { textContent: req.reqDoc.name }));
    meta.appendChild(doc);
  }
  meta.appendChild(e('span', 'sep', '·'));
  const versions = req.devDoc?.versions || [];
  meta.appendChild(
    e(
      'span',
      null,
      versions.length
        ? `开发文档 v${Math.max(...versions.map((v) => v.v))} · 共 ${versions.length} 版`
        : req.busy
          ? '开发文档生成中'
          : '尚未生成开发文档',
    ),
  );
  top.appendChild(meta);
  top.appendChild(renderStepsBar(req));
  return top;
}

/**
 * 阶段轨：配置 → 生成文档 → 定稿。三步而非四步 —— 问卷是「生成」动作里的一道闸，
 * 不是用户需要规划的阶段，给它一格会让人以为那是个必经的独立环节。
 */
function renderStepsBar(req) {
  const ready = cfgReady(req);
  const hasDoc = hasDevDoc(req);
  const busy = !!req.busy;
  const failed = !hasDoc && !busy && lastEventFailed(req);

  const dirs = [req.projects?.frontend?.dir, req.projects?.backend?.dir].filter(Boolean).length;
  const slots = dirs + (req.reqDoc ? 1 : 0);

  let s2 = ['todo', ''];
  if (hasDoc) s2 = busy ? ['now', '修订中'] : ['done', `已出 v${Math.max(...(req.devDoc.versions || []).map((v) => v.v))}`];
  else if (busy) s2 = ['now', '模型阅读代码中'];
  else if (failed) s2 = ['err', '生成失败'];
  else if (ready) s2 = ['now', '待生成'];

  const rows = [
    ready ? ['done', `${slots}/3 已配置`] : ['now', `${slots}/3 已配置`],
    s2,
    hasDoc && !busy ? ['now', '待定稿'] : ['todo', ''],
  ];
  const defs = [
    ['01', '配置工程与文档'],
    ['02', '生成开发文档'],
    ['03', '定稿进开发期'],
  ];

  const bar = e('div', 'rqw-steps');
  rows.forEach(([cls, sub], i) => {
    const step = e('div', 'rqw-step ' + cls);
    step.appendChild(e('div', 'rqw-step-n', defs[i][0]));
    step.appendChild(e('div', 'rqw-step-t', defs[i][1]));
    const s = e('div', 'rqw-step-s');
    s.innerHTML = sub ? '' : '&nbsp;'; // 占位保持三步等高，否则有副标题的那格会把轨道顶歪
    if (sub) s.textContent = sub;
    step.appendChild(s);
    bar.appendChild(step);
  });
  return bar;
}

// ---- 左主栏 ----

function renderMainCol(req) {
  const col = e('div', 'rqw-main');
  const err = renderErrorBanner(req);
  if (err) col.appendChild(err);
  const busyBar = renderBusyBar(req);
  if (busyBar) col.appendChild(busyBar);

  // 问卷就绪且用户正走在生成流程上：它是此刻唯一该做的事，占据主栏。
  // 出题期间走不到这里（还没有题），主栏仍是配置卡 + 顶部 busy 条。
  if (quizInlineOpen && req.quiz?.status === 'ready' && req.quiz.questions?.length) {
    col.appendChild(renderQuizPanel(req, { onClose: closeQuizPanel, onRefresh: () => loadAndRenderReq(req.id) }));
    return col;
  }

  if (hasDevDoc(req)) {
    col.appendChild(renderReportArea(req));
    // 补充说明是「对已有文档提调整」，没有文档时提交没有意义。
    // 地图页签下不出：那是「对文档提意见」的入口，与地图标注是两条不同的回流路径。
    if (reportTab === 'doc') col.appendChild(renderSupplementBox(req));
    return col;
  }

  // 还没有文档：配置是主角，背景补充紧随其后
  col.appendChild(renderConfigCard(req));
  col.appendChild(renderPrimeBox(req));
  return col;
}

/**
 * 工程配置卡（配置阶段主栏主角）。
 *
 * 旧版把三个槽位压成一行 chips：未配置时只有「＋ 前端工程」一个虚框，看不出配了
 * 什么、开发还是只读、完整路径是什么。这里每槽一张子卡把这些摊开——它们正是
 * 「文档会不会生成错」的判断依据。
 *
 * 三个槽位全部就地编辑，不再有配置弹层：工程目录直接调系统文件夹框，需求文档在槽位内
 * 切换「在线链接 / 粘贴文本 / 上传文件」。留一个弹层等于两套并行的配置写法，行为迟早走偏。
 */
function renderConfigCard(req) {
  const card = e('div', 'rqw-cfg');

  const dirs = [req.projects?.frontend?.dir, req.projects?.backend?.dir].filter(Boolean).length;
  const hd = e('div', 'rqw-cfg-hd');
  hd.appendChild(e('h4', null, '工程配置'));
  hd.appendChild(e('span', 'cnt', `${dirs + (req.reqDoc ? 1 : 0)} / 3 已配置`));
  card.appendChild(hd);

  const note = e('div', 'rqw-cfg-note');
  note.append(
    '开发文档会基于这些工程的',
    Object.assign(e('b'), { textContent: '实际代码' }),
    '生成，配置错了文档就是错的。只读工程仅供模型阅读，不会产生任何改动。',
  );
  card.appendChild(note);

  const slots = e('div', 'rqw-slots');
  slots.appendChild(makeProjSlot(req, 'frontend', '前端工程', FRONTEND_ICON_SVG));
  slots.appendChild(makeProjSlot(req, 'backend', '后端工程', BACKEND_ICON_SVG));
  slots.appendChild(makeDocSlot(req));
  // 功能模块标签由 docgen 自动识别，没文档时还没有值，展示它只会是个空槽
  if (req.featureTag) slots.appendChild(makeTagSlot(req));
  card.appendChild(slots);
  return card;
}

/** @param {string} icon 内联 SVG（icons.js 的常量），不是 emoji */
function makeProjSlot(req, key, label, icon) {
  const p = req.projects?.[key];
  const slot = e('div', 'rqw-slot' + (p ? '' : ' blank'));

  const top = e('div', 'rqw-slot-top');
  top.appendChild(iconEl(icon, 'rqw-slot-ic'));
  top.appendChild(e('span', 'rqw-slot-k', label));
  // 后端可空是刻意的：只有前端改动的需求很常见，不该拿一个红叉逼用户填
  if (key === 'backend' && !p) top.appendChild(e('span', 'rqw-slot-opt', '可留空'));
  top.appendChild(e('span', 'gap'));
  if (p) top.appendChild(makeDevSeg(req, key, p));
  slot.appendChild(top);

  const row = e('div', 'rqw-slot-row');
  if (p) {
    const path = e('input', 'rqw-path');
    path.value = p.dir;
    path.readOnly = true; // 改路径一律走系统文件夹框，手打容易打出不存在的路径
    path.title = p.dir;
    row.appendChild(path);
    const change = e('button', 'rqw-btn sm', '更改');
    change.type = 'button';
    change.onclick = () => pickProjectDir(req, key, change);
    row.appendChild(change);
    const clear = e('button', 'rqw-btn sm', '清除');
    clear.type = 'button';
    clear.onclick = () => saveProjectSlot(req, key, null);
    row.appendChild(clear);
  } else {
    const btn = e('button', 'rqw-btn sm', '选择工程目录');
    btn.type = 'button';
    btn.onclick = () => pickProjectDir(req, key, btn);
    row.appendChild(btn);
  }
  slot.appendChild(row);

  const ft = e('div', 'rqw-slot-ft');
  if (p) {
    ft.appendChild(
      e('span', p.dev ? 'ok' : null, p.dev ? '✓ 开发态：本次改动会落在这个工程' : '只读：仅供模型阅读，不会产生改动'),
    );
  } else if (key === 'backend') {
    ft.appendChild(e('span', null, '未配置时模型看不到后端代码，接口契约只能依据需求文档推断'));
  } else {
    ft.appendChild(e('span', 'warn', '至少要配一个工程才能生成开发文档'));
  }
  slot.appendChild(ft);
  return slot;
}

/** 读写模式二段开关，就地保存。 */
function makeDevSeg(req, key, p) {
  const seg = e('span', 'rqw-seg');
  const mk = (mode, text) => {
    const b = e('button', p.dev === (mode === 'dev') ? 'on' : '', text);
    b.type = 'button';
    b.dataset.m = mode;
    b.onclick = () => {
      const want = mode === 'dev';
      if (p.dev === want) return;
      saveProjectSlot(req, key, { ...p, dev: want });
    };
    return b;
  };
  seg.append(mk('dev', '开发'), mk('ro', '只读'));
  return seg;
}

/**
 * 保存单个工程槽位，value 为 null 表示清除。
 *
 * 只提交被改动的那一个键：buildProjectsPatch 只处理 `key in input` 的键，全量拼装等于
 * 拿渲染那一刻的旧快照把另一侧原样写回去——两处槽位先后操作时会互相覆盖。
 */
async function saveProjectSlot(req, key, value) {
  try {
    const r = await fetch('/api/req/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, projects: { [key]: value } }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '保存失败');
    await loadAndRenderReq(req.id);
  } catch {
    window.toast.error('网络错误');
  }
}

/**
 * 直接调系统文件夹对话框选工程目录。
 *
 * 起框走的是服务端 PowerShell（routes-files.js:handlePickDir），有 1~2 秒延迟、超时长达
 * 3 分钟，期间必须禁用按钮并改文案，否则用户会连点、开出好几个框。
 *
 * 新配的工程一律按只读登记：选完再点一下旁边的「开发」开关成本极低，而误把只读工程
 * 当成开发工程，代价是模型在一个本不该动的工程里改代码——两边不对称，取保守侧。
 */
async function pickProjectDir(req, key, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '选择中…';
  try {
    const d = await (await fetch('/api/dirs/pick')).json();
    if (d.error) return window.toast.error(d.error);
    if (!d.path) return; // 用户在系统框里点了取消：什么都不做，不打扰
    await saveProjectSlot(req, key, { dir: d.path, dev: req.projects?.[key]?.dev ?? false });
  } catch {
    window.toast.error('调用系统对话框失败');
  } finally {
    // 保存成功会整页重建、这个按钮已不在 DOM 上，恢复是给失败与取消两条路径用的
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * 需求文档槽位。三种来源就地切换，在线链接是主位——实际需求几乎都是飞书文档。
 *
 * 链接来源存的是拉取那一刻的快照（后端 doc-from-link 落盘成 req-doc.md），不是每次生成
 * 实时取：同一份需求的首版与多次修订必须基于同一份正文，否则文档中途被人改过，问题就
 * 复现不出来。代价是飞书那边改了不会自动同步，靠脚注的拉取时间与「刷新」按钮兜住。
 */
function makeDocSlot(req) {
  const d = req.reqDoc;
  // 没有文档时恒为编辑态：此时展示态没有任何可展示的东西
  const mode = docSlotEdit || (d ? null : 'link');
  const slot = e('div', 'rqw-slot' + (d ? '' : ' blank'));

  const top = e('div', 'rqw-slot-top');
  top.appendChild(iconEl(DOC_ICON_SVG, 'rqw-slot-ic'));
  top.appendChild(e('span', 'rqw-slot-k', '需求文档'));
  top.appendChild(e('span', 'gap'));
  if (mode) {
    const seg = e('span', 'rqw-seg');
    const mk = (m, text) => {
      const b = e('button', mode === m ? 'on' : '', text);
      b.type = 'button';
      b.onclick = () => setDocSlotEdit(m);
      return b;
    };
    seg.append(mk('link', '在线链接'), mk('text', '粘贴文本'));
    top.appendChild(seg);
    const up = e('button', 'rqw-iconbtn', '上传文件');
    up.type = 'button';
    up.onclick = () => pickDocFile(req);
    top.appendChild(up);
    if (d) {
      // 已有文档时才给取消：否则用户能把自己关进一个没有文档、也退不出编辑态的界面
      const cancel = e('button', 'rqw-iconbtn', '取消');
      cancel.type = 'button';
      cancel.onclick = () => setDocSlotEdit(null);
      top.appendChild(cancel);
    }
  } else {
    if (d.url) {
      const refresh = e('button', 'rqw-iconbtn');
      setIconText(refresh, REFRESH_ICON_SVG, '刷新');
      refresh.type = 'button';
      refresh.title = '重新拉取飞书文档的最新内容';
      refresh.onclick = () => fetchDocFromLink(req, '', refresh);
      top.appendChild(refresh);
    }
    const change = e('button', 'rqw-iconbtn', '更换');
    change.type = 'button';
    change.onclick = () => setDocSlotEdit('link');
    top.appendChild(change);
  }
  slot.appendChild(top);

  const row = e('div', 'rqw-slot-row' + (mode === 'text' ? ' col' : ''));
  if (mode === 'link') {
    const input = e('input', 'rqw-path');
    input.placeholder = '粘贴飞书文档链接…';
    input.value = docSlotLinkDraft || d?.url || '';
    input.addEventListener('input', () => {
      docSlotLinkDraft = input.value;
    });
    const go = e('button', 'rqw-btn sm', '拉取');
    go.type = 'button';
    const submit = () => fetchDocFromLink(req, input.value.trim(), go);
    go.onclick = submit;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
    row.append(input, go);
  } else if (mode === 'text') {
    const ta = e('textarea', 'rqw-doc-ta');
    ta.rows = 6;
    ta.placeholder = '粘贴需求文档全文…';
    ta.value = docSlotTextDraft;
    ta.addEventListener('input', () => {
      docSlotTextDraft = ta.value;
    });
    const save = e('button', 'rqw-btn sm', '保存');
    save.type = 'button';
    save.onclick = () => saveDocText(req, save);
    row.append(ta, save);
  } else {
    const path = e('input', 'rqw-path');
    path.value = d.name;
    path.readOnly = true;
    path.title = d.path || d.name;
    row.appendChild(path);
  }
  slot.appendChild(row);

  const ft = e('div', 'rqw-slot-ft');
  if (mode === 'link') {
    ft.appendChild(e('span', null, '支持飞书云文档（/docx/ 或 /wiki/ 链接），需先把机器人加为该文档的协作者'));
  } else if (mode === 'text') {
    ft.appendChild(e('span', null, '整篇粘进来即可，生成时会通读全文'));
  } else {
    ft.appendChild(e('span', 'ok', '✓ 已就绪，生成时会通读全文'));
    if (d.url) {
      ft.appendChild(e('span', 'br'));
      const link = e('a', null, '🔗 飞书文档');
      link.href = d.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.title = d.url;
      ft.appendChild(link);
      if (d.fetchedAt) ft.appendChild(e('span', null, ` · ${fmtFetchedAt(d.fetchedAt)} 拉取，文档有更新时点「刷新」`));
    }
  }
  slot.appendChild(ft);
  return slot;
}

function setDocSlotEdit(mode) {
  docSlotEdit = mode;
  renderReqPage(currentReq);
}

/** 拉取时间只用于「快照有多旧」的粗判，精确到分钟足够，不引入日期库。 */
function fmtFetchedAt(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** 从飞书链接拉取需求文档快照。url 传空串 = 刷新（后端会用已存的 reqDoc.url 重拉）。 */
async function fetchDocFromLink(req, url, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const r = await fetch('/api/req/doc-from-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, url }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '拉取失败');
    docSlotEdit = null;
    docSlotLinkDraft = '';
    window.toast.success(`已拉取「${d.reqDoc?.name || '需求文档'}」`);
    await loadAndRenderReq(req.id);
  } catch {
    window.toast.error('网络错误');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveDocText(req, btn) {
  const text = docSlotTextDraft.trim();
  if (!text) return window.toast.error('请先粘贴需求文档正文');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const r = await fetch('/api/req/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, reqDoc: { name: '需求文档.md', text } }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '保存失败');
    docSlotEdit = null;
    docSlotTextDraft = '';
    window.toast.success('需求文档已保存');
    await loadAndRenderReq(req.id);
  } catch {
    window.toast.error('网络错误');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

/** 上传文件作为需求文档：走浏览器原生 file input（不是服务端对话框），沿用 /api/upload。 */
function pickDocFile(req) {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const up = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
      const ud = await up.json();
      if (!ud.path) throw new Error(ud.error || '上传失败');
      const r = await fetch('/api/req/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id, reqDoc: { name: ud.name || file.name, path: ud.path } }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      docSlotEdit = null;
      window.toast.success('需求文档已上传');
      await loadAndRenderReq(req.id);
    } catch (err) {
      // 同 req-chat：系统故障不叠业务前缀
      if (isNetworkError(err)) window.toast.error(err.message);
      else window.toast.error('上传失败：' + (err?.message || err));
    }
  };
  input.click();
}

function makeTagSlot(req) {
  const slot = e('div', 'rqw-slot');
  const top = e('div', 'rqw-slot-top');
  top.appendChild(e('span', 'rqw-slot-ic', '🏷'));
  top.appendChild(e('span', 'rqw-slot-k', '功能模块'));
  top.appendChild(e('span', 'gap'));
  top.appendChild(makeTagEditor(req));
  slot.appendChild(top);
  const ft = e('div', 'rqw-slot-ft');
  ft.appendChild(e('span', null, '用于归档检索与避坑规则归类，docgen 自动识别，可随时改'));
  slot.appendChild(ft);
  return slot;
}

/** 功能模块标签：展示态 ↔ 就地编辑态。复用 /api/req/feature-tag。 */
function makeTagEditor(req) {
  const host = e('span', 'rqw-tag');
  const show = (tag) => {
    host.innerHTML = '';
    host.append(tag || '未识别');
    const ed = e('button', 'rqw-iconbtn');
    setIconText(ed, EDIT_ICON_SVG);
    ed.type = 'button';
    ed.title = '修改功能模块标签';
    ed.onclick = () => edit(tag);
    host.appendChild(ed);
  };
  const edit = (tag) => {
    host.innerHTML = '';
    const input = e('input');
    input.type = 'text';
    input.value = tag || '';
    input.maxLength = 20;
    input.placeholder = '如：宝宝辅食';
    host.appendChild(input);
    const save = e('button', 'rqw-iconbtn', '保存');
    save.type = 'button';
    save.onclick = async () => {
      const next = input.value.trim();
      try {
        const r = await fetch('/api/req/feature-tag', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: req.id, tag: next }),
        });
        if (!r.ok) throw new Error(await r.text().catch(() => '未知错误'));
        show(next || null);
      } catch (err) {
        window.toast?.error('保存失败：' + (err?.message || err));
      }
    };
    const cancel = e('button', 'rqw-iconbtn', '取消');
    cancel.type = 'button';
    cancel.onclick = () => show(tag);
    host.append(save, cancel);
    input.focus();
    input.select();
  };
  show(req.featureTag);
  return host;
}

/**
 * 生成前背景补充（req.prime）。
 *
 * 旧版刻意不在生成前放补充框，理由是「没有文档时提交没有意义，且会让首次流程出现
 * 两个入口造成困惑」。顾虑成立，所以这里**不给提交按钮**：内容防抖自动存 req.prime，
 * 随「生成开发文档」一并生效 —— 它是生成表单的一部分，不是第二个提交入口。
 */
function renderPrimeBox(req) {
  if (primeDraft === null) primeDraft = req.prime?.text || '';
  if (!primeFiles.length && req.prime?.files?.length) primeFiles = req.prime.files.map((f) => ({ ...f }));

  const box = e('div', 'rqw-prime');
  const hd = e('div', 'rqw-prime-hd');
  hd.appendChild(e('h4', null, '你对这个需求的理解'));
  hd.appendChild(e('span', 'opt', '可选'));
  hd.appendChild(e('span', 'gap'));
  const cnt = e('span', 'cnt' + (primeDraft.length > PRIME_MAX ? ' over' : ''), `${primeDraft.length} / ${PRIME_MAX}`);
  hd.appendChild(cnt);
  box.appendChild(hd);

  const note = e('div', 'rqw-prime-note');
  note.append(
    '需求文档之外你知道的事。会和文档一起交给模型，',
    Object.assign(e('b'), { textContent: '不用单独提交' }),
    ' —— 点右侧「生成开发文档」时一并带上。',
  );
  box.appendChild(note);

  // 空输入框最容易被跳过，给出「该写什么」的具体门类而不是一句泛泛的提示
  const eg = e('div', 'rqw-prime-eg');
  for (const [n, t] of [
    ['①', '文档没写但你知道的背景：为什么要做、给谁用、上游依赖谁'],
    ['②', '已知的技术约束或历史坑：这块去年改崩过、那个接口不能动'],
    ['③', '希望模型特别注意的地方：优先保证什么、什么可以先不做'],
  ]) {
    const row = e('div');
    row.appendChild(e('span', 'n', n));
    row.appendChild(e('span', null, t));
    eg.appendChild(row);
  }
  box.appendChild(eg);

  const ta = e('textarea', 'rqw-ta');
  ta.placeholder =
    '例：这个页面去年做过一版本地筛选，因为数据量涨到 3 万条后卡死才下线的，这次务必走后端查询。';
  ta.value = primeDraft;
  const savedTip = e('span', 'saved', '已保存');
  ta.addEventListener('input', () => {
    primeDraft = ta.value;
    cnt.textContent = `${primeDraft.length} / ${PRIME_MAX}`;
    cnt.classList.toggle('over', primeDraft.length > PRIME_MAX);
    schedulePrimeSave(req.id, savedTip);
  });
  box.appendChild(ta);

  const chips = e('div', 'rqw-chips');
  for (const f of primeFiles) {
    const chip = e('span', 'rqw-fchip' + (f.path ? '' : ' uploading'), f.name);
    const rm = e('button', 'rm', '✕');
    rm.type = 'button';
    rm.title = '移除';
    rm.onclick = () => {
      const i = primeFiles.indexOf(f);
      if (i >= 0) primeFiles.splice(i, 1);
      chip.remove();
      schedulePrimeSave(req.id, savedTip);
    };
    chip.appendChild(rm);
    chips.appendChild(chip);
  }
  box.appendChild(chips);

  const ft = e('div', 'rqw-prime-ft');
  const fileInput = e('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const attach = e('button', 'rqw-btn sm');
  setIconText(attach, ATTACH_ICON_SVG, '附件');
  attach.type = 'button';
  attach.onclick = () => fileInput.click();
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const f of files) {
      const entry = { name: f.name, path: null };
      primeFiles.push(entry);
      const chip = e('span', 'rqw-fchip uploading', f.name);
      chips.appendChild(chip);
      try {
        const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        const d = await r.json();
        if (!d.path) throw new Error(d.error || '上传失败');
        entry.path = d.path;
        entry.name = d.name || f.name;
        chip.classList.remove('uploading');
        schedulePrimeSave(req.id, savedTip);
      } catch (err) {
        const i = primeFiles.indexOf(entry);
        if (i >= 0) primeFiles.splice(i, 1);
        chip.remove();
        window.toast.error('文件上传失败：' + (err?.message || err));
      }
    }
  });
  ft.append(attach, fileInput);
  ft.appendChild(e('span', 'tip', '写了会同时影响下一步的不确定点分析 —— 说清楚的地方就不会再问你'));
  ft.appendChild(e('span', 'gap'));
  ft.appendChild(savedTip);
  box.appendChild(ft);
  return box;
}

const PRIME_MAX = 5000; // 与 routes-req-v2.js 的 PRIME_TEXT_MAX 一致（超出后端会截断）
const PRIME_SAVE_DEBOUNCE = 800;

/** 防抖保存背景草稿。不写 history、不触发生成，纯落盘（见 PUT /api/req/prime）。 */
function schedulePrimeSave(reqId, tipEl) {
  if (primeSaveTimer) clearTimeout(primeSaveTimer);
  primeSaveTimer = setTimeout(async () => {
    primeSaveTimer = null;
    // 只提交已上传完成的附件：path 为空的还在途，下一次保存会带上
    const files = primeFiles.filter((f) => f.path).map(({ name, path }) => ({ name, path }));
    try {
      const r = await fetch('/api/req/prime', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, text: primeDraft, files }),
      });
      if (!r.ok) return; // 静默失败：草稿还在内存里，下次输入会重试，不打扰用户
      primeSavedAt = Date.now();
      if (tipEl) {
        tipEl.classList.add('on');
        setTimeout(() => tipEl.classList.remove('on'), 1400);
      }
    } catch {
      /* 同上：网络抖动不提示 */
    }
  }, PRIME_SAVE_DEBOUNCE);
}

// ---- 右栏 ----

function renderSideCol(req) {
  const col = e('div', 'rqw-side');
  const hasDoc = hasDevDoc(req);

  col.appendChild(renderActionCard(req, hasDoc));
  if (!hasDoc && !req.busy) col.appendChild(renderFlowCard(req));
  if (hasDoc) col.appendChild(renderCfgSummaryCard(req));
  if (req.quiz?.questions?.length) col.appendChild(renderQuizSummaryCard(req));
  if (hasDoc) {
    col.appendChild(renderVersionCard(req));
    const stats = renderStatsCard(req);
    if (stats) col.appendChild(stats);
  }
  col.appendChild(renderNotifyCard(req));
  return col;
}

/** 行动区：配置态是「生成」，文档态是「定稿」。评审期唯一的不可逆动作放这里最醒目。 */
function renderActionCard(req, hasDoc) {
  const card = e('div', 'rqw-act');

  if (req.busy) {
    // 出题与生成是两件事，耗时差一个数量级。出题阶段显示「正在生成开发文档」是假话，
    // 会让用户以为卡住了（十几秒的事被当成十几分钟的事等）。
    const quizzing = req.busy.kind === 'quizgen';
    card.appendChild(e('div', 'rqw-act-t', quizzing ? '正在分析' : hasDoc ? '正在修订' : '正在生成'));
    card.appendChild(
      e(
        'div',
        'rqw-act-d',
        quizzing
          ? '模型在通读需求文档，找出没写清、但会影响实现的地方。通常十几秒，出题后会请你逐题确认。'
          : '可以关掉页面去做别的，完成后回来查看，或勾上机器人通知。',
      ),
    );
    const b = e('button', 'rqw-btn full', quizzing ? '分析中…' : '生成中…');
    b.type = 'button';
    b.disabled = true;
    card.appendChild(b);
    return card;
  }

  if (hasDoc) {
    card.appendChild(e('div', 'rqw-act-t', '下一步'));
    card.appendChild(e('div', 'rqw-act-d', '定稿后配置与文档冻结，将建需求分支并自动开始开发。'));
    const b = e('button', 'rqw-btn primary full', '✓ 定稿，进入开发期');
    b.type = 'button';
    b.onclick = () => startFinalizeFlow(req.id);
    card.appendChild(b);
    return card;
  }

  const ready = cfgReady(req);
  const failed = lastEventFailed(req);
  card.appendChild(e('div', 'rqw-act-t', failed ? '生成失败' : '下一步'));
  card.appendChild(
    e(
      'div',
      'rqw-act-d',
      failed
        ? '问卷结论已保留，重试不必重答。也可以先补上工程配置再重试。'
        : ready
          ? '配置已满足最低要求，可以开始生成开发文档。'
          : '先补齐上方标黄的配置项，然后才能生成。',
    ),
  );
  const gen = e('button', 'rqw-btn primary full', failed ? '重新生成' : '生成开发文档 →');
  gen.type = 'button';
  gen.disabled = !ready;
  gen.onclick = () => beginGenerate(req, false);
  card.appendChild(gen);

  const pre = e('div', 'rqw-precheck');
  const addLine = (ok, text) => {
    const row = e('div');
    row.appendChild(e('span', ok ? 'ok' : 'no', ok ? '✓' : '!'));
    row.appendChild(e('span', null, text));
    pre.appendChild(row);
  };
  const f = req.projects?.frontend;
  const b = req.projects?.backend;
  if (f) addLine(true, `前端工程已配置（${f.dev ? '开发' : '只读'}）`);
  if (b) addLine(true, `后端工程已配置（${b.dev ? '开发' : '只读'}）`);
  else addLine(false, '后端未配置，接口契约将靠推断');
  if (!f && !b) addLine(false, '尚未配置任何工程');
  addLine(!!req.reqDoc, req.reqDoc ? '需求文档已就绪' : '需求文档缺失');
  card.appendChild(pre);
  return card;
}

/** 流程预告：点下去会经历什么、大概多久，先说清楚。 */
function renderFlowCard(req) {
  const card = e('div', 'rqw-card');
  const hd = e('div', 'rqw-card-h');
  hd.appendChild(e('span', 'ic', '◈'));
  hd.appendChild(e('span', null, '点击后会发生什么'));
  card.appendChild(hd);

  const body = e('div', 'rqw-card-b');
  const flow = e('div', 'rqw-flow');
  const steps = [
    ['1', '找出需求里的不确定点', req.prime?.text ? '会结合你写的背景 · 你说清的不会再问 · 约十几秒' : '通读需求文档 · 约十几秒'],
    ['2', '逐题确认', '需全部作答 · 每题可选「不确定」或自主补充 · 约 1 分钟'],
    ['3', '模型阅读工程实际代码', '可离开页面 · 3~10 分钟'],
    ['4', '产出开发文档', '可多轮修订，首版不是终稿'],
  ];
  for (const [n, t, sub] of steps) {
    const row = e('div', 'rqw-flow-i');
    row.appendChild(e('span', 'n', n));
    const tx = e('span', 'tx', t);
    tx.appendChild(e('em', null, sub));
    row.appendChild(tx);
    flow.appendChild(row);
  }
  body.appendChild(flow);
  card.appendChild(body);
  return card;
}

/**
 * 文档产出后配置降级为只读树：此时它已不是主角，但仍要能一眼核对。
 *
 * 「编辑」就地展开成主栏那套槽位，而不是另开一套编辑界面——两处编辑配置的写法必须是同一份，
 * 否则「主栏能清除、右栏不能」这类差异会慢慢长出来。
 */
function renderCfgSummaryCard(req) {
  const card = e('div', 'rqw-card');
  const hd = e('div', 'rqw-card-h');
  hd.appendChild(iconEl(SETTINGS_ICON_SVG, 'ic'));
  hd.appendChild(e('span', null, '工程配置'));
  hd.appendChild(e('span', 'gap'));
  const edit = e('button', 'rqw-iconbtn', cfgSummaryEditing ? '完成' : '编辑');
  edit.type = 'button';
  edit.onclick = () => {
    cfgSummaryEditing = !cfgSummaryEditing;
    renderReqPage(currentReq);
  };
  hd.appendChild(edit);
  card.appendChild(hd);

  if (cfgSummaryEditing) {
    const body = e('div', 'rqw-card-b');
    const slots = e('div', 'rqw-slots');
    slots.appendChild(makeProjSlot(req, 'frontend', '前端工程', FRONTEND_ICON_SVG));
    slots.appendChild(makeProjSlot(req, 'backend', '后端工程', BACKEND_ICON_SVG));
    slots.appendChild(makeDocSlot(req));
    body.appendChild(slots);
    card.appendChild(body);
    return card;
  }

  const body = e('div', 'rqw-card-b');
  const tree = e('div', 'rqw-tree');
  const rows = [
    ['前端', req.projects?.frontend],
    ['后端', req.projects?.backend],
  ];
  const items = [];
  for (const [k, p] of rows) {
    items.push({ k, v: p ? dirTail(p.dir) : '未配置', title: p?.dir, tag: p ? (p.dev ? 'dev' : 'ro') : null, blank: !p });
  }
  items.push({ k: '文档', v: req.reqDoc?.name || '未上传', title: req.reqDoc?.name, blank: !req.reqDoc });
  if (req.featureTag) items.push({ k: '模块', v: req.featureTag });

  items.forEach((it, i) => {
    const row = e('div', 'rqw-trow' + (it.blank ? ' blank' : ''));
    row.appendChild(e('span', 'br', i === items.length - 1 ? '└' : '├'));
    row.appendChild(e('span', 'k', it.k));
    const v = e('span', 'v', it.v);
    if (it.title) v.title = it.title;
    row.appendChild(v);
    if (it.tag) row.appendChild(e('span', 't ' + it.tag, it.tag === 'dev' ? '开发' : '只读'));
    tree.appendChild(row);
  });
  body.appendChild(tree);
  card.appendChild(body);
  return card;
}

/**
 * 问卷结论回看。用户填了东西必须能看到它被用了，否则不会填第二次 ——
 * 「＋说明」标记就是回答「我写的那段到底进没进去」。
 */
function renderQuizSummaryCard(req) {
  const questions = req.quiz.questions || [];
  const answers = req.quiz.answers || {};
  const answered = req.quiz.status === 'answered';

  const card = e('div', 'rqw-card');
  const hd = e('div', 'rqw-card-h');
  hd.appendChild(e('span', 'ic', '◈'));
  hd.appendChild(e('span', null, answered ? '本版问卷结论' : '待答问卷'));
  hd.appendChild(e('span', 'gap'));
  if (!req.busy) {
    const btn = e('button', 'rqw-iconbtn', answered ? '重答' : '去作答');
    btn.type = 'button';
    btn.onclick = () => beginGenerate(req, answered); // 重答要新题；「去作答」沿用已出的题
    hd.appendChild(btn);
  }
  card.appendChild(hd);

  const body = e('div', 'rqw-card-b');
  const tree = e('div', 'rqw-tree');
  questions.forEach((q, i) => {
    const a = answers[q.id];
    const unsure = a?.v === UNSURE_TAG;
    const picked = a?.v && !unsure ? q.opts.find((o) => o.v === a.v) : null;
    const row = e('div', 'rqw-trow' + (picked ? '' : ' blank'));
    row.appendChild(e('span', 'br', i === questions.length - 1 ? '└' : '├'));
    row.appendChild(e('span', 'k', 'Q' + (i + 1)));
    const v = e('span', 'v', picked ? picked.lab : unsure ? '不确定' : '未作答');
    v.title = q.title;
    row.appendChild(v);
    if ((a?.note || '').trim()) row.appendChild(e('span', 't note', '＋说明'));
    tree.appendChild(row);
  });
  body.appendChild(tree);
  card.appendChild(body);
  return card;
}

/** 与 req-quiz.js / req-quiz.logic.js 的 UNSURE_VALUE 同值，改动时三处一起改。 */
const UNSURE_TAG = '__unsure__';

function renderVersionCard(req) {
  const versions = (req.devDoc?.versions || []).slice().sort((a, b) => b.v - a.v);
  const latestV = Math.max(...versions.map((v) => v.v));
  const activeV = docOverride && versions.some((v) => v.v === docOverride.v) ? docOverride.v : latestV;

  const card = e('div', 'rqw-card');
  const hd = e('div', 'rqw-card-h');
  hd.appendChild(e('span', 'ic', '🗂'));
  hd.appendChild(e('span', null, '版本历史'));
  card.appendChild(hd);

  const list = e('div', 'rqw-vlist');
  for (const v of versions) {
    const row = e('div', 'rqw-vrow' + (v.v === activeV ? ' on' : ''));
    row.appendChild(e('span', 'v', 'v' + v.v));
    row.appendChild(e('span', 'at', fmtTime(v.at)));
    if (v.v === latestV) row.appendChild(e('span', 'now-tag', '最新'));
    row.onclick = () => selectDocVersion(req, v.v, latestV);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

/** 生成开销。只在最新版有耗时数据时出：老版本没记录过 ms/tokens。 */
function renderStatsCard(req) {
  const versions = req.devDoc?.versions || [];
  const latest = versions.find((v) => v.v === Math.max(...versions.map((x) => x.v)));
  if (!latest?.ms) return null;

  const card = e('div', 'rqw-card');
  const hd = e('div', 'rqw-card-h');
  hd.appendChild(e('span', 'ic', '📊'));
  hd.appendChild(e('span', null, '本版生成开销'));
  card.appendChild(hd);

  const body = e('div', 'rqw-card-b');
  const stats = e('div', 'rqw-stats');
  const add = (k, v, u) => {
    const row = e('div', 'rqw-stat');
    row.appendChild(e('span', 'k', k));
    row.appendChild(e('span', 'v', v));
    if (u) row.appendChild(e('span', 'u', u));
    stats.appendChild(row);
  };
  add('耗时', formatDocgenDuration(latest.ms));
  add('输入', ((latest.inputTokens || 0) / 1000).toFixed(1), 'k tokens');
  add('输出', ((latest.outputTokens || 0) / 1000).toFixed(1), 'k tokens');
  body.appendChild(stats);
  card.appendChild(body);
  return card;
}

/** 完成通知。空态也要能勾：不然首次生成完成的通知收不到。 */
function renderNotifyCard(req) {
  const card = e('div', 'rqw-card');
  const hd = e('div', 'rqw-card-h');
  hd.appendChild(e('span', 'ic', '🔔'));
  hd.appendChild(e('span', null, '完成通知'));
  card.appendChild(hd);

  const body = e('div', 'rqw-card-b');
  const label = e('label', 'rqw-notify');
  const chk = e('input');
  chk.type = 'checkbox';
  chk.className = 'pretty-check';
  chk.checked = !!req.notifyBotId;
  const dropdown = e('select', 'rqw-sel');
  dropdown.hidden = !req.notifyBotId;
  dropdown.onchange = () => saveNotifyBotId(req.id, dropdown.value || null);
  chk.onchange = () => {
    dropdown.hidden = !chk.checked;
    if (!chk.checked) saveNotifyBotId(req.id, null);
    else if (!dropdown._bots) loadBotsForNotify(dropdown, req.notifyBotId);
  };
  label.append(chk, e('span', null, '生成完成后通过机器人通知我'));
  body.appendChild(label);
  body.appendChild(dropdown);
  if (req.notifyBotId) loadBotsForNotify(dropdown, req.notifyBotId);
  card.appendChild(body);
  return card;
}

function renderReadonlyDoc(req) {
  const box = document.createElement('div');
  box.className = 'req-doc-content req-doc-readonly';
  if (req.devDocLatest) renderMarkdown(box, req.devDocLatest);
  else box.textContent = '暂无开发文档';
  return box;
}

// ---- 归档期：只读芯片条（复用评审期芯片条的展示样式，去掉可点击/编辑入口） ----

// 前端/后端/文档三种图标与评审期工作台的 makeProjSlot、开发/测试期横幅 renderBanner 共用
// icons.js 的同一份常量。原先此处三处各写一个 emoji，同一份工程数据在不同页面图标不一致，
// 只会让人以为看错了需求。
function renderReadonlyChipsBar(req) {
  const bar = document.createElement('div');
  bar.className = 'req-chips';
  const addChip = (icon, text, title) => {
    const chip = document.createElement('span');
    chip.className = 'req-chip req-chip-readonly';
    chip.appendChild(iconEl(icon));
    chip.appendChild(document.createTextNode(text));
    if (title) chip.title = title;
    bar.appendChild(chip);
  };
  const f = req.projects?.frontend;
  const b = req.projects?.backend;
  if (f) addChip(FRONTEND_ICON_SVG, `${dirTail(f.dir)} · ${f.dev ? '开发' : '只读'}`, f.dir);
  if (b) addChip(BACKEND_ICON_SVG, `${dirTail(b.dir)} · ${b.dev ? '开发' : '只读'}`, b.dir);
  if (req.reqDoc) addChip(DOC_ICON_SVG, req.reqDoc.name, req.reqDoc.name);
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

  // 汇总进度块（idle 时为空占位；由 setRetroProgress 就地填充，不整页重渲）
  const progressHost = document.createElement('div');
  progressHost.className = 'req-retro-progress';
  progressHost.id = 'reqRetroProgress';
  wrap.appendChild(progressHost);
  renderRetroProgress(progressHost); // 回填已有进度：归档页会因轮询/重开而整页重建

  // 按钮行：[优化汇总] [查看汇总会话] [确认归档]
  const btnRow = document.createElement('div');
  btnRow.className = 'req-archive-button-row';

  const retroBtn = document.createElement('button');
  retroBtn.type = 'button';
  retroBtn.className = 'btn req-retro-summary-btn';
  retroBtn.textContent = '优化汇总';
  retroBtn.onclick = () => startRetroSummary(req.id);
  btnRow.appendChild(retroBtn);

  // 「查看汇总会话」：汇总过程/结果全在 retro 会话里，之前没有任何入口能回看
  //（跑完后 run 注册表被 GC、busy 恒为 null，两条既有补救通道都不认 retro）。
  const retroSession = pickRetroSession(req);
  if (retroSession) {
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn req-retro-view-btn';
    viewBtn.textContent = '查看汇总会话';
    viewBtn.onclick = () => openRetroConv(req, retroSession);
    btnRow.appendChild(viewBtn);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn primary req-archive-confirm-btn';
  confirmBtn.textContent = '确认归档';
  confirmBtn.onclick = () => confirmArchive(req.id, confirmBtn);
  btnRow.appendChild(confirmBtn);

  wrap.appendChild(btnRow);

  return wrap;
}

const RETRO_PHASE_LABEL = {
  map: '逐会话小结中',
  reduce: '聚合提炼中',
  done: '汇总完成',
  failed: '汇总中断',
};

/** 就地渲染汇总进度块（不整页重渲，避免打断用户正在填的归档备注）。
 *  @param {HTMLElement} [hostEl] 归档页首次构建时元素还没进 DOM，由 renderArchivingPage 直接传入 */
function renderRetroProgress(hostEl) {
  const host = hostEl || document.getElementById('reqRetroProgress');
  if (!host) return; // 不在归档页（用户可能已切走），进度仍留在模块级状态里，回来时重建
  const p = retroProgress;
  host.innerHTML = '';
  if (p.phase === 'idle') return;
  // 别把上一个需求的进度画到这个需求的归档页上
  if (p.reqId && currentReqId && p.reqId !== currentReqId) return;

  const line = document.createElement('div');
  line.className = 'req-retro-progress-line';
  const label = RETRO_PHASE_LABEL[p.phase] || p.phase;
  const counter = p.phase === 'map' && p.total ? ` [${p.current}/${p.total}]` : '';
  const who = p.phase === 'map' && p.title ? ` 《${p.title}》` : '';
  // 跑完/中断就不再挂等待图标：那时这行是结论，不是进度
  const running = p.phase !== 'done' && p.phase !== 'failed';
  const lineText = `${label}${counter}${who}`;
  if (running) setIconText(line, WAITING_ICON_SVG, lineText);
  else line.textContent = lineText;
  host.appendChild(line);

  if (p.total) {
    const bar = document.createElement('div');
    bar.className = 'req-retro-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'req-retro-progress-fill';
    const ratio = p.phase === 'done' ? 1 : Math.min(1, p.current / Math.max(1, p.total));
    fill.style.width = Math.round(ratio * 100) + '%';
    bar.appendChild(fill);
    host.appendChild(bar);
  }

  if (p.failed) {
    const warn = document.createElement('div');
    warn.className = 'req-retro-progress-failed';
    warn.textContent = `${p.failed} 个会话处理失败（已跳过）`;
    host.appendChild(warn);
  }
}

/** 取该需求最近一条 retro 会话（可能汇总过多次，取最后建的那条）。 */
function pickRetroSession(req) {
  const retros = (req?.sessions || []).filter((s) => s.kind === 'retro' && s.convId);
  return retros.length ? retros[retros.length - 1] : null;
}

/**
 * 打开汇总会话回看。
 * 过程若曾实时落库（当时有人看着）直接就能看到；若没有——系统 run 的输出只在客户端挂着流时
 * 才写 localStorage——就从磁盘 Claude 转录回放（sessionId 已由 SSE session 事件回填到
 * requirements.json 的 sessions[kind==='retro']，GET /api/history/:sid 可读）。
 */
async function openRetroConv(req, session) {
  await openConv(session.convId); // 用户手势：跳视图
  if (!session.sessionId) return; // 汇总刚起、还没拿到 session id：实时流会自己把内容画出来
  const cwd = req.devCwd || req.projects?.frontend?.dir || req.projects?.backend?.dir || '';
  try {
    const { loadReqTranscript } = await import('./chat.js');
    // loadReqTranscript 自带护栏：有实时流或会话已有内容就不动，避免覆盖正在跑的汇总
    await loadReqTranscript(session.convId, session.sessionId, cwd);
  } catch (e) {
    console.error('[openRetroConv] 转录回放失败', e);
    window.toast.warn('汇总会话转录回放失败：' + (e?.message || e));
  }
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
  // 同一需求重复点：正在跑就别再起一轮（map-reduce 是长流程，两轮并发会互相抢 waitForRunCompletion）
  if (retroProgress.reqId === reqId && (retroProgress.phase === 'map' || retroProgress.phase === 'reduce')) {
    window.toast.info('汇总正在进行中');
    return;
  }

  // 获取工程目录（前后端优先）
  const cwd = req.projects?.frontend?.dir || req.projects?.backend?.dir || '';

  try {
    setRetroProgress({ phase: 'map', reqId, total: 0, current: 0, title: '准备中', failed: 0 });
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
      setRetroProgress({ phase: 'idle', reqId: null });
      return;
    }

    // 打开 retro 会话（用户手势发起，跳视图；map 步骤的气泡随后就画在这里）
    openConv(retroConvId);

    // 重渲侧栏树
    if (window._updateReqList) window._updateReqList();

    // 启动 map-reduce 编排
    runRetroMapReduce(reqId, retroConvId, cwd, existingPitfalls);
  } catch (e) {
    window.toast.error('启动汇总失败：' + (e?.message || e));
    console.error('[startRetroSummary]', e);
    setRetroProgress({ phase: 'failed' });
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
  setRetroProgress({ phase: 'map', total: validSessions.length, current: 0, title: '', failed: 0 });
  for (let i = 0; i < validSessions.length; i++) {
    const session = validSessions[i];
    const progress = `[${i + 1}/${validSessions.length}]`;
    setRetroProgress({ current: i + 1, title: session.title || '未命名会话' });

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
        bumpRetroFailed();
        continue;
      }

      // 构造转录文本
      let transcript = (hist.data.messages || [])
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n\n');

      // 截断保护：超 30000 字符时首尾各取 15000
      const TRUNCATE_LIMIT = 30000;
      let truncatedNote = '';
      const rawLen = transcript.length; // 先记原长：截断后再反推会把 ellipsis 的长度算进去
      if (rawLen > TRUNCATE_LIMIT) {
        const half = Math.floor(TRUNCATE_LIMIT / 2);
        const dropped = rawLen - TRUNCATE_LIMIT;
        const ellipsis = `…（已截断 ${dropped} 字符）…`;
        transcript = transcript.slice(0, half) + ellipsis + transcript.slice(-half);
        // 截断信息写进用户气泡本身，而不是另插一条系统消息（旧做法字段名写错且从未落盘，
        // 且单独插一条只落库不上屏的消息会破坏「存储索引 = DOM 索引」不变量）
        truncatedNote = `（原转录 ${Math.round(rawLen / 1000)}KB 超限，已截断中段 ${dropped} 字符）`;
        window.toast.info(`${progress} 转录已截断，详情见会话内该步骤气泡`);
      }

      // 生成 map 提示词（调用服务端生成或客户端拼装）
      const mapPrompt = buildClientRetroMapPrompt(session.title, transcript, i + 1, validSessions.length);

      // 发送 map 消息到 retro 会话。displayText 只放简短说明——真正发出去的 mapPrompt 里塞着
      // 整份转录（可达 30KB），直接进气泡会把对话区撑爆
      await sendMessageToConv(retroConvId, mapPrompt, {
        displayText: `${progress} 汇总会话《${session.title || '未命名会话'}》${truncatedNote}`,
      });

      // 等待 run 完成，收集 assistant 回复
      const mapResult = await waitForRunCompletion(retroConvId);
      mapMessages.push({ role: 'assistant', content: mapResult });

      // 单会话小结完成，显示进度
      window.toast.success(`${progress} 会话已处理`);
    } catch (e) {
      window.toast.warn(`${progress} 处理失败：${e?.message || e}`);
      console.error(`[MAP ${i + 1}]`, e);
      bumpRetroFailed();
    }
  }

  if (mapMessages.length === 0) {
    window.toast.error('未能收集任何会话小结，汇总中止');
    setRetroProgress({ phase: 'failed' });
    return;
  }

  // ★ REDUCE 阶段：聚合分析
  try {
    setRetroProgress({ phase: 'reduce' });
    const reducePrompt = buildClientRetroReducePrompt(mapMessages, existingPitfalls);
    await sendMessageToConv(retroConvId, reducePrompt, {
      displayText: `[汇总] 聚合 ${mapMessages.length} 份会话小结，提炼避坑清单`,
    });

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

    setRetroProgress({ phase: 'done' });
    // 预览确认（即使 pitfallsText 为空也弹出，让用户看到"无新内容"并确认或手动编辑）
    await showPitfallsPreviewDialog(reqId, pitfallsText || '');
  } catch (e) {
    window.toast.error('reduce 阶段失败：' + (e?.message || e));
    console.error('[REDUCE]', e);
    setRetroProgress({ phase: 'failed' });
  }
}

/**
 * 向会话发送消息（服务端起 run；目标会话正被查看时会画出气泡与流式输出）。
 * @param {string} convId 会话 ID
 * @param {string} text 真正发给模型的提示词
 * @param {{displayText?: string}} [opts] 见 chat.js sendMessageBackground：给出简短说明用于气泡展示，
 *   避免把整份转录塞进对话区
 * @returns {Promise<void>}
 */
async function sendMessageToConv(convId, text, opts = {}) {
  try {
    const { sendMessageBackground } = await import('./chat.js');
    return await sendMessageBackground(convId, text, opts);
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
            // 字段名是 text 不是 content（见 conv-store.js convPushMessage）。原来写 .content
            // 恒取到 undefined → map 结果全是 undefined → reduce 提示词拼成「1. undefined」→
            // extractPitfallsBlock(undefined) 抛 TypeError，导致每一次汇总都在最后一步失败。
            resolve(conv.messages[i].text);
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

// 原本这里有个局部 addMessage(convId, {role, content})，用来往 retro 会话塞「转录已截断」提示。
// 它有两处硬伤：① 写的字段名是 content，而 conv-store 存的是 text（渲染侧读 m.text）；
// ② 注释说「不调 saveConvs 由上层决定」，而唯一的调用方从没保存过。
// 所以 toast 里那句「详见 retro 会话消息」指向的消息从来不存在——这正是用户说"找不到入口"的原因。
// 现在截断提示直接并进 map 步骤的 displayText（见 runRetroMapReduce），一并解决了另一个问题：
// 单独插一条「只落库不上屏」的消息会破坏「存储索引 = DOM 索引」不变量（本仓的既有铁律）。

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
  // 空值防御：reduce 结果拿不到时（run 异常/超时/会话被删）原来会在 text.match 直接抛 TypeError，
  // 把一个「没结果」变成一个看不懂的崩栈
  if (typeof text !== 'string' || !text) return { report: '', pitfallsText: null };
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

// ---- 评审期：错误条 / busy 进度条 ----

/** 错误条只报事实。重试入口在右栏行动区（那里能同时说明"结论已保留"），不在这里重复给按钮。 */
function renderErrorBanner(req) {
  if (req.busy || !lastEventFailed(req)) return null;
  const last = (req.history || []).at(-1);
  const bar = e('div', 'rqw-bar err');
  bar.appendChild(e('span', 'ic', '✕'));
  bar.appendChild(e('span', 'tx', last.event));
  return bar;
}

/**
 * 地图系 busy 的文案。这四类任务都不是「开发文档生成」，套用那套文案是假话；且下面那个
 * 「停止」按钮只对 docgen 有效（走 docgenAborts 注册表），对它们点了不会有任何反应。
 * 故 renderBusyBar 里单独早返回，不落到默认分支。
 */
const MAP_BUSY_TEXT = {
  mapgen: '正在生成需求地图…',
  mapfix: '正在按你的标注修订需求地图…',
  mapchange: '正在按需求变动更新地图…',
  mapregen: '正在重新通读代码并生成需求地图…',
};

function renderBusyBar(req) {
  if (!req.busy) return null;
  const bar = e('div', 'rqw-bar busy');
  bar.appendChild(e('div', 'rqw-spin'));
  // busy 条每 3s 随轮询整页重建，据 startedAt 现算已运行时长，让「生成中」有可见进度、不显得假死。
  // docgen 需实际读工程 + 生成长文档，大型工程或遇账号限流时耗时可达十几分钟，故明确提示可离开。
  const startedAt = req.busy.startedAt;
  const mins = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 60000)) : 0;
  const body = e('div');
  // 出题阶段不能套用「开发文档生成中」那套文案与时长口径：它只跑十几秒、且不读工程代码
  if (req.busy.kind === 'quizgen') {
    body.appendChild(e('span', null, '正在分析需求文档中的不确定点…'));
    body.appendChild(document.createElement('br'));
    body.append(
      req.prime?.text
        ? '模型在通读需求文档并结合你补充的背景，找出没写清、但会影响实现的地方。你已说明的部分不会再问。通常十几秒。'
        : '模型在通读需求文档，找出没写清、但会影响实现的地方。通常十几秒。分析不出结果也不影响生成，会直接跳到读代码。',
    );
    bar.appendChild(body);
    return bar;
  }
  if (MAP_BUSY_TEXT[req.busy.kind]) {
    body.appendChild(e('span', null, MAP_BUSY_TEXT[req.busy.kind]));
    body.appendChild(document.createElement('br'));
    body.append(
      (req.busy.kind === 'mapregen' ? '模型在按当前代码的实际实现重新查证一遍，耗时与生成开发文档同量级。' : '') +
        '完成后会自动切到新版本。' +
        (mins > 0 ? '已用时 ' + mins + ' 分钟。' : ''),
    );
    bar.appendChild(body);
    return bar;
  }
  // 头部：文案 + 停止按钮（同一行）
  const headRow = e('div', 'docgen-head-row');
  const head = e('span', null, hasDevDoc(req) ? '开发文档修订中…' : '开发文档生成中…');
  const stopBtn = e('button', 'rqw-btn-small', '停止');
  stopBtn.type = 'button';
  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = '停止中…';
    try {
      const r = await fetch('/api/req/docgen/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id }),
      });
      if (!r.ok) {
        window.toast?.error('停止失败，请稍后重试');
        stopBtn.disabled = false;
        stopBtn.textContent = '停止';
      } else {
        // 兜底：若 10s 后轮询仍未重渲（服务端异常不清 busy），恢复按钮让用户可再试
        setTimeout(() => {
          if (stopBtn.disabled) {
            stopBtn.disabled = false;
            stopBtn.textContent = '停止';
          }
        }, 10000);
      }
      // 成功：3s busy 轮询感知 busy=null 后整页重渲，按钮自动消失
    } catch (_e) {
      window.toast?.error('网络错误');
      stopBtn.disabled = false;
      stopBtn.textContent = '停止';
    }
  };
  headRow.appendChild(head);
  headRow.appendChild(stopBtn);
  body.appendChild(headRow);

  if (startedAt) body.appendChild(e('span', 'el', `（已运行 ${mins} 分钟）`));
  body.appendChild(document.createElement('br'));

  const answeredCount = Object.keys(req.quiz?.answers || {}).length;
  body.append(
    (answeredCount ? `已采纳你的 ${answeredCount} 项问卷结论，` : '') +
      '正在阅读工程实际代码。无时间限制，可先离开，完成后回来查看。',
  );

  // 实时日志（liveLog 由 GET /api/req/get 每 3s 带回）
  if (req.liveLog) {
    const logDiv = e('div', 'docgen-livelog');
    const logCode = e('code', null, req.liveLog);
    logDiv.appendChild(logCode);
    body.appendChild(logDiv);
  }

  bar.appendChild(body);
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

/**
 * 评审期双报告区：开发文档（技术细节）+ 需求地图（页面 × 逻辑点）。
 * 只有地图存在时才出页签——没地图时多一排空标签只会让人以为坏了。
 */
function renderReportArea(req) {
  const hasMap = !!(req.reqMap?.versions || []).length && !!req.mapLatest;
  if (!hasMap) {
    reportTab = 'doc';
    return renderDocArea(req);
  }
  const box = document.createElement('div');
  box.className = 'rq-report';

  const tabs = document.createElement('div');
  tabs.className = 'rq-report-tabs';
  const mk = (key, label, badge) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rq-report-tab' + (reportTab === key ? ' on' : '');
    b.appendChild(Object.assign(document.createElement('span'), { textContent: label }));
    if (badge) {
      const n = document.createElement('span');
      n.className = 'rq-report-badge';
      n.textContent = badge;
      b.appendChild(n);
    }
    b.onclick = () => {
      if (reportTab === key) return;
      reportTab = key;
      renderReqPage(req);
    };
    tabs.appendChild(b);
  };
  const points = (req.mapLatest.pages || []).reduce((n, p) => n + (p.points || []).length, 0);
  mk('doc', '开发文档');
  mk('map', '需求地图', points + ' 处变更');
  box.appendChild(tabs);

  if (reportTab === 'doc') {
    box.appendChild(renderDocArea(req));
    return box;
  }
  const host = document.createElement('div');
  host.className = 'rq-report-map';
  box.appendChild(host);
  // mountMap 要量容器尺寸做「适应」缩放，必须等它进 DOM 之后再挂
  requestAnimationFrame(() => {
    if (!document.body.contains(host)) return;
    mountMap(host, {
      reqId: req.id,
      phase: req.phase,
      map: req.mapLatest,
      versions: (req.reqMap?.versions || []).map((x) => ({ v: x.v, at: x.at })),
      busy: req.busy,
      // 刷新后 req.busy 非空，现有 3s 轮询自动接管；busy 下降沿的「回到最新版」逻辑会带出重扫结果
      onRegen: () => loadAndRenderReq(req.id),
      onReload: () => loadAndRenderReq(req.id),
      onRestore: (prompt) => {
        // 评审期还没有需求会话，还原只能等定稿进开发期再点
        if (!req.convId) return window.toast.error('还原需要开发会话，请先定稿进入开发期');
        sendMessageProgrammatically(prompt, { mode: 'bypassPermissions' });
      },
    });
  });
  return box;
}

/**
 * 文档区。相比旧版少了三块，都是挪走而非删掉：
 * - 定稿按钮 → 右栏行动区（它是评审期唯一不可逆动作，挤在版本条右端太不起眼）
 * - 耗时/tokens 统计 → 右栏「本版生成开销」卡
 * - 通知勾选 → 右栏「完成通知」卡
 * 本函数只在已有版本时被调用（无版本时主栏渲染的是配置卡），故不再有空态分支。
 */
function renderDocArea(req) {
  const box = e('div', 'rqw-docarea');
  const versions = req.devDoc?.versions || [];
  const latestV = Math.max(...versions.map((v) => v.v));
  const activeV = docOverride && versions.some((v) => v.v === docOverride.v) ? docOverride.v : latestV;
  const activeEntry = versions.find((v) => v.v === activeV);
  const showingLatest = activeV === latestV && !docOverride;
  const content = showingLatest ? req.devDocLatest ?? '' : docOverride?.content ?? '';

  const bar = e('div', 'rqw-docbar');
  for (const v of versions) {
    const tab = e('button', 'rqw-vtab' + (v.v === activeV ? ' on' : ''), 'v' + v.v);
    tab.type = 'button';
    tab.onclick = () => selectDocVersion(req, v.v, latestV);
    bar.appendChild(tab);
  }
  bar.appendChild(e('span', 'gap'));
  bar.appendChild(
    e(
      'span',
      'hint',
      showingLatest
        ? `正在看最新版 · ${fmtTime(activeEntry?.at)} 生成`
        : `正在看历史版 v${activeV} · 最新是 v${latestV}`,
    ),
  );
  box.appendChild(bar);

  if (activeEntry?.summary) {
    const sum = e('div', 'rqw-sum');
    sum.appendChild(e('div', 'rqw-sum-l', '本版改动摘要'));
    const body = e('div', 'rqw-sum-b');
    renderMarkdown(body, activeEntry.summary);
    sum.appendChild(body);
    box.appendChild(sum);
  }

  const doc = e('div', 'rqw-doc');
  const contentEl = e('div', 'req-doc-content'); // 沿用 renderMarkdown 的样式契约，不重复一套排版规则
  renderMarkdown(contentEl, content);
  doc.appendChild(contentEl);
  box.appendChild(doc);
  return box;
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
  setIconText(attachBtn, ATTACH_ICON_SVG);
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
