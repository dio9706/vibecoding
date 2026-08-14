# 前端性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 7 项精准热路径修复减少内存占用、降低流式输出期间的 CPU/DOM 开销。

**Architecture:** 纯原生 JS + CSS 单页应用，无构建步骤无框架。所有改动在 `public/app.js` 和 `public/app.css` 两个文件中完成，改动互相独立可逐步回滚。

**Tech Stack:** Vanilla JS（ES2020）、原生 localStorage、原生 DOM API

---

## 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `public/app.js` | Modify | 全部 7 项优化逻辑 |
| `public/app.css` | Modify | 日志虚拟滚动容器样式 |

> **注意**：本项目无测试框架，验证步骤均为浏览器手工操作。每步改动后在 `http://127.0.0.1:<port>` 验证，端口见 `src/shared/config.js`。

---

## Task 1：工具函数 + loadConvs/saveConvs 缓存与写防抖

**目标**：消除流式输出期间每条 token 都触发的 `JSON.parse` / `JSON.stringify`

**Files:**
- Modify: `public/app.js`（在 `CONV_KEY` 定义附近，约第 207 行）

---

- [ ] **Step 1：在 `CONV_KEY` 常量之后添加缓存变量和防抖工具函数**

找到以下位置（约第 207 行）：
```js
      const CONV_KEY = 'claude_convs';
      let currentConvId = null;
```

在 `const CONV_KEY = 'claude_convs';` 这一行**之后、`let currentConvId` 之前**插入：

```js
      // ---- localStorage 内存缓存（减少 JSON.parse/stringify 频率）----
      let _convsCache = null; // null 表示尚未初始化
      let _convsSaveTimer = null;

      /** 通用防抖：返回防抖包装后的函数 */
      function debounce(fn, ms) {
        let t = null;
        const wrapped = (...args) => {
          clearTimeout(t);
          t = setTimeout(() => { t = null; fn(...args); }, ms);
        };
        wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
        return wrapped;
      }
```

- [ ] **Step 2：替换 `loadConvs()` 函数**

找到（约第 212 行）：
```js
      function loadConvs() {
        try {
          return JSON.parse(localStorage.getItem(CONV_KEY)) || [];
        } catch {
          return [];
        }
      }
```

替换为：
```js
      function loadConvs() {
        if (_convsCache !== null) return _convsCache;
        try {
          _convsCache = JSON.parse(localStorage.getItem(CONV_KEY)) || [];
        } catch {
          _convsCache = [];
        }
        return _convsCache;
      }
```

- [ ] **Step 3：替换 `saveConvs()` 函数**

找到（约第 219 行）：
```js
      function saveConvs(list) {
        localStorage.setItem(CONV_KEY, JSON.stringify(list));
      }
```

替换为：
```js
      function saveConvs(list) {
        _convsCache = list; // 内存立即更新（快路径）
        clearTimeout(_convsSaveTimer);
        _convsSaveTimer = setTimeout(() => {
          _convsSaveTimer = null;
          try { localStorage.setItem(CONV_KEY, JSON.stringify(_convsCache)); } catch { /* 配额满等 */ }
        }, 500);
      }
      /** 强制立即写 localStorage（页面卸载前调用，防止防抖窗口内丢数据）*/
      function flushConvs() {
        if (_convsSaveTimer === null) return;
        clearTimeout(_convsSaveTimer);
        _convsSaveTimer = null;
        try { localStorage.setItem(CONV_KEY, JSON.stringify(_convsCache || [])); } catch { /* ignore */ }
      }
```

- [ ] **Step 4：注册 `beforeunload` flush，防止页面关闭丢最后 500ms 数据**

在文件末尾附近（约第 2560 行之前，找 `window.addEventListener` 或直接在文件最后的初始化代码末尾）添加：

```js
      // 页面关闭前强制写 localStorage，防止防抖窗口内的数据丢失
      window.addEventListener('beforeunload', flushConvs);
```

- [ ] **Step 5：验证**

