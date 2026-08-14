# 统一历史列表（合并到左侧栏）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把右上「📜 历史」磁盘会话面板合并进左侧栏，与本地会话按 sessionId 去重成唯一列表，每条带「本地/web」来源徽标，并在左栏加搜索。

**Architecture:** 纯前端改动。`renderConvList` 升级为「合并 loadConvs()(本地) + historyCache(磁盘)、去重、排序、徽标、客户端搜索过滤」；新增 `buildMergedHistory()`、`refreshDiskHistory()`；移除右抽屉相关 DOM/CSS/函数。后端 `/api/history` 与 `src/store/history.js` 零改动。

**Tech Stack:** 原生 JS（无框架无构建）、localStorage、深色主题 CSS 变量。

**提交策略：** 按用户要求，执行期间不逐 Task 提交，全部完成并集成测试通过后在最后统一提交（见 Task 4）。

---

## 文件结构

```
public/app.js      [修改] 合并渲染逻辑 + 移除抽屉函数 + init/done 接线
public/index.html  [修改] 移除 📜 按钮与 #historyPanel；左栏加搜索框
public/app.css     [修改] 移除 .history-* 面板样式；新增 .conv-badge/.conv-search/状态
```

设计文档：`docs/superpowers/specs/2026-07-16-unified-history-sidebar-design.md`

---

## Task 1: app.js — 合并渲染核心与抽屉函数清理

**Files:**
- Modify: `public/app.js`

### 背景锚点（当前代码）
- 状态变量区约 14-16 行：`historyPanelOpen` / `historyCache` / `historyCacheExpire`。
- `loadHistorySessions`（约 79-116）、`renderHistoryList`（约 127-176）、`resumeHistorySession`（约 177-214）、`openHistoryPanel/closeHistoryPanel/toggleHistoryPanel`（约 215-230）、`setupHistorySearch`（约 231-247）、`renderHistoryLoading`（约 117-126）。
- 本地会话区：`CONV_KEY`（250）、`loadConvs`（252）、`saveConvs`（259）、`renderConvList`（262-305）、`recordMessage`（306-324，末尾调用 `renderConvList()`）、`openConv`（325+）。
- SSE `done` 处理器约 833-854，末尾 `endJob(convId, job.err)`。
- 抽屉接线块（搜索 `historyToggle` 可定位，约 1478-1500）：含 `setupHistorySearch()`、`#historyToggle`、`#historyClose` 的绑定。
- 启动初始化约 1613-1619：`renderConvList(); // 渲染左侧对话历史`。

- [ ] **Step 1: 简化 loadHistorySessions（搜索改客户端，不再需要 q 参数）**

把 `loadHistorySessions`（约 79-116）整个替换为：

```javascript
      // 拉取磁盘历史会话列表（5s 内存缓存）；成功写 historyCache，失败返回 null
      async function loadHistorySessions() {
        if (historyCache && Date.now() < historyCacheExpire) return historyCache;
        try {
          const json = await (await fetch('/api/history')).json();
          if (!json.ok) {
            console.error('读取历史会话失败:', json.error);
            return null;
          }
          const data = json.data || [];
          historyCache = data;
          historyCacheExpire = Date.now() + 5000;
          return data;
        } catch (err) {
          console.error('读取历史会话失败:', err);
          return null;
        }
      }
```

- [ ] **Step 2: 删除右抽屉专用函数**

删除这些函数与变量（它们的职责被左栏合并逻辑取代）：
- 变量 `historyPanelOpen`（约 14 行，那一行删掉；保留 `historyCache` 与 `historyCacheExpire`）。
- `renderHistoryLoading`（约 117-126）
- `renderHistoryList`（约 127-176）
- `openHistoryPanel` / `closeHistoryPanel` / `toggleHistoryPanel`（约 215-230）
- `setupHistorySearch`（约 231-247）

保留 `loadHistorySessions`（已在 Step 1 改）和 `resumeHistorySession`（下一步改）。

