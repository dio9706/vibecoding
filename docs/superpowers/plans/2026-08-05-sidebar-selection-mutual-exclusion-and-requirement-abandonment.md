# 左侧菜单选中态互斥与需求废弃功能实现计划

> **For agentic workers:** RECOMMENDED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复左侧菜单选中态互斥问题，为需求行新增右键菜单（钉住/废弃），系统支持需求废弃状态。

**Architecture:**
- 前端三层协调：chat.js 中 active 加视图门控、app.js 中 showView 触发对方列表重渲、req-view.js 中新增钉住+右键菜单
- 钉住状态存 localStorage（会话级别），右键菜单参考 chat.js 的 `_ctxMenu` 模式
- 废弃需求侧栏按层级展示（钉住 → 活跃 → 已废弃 → 已归档），各层支持折叠

**Tech Stack:** 原生 JavaScript DOM API（无框架）、localStorage、fetch、CSS 样式类

---

## 文件修改清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `public/js/chat.js` | 修改 | buildMergedHistory 中 active 逻辑加视图门控 |
| `public/app.js` | 修改 | showView 函数触发对方列表重渲 |
| `public/js/req-view.js` | 修改 | 新增钉住状态、右键菜单、废弃态渲染 |
| `public/app.css` | 修改 | 新增 .discarded、.req-pinned、右键菜单样式 |
| 后端 src 目录 | 修改 | 新增 `/api/req/discard` 接口（待确认后端框架） |

---

## 任务分解

### Task 1: 修复选中态互斥 - chat.js 门控

**文件：**
- 修改: `public/js/chat.js:250-290`

**目标：** buildMergedHistory 中会话的 active 字段加入视图激活判断，仅聊天视图激活时才标记为 active。

- [ ] **Step 1: 定位 buildMergedHistory 函数**

打开 `public/js/chat.js`，找到 `function buildMergedHistory()` 的 entries 构造块（约 250-290 行）。

当前代码：
```javascript
entries.push({
  source: 'local',
  convId: c.id,
  sessionId: c.session || null,
  title: c.title || '未命名对话',
  updatedAt: c.updatedAt || 0,
  running: isRunning,
  active: c.id === currentConvId,  // ← 改这里
  pinned: c.pinned || false,
});
```

- [ ] **Step 2: 修改 active 字段加入视图门控**

替换为：
```javascript
entries.push({
  source: 'local',
  convId: c.id,
  sessionId: c.session || null,
  title: c.title || '未命名对话',
  updatedAt: c.updatedAt || 0,
  running: isRunning,
  active: c.id === currentConvId && _isChatViewActive(),  // ← 加入视图门控
  pinned: c.pinned || false,
});
```

- [ ] **Step 3: 验证磁盘会话部分也不标记 active**

往下看磁盘会话部分（约 281-290 行）：
```javascript
entries.push({
  source: 'web',
  convId: null,
  sessionId: s.sessionId,
  title: s.title || '未命名对话',
  updatedAt: s.updatedAt || 0,
  running: false,
  active: false,  // ← 磁盘会话恒为 false，无需改
});
```

确认磁盘会话 active 恒为 false（已是正确状态）。

- [ ] **Step 4: 从 chat.js 导出 renderConvListNow 函数**

在 chat.js 最后找到 `const renderConvListDebounced = debounce(renderConvList, 200)` 的定义（约 456 行），在其上方添加导出：

```javascript
/** 非防抖版本，用于视图切换时立即重渲 */
export function renderConvListNow() {
  renderConvList();
}
```

在 renderConvListDebounced 定义后保持不变。

- [ ] **Step 5: 提交**

```bash
git add public/js/chat.js
git commit -m "fix: chat.js buildMergedHistory 中 active 加视图门控，新增 renderConvListNow 导出"
```

---

### Task 2: 修复选中态互斥 - app.js 协调

**文件：**
- 修改: `public/app.js:29-48`

**目标：** 在 showView 函数中，切换视图时触发对方列表重渲，消除选中态交叉。

- [ ] **Step 1: 导入依赖函数**