1. 打开浏览器 DevTools → Application → Local Storage，记录当前 `claude_convs` 内容
2. 发送一条消息，观察流式输出期间 Local Storage 写入频率（应降为每 500ms 一次，而非每 token 一次）
3. 刷新页面，确认历史对话仍完整（未丢消息）

- [ ] **Step 6：提交**

```bash
git add public/app.js
git commit -m "perf: cache loadConvs in memory, debounce saveConvs writes (500ms)"
```

---

## Task 2：renderConvList 防抖（侧栏 DOM 重建去抖）

**目标**：流式输出期间从每 token 重建一次侧栏 → 每 200ms 最多重建一次

**Files:**
- Modify: `public/app.js`

---

- [ ] **Step 1：在 `renderConvList` 函数定义之后创建防抖版本**

找到 `renderConvList` 函数结束位置（约第 378 行，函数体右花括号 `}`），在其**之后**插入：

```js
      /** 防抖版 renderConvList：流式输出期间合批，200ms 内多次调用只渲染最后一次 */
      const renderConvListDebounced = debounce(renderConvList, 200);
```

- [ ] **Step 2：将 `recordMessage` 中的直接调用改为防抖版**

找到（约第 412 行）：
```js
        saveConvs(list);
        renderConvList();
      }
```

> 注意：这行 `renderConvList()` 处于 `recordMessage` 函数内，紧跟 `saveConvs(list)` 之后。

替换为：
```js
        saveConvs(list);
        renderConvListDebounced();
      }
```

- [ ] **Step 3：将 `endJob` 中的调用改为防抖版**

找到（约第 567 行）`endJob` 函数末尾：
```js
        delete runningJobs[convId];
        if (convId === currentConvId) updateComposerRunning();
        renderConvList();
      }
```

替换为：
```js
        delete runningJobs[convId];
        if (convId === currentConvId) updateComposerRunning();
        renderConvListDebounced();
      }
```

- [ ] **Step 4：将启动任务时的调用改为防抖版**

找到（约第 893 行）`runningJobs[convId] = job;` 之后：
```js
        runningJobs[convId] = job;
        updateComposerRunning();
        renderConvList();
        paintJob(job);
```

替换为：
```js
        runningJobs[convId] = job;
        updateComposerRunning();
        renderConvListDebounced();
        paintJob(job);
```

- [ ] **Step 5：openConv 和 newConversation 需立即刷新（flush 防抖）**

找到 `openConv` 函数末尾（约第 461 行）：
```js
        updateComposerRunning();
        renderConvList();
        renderPendingBanner();
      }
```

替换为：
```js
        updateComposerRunning();
        renderConvListDebounced.flush(); // 切换对话须立即更新高亮
        renderPendingBanner();
      }
```

找到 `newConversation` 函数中（约第 474 行）：
```js
        updateComposerRunning();
        renderConvList();
        renderPendingBanner();
```

替换为：
```js
        updateComposerRunning();
        renderConvListDebounced.flush(); // 新建对话须立即更新高亮
        renderPendingBanner();
```

- [ ] **Step 6：验证**

1. 开始一次长对话，观察流式输出期间侧栏是否仍正常更新（不超过每 200ms 刷新一次）
2. 切换对话时侧栏高亮应立即切换，无延迟感
3. DevTools Performance 录制发现 `renderConvList` 调用次数大幅减少

- [ ] **Step 7：提交**

```bash
git add public/app.js
git commit -m "perf: debounce renderConvList (200ms), flush on conv switch/new"
```

---

## Task 3：convSearch 输入防抖

**目标**：快速键入搜索词时不频繁重建列表

**Files:**
- Modify: `public/app.js`

---

- [ ] **Step 1：替换 convSearch 事件监听器**

找到（约第 2179 行）：
```js
      const _convSearch = $('#convSearch');
      if (_convSearch) {
        _convSearch.addEventListener('input', () => {
          convSearchQuery = _convSearch.value;
          renderConvList();
        });
      }
```