- [ ] **Step 3: 改造 resumeHistorySession（去掉 closeHistoryPanel 调用）**

`resumeHistorySession`（约 177-214）中把 `closeHistoryPanel();`（约 208 行）那一行删除。其余不变（去重、拉详情、`addMessage`+`recordMessage` 落库、`historyCacheExpire = 0`、`updateComposerRunning()`、失败 `toast()`）。`recordMessage` 会触发 `renderConvList()`，续接后新会话会以「本地」出现，无需手动关面板。

- [ ] **Step 4: 新增合并状态变量**

在 `CONV_KEY`（约 250 行）附近、`let currentConvId = null;` 之后新增：

```javascript
      let convSearchQuery = '';   // 左栏搜索词（客户端过滤合并列表）
      let diskLoadFailed = false; // 磁盘历史是否拉取失败（用于错误态提示）
```

- [ ] **Step 5: 新增 buildMergedHistory（合并 + 去重 + 排序 + 过滤）**

在 `renderConvList` 之前新增：

```javascript
      // 合并本地会话(localStorage) + 磁盘会话(historyCache)，按 sessionId 去重，排序并按搜索词过滤。
      // 返回统一条目：{ source:'local'|'web', convId, sessionId, title, updatedAt, running, active }
      function buildMergedHistory() {
        const convs = loadConvs();
        const localSessions = new Set(convs.map((c) => c.session).filter(Boolean));
        const entries = [];
        for (const c of convs) {
          entries.push({
            source: 'local',
            convId: c.id,
            sessionId: c.session || null,
            title: c.title || '未命名对话',
            updatedAt: c.updatedAt || 0,
            running: !!runningJobs[c.id],
            active: c.id === currentConvId,
          });
        }
        // 磁盘会话：已有本地缓存的跳过（去重）
        for (const s of historyCache || []) {
          if (localSessions.has(s.sessionId)) continue;
          entries.push({
            source: 'web',
            convId: null,
            sessionId: s.sessionId,
            title: s.title || '未命名对话',
            updatedAt: s.updatedAt || 0,
            running: false,
            active: false,
          });
        }
        entries.sort((a, b) => b.updatedAt - a.updatedAt);
        const q = convSearchQuery.trim().toLowerCase();
        if (!q) return entries;
        return entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            (e.sessionId || '').toLowerCase().includes(q),
        );
      }
```

- [ ] **Step 6: 重写 renderConvList（渲染合并列表 + 徽标 + 分源点击/删除）**

把 `renderConvList`（约 262-305）整个替换为：

```javascript
      function renderConvList() {
        const el = $('#convList');
        const entries = buildMergedHistory();
        el.innerHTML = '';
        if (!entries.length) {
          const empty = document.createElement('div');
          empty.className = 'conv-empty';
          empty.textContent = convSearchQuery.trim()
            ? '无匹配的历史'
            : diskLoadFailed
              ? '本地无对话（磁盘历史加载失败）'
              : '暂无历史对话';
          el.appendChild(empty);
          return;
        }
        for (const e of entries) {
          const row = document.createElement('div');
          row.className =
            'conv-item' + (e.active ? ' active' : '') + (e.running ? ' running' : '');
          const title = document.createElement('span');
          title.className = 'conv-title';
          title.textContent = e.title;
          title.onclick = () =>
            e.source === 'local' ? openConv(e.convId) : resumeHistorySession(e.sessionId);
          row.appendChild(title);
          const badge = document.createElement('span');
          badge.className = 'conv-badge ' + e.source;
          badge.textContent = e.source === 'local' ? '本地' : 'web';
          row.appendChild(badge);
          // 删除仅对本地条目（磁盘文件与 CLI 共享，不提供删除）
          if (e.source === 'local') {
            const rm = document.createElement('button');
            rm.className = 'conv-rm';
            rm.title = '删除';
            rm.textContent = '✕';
            rm.onclick = async (ev) => {
              ev.stopPropagation();
              const ok = await confirmDialog({
                title: '删除对话',
                message: '确认删除「' + e.title + '」？此操作不可恢复。',
                confirmText: '删除',
                danger: true,
              });
              if (!ok) return;
              const job = runningJobs[e.convId];
              if (job) {
                try {
                  job.es.close();
                } catch {}
                delete runningJobs[e.convId];
              }
              saveConvs(loadConvs().filter((x) => x.id !== e.convId));
              if (e.convId === currentConvId) newConversation();
              else renderConvList();
            };
            row.appendChild(rm);
          }
          el.appendChild(row);
        }
      }
```