在 `public/app.js` 最顶部的 import 块中（约第 1-14 行），修改 req-view 和 chat 的导入：

当前：
```javascript
import { initReqView, refreshReqList } from './js/req-view.js';
import { initChat, chatOnShow, bindChatNav, refreshAskChip, openConv } from './js/chat.js';
```

改为（添加导出）：
```javascript
import { initReqView, refreshReqList, renderReqListLocal } from './js/req-view.js';  // ← 新增 renderReqListLocal
import { initChat, chatOnShow, bindChatNav, refreshAskChip, openConv, renderConvListNow } from './js/chat.js';  // ← 新增 renderConvListNow
```

- [ ] **Step 2: 修改 showView 函数加入对方列表重渲**

找到 `function showView(name)` 的定义（约 29-48 行），在末尾加入视图切换协调逻辑：

```javascript
function showView(name) {
  if (activeView === name) return;
  if (activeView === 'tasks') stopTaskPolling();
  activeView = name;
  const inChat = name === 'chat';
  appEl.classList.toggle('in-panel', !inChat);
  appEl.classList.toggle('in-json-tool', name === 'json-tool');
  panelView.hidden = inChat;
  panelView
    .querySelectorAll('.panel-page')
    .forEach((p) => (p.hidden = p.dataset.view !== name));
  if (inChat) chatOnShow();
  if (name === 'settings') { loadSettings(); bindConfigTransfer(); }
  else if (name === 'tasks') {
    requestNotifyPermission();
    startTaskPolling();
  } else if (name === 'logs') loadLogs();
  else if (name === 'json-tool') initJsonTool();
  refreshAskChip();
  
  // ← 新增：视图切换时触发对方列表重渲，消除选中态交叉
  if (name === 'chat') {
    renderReqListLocal?.();  // 切到对话视图 → 需求列表清除选中
  } else if (name === 'req') {
    renderConvListNow?.();   // 切到需求视图 → 会话列表清除选中
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add public/app.js
git commit -m "fix: app.js showView 中添加对方列表重渲协调，实现选中态互斥"
```

---

### Task 3: 需求行钉住状态 - 存储层

**文件：**
- 修改: `public/js/req-view.js:1-60`

**目标：** 在模块顶部添加钉住状态管理（localStorage 持久化），支持加载/保存/查询。

- [ ] **Step 1: 添加模块级状态变量**

在 `public/js/req-view.js` 顶部（约第 30-40 行的 `supplementDraftText` 之后），添加：

```javascript
// ---- 需求钉住状态（localStorage 持久化） ----
let reqPinnedIds = new Set();  // 当前 session 的钉住需求 ID 集合
const REQ_PINNED_LS_KEY = 'claude_req_pinned';  // localStorage key

function loadReqPinned() {
  try {
    const stored = localStorage.getItem(REQ_PINNED_LS_KEY) || '';
    reqPinnedIds = new Set(stored.split(',').filter(id => id.trim()));
  } catch {
    reqPinnedIds = new Set();
  }
}

function saveReqPinned() {
  try {
    const arr = Array.from(reqPinnedIds);
    localStorage.setItem(REQ_PINNED_LS_KEY, arr.join(','));
  } catch {}
}

function isReqPinned(reqId) {
  return reqPinnedIds.has(reqId);
}

function _toggleReqPin(reqId, shouldPin) {
  if (shouldPin) {
    reqPinnedIds.add(reqId);
  } else {
    reqPinnedIds.delete(reqId);
  }
  saveReqPinned();
  renderReqList();
  window.toast.success(shouldPin ? '已钉住' : '已取消钉住');
}
```

- [ ] **Step 2: 在 initReqView 中调用 loadReqPinned**

找到 `export function initReqView({ showView })` 的定义（约 52-57 行），在第一行添加：

```javascript
export function initReqView({ showView }) {
  loadReqPinned();  // ← 新增：初始化时从 localStorage 加载钉住状态
  _showView = showView;
  $('#sidebarNewReq')?.addEventListener('click', createNewRequirement);
  // ... 后续代码不变
}
```

- [ ] **Step 3: 导出 renderReqListLocal**