替换为：
```js
      const _convSearch = $('#convSearch');
      if (_convSearch) {
        const _renderConvSearchDebounced = debounce(() => renderConvList(), 300);
        _convSearch.addEventListener('input', () => {
          convSearchQuery = _convSearch.value;
          _renderConvSearchDebounced();
        });
      }
```

- [ ] **Step 2：验证**

在搜索框快速输入 5 个字符，DevTools Performance 中 `renderConvList` 应只触发 1 次（300ms 后），而非 5 次。

- [ ] **Step 3：提交**

```bash
git add public/app.js
git commit -m "perf: debounce conv search input (300ms)"
```

---

## Task 4：bubbleAt 改 Map 缓存（paintJob O(n) → O(1)）

**目标**：打字机每帧找气泡从线性扫描变成 O(1) 查 Map

**Files:**
- Modify: `public/app.js`

---

- [ ] **Step 1：添加气泡 Map 缓存变量**

找到（约第 207 行）`_convsCache` 变量定义块，在其末尾追加：

```js
      // ---- 气泡 DOM 引用缓存（convId → Element[]，避免 querySelectorAll 线性扫描）----
      const _bubbleMap = new Map(); // convId -> [bubbleEl, bubbleEl, ...]
```

- [ ] **Step 2：修改 `addMessage` 函数，将气泡引用写入缓存**

找到 `addMessage` 函数末尾（约第 594 行）：
```js
        messagesEl.appendChild(msg);
        scrollBottom();
        return bubble;
      }
```

替换为：
```js
        messagesEl.appendChild(msg);
        scrollBottom();
        // 写入气泡缓存（仅当前会话）
        if (currentConvId) {
          if (!_bubbleMap.has(currentConvId)) _bubbleMap.set(currentConvId, []);
          _bubbleMap.get(currentConvId).push(bubble);
        }
        return bubble;
      }
```

- [ ] **Step 3：修改 `bubbleAt` 函数，优先走缓存**

找到（约第 525 行）：
```js
      // 当前可见消息区中第 index 条消息的气泡
      function bubbleAt(index) {
        const msg = messagesEl.querySelectorAll('.msg')[index];
        return msg ? msg.querySelector('.bubble') : null;
      }
```

替换为：
```js
      // 当前可见消息区中第 index 条消息的气泡（优先走 Map 缓存，O(1)）
      function bubbleAt(index) {
        if (currentConvId) {
          const arr = _bubbleMap.get(currentConvId);
          if (arr && arr[index]) return arr[index];
        }
        // 降级：Map 未命中时回退线性扫描（兼容边界情况）
        const msg = messagesEl.querySelectorAll('.msg')[index];
        return msg ? msg.querySelector('.bubble') : null;
      }
```

- [ ] **Step 4：在 `openConv` 中清空当前会话缓存并重建**

找到 `openConv` 函数中清除消息 DOM 的位置（约第 440 行）：
```js
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        emptyEl.style.display = c.messages.length ? 'none' : '';
        for (const m of c.messages) addMessage(m.role, m.text);
```

替换为：
```js
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        _bubbleMap.delete(id); // 清旧缓存，下面 addMessage 会重建
        emptyEl.style.display = c.messages.length ? 'none' : '';
        for (const m of c.messages) addMessage(m.role, m.text);
```

- [ ] **Step 5：在 `newConversation` 中清空缓存**

找到（约第 468 行）：
```js
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        emptyEl.style.display = '';
```

替换为：
```js
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        if (currentConvId) _bubbleMap.delete(currentConvId);
        emptyEl.style.display = '';
```

- [ ] **Step 6：验证**

发起一次长对话（100+ token），在 DevTools Performance 中确认 `querySelectorAll` 调用次数大幅减少，paintJob 帧时间下降。

- [ ] **Step 7：提交**

```bash
git add public/app.js
git commit -m "perf: cache bubble DOM refs in Map, O(n) -> O(1) per paintJob frame"
```

---

## Task 5：DocumentFragment 批量插入（列表渲染减少 reflow）

**目标**：renderConvList 和 loadLogs 的列表循环改为先离屏构建再一次性上屏

**Files:**
- Modify: `public/app.js`