- [ ] **Step 7: 新增 refreshDiskHistory**

在 `renderConvList` 之后新增：

```javascript
      // 拉取磁盘历史（含 5s 缓存）并刷新左栏；失败置错误态
      async function refreshDiskHistory() {
        const data = await loadHistorySessions();
        diskLoadFailed = data === null;
        renderConvList();
      }
```

- [ ] **Step 8: 移除抽屉接线、新增搜索框接线**

在抽屉接线块（搜索 `historyToggle` 定位，约 1478-1500）里：删除 `setupHistorySearch();` 以及 `#historyToggle` / `#historyClose` 的 `addEventListener` 绑定（含它们的 null 守卫）。替换为左栏搜索接线：

```javascript
      // ---- 左栏历史搜索（客户端过滤合并列表）----
      const _convSearch = $('#convSearch');
      if (_convSearch) {
        _convSearch.addEventListener('input', () => {
          convSearchQuery = _convSearch.value;
          renderConvList();
        });
      }
```

- [ ] **Step 9: init 与 done 接线刷新磁盘历史**

启动初始化（约 1615）在 `renderConvList();` 之后加一行：

```javascript
      renderConvList(); // 渲染左侧对话历史（先本地，秒出）
      refreshDiskHistory(); // 异步合并磁盘历史后重渲染
```

SSE `done` 处理器（约 853）在 `endJob(convId, job.err);` 之后加一行，让一次运行结束后拉取可能新增的磁盘会话：

```javascript
          endJob(convId, job.err);
          refreshDiskHistory(); // 运行结束可能新增磁盘会话，刷新左栏
```

- [ ] **Step 10: 语法与残留引用检查**

Run:
```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
node -e "new Function(require('fs').readFileSync('public/app.js','utf8')); console.log('app.js syntax OK')"
```
Expected: `app.js syntax OK`

Run（确认无对已删函数的残留引用）:
```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
grep -nE "openHistoryPanel|closeHistoryPanel|toggleHistoryPanel|setupHistorySearch|renderHistoryList|renderHistoryLoading|historyPanelOpen" public/app.js || echo "无残留引用"
```
Expected: `无残留引用`（若有输出说明还有引用未清理，需修）。

---

## Task 2: index.html — 移除抽屉/按钮，左栏加搜索框

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 移除顶栏「📜 历史」按钮**

删除这一行（约 31 行）：

```html
        <button class="btn" id="historyToggle" title="磁盘历史会话">📜 历史</button>
```

- [ ] **Step 2: 移除 #historyPanel 抽屉结构**

删除整段 `#historyPanel`（约 133-141 行，从 `<div id="historyPanel" ...>` 到其闭合 `</div>`），即：

```html
    <div id="historyPanel" class="history-panel" style="display:none">
      <div class="history-head">
        <span>历史对话</span>
        <button class="close" id="historyClose" title="关闭">✕</button>
      </div>
      <input id="historySearch" class="history-search" type="text" placeholder="搜索历史会话…" autocomplete="off" />
      <div id="historyList" class="history-list"></div>
    </div>
```

- [ ] **Step 3: 左栏加搜索框**

在 `.sidebar` 内、`.sidebar-head` 之后、`.conv-list` 之前插入：

```html
        <input id="convSearch" class="conv-search" type="text" placeholder="搜索历史…" autocomplete="off" />
```