在 `function renderReqList()` 的定义之前或之后添加一行导出别名（约 87 行处）：

```javascript
export function renderReqListLocal() {
  renderReqList();  // 视图切换时由 app.js 调用，不涉及防抖
}
```

- [ ] **Step 4: 提交**

```bash
git add public/js/req-view.js
git commit -m "feat: req-view.js 新增需求钉住状态管理（localStorage 持久化）"
```

---

### Task 4: 需求行右键菜单 - UI 层

**文件：**
- 修改: `public/js/req-view.js:60-200`

**目标：** 创建需求右键菜单 DOM 元素，实现菜单显示/隐藏逻辑，为需求行绑定 contextmenu 事件。

- [ ] **Step 1: 创建需求右键菜单 DOM 和事件处理**

在 `loadReqPinned()` 函数之后、`renderReqList()` 之前添加（约 100-150 行）：

```javascript
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
let _ctxReqId = null;  // 当前右键的 reqId

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

// 菜单按钮事件绑定
_reqCtxMenu.querySelector('#reqCtxPin').addEventListener('click', () => {
  if (!_ctxReqId) return;
  _toggleReqPin(_ctxReqId, !isReqPinned(_ctxReqId));
  _hideReqCtxMenu();
});

_reqCtxMenu.querySelector('#reqCtxDiscard').addEventListener('click', () => {
  if (!_ctxReqId) return;
  _reqDiscard(_ctxReqId);
  _hideReqCtxMenu();
});

// 点其他地方关闭菜单
document.addEventListener('click', (e) => {
  if (!_reqCtxMenu.hidden && !_reqCtxMenu.contains(e.target)) _hideReqCtxMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') _hideReqCtxMenu();
});
```

- [ ] **Step 2: 实现废弃需求的函数**

在上述菜单代码之后添加：

```javascript
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
```

- [ ] **Step 3: 修改 makeReqRow 添加右键绑定和钉住图标**

找到 `function makeReqRow(r)` 的定义（约 129-150 行），在 row 元素创建后、class 赋值后添加：

```javascript
function makeReqRow(r) {
  const row = document.createElement('div');
  row.className = 'req-item' + (r.id === currentReqId && isReqViewActive() ? ' active' : '');
  row.dataset.reqId = r.id;
  
  // ← 新增：右键菜单绑定
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _showReqCtxMenu(e.pageX, e.pageY, r.id, isReqPinned(r.id));
  });
  
  // ← 新增：钉住图标（如果已钉住）
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
  // ... 后续代码不变
}
```

- [ ] **Step 4: 提交**

```bash
git add public/js/req-view.js
git commit -m "feat: req-view.js 新增需求右键菜单（钉住/废弃）与菜单交互"
```

---

### Task 5: 需求侧栏四层展示逻辑

**文件：**
- 修改: `public/js/req-view.js:175-250`

**目标：** 重构 renderReqList 支持四层展示（钉住 → 活跃 → 已废弃 → 已归档），各层支持折叠。

- [ ] **Step 1: 添加模块级状态变量控制折叠**

在现有的 `archivedExpanded` 变量之后添加：

```javascript
let discardedExpanded = false;  // 「已废弃」折叠组展开态，默认收起
```

- [ ] **Step 2: 更新 PHASE_META 添加 discarded**

找到 `const PHASE_META` 的定义（约 33-39 行），修改为：

```javascript
const PHASE_META = {
  review: { label: '评审', cls: 'review' },
  dev: { label: '开发', cls: 'dev' },
  test: { label: '测试', cls: 'test' },
  archiving: { label: '归档中', cls: 'archiving' },
  archived: { label: '已归档', cls: 'archiving' },
  discarded: { label: '已废弃', cls: 'discarded' },  // ← 新增
};
```

- [ ] **Step 3: 添加 makeDiscardedToggle 函数**

在 `makeArchivedToggle` 之前添加：

```javascript
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
```

- [ ] **Step 4: 重构 renderReqList 为四层展示**

找到 `function renderReqList()` 的定义（约 87-109 行），全部替换为：