---

- [ ] **Step 1：修改 `renderConvList` 中的 DOM 插入逻辑**

找到 `renderConvList` 函数中的循环（约第 276 行），找到这段：
```js
        const el = $('#convList');
        const allEntries = buildMergedHistory();
        el.innerHTML = '';
```

以及循环中所有 `el.appendChild(row)` 的地方（约第 363 行），以及底部按钮的 `el.appendChild`（约第 370、376 行）。

将整个 `renderConvList` 函数的 DOM 构建部分改造为 fragment 模式：找到 `el.innerHTML = '';` 之后到函数结束，在 `el.innerHTML = '';` 后面加一行，并将所有 `el.appendChild(...)` 改为 `frag.appendChild(...)`，最后在函数末尾加 `el.appendChild(frag)`。

具体替换：将
```js
        el.innerHTML = '';

        // 搜索时不过滤日期；否则仅展示今日（运行中 / 当前对话始终显示）
        const searching = !!convSearchQuery.trim();
```

改为：
```js
        el.innerHTML = '';
        const frag = document.createDocumentFragment();

        // 搜索时不过滤日期；否则仅展示今日（运行中 / 当前对话始终显示）
        const searching = !!convSearchQuery.trim();
```

然后将函数内所有 `el.appendChild(` 改为 `frag.appendChild(`（共约 4 处），最后在函数的**最末尾右花括号之前**追加：
```js
        el.appendChild(frag);
```

- [ ] **Step 2：修改 `loadLogs` 中的 DOM 插入逻辑**

找到（约第 1670 行）：
```js
          body.innerHTML = '';
          for (const g of logs) {
            const { ok, text } = formatLogEntry(g);
            const row = document.createElement('div');
            row.className = 'log-row';
            row.innerHTML =
              `<span class="st">${ok ? '✅' : '❌'}</span><span class="t"></span><span class="info"></span>`;
            row.querySelector('.t').textContent = fmtTime(g.time);
            row.querySelector('.info').textContent = text;
            body.appendChild(row);
          }
```

替换为：
```js
          body.innerHTML = '';
          const logFrag = document.createDocumentFragment();
          for (const g of logs) {
            const { ok, text } = formatLogEntry(g);
            const row = document.createElement('div');
            row.className = 'log-row';
            row.innerHTML =
              `<span class="st">${ok ? '✅' : '❌'}</span><span class="t"></span><span class="info"></span>`;
            row.querySelector('.t').textContent = fmtTime(g.time);
            row.querySelector('.info').textContent = text;
            logFrag.appendChild(row);
          }
          body.appendChild(logFrag);
```

- [ ] **Step 3：验证**

打开日志面板，观察无闪烁，列表完整显示。刷新侧栏正常工作。

- [ ] **Step 4：提交**

```bash
git add public/app.js
git commit -m "perf: use DocumentFragment for batch DOM insertion in conv list and log list"
```

---

## Task 6：日志列表虚拟滚动（1000 行 → ~40 行 DOM）

**目标**：日志面板只渲染可见区域行，大幅减少内存和首次打开延迟

**Files:**
- Modify: `public/app.js`
- Modify: `public/app.css`

---

- [ ] **Step 1：添加日志虚拟滚动 CSS**

打开 `public/app.css`，找到 `.log-row` 相关样式（或在文件末尾追加）：

```css
      /* ---- 日志虚拟滚动 ---- */
      #logBody {
        position: relative;
        overflow-y: auto;
        max-height: calc(100vh - 140px);
      }
      .log-vscroll-spacer {
        position: absolute;
        top: 0;
        left: 0;
        width: 1px;
        pointer-events: none;
      }
      .log-vscroll-content {
        position: absolute;
        left: 0;
        right: 0;
      }
      .log-search-bar {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--panel);
        padding: 8px;
        border-bottom: 1px solid var(--border-soft);
        display: flex;
        gap: 8px;
      }
      .log-search-bar input {
        flex: 1;
        background: var(--panel-2);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
        font-family: var(--mono);
      }
      .log-search-bar input:focus {
        outline: none;
        border-color: var(--accent);
      }
```