即改为：
```html
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-head">
          <span>对话历史</span>
          <button class="btn" id="sidebarNew">＋ 新对话</button>
        </div>
        <input id="convSearch" class="conv-search" type="text" placeholder="搜索历史…" autocomplete="off" />
        <div class="conv-list" id="convList"></div>
      </aside>
```

- [ ] **Step 4: 校验**

Run:
```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
echo "应无输出:"; grep -nE 'id="historyToggle"|id="historyPanel"|id="historySearch"|id="historyList"|id="historyClose"' public/index.html || echo "抽屉元素已清除"
echo "应有 convSearch:"; grep -n 'id="convSearch"' public/index.html
```
Expected: 抽屉元素已清除；`convSearch` 存在。

---

## Task 3: app.css — 移除 .history-* 面板样式，新增左栏徽标/搜索/状态

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: 删除 .history-* 右抽屉样式（保留 .toast）**

删除全部 `.history-panel` / `.history-head` / `.history-search` / `.history-list` / `.history-empty` / `.history-item` / `.history-title` / `.history-meta` / `.history-resume` / `.history-loading` / `.history-error` 规则（约 1143-1270 区段，止于 `.toast` 之前）。**保留** `.toast` 及其后的规则（`resumeHistorySession` 仍用）。含 `@media (max-width:768px)` 里针对 `.history-panel` 的规则一并删除。

- [ ] **Step 2: 新增左栏样式（追加到 app.css 末尾）**

```css
      /* ---- 左栏统一历史：搜索框 / 来源徽标 / 状态 ---- */
      .conv-search {
        margin: 0 12px 8px;
        padding: 7px 10px;
        background: var(--panel-2);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
        font-size: 13px;
        box-sizing: border-box;
      }
      .conv-search::placeholder {
        color: var(--faint);
      }
      .conv-search:focus {
        outline: none;
        border-color: var(--accent);
      }
      .conv-badge {
        flex-shrink: 0;
        font-size: 11px;
        line-height: 1.6;
        padding: 0 6px;
        border-radius: 4px;
        white-space: nowrap;
      }
      .conv-badge.local {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .conv-badge.web {
        color: var(--faint);
        border: 1px solid var(--border);
      }
      .conv-loading,
      .conv-error {
        text-align: center;
        color: var(--muted);
        padding: 16px 8px;
        font-size: 13px;
      }
      .conv-error {
        color: var(--red);
      }
```

（`.sidebar` 是 flex 列、`align-items` 默认 stretch，`.conv-search` 会横向铺满减去左右 margin；`.conv-item` 是 `flex; align-items:center; gap:6px`，`.conv-title` 已 `flex:1`，徽标插在其后自然右对齐，`.conv-rm` 仍 hover 显现。）

- [ ] **Step 3: 校验**

Run:
```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
echo "应无 .history- 面板类:"; grep -nE '\.history-(panel|head|search|list|item|title|meta|resume|empty|loading|error)' public/app.css || echo "已清除"
echo "应保留 .toast:"; grep -c '\.toast' public/app.css
echo "新增类:"; grep -nE '\.conv-(search|badge|loading|error)' public/app.css | head
```
Expected: `.history-*` 面板类已清除；`.toast` 仍在；`.conv-search/.conv-badge/.conv-loading/.conv-error` 存在。

---

## Task 4: 集成测试与最终统一提交

**Files:**
- Test: 通过服务器 + 浏览器验证

- [ ] **Step 1: 三文件一致性交叉核验**

Run:
```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
echo "== app.js 引用 convSearch:"; grep -c '#convSearch' public/app.js
echo "== index.html 定义 convSearch:"; grep -c 'id="convSearch"' public/index.html
echo "== app.js 生成 conv-badge:"; grep -c "conv-badge" public/app.js
echo "== app.css 定义 .conv-badge:"; grep -c '\.conv-badge' public/app.css
echo "== 抽屉残留(应全 0):"; grep -c "historyToggle\|historyPanel" public/app.js public/index.html public/app.css
```
Expected: convSearch 引用/定义各 ≥1；conv-badge 生成/样式各 ≥1；抽屉残留全为 0。

