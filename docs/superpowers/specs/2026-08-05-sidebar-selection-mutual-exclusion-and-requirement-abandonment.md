# 左侧菜单选中态互斥与需求废弃功能设计

**日期：** 2026-08-05  
**作者：** Claude Code  
**状态：** 待审核  

## 概述

当前左侧菜单存在两个问题：
1. **选中态互斥失效**：需求行和会话行可以同时处于选中态，应仅有一个处于选中态
2. **需求管理不完整**：需求行缺少右键菜单，无法快速废弃需求；同时需求系统无「废弃」状态

## 目标

1. 修复左侧菜单选中态互斥：视图切换时自动清除对方列表的选中标记
2. 为需求行新增右键菜单：支持「钉住」和「废弃」两个操作
3. 需求系统新增「废弃」状态：与「已归档」并列展示，支持自动折叠

## 设计细节

### 1. 选中态互斥问题根因

#### 当前行为
- **需求列表**（req-view.js）：`makeReqRow` 检查 `r.id === currentReqId && isReqViewActive()`，依赖 DOM 检测
- **会话列表**（chat.js）：`buildMergedHistory` 检查 `c.id === currentConvId`，**不感知当前视图是否激活**
- **结果**：两个列表各自判断，视图切换时对方状态不更新

#### 修复方案
在 chat.js 中 `buildMergedHistory` 的 `active` 计算加入视图门控：
```javascript
active: c.id === currentConvId && _isChatViewActive(),  // 仅聊天视图激活时才标记
```

在 app.js 的 `showView` 函数中，切换视图时主动触发对方列表重渲染：
```javascript
function showView(name) {
  // ... 现有逻辑 ...
  if (name === 'chat') {
    renderReqListLocal?.();  // 清除需求列表选中态
  } else if (name === 'req') {
    renderConvListNow?.();   // 清除会话列表选中态
  }
}
```

**导出函数**：
- `req-view.js` 导出 `renderReqListLocal()`（内部别名为 `renderReqList`）
- `chat.js` 导出 `renderConvListNow()`（即现有的防抖前的原始函数）

### 2. 需求右键菜单：[钉住 / 废弃]

#### UI 设计
- 需求行（req-item）右键弹出菜单，两个操作：
  - **钉住**：切换钉住态，置顶显示，表文案为「取消钉住」或「钉住」
  - **废弃**：弹确认对话框 → 调后端接口废弃 → 侧栏刷新

#### 前端实现

**钉住状态持久化**（req-view.js）：
```javascript
// 模块级状态
let reqPinnedIds = new Set();  // localStorage key: 'claude_req_pinned'

function loadReqPinned() {
  const stored = localStorage.getItem('claude_req_pinned') || '';
  reqPinnedIds = new Set(stored.split(',').filter(Boolean));
}

function saveReqPinned() {
  const arr = Array.from(reqPinnedIds);
  localStorage.setItem('claude_req_pinned', arr.join(','));
}

function _reqPin(reqId, shouldPin) {
  if (shouldPin) {
    reqPinnedIds.add(reqId);
  } else {
    reqPinnedIds.delete(reqId);
  }
  saveReqPinned();
  renderReqList();
  toast(shouldPin ? '已钉住' : '已取消钉住');
}
```

**右键菜单（req-view.js）**：
- 创建浮动菜单元素（仿 chat.js 的 `_ctxMenu` 模式）
- `makeReqRow` 中绑定 `contextmenu` 事件，显示菜单

```javascript
// 需求行右键菜单（内部模块 _reqCtxMenu）
function makeReqRow(r) {
  const row = document.createElement('div');
  // ... 现有渲染 ...
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _showReqCtxMenu(e.pageX, e.pageY, r.id, reqPinnedIds.has(r.id));
  });
  return row;
}
```

**废弃接口调用**：
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

### 3. 需求新增「废弃」状态

#### PHASE_META 更新
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