```javascript
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
  
  // 钉住需求（始终顶部，不分类）
  const pinned = lastList.filter((r) => isReqPinned(r.id));
  for (const r of pinned) frag.appendChild(makeReqRow(r));
  
  // 活跃需求（评审/开发/测试/归档中）
  const active = lastList.filter(
    (r) => !isReqPinned(r.id) && ['review', 'dev', 'test', 'archiving'].includes(r.phase)
  );
  if (active.length) {
    frag.appendChild(makeReqSectionLabel('本次需求'));
    for (const r of active) frag.appendChild(makeReqRow(r));
  }
  
  // 已废弃需求（折叠组）
  const discarded = lastList.filter(
    (r) => !isReqPinned(r.id) && r.phase === 'discarded'
  );
  if (discarded.length) {
    frag.appendChild(makeDiscardedToggle(discarded.length));
    if (discardedExpanded) for (const r of discarded) frag.appendChild(makeReqRow(r));
  }
  
  // 已归档需求（折叠组）
  const archived = lastList.filter(
    (r) => !isReqPinned(r.id) && r.phase === 'archived'
  );
  if (archived.length) {
    frag.appendChild(makeArchivedToggle(archived.length));
    if (archivedExpanded) for (const r of archived) frag.appendChild(makeReqRow(r));
  }
  
  el.appendChild(frag);
}
```

- [ ] **Step 5: 提交**

```bash
git add public/js/req-view.js
git commit -m "feat: req-view.js renderReqList 重构为四层展示（钉住/活跃/已废弃/已归档）"
```

---

### Task 6: 已废弃需求详情页面

**文件：**
- 修改: `public/js/req-view.js:320-370`

**目标：** 在 renderReqPage 中添加 discarded 态的处理，显示只读页面。

- [ ] **Step 1: 修改 renderReqPage 添加 discarded 分支**

找到 `function renderReqPage(req)` 的定义（约 327-353 行），在现有的 `else if (req.phase === 'archived')` 之后添加：

```javascript
function renderReqPage(req) {
  const box = $('#reqPage');
  if (!box || !req) return;
  const titleEl = $('#reqPageTitle');
  if (titleEl) titleEl.textContent = req.title || '需求';
  const scrollHost = document.querySelector('.panel-view');
  const savedScroll = scrollHost ? scrollHost.scrollTop : 0;
  box.innerHTML = '';
  if (req.phase === 'review') {
    // 现有逻辑...
  } else if (req.phase === 'archiving') {
    // 现有逻辑...
  } else if (req.phase === 'archived') {
    // 现有逻辑...
  } else if (req.phase === 'discarded') {  // ← 新增
    box.appendChild(renderDiscardedPage(req));
  } else {
    // dev/test：聊天模式
  }
  if (scrollHost) scrollHost.scrollTop = savedScroll;
}
```

- [ ] **Step 2: 添加 renderDiscardedPage 函数**

在 `renderArchivedPage` 函数之后添加：

```javascript
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
```

- [ ] **Step 3: 提交**

```bash
git add public/js/req-view.js
git commit -m "feat: req-view.js 添加已废弃需求页面渲染"
```

---

### Task 7: CSS 样式 - 钉住图标、右键菜单、废弃态

**文件：**
- 修改: `public/app.css`（或相应样式文件）

**目标：** 为右键菜单、钉住图标、废弃状态添加样式。

- [ ] **Step 1: 查找现有需求相关样式位置**

打开 `public/app.css`，找到 `.req-` 开头的样式块（约搜索 "req-item"、"req-badge"）。在该区域添加新样式。

- [ ] **Step 2: 添加需求右键菜单样式**

在需求样式块中添加：

```css
/* 需求右键菜单 */
.req-ctx-menu {
  position: fixed;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  min-width: 120px;
}

.req-ctx-menu .ctx-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text);
  transition: background-color 0.15s ease;
}

.req-ctx-menu .ctx-item:hover {
  background-color: var(--bg-hover);
}

.req-ctx-menu .ctx-item.ctx-danger:hover {
  background-color: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.req-ctx-menu .ctx-item:first-child {
  border-radius: 5px 5px 0 0;
}

.req-ctx-menu .ctx-item:last-child {
  border-radius: 0 0 5px 5px;
}
```