- [ ] **Step 2: 启动测试服务器端到端验证**

Run:
```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
SC="C:/Users/DELL/AppData/Local/Temp/claude/C--Users-DELL-Desktop-claude-p-web-demo/bc4b548a-5a3a-46c3-be47-8342deb2911d/scratchpad"
PORT=3999 node src/entrypoints/web/server.js > "$SC/srv3.log" 2>&1 &
SRV=$!; sleep 3
echo "== index.html：有 convSearch、无 historyToggle =="
curl -s http://127.0.0.1:3999/ | grep -oE 'id="(convSearch|historyToggle|historyPanel)"' | sort -u
echo "== API 仍正常 =="
curl -s "http://127.0.0.1:3999/api/history?limit=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log('ok='+o.ok+' 条数='+o.data.length)})"
echo "== app.js/app.css 可服务 =="
echo "app.js HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3999/app.js)  含 buildMergedHistory=$(curl -s http://127.0.0.1:3999/app.js | grep -c buildMergedHistory)"
kill $SRV 2>/dev/null; sleep 0.5; taskkill //F //PID $SRV >/dev/null 2>&1 || true
echo "已清理端口 3999"
```
Expected: 只出现 `id="convSearch"`（无 historyToggle/historyPanel）；API `ok=true`；app.js HTTP 200 且含 `buildMergedHistory`。

- [ ] **Step 3: 手动浏览器冒烟（需人工）**

打开 `http://127.0.0.1:3000/`（或你的服务端口），验证：
1. 左栏出现搜索框；列表混合显示「●本地」与「○web」徽标条目，同一会话不重复。
2. 点「本地」条目秒开（缓存消息）；点「web」条目加载磁盘会话并落库，随后该条变「本地」。
3. 搜索框输入关键词，列表实时过滤；清空恢复全部。
4. 「本地」条目 hover 出现 ✕ 可删除（二次确认）；「web」条目无 ✕。
5. 右上角不再有「📜 历史」按钮；无 JS 控制台报错。

- [ ] **Step 4: 最终统一提交**

（按用户偏好，本次改动到此一次性提交。）

```bash
cd /c/Users/DELL/Desktop/claude-p-web-demo
git add public/app.js public/index.html public/app.css docs/superpowers/specs/2026-07-16-unified-history-sidebar-design.md docs/superpowers/plans/2026-07-16-unified-history-sidebar.md
git commit -m "feat(history): 合并磁盘历史到左栏统一列表（本地/web 徽标去重 + 搜索）

- app.js: renderConvList 合并 loadConvs()+historyCache 去重排序、来源徽标、
  客户端搜索、两阶段渲染；新增 buildMergedHistory/refreshDiskHistory；
  移除右抽屉函数(openHistoryPanel/renderHistoryList 等)；init/done 接线刷新
- index.html: 移除 📜 按钮与 #historyPanel 抽屉；左栏加 #convSearch
- app.css: 移除 .history-* 面板样式(保留 .toast)；新增 .conv-badge/.conv-search/状态
- docs: 设计文档 + 实现计划"
```

---

## Self-Review Checklist

- [x] **Spec 覆盖**：合并数据模型→Task1 Step5/6；去重→buildMergedHistory；徽标→Step6+Task3；点击分源→Step6；搜索→Step4/8+Task2/3；删除仅本地→Step6；刷新策略→Step7/9；移除抽屉→Task1 Step2/8 + Task2 + Task3。
- [x] **无占位符**：每步给出完整代码或精确命令。
- [x] **类型/命名一致**：`buildMergedHistory`/`refreshDiskHistory`/`convSearchQuery`/`diskLoadFailed`/`historyCache`/`historyCacheExpire` 全程一致；条目字段 `source/convId/sessionId/title/updatedAt/running/active` 在生成与渲染处一致；CSS 类 `.conv-badge(.local/.web)`/`.conv-search`/`.conv-loading`/`.conv-error` 与 JS 生成一致。