#### 侧栏列表渲染
```javascript
function renderReqList() {
  const el = $('#reqList');
  if (!lastList.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const frag = document.createDocumentFragment();
  
  // 钉住需求（始终顶部）
  const pinned = lastList.filter((r) => reqPinnedIds.has(r.id));
  if (pinned.length) {
    for (const r of pinned) frag.appendChild(makeReqRow(r));
  }
  
  // 活跃需求（评审/开发/测试）
  const active = lastList.filter(
    (r) => !reqPinnedIds.has(r.id) && ['review', 'dev', 'test', 'archiving'].includes(r.phase)
  );
  if (active.length) {
    frag.appendChild(makeReqSectionLabel('本次需求'));
    for (const r of active) frag.appendChild(makeReqRow(r));
  }
  
  // 已废弃需求（折叠组）
  const discarded = lastList.filter(
    (r) => !reqPinnedIds.has(r.id) && r.phase === 'discarded'
  );
  if (discarded.length) {
    frag.appendChild(makeDiscardedToggle(discarded.length));
    if (discardedExpanded) for (const r of discarded) frag.appendChild(makeReqRow(r));
  }
  
  // 已归档需求（现有逻辑，调整为排除钉住）
  const archived = lastList.filter(
    (r) => !reqPinnedIds.has(r.id) && r.phase === 'archived'
  );
  if (archived.length) {
    frag.appendChild(makeArchivedToggle(archived.length));
    if (archivedExpanded) for (const r of archived) frag.appendChild(makeReqRow(r));
  }
  
  el.appendChild(frag);
}
```

#### renderReqPage 中的已废弃态展示
```javascript
function renderReqPage(req) {
  const box = $('#reqPage');
  // ...
  if (req.phase === 'review') {
    // 现有逻辑
  } else if (req.phase === 'archiving') {
    // 现有逻辑
  } else if (req.phase === 'archived') {
    // 现有逻辑
  } else if (req.phase === 'discarded') {
    box.appendChild(renderDiscardedPage(req));  // 新增
  } else {
    // dev/test：聊天模式
  }
}

function renderDiscardedPage(req) {
  const wrap = document.createElement('div');
  wrap.className = 'req-discarded-page';
  const hint = document.createElement('div');
  hint.className = 'req-archived-meta';
  hint.textContent = '此需求已废弃，仅保留记录供查阅。';
  wrap.appendChild(hint);
  const content = document.createElement('div');
  content.className = 'req-doc-content';
  renderMarkdown(content, req.devDocLatest || req.archive?.summary || '（无内容）');
  wrap.appendChild(content);
  return wrap;
}
```

### 4. 后端接口

#### POST `/api/req/discard`
- **请求体**：`{ id: string }`
- **逻辑**：
  1. 查询需求记录，确认存在且 `phase` 非 `discarded`
  2. 将 `phase` 设为 `discarded`，记录 `discardedAt` 时间戳
  3. 返回成功响应 `{ ok: true }`
- **错误**：
  - 404：需求不存在
  - 409：已是废弃态 / 其他冲突

## 影响范围

| 模块 | 变更 | 影响 |
|------|------|------|
| req-view.js | 新增钉住状态 + 右键菜单 + 废弃状态渲染 | 低 |
| chat.js | buildMergedHistory 加视图门控 | 低 |
| app.js | showView 触发对方列表重渲 | 低 |
| 后端 API | 新增 /api/req/discard | 中 |
| CSS | 新增 .discarded 样式类 | 低 |

## 测试清单

- [ ] 切换「对话」⇄「需求」视图时，对方列表选中态消失
- [ ] 需求行右键弹出菜单，含「钉住」和「废弃」
- [ ] 钉住需求后，刷新页面仍保持钉住；取消钉住正常消失
- [ ] 点击「废弃」→ 确认对话 → 需求消失，出现在「已废弃」折叠组
- [ ] 「已废弃」折叠组支持展开/收起，默认收起
- [ ] 打开已废弃需求显示只读页面
- [ ] 已废弃需求不出现在「本次需求」或历史列表

## 兼容性注意

- localStorage 持久化需求钉住态：跟随 session 清空，无跨会话持久化需求
- 已废弃需求的 phase 值为字符串 `'discarded'`，与 archiving/archived 并行
- 废弃需求不触发 busy 轮询（仅评审期需要）