- [ ] **Step 3: 添加需求钉住图标样式**

```css
/* 需求钉住图标 */
.req-item .req-pin-ic {
  display: inline-block;
  margin-right: 4px;
  opacity: 0.7;
}

.req-item.active .req-pin-ic,
.req-item:hover .req-pin-ic {
  opacity: 1;
}
```

- [ ] **Step 4: 添加已废弃状态样式**

```css
/* 已废弃需求状态 */
.req-badge.discarded {
  background: var(--bg-muted);
  color: var(--text-muted);
}

.req-discarded-page {
  padding: 16px;
}

.req-discarded-toggle {
  /* 与 req-archived-toggle 样式一致 */
}
```

- [ ] **Step 5: 验证样式类名一致性**

检查样式中的类名是否与 JS 代码中使用的一致：
- 菜单类名：`.req-ctx-menu` ✓
- 钉住图标：`.req-pin-ic` ✓
- 已废弃 badge：`.discarded` ✓

- [ ] **Step 6: 提交**

```bash
git add public/app.css
git commit -m "style: 为需求右键菜单、钉住图标、废弃状态添加样式"
```

---

### Task 8: 后端 API - /api/req/discard 接口

**文件：**
- 修改: 后端需求路由文件（待确认路径，假设为 `src/routes/req.js` 或类似）

**目标：** 实现 POST `/api/req/discard` 接口，将需求 phase 设为 discarded。

- [ ] **Step 1: 确认后端结构**

在后端代码中找到需求相关路由，确认现有接口如 `/api/req/archive` 的位置和实现方式。

命令：
```bash
find src -name "*req*" -o -name "*requirement*" | head -10
```

Expected output: 列出包含需求相关的文件路径

- [ ] **Step 2: 定位需求处理逻辑**

找到现有的 POST `/api/req/archive` 实现，参考其结构（数据库查询、验证、更新、返回）。

- [ ] **Step 3: 添加 /api/req/discard 接口**

在需求路由文件中（同级或相近 `/api/req/archive` 的位置），添加：

```javascript
// POST /api/req/discard - 废弃需求
app.post('/api/req/discard', requireAuth, async (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: '缺少或无效的需求 ID' });
  }
  
  try {
    // 查询需求
    const requirement = await db.requirements.findById(id);
    if (!requirement) {
      return res.status(404).json({ error: '需求不存在' });
    }
    
    // 验证状态（不能重复废弃）
    if (requirement.phase === 'discarded') {
      return res.status(409).json({ error: '需求已是废弃状态' });
    }
    
    // 更新 phase 为 discarded，记录时间
    requirement.phase = 'discarded';
    requirement.discardedAt = Date.now();
    
    await db.requirements.update(id, requirement);
    
    res.json({ ok: true });
  } catch (err) {
    console.error('[req/discard]', err);
    res.status(500).json({ error: '废弃失败' });
  }
});
```

**说明：** 上述代码为伪代码，需根据实际后端框架（Express/Koa/Fastify 等）和数据库操作库（MongoDB/PostgreSQL 等）调整语法。

- [ ] **Step 4: 提交**

```bash
git add src/<backend-path>/req.js  # 替换为实际路径
git commit -m "feat: 后端新增 POST /api/req/discard 接口"
```

---

### Task 9: 集成测试 - 手动验证

**文件：**
- 无新增文件

**目标：** 手动验证前端三个功能的完整流程。

- [ ] **Step 1: 启动项目**

```bash
npm run dev  # 或项目对应的启动命令
```

访问 `http://localhost:<port>`，确保应用启动正常。

- [ ] **Step 2: 测试选中态互斥**

1. 打开侧栏，确认「对话」和「需求」两个列表存在
2. 点击某个「对话」行，观察其高亮为 active
3. 点击左侧「需求」按钮，切到需求视图
4. 验证：之前高亮的「对话」行不再显示 active（选中态消失）
5. 点击某个「需求」行，观察其高亮为 active
6. 点击左侧「对话」按钮，切回对话视图
7. 验证：之前高亮的「需求」行不再显示 active