- [ ] **Step 2：重写 `loadLogs` 函数，改为虚拟滚动**

找到（约第 1661 行）现有 `loadLogs` 函数，完整替换为：

```js
      async function loadLogs() {
        const body = $('#logBody');
        body.innerHTML = '<div style="color:var(--faint);padding:8px">加载中…</div>';
        let allLogs = [];
        try {
          const { logs } = await (await fetch('/api/logs')).json();
          allLogs = logs || [];
        } catch {
          body.innerHTML = '<div style="color:var(--red);padding:8px">读取失败</div>';
          return;
        }
        if (!allLogs.length) {
          body.innerHTML = '<div style="color:var(--faint);padding:8px">暂无日志</div>';
          return;
        }

        const ROW_H = 32; // 每行固定高度 px（log-row 单行文本）
        const BUFFER = 5; // 可视区上下各预渲染 5 行
        let filteredLogs = allLogs;

        body.innerHTML = '';

        // 搜索栏（替代浏览器 Ctrl+F，因虚拟滚动 DOM 不全）
        const searchBar = document.createElement('div');
        searchBar.className = 'log-search-bar';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = '过滤日志…';
        const countSpan = document.createElement('span');
        countSpan.style.cssText = 'color:var(--faint);font-size:12px;white-space:nowrap;align-self:center';
        searchBar.appendChild(searchInput);
        searchBar.appendChild(countSpan);
        body.appendChild(searchBar);

        // 虚拟滚动容器
        const scroller = document.createElement('div');
        scroller.style.cssText = 'position:relative;flex:1;overflow-y:auto;';
        body.appendChild(scroller);

        // 撑高用占位
        const spacer = document.createElement('div');
        spacer.className = 'log-vscroll-spacer';
        scroller.appendChild(spacer);

        // 可见行容器
        const content = document.createElement('div');
        content.className = 'log-vscroll-content';
        scroller.appendChild(content);

        let rafPending = false;
        function renderVisible() {
          const scrollTop = scroller.scrollTop;
          const clientH = scroller.clientHeight || 400;
          const total = filteredLogs.length;
          spacer.style.height = (total * ROW_H) + 'px';

          const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
          const endIdx = Math.min(total, Math.ceil((scrollTop + clientH) / ROW_H) + BUFFER);

          content.style.top = (startIdx * ROW_H) + 'px';
          const frag = document.createDocumentFragment();
          for (let i = startIdx; i < endIdx; i++) {
            const g = filteredLogs[i];
            const { ok, text } = formatLogEntry(g);
            const row = document.createElement('div');
            row.className = 'log-row';
            row.style.height = ROW_H + 'px';
            row.innerHTML = `<span class="st">${ok ? '✅' : '❌'}</span><span class="t"></span><span class="info"></span>`;
            row.querySelector('.t').textContent = fmtTime(g.time);
            row.querySelector('.info').textContent = text;
            frag.appendChild(row);
          }
          content.innerHTML = '';
          content.appendChild(frag);
          countSpan.textContent = filteredLogs.length + ' 条' +
            (filteredLogs.length < allLogs.length ? `（共 ${allLogs.length}）` : '');
        }

        scroller.addEventListener('scroll', () => {
          if (rafPending) return;
          rafPending = true;
          requestAnimationFrame(() => { rafPending = false; renderVisible(); });
        });

        // 搜索过滤
        const filterDebounced = debounce((q) => {
          const kw = q.trim().toLowerCase();
          filteredLogs = kw
            ? allLogs.filter((g) => {
                const { text } = formatLogEntry(g);
                return text.toLowerCase().includes(kw) || (g.path || '').includes(kw);
              })
            : allLogs;
          scroller.scrollTop = 0;
          renderVisible();
        }, 200);
        searchInput.addEventListener('input', (e) => filterDebounced(e.target.value));

        renderVisible(); // 首屏渲染
      }
```

- [ ] **Step 3：验证**