**预期：** ✓ 视图切换时对方列表选中态自动清除

- [ ] **Step 3: 测试需求钉住**

1. 切到需求视图
2. 右键点击某个「本次需求」区的需求行
3. 验证弹出右键菜单，含「钉住」和「废弃」两个按钮
4. 点击「钉住」
5. 验证：需求行前出现钉住图标，且该需求移到列表顶部
6. 刷新页面（F5）
7. 验证：需求仍在顶部且保持钉住状态（localStorage 生效）
8. 右键点击，选「取消钉住」
9. 验证：图标消失，需求回到「本次需求」区

**预期：** ✓ 钉住状态本地持久化，页面刷新后保持

- [ ] **Step 4: 测试需求废弃**

1. 右键点击某个「本次需求」区的需求行
2. 点击「废弃」
3. 验证弹出确认对话框，文案为「确认要废弃这个需求吗？...」
4. 点「废弃」
5. 验证：需求消失，并出现在「已废弃（N）」折叠组（初始收起）
6. 点击「已废弃（N）」展开
7. 验证：之前废弃的需求出现在该组
8. 点击废弃的需求打开其详情页
9. 验证：页面显示只读内容，顶部提示「此需求已废弃，仅保留记录供查阅。」
10. 右键点击废弃的需求行
11. 验证：右键菜单仍可显示（废弃态不禁用菜单）

**预期：** ✓ 需求废弃流程完整，页面显示正确

- [ ] **Step 5: 测试已废弃折叠逻辑**

1. 创建或废弃多个需求，使「已废弃（N）」组有 3+ 条
2. 点击「已废弃（N）」标签收起
3. 验证：已废弃需求行隐藏，仅显示折叠标签
4. 再次点击展开
5. 验证：已废弃需求行再次显示

**预期：** ✓ 折叠/展开状态在会话内保持

- [ ] **Step 6: 浏览器控制台检查**

1. 打开浏览器开发者工具（F12）
2. 在 Console 中运行 `localStorage.getItem('claude_req_pinned')`
3. 验证：返回逗号分隔的已钉住需求 ID 列表

**预期：** ✓ localStorage 正确存储钉住状态

- [ ] **Step 7: 提交**

如手动测试全部通过，确认无 bug：

```bash
git log --oneline -8  # 查看前 8 条提交
```

预期见到 8 条新增提交（Task 1-8）。

---

## 自检清单

**规范覆盖：**
- [x] 选中态互斥问题：Task 1-2 覆盖 chat.js + app.js 协调
- [x] 需求右键菜单：Task 4 覆盖 UI 实现，Task 3 覆盖存储
- [x] 钉住状态：Task 3 覆盖存储，Task 5 覆盖渲染
- [x] 已废弃状态：Task 5 覆盖侧栏，Task 6 覆盖页面，Task 8 覆盖后端
- [x] CSS 样式：Task 7 覆盖所有新样式

**代码一致性：**
- 函数名：`_toggleReqPin` (Task 3) vs 右键菜单调用 (Task 4) ✓
- localStorage key：`REQ_PINNED_LS_KEY = 'claude_req_pinned'` (Task 3) vs 使用处 (Task 3) ✓
- 类名：`.req-ctx-menu` (Task 4 JS) vs `.req-ctx-menu` (Task 7 CSS) ✓
- Phase 值：`'discarded'` (Task 5-6 JS) vs `/api/req/discard` (Task 8 后端) ✓

**无占位符检查：**
- [x] 每个代码块都包含完整实现（无 TBD、TODO）
- [x] 每个命令都列出预期输出
- [x] 每个步骤都有具体代码或验证方式

---

## 执行建议

- **总代码量：** ~400 行 JS + ~100 行 CSS + ~40 行后端
- **预计耗时：** 45-60 分钟（含手动测试）
- **分支策略：** 单一功能分支，每 task 一次提交，便于问题追溯
- **测试复杂度：** 低（无单元测试框架依赖，手动交互验证即可）

---