1. 点击「访问日志」按钮，面板秒开无卡顿
2. 在 DevTools Elements 中确认 `#logBody` 下的 `.log-row` 数量约为可见行数 +10，而非 1000
3. 滚动日志列表，行内容随滚动动态更新，无闪烁
4. 在搜索框输入关键词，列表正确过滤

- [ ] **Step 4：提交**

```bash
git add public/app.js public/app.css
git commit -m "perf: virtual scroll for log list, add filter search bar, ~96% DOM reduction"
```

---

## Task 7：Task 2 遗留 renderConvList 调用批量替换

**目标**：将 Task 2 未覆盖到的其余直接 `renderConvList()` 调用也改为防抖版，确保全面覆盖

**Files:**
- Modify: `public/app.js`

---

- [ ] **Step 1：搜索剩余直接调用**

在编辑器中全局搜索 `renderConvList()` （不含 `Debounced`、不含函数定义本身），找到以下位置并逐一判断是否需要立即刷新：

| 位置 | 上下文 | 处理方式 |
|------|--------|---------|
| `refreshDiskHistory` 中（约第 390 行） | 磁盘历史拉取完毕，非交互触发 | 改为 `renderConvListDebounced()` |
| 对话删除后（约第 359 行，`conv-rm` 的 onclick）| 用户手动删除，应立即更新 | 改为 `renderConvListDebounced.flush()` |
| `historyShowAll` 切换按钮（约第 375、383 行）| 用户点击展开/收起，应立即 | 改为 `renderConvListDebounced.flush()` |
| `refreshPending` 末尾（约第 2322 行）| 轮询回调，非交互 | 改为 `renderConvListDebounced()` |
| 初始化（约第 2335 行）| 页面启动首次渲染 | 保持 `renderConvList()`（直接调用，无需防抖） |

- [ ] **Step 2：逐一替换上表中的调用**

`refreshDiskHistory`（约第 390 行），将：
```js
        diskLoadFailed = data === null;
        renderConvList();
```
改为：
```js
        diskLoadFailed = data === null;
        renderConvListDebounced();
```

对话删除按钮回调（约第 359 行），将：
```js
              else renderConvList();
```
改为：
```js
              else renderConvListDebounced.flush();
```

`makeLoadMoreBtn` 中展开（约第 383 行）：
```js
        btn.onclick = () => { historyShowAll = true; renderConvList(); };
```
改为：
```js
        btn.onclick = () => { historyShowAll = true; renderConvListDebounced.flush(); };
```

收起按钮（约第 375 行）：
```js
          collapseBtn.onclick = () => { historyShowAll = false; renderConvList(); };
```
改为：
```js
          collapseBtn.onclick = () => { historyShowAll = false; renderConvListDebounced.flush(); };
```

`refreshPending`（约第 2322 行）：
```js
              renderConvList();
```
改为：
```js
              renderConvListDebounced();
```

- [ ] **Step 3：验证**

1. 点击删除对话 → 侧栏立即更新
2. 点击「加载更多」/ 「收起历史」→ 侧栏立即展开/收起
3. 流式输出时侧栏更新频率不超过每 200ms 一次

- [ ] **Step 4：提交**

```bash
git add public/app.js
git commit -m "perf: complete renderConvList debounce coverage, flush on user-initiated actions"
```

---

## 自检清单

- [x] **Spec 覆盖**：7 项改动全部有对应 Task（改动 1-3 → Task 1；改动 3 → Task 2；改动 7 → Task 3；改动 4 → Task 4；改动 5 → Task 5；改动 6 → Task 6；遗留清理 → Task 7）
- [x] **无占位符**：所有 Step 包含完整可运行代码，无 TBD/TODO
- [x] **类型一致**：`debounce` 工具函数在 Task 1 定义，Task 2/3/6 中使用；`renderConvListDebounced` 在 Task 2 定义，Task 7 中引用
- [x] **beforeunload flush** 在 Task 1 Step 4 已覆盖
- [x] **_bubbleMap 清理**：Task 4 Step 4/5 在 openConv 和 newConversation 中都有清理逻辑
