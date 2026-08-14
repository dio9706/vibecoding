# 嵌入式面板 + 模型/模式即时生效 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置/需求故障/访问日志三个弹层改为嵌入 messages 区的扁平视图（设置带 tab），并让右下角模型/问询模式改动即时生效（写穿 + 还原可见化 + 运行中放宽模式）。

**Architecture:** 前端 vanilla JS 单文件（`public/app.js`，无构建）+ Node 原生 http 后端。视图层用单一 `activeView` 状态切换 `.app` 内的消息区与 `#panelView`；后端把 run 的权限模式从"启动时闭包定值"改为"运行时可变字段"，新增 `POST /api/run/set-mode`。

**Tech Stack:** vanilla JS / CSS（深色主题变量）、Node `node:test`、`@anthropic-ai/claude-agent-sdk`。

**依据 spec:** `docs/superpowers/specs/2026-07-19-embedded-panels-and-model-fab-fix-design.md`

**⚠️ 项目规则：全程不执行任何 git 操作（commit/branch/push）。本计划无 commit 步骤，完成后由用户决定是否提交。**

---

### Task 1: runs store 新增 setRunMode（TDD）

**Files:**
- Test: `src/store/runs.test.js`（新建）
- Modify: `src/store/runs.js`（在 `resolveDecision` 后新增函数）

背景：`run.pending` 是当前展示给用户的询问 `{ reqId, kind, title, body, options, defaultChoice, resolve }`，`run.pendingQueue` 是排队询问。`kind` 取值 `'permission'`（工具审批）或 `'dialog'`（交互提问）。`advanceAsk(run)` 会把队列下一个上位展示（内部经 `presentAsk` 广播）或退出等待态；`fanout(run, 'ask', data)` 向前端广播（前端 `ask` 事件里 `JSON.parse('null')` → 清掉弹窗，是合法状态）。

- [ ] **Step 1: 写失败测试**

创建 `src/store/runs.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, askUser, setRunMode, nextReqId, stopRun } from './runs.js';

// 模拟「询问」模式起跑的 run（server 的 startClaudeRun 负责设置这两个字段）
function makeDefaultModeRun() {
  const run = createRun();
  run.mode = 'default';
  run.startMode = 'default';
  return run;
}

test('setRunMode：询问起跑 + 放宽目标 → 生效并放行挂起/排队的 permission', async (t) => {
  const run = makeDefaultModeRun();
  t.after(() => stopRun(run)); // 清看门狗定时器，避免测试进程挂住
  const p1 = askUser(run, { reqId: nextReqId(run), kind: 'permission', title: 'Bash', options: [], defaultChoice: 'deny' });
  const p2 = askUser(run, { reqId: nextReqId(run), kind: 'permission', title: 'Edit', options: [], defaultChoice: 'deny' });
  assert.equal(setRunMode(run.id, 'acceptEdits'), true);
  assert.equal(run.mode, 'acceptEdits');
  assert.equal(await p1, 'allow');
  assert.equal(await p2, 'allow');
  assert.equal(run.pending, null);
  assert.equal(run.waiting, false);
});

test('setRunMode：dialog 类询问保序保留，不被自动放行', async (t) => {
  const run = makeDefaultModeRun();
  t.after(() => stopRun(run));
  const perm = askUser(run, { reqId: nextReqId(run), kind: 'permission', title: 'Bash', options: [], defaultChoice: 'deny' });
  askUser(run, { reqId: nextReqId(run), kind: 'dialog', title: '选一个', options: [], defaultChoice: '__cancel__' });
  assert.equal(setRunMode(run.id, 'bypassPermissions'), true);
  assert.equal(await perm, 'allow');
  assert.equal(run.pending.kind, 'dialog'); // dialog 上位继续等用户
});

test('setRunMode：非法目标 / 非询问起跑 / 未知 run / 已结束 → 不生效', (t) => {
  const run = makeDefaultModeRun();
  t.after(() => stopRun(run));
  assert.equal(setRunMode(run.id, 'plan'), false);
  assert.equal(setRunMode(run.id, 'default'), false);
  assert.equal(setRunMode('run_nonexistent', 'acceptEdits'), false);

  const bypassRun = createRun();
  bypassRun.mode = 'bypassPermissions';
  bypassRun.startMode = 'bypassPermissions';
  assert.equal(setRunMode(bypassRun.id, 'acceptEdits'), false);
  stopRun(bypassRun);

  const doneRun = makeDefaultModeRun();
  stopRun(doneRun);
  assert.equal(setRunMode(doneRun.id, 'acceptEdits'), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/runs.test.js`
Expected: FAIL —— `SyntaxError: The requested module './runs.js' does not provide an export named 'setRunMode'`

- [ ] **Step 3: 实现 setRunMode**

在 `src/store/runs.js` 的 `resolveDecision`（约 216-223 行）之后插入：

```js
/**
 * 运行中切换权限模式（仅放宽）：只有「询问」起跑的 run 可即时生效——
 * 起跑时装了 PreToolUse ask 钩子，所有工具都会经 canUseTool，改 run.mode 即可放行。
 * 放宽同时自动放行挂起/排队的 permission 询问；dialog（交互提问）保序保留。
 * 非询问起跑的 run 没装钩子，工具不经回调，中途无从拦截 → 返回 false（下一条消息生效）。
 */
export function setRunMode(runId, mode) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  if (run.startMode !== 'default') return false;
  if (mode !== 'acceptEdits' && mode !== 'bypassPermissions') return false;
  run.mode = mode;
  // 排队中的 permission 直接放行；dialog 保序留下
  const keep = [];
  for (const p of run.pendingQueue) {
    if (p.kind === 'permission') p.resolve('allow');
    else keep.push(p);
  }
  run.pendingQueue = keep;
  // 展示位是 permission → 放行；advanceAsk 会让队列下一个（若有）上位并广播
  if (run.pending && run.pending.kind === 'permission') {
    const p = run.pending;
    advanceAsk(run);
    p.resolve('allow');
  }
  if (!run.pending) fanout(run, 'ask', null); // 通知前端撤下已展示的审批弹窗
  touch(run);
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/runs.test.js`
Expected: PASS，3 个 test 全绿

- [ ] **Step 5: 回归既有测试**

Run: `node --test src/store/history.test.js`
Expected: PASS（2 个 test）

---

### Task 2: server.js 接线（run.mode 运行时可变 + /api/run/set-mode）

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 导入 setRunMode**

在 `from '../../store/runs.js'` 的导入列表（约 20-40 行）中，`resolveDecision,` 之后加一行：

```js
  setRunMode,
```

- [ ] **Step 2: 注册路由**

在路由分发处（约 101 行）`/api/run/decision` 之后插入：

```js
  if (url.pathname === '/api/run/set-mode') return handleRunSetMode(req, res);
```

- [ ] **Step 3: startClaudeRun 初始化运行时模式字段**

`startClaudeRun`（约 278-284 行）中，`const effectiveMode = mode || 'default';` 之后插入两行：

```js
  run.mode = effectiveMode; // 运行时可变（/api/run/set-mode 可中途放宽）
  run.startMode = effectiveMode; // 起跑模式：非「询问」起跑未装 ask 钩子，中途无法拦截
```

- [ ] **Step 4: canUseTool 改读运行时模式**

`canUseTool` 回调（约 321-322 行）中，把

```js
      if (effectiveMode !== 'default') return { behavior: 'allow' }; // 非「询问」模式交给 permissionMode
```

改为

```js
      if (run.mode !== 'default') return { behavior: 'allow' }; // 非「询问」（含中途放宽）交给 permissionMode
```

注意：`hooks` 的安装条件（`effectiveMode === 'default'`，约 304 行）**保持不动**——钩子只能在启动时决定。

- [ ] **Step 5: 新增 handler**

在 `handleRunDecision`（约 609-627 行）之后插入：

```js
/** 运行中切换权限模式（仅放宽）：「询问」起跑的 run 即时生效并自动放行挂起审批 */
function handleRunSetMode(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body || '{}');
    } catch {
      data = {};
    }
    const applied = setRunMode((data.runId || '').trim(), (data.mode || '').trim());
    sendJson(res, 200, { applied });
  });
}
```

- [ ] **Step 6: 语法验证**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出（exit 0）

---

### Task 3: 前端即时生效（写穿 + 还原可见化 + 运行中切模式）

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 新增 MODE_LABELS 常量**

在 `MODEL_LABELS` 定义（约 1106-1111 行）之后插入：

```js
      const MODE_LABELS = {
        default: '询问',
        acceptEdits: '接受编辑',
        plan: '计划',
        bypassPermissions: '自动',
      };
```

- [ ] **Step 2: 新增 persistPrefsToConv（写穿）**

在 `recordMessage` 函数（约 279-300 行）结束后插入：

```js
      // 写穿：右下角改动立即写入当前会话记录（不等下一条消息快照），杜绝切走再切回被还原
      function persistPrefsToConv() {
        if (!currentConvId) return;
        const list = loadConvs();
        const c = list.find((x) => x.id === currentConvId);
        if (!c) return;
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
      }
```

- [ ] **Step 3: applySessionPrefs 改为「真变化才动」+ toast**

整体替换 `applySessionPrefs`（约 1136-1155 行，含上方注释行）为：

```js
      // 会话级偏好还原：仅接受白名单内的值（未知模型/模式一律忽略），实际变化才刷 UI + 提示
      function applySessionPrefs(prefs) {
        let changed = false;
        if (prefs.model && MODEL_LABELS[prefs.model] && prefs.model !== chatModel) {
          chatModel = prefs.model;
          localStorage.setItem('claude_model', chatModel);
          changed = true;
        }
        if (prefs.effort && EFFORTS.includes(prefs.effort) && prefs.effort !== chatEffort) {
          chatEffort = prefs.effort;
          localStorage.setItem('claude_effort', chatEffort);
          changed = true;
        }
        if (prefs.mode && MODES.includes(prefs.mode) && prefs.mode !== chatMode) {
          chatMode = prefs.mode;
          localStorage.setItem('claude_mode', chatMode);
          changed = true;
        }
        if (changed) {
          syncModelUI();
          toast('已还原此会话偏好：' + MODEL_LABELS[chatModel] + ' · ' + MODE_LABELS[chatMode]);
        }
      }
```

（原实现只要字段合法就置 `changed = true`，同值也会误报"变化"——加 `!==` 判断是本次修复的一部分，否则每次切会话都弹 toast。）

- [ ] **Step 4: 模型 pill 点击 → 写穿 + 运行中提示**

替换 `modelPills` 的点击绑定（约 1163-1169 行）为：

```js
      [...modelPills.children].forEach((b) => {
        b.addEventListener('click', () => {
          chatModel = b.dataset.m;
          localStorage.setItem('claude_model', chatModel);
          syncModelUI();
          persistPrefsToConv();
          if (currentConvId && runningJobs[currentConvId]) toast('模型将从下一条消息生效');
        });
      });
```

- [ ] **Step 5: 模式 pill 点击 → 写穿 + 运行中尝试即时切换**

替换 `modePills` 的点击绑定（约 1170-1176 行）为：

```js
      [...modePills.children].forEach((b) => {
        b.addEventListener('click', async () => {
          chatMode = b.dataset.mode;
          localStorage.setItem('claude_mode', chatMode);
          syncModelUI();
          persistPrefsToConv();
          // 运行中任务：尝试即时切换（仅「询问」起跑可放宽为 接受编辑/自动）
          const job = currentConvId && runningJobs[currentConvId];
          if (!job || !job.runId) return;
          try {
            const r = await fetch('/api/run/set-mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: job.runId, mode: chatMode }),
            });
            const d = await r.json();
            toast(
              d.applied
                ? '当前任务已切换为「' + MODE_LABELS[chatMode] + '」'
                : '当前任务无法中途切换，将从下一条消息生效',
            );
          } catch {
            /* 网络失败不打扰：下一条消息仍会带上新模式 */
          }
        });
      });
```

- [ ] **Step 6: 强度滑杆 → 写穿 +（拖完才）提示**

替换 `effortSlider` 的绑定（约 1177-1180 行）为：

```js
      effortSlider.addEventListener('input', () => {
        chatEffort = EFFORTS[Number(effortSlider.value)] || 'medium';
        localStorage.setItem('claude_effort', chatEffort);
        persistPrefsToConv();
      });
      effortSlider.addEventListener('change', () => {
        if (currentConvId && runningJobs[currentConvId]) toast('思考强度将从下一条消息生效');
      });
```

（`input` 拖动中高频触发，toast 放 `change`——松手才提示一次。）

- [ ] **Step 7: 访问日志标签**

`LOG_PATH_LABELS`（约 1244-1252 行）中 `'/api/run/abort': '停止对话',` 之后加一行：

```js
        '/api/run/set-mode': '切换权限模式',
```

- [ ] **Step 8: 语法验证**

Run: `node --check public/app.js`
Expected: 无输出（exit 0）

---

### Task 4: index.html 弹层 → 嵌入式面板结构

**Files:**
- Modify: `public/index.html`

⚠️ Task 4-6 是一个整体（HTML/JS/CSS 联动），中间态页面不可用属预期，Task 7 统一验证。

- [ ] **Step 1: 新增 panelView（置于 `</main>` 之后、`.fab-row` 之前）**

在 `<main class="messages" id="messages">…</main>` 闭合标签后插入：

```html
      <!-- 嵌入式面板视图：设置 / 需求故障 / 访问日志（替代原弹层） -->
      <section class="panel-view" id="panelView" hidden>
        <div class="panel-page" data-view="settings" hidden>
          <div class="panel-head">
            <h3>设置</h3>
            <button class="panel-close" title="返回对话">✕</button>
          </div>
          <div class="panel-tabs" id="settingsTabs">
            <button data-tab="lark" class="active">飞书凭证</button>
            <button data-tab="messages">机器人文案</button>
            <button data-tab="tokens">Claude 账号<span class="badge-dot" id="settingsTabBadge" hidden></span></button>
          </div>
          <div class="set-tab" data-tab="lark">
            <div class="set-sec">
              <div class="set-sec-head">
                <span class="sec-label">应用凭证</span>
                <span class="feishu-state" id="feishuState">—</span>
              </div>
              <label class="set-field">App ID
                <input id="larkAppId" placeholder="cli_xxxxxxxxxxxx" autocomplete="off" />
              </label>
              <label class="set-field">App Secret
                <input id="larkAppSecret" type="password" placeholder="留空则不改动" autocomplete="new-password" />
              </label>
              <div class="set-actions">
                <button class="btn primary" id="larkSaveBtn">保存并重连</button>
              </div>
            </div>
          </div>
          <div class="set-tab" data-tab="messages" hidden>
            <div class="set-sec">
              <div class="set-sec-head">
                <span class="sec-label">文案列表</span>
                <span class="msg-hint">留空用默认 · 保存后下一条消息生效</span>
              </div>
              <div class="msg-list" id="msgList"></div>
              <div class="set-actions">
                <button class="btn primary" id="msgSaveBtn">保存文案</button>
              </div>
            </div>
          </div>
          <div class="set-tab" data-tab="tokens" hidden>
            <div class="set-sec">
              <div class="set-sec-head">
                <span class="sec-label">备用 token 列表</span>
                <span class="active-token" id="activeToken">—</span>
              </div>
              <div class="token-list" id="tokenList"></div>
              <div class="token-add">
                <input id="tokenLabel" placeholder="名称，如 备用A" autocomplete="off" />
                <input id="tokenValue" placeholder="sk-ant-oat01-…" autocomplete="off" />
                <button class="btn" id="tokenAddBtn">＋ 添加</button>
              </div>
            </div>
          </div>
        </div>

        <div class="panel-page" data-view="tasks" hidden>
          <div class="panel-head">
            <h3>需求 / 故障</h3>
            <button class="panel-close" title="返回对话">✕</button>
          </div>
          <div id="taskBody"></div>
        </div>

        <div class="panel-page" data-view="logs" hidden>
          <div class="panel-head">
            <h3>访问日志</h3>
            <button class="panel-close" title="返回对话">✕</button>
          </div>
          <div id="logBody"></div>
        </div>
      </section>
```

- [ ] **Step 2: 删除三个旧弹层**

整块删除以下三段（注释行一并删）：
1. `<!-- 访问日志弹层 -->` 至其 `</div>` 闭合（原 118-127 行，`id="logMask"` 整块）；
2. `<!-- 设置弹层 -->` 至其闭合（原 129-182 行，`id="settingsMask"` 整块）；
3. `<!-- 需求 / 故障弹层 -->` 至其闭合（原 184-193 行，`id="taskMask"` 整块）。

**保留** `<!-- 目录选择弹层 -->`（`dirMask`）不动。

- [ ] **Step 3: 确认 ID 无丢失**

Run: `grep -c 'id="feishuState"\|id="larkAppId"\|id="larkAppSecret"\|id="larkSaveBtn"\|id="msgList"\|id="msgSaveBtn"\|id="tokenList"\|id="tokenLabel"\|id="tokenValue"\|id="tokenAddBtn"\|id="activeToken"\|id="taskBody"\|id="logBody"' public/index.html`
Expected: `13`（每个 ID 恰好一处）
Run: `grep -c 'settingsMask\|taskMask\|logMask' public/index.html`
Expected: `0`

---

### Task 5: app.js 视图切换层

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 新增视图状态与 showView**

在 `// ---- 需求 / 故障任务 ----` 注释行（约 1296 行）之前插入：

```js
      // ---- 嵌入式面板视图（chat=对话 | settings | tasks | logs），替代原弹层 ----
      const appEl = $('.app');
      const panelView = $('#panelView');
      let activeView = 'chat';
      function showView(name) {
        if (activeView === name) return;
        if (activeView === 'tasks') stopTaskPolling(); // 离开任务视图停轮询
        activeView = name;
        const inChat = name === 'chat';
        appEl.classList.toggle('in-panel', !inChat);
        panelView.hidden = inChat;
        panelView
          .querySelectorAll('.panel-page')
          .forEach((p) => (p.hidden = p.dataset.view !== name));
        if (name === 'settings') loadSettings();
        else if (name === 'tasks') {
          requestNotifyPermission(); // 在用户手势内请求桌面通知授权
          startTaskPolling();
        } else if (name === 'logs') loadLogs();
      }
      function toggleView(name) {
        showView(activeView === name ? 'chat' : name);
      }
      panelView
        .querySelectorAll('.panel-close')
        .forEach((b) => b.addEventListener('click', () => showView('chat')));
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || activeView === 'chat') return;
        if (document.querySelector('.mask:not([hidden])')) return; // 目录/确认弹层优先消费 Esc
        showView('chat');
      });
```

- [ ] **Step 2: 任务弹层逻辑 → 视图轮询**

删除 `const taskMask = $('#taskMask');`（约 1297 行）。
整体替换 `openTaskModal` / `closeTaskModal` 及其下的三处绑定（原约 1554-1574 行）为：

```js
      function startTaskPolling() {
        loadTasks();
        // 分析/开发在后台异步推进，轮询刷新状态；正在补充编辑时暂停，避免清空输入
        taskTimer = setInterval(() => {
          if (activeView === 'tasks' && !panelView.querySelector('.task-fix')) loadTasks();
        }, 4000);
      }
      function stopTaskPolling() {
        if (taskTimer) {
          clearInterval(taskTimer);
          taskTimer = null;
        }
      }
      $('#taskBtn').addEventListener('click', () => toggleView('tasks'));
```

- [ ] **Step 3: 修正 taskMask 残留引用**

`refreshTaskBadge`（约 1378-1379 行）的守卫 `if (!taskMask.hidden) return; // 抽屉打开时由 loadTasks 负责` 改为：

```js
        if (activeView === 'tasks') return; // 任务视图打开时由 loadTasks 负责
```

桌面通知点击回调（约 1366-1370 行）中 `openTaskModal();` 改为 `showView('tasks');`。

- [ ] **Step 4: 日志弹层 → loadLogs**

删除 `const logMask = ...` 声明（用 `grep -n 'logMask' public/app.js` 定位全部残留）。
`openLogModal`（约 1265-1289 行）改名为 `loadLogs` 并删除函数体第一行 `logMask.hidden = false;`，其余不动。
其下三处绑定（原约 1290-1294 行）整体替换为：

```js
      $('#logBtn').addEventListener('click', () => toggleView('logs'));
```

- [ ] **Step 5: 设置弹层 → 视图 + tab**

删除 `const settingsMask = $('#settingsMask');`（约 1577 行）与 `openSettings` / `closeSettings` 两个函数（约 1584-1590 行）。
把设置区底部的三行绑定（约 1753-1757 行）：

```js
      $('#settingsBtn').addEventListener('click', openSettings);
      $('#settingsClose').addEventListener('click', closeSettings);
      settingsMask.addEventListener('click', (e) => {
        if (e.target === settingsMask) closeSettings();
      });
```

整体替换为：

```js
      $('#settingsBtn').addEventListener('click', () => toggleView('settings'));
      // 设置页内部 tab（纯显隐，不重复拉数据）
      const settingsTabs = $('#settingsTabs');
      [...settingsTabs.querySelectorAll('button')].forEach((b) => {
        b.addEventListener('click', () => {
          [...settingsTabs.querySelectorAll('button')].forEach((x) =>
            x.classList.toggle('active', x === b),
          );
          panelView
            .querySelectorAll('.set-tab')
            .forEach((p) => (p.hidden = p.dataset.tab !== b.dataset.tab));
        });
      });
```

- [ ] **Step 6: 「Claude 账号」tab 红点与 ⚙ 徽标同步**

`refreshTokenStatus`（约 1842-1865 行）中 `badge.hidden = !anyBad && !d.notice;` 之后加一行：

```js
        $('#settingsTabBadge').hidden = badge.hidden;
```

- [ ] **Step 7: 四处返回聊天钩子**

1. `openConv`（约 301 行）函数体**最前**（`if (id === currentConvId) return;` 之前）插入 `showView('chat');`
2. `newConversation`（约 337 行）函数体最前插入 `showView('chat');`
3. `resumeHistorySession`（约 112 行）函数体最前插入 `showView('chat');`
4. `send()`（约 632-636 行）中 `if (currentConvId && runningJobs[currentConvId]) return;` 之后插入 `showView('chat'); // 面板视图下发送 → 回到对话看流式输出`

- [ ] **Step 8: 残留引用清零 + 语法验证**

Run: `grep -c 'taskMask\|logMask\|settingsMask\|openTaskModal\|closeTaskModal\|openLogModal\|openSettings\|closeSettings' public/app.js`
Expected: `0`
Run: `node --check public/app.js`
Expected: 无输出（exit 0）

---

### Task 6: app.css 扁平化样式

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: 删除抽屉样式**

整块删除 `/* ---- 右侧抽屉（复用 .modal 的 head/body 结构）---- */` 注释起、至 `@keyframes slideIn { ... }` 闭合止（原约 861-880 行）。`.mask` / `.modal` 系保留（目录弹层与确认框仍在用）。

- [ ] **Step 2: 追加面板样式**

在文件末尾（`.token-banner button` 规则之后）追加（保持文件现有 6 空格缩进）：

```css
      /* ---- 嵌入式面板视图（设置 / 需求故障 / 访问日志）---- */
      .app.in-panel .messages,
      .app.in-panel .fab-row,
      .app.in-panel .lottie-fab {
        display: none;
      }
      .panel-view {
        flex: 1;
        overflow-y: auto;
        padding: 20px 24px 32px;
        animation: fade 0.15s ease;
      }
      .panel-view[hidden] {
        display: none; /* flex 会压过 UA 的 [hidden]，须显式覆盖（同 token-banner） */
      }
      .panel-page {
        max-width: 720px;
        margin: 0 auto;
      }
      .panel-page[hidden] {
        display: none;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 12px;
        margin-bottom: 14px;
        border-bottom: 1px solid var(--border-soft);
      }
      .panel-head h3 {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .panel-close {
        cursor: pointer;
        color: var(--muted);
        background: none;
        border: none;
        font-size: 15px;
        font-family: inherit;
        padding: 4px 9px;
        border-radius: 6px;
      }
      .panel-close:hover {
        color: var(--text);
        background: var(--panel-2);
      }
      /* 设置页下划线式 tab */
      .panel-tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border-soft);
        margin-bottom: 18px;
      }
      .panel-tabs button {
        position: relative;
        background: none;
        border: none;
        cursor: pointer;
        font-family: inherit;
        font-size: 13px;
        color: var(--muted);
        padding: 8px 14px 10px;
      }
      .panel-tabs button:hover {
        color: var(--text);
      }
      .panel-tabs button.active {
        color: var(--text);
      }
      .panel-tabs button.active::after {
        content: '';
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: -1px;
        height: 2px;
        border-radius: 2px;
        background: var(--accent);
      }
      .panel-tabs .badge-dot {
        position: static;
        display: inline-block;
        margin-left: 6px;
        border: none;
      }
      .set-tab[hidden] {
        display: none;
      }
```

（`.badge-dot` 原是绝对定位（顶栏按钮角标），tab 内改静态内联；`fade` 动画复用 `.mask` 已有的 `@keyframes fade`。）

- [ ] **Step 3: 确认无残留 drawer 引用**

Run: `grep -c 'drawer' public/app.css public/index.html public/app.js`
Expected: 三个文件均为 `0`

---

### Task 7: 回归与手工验证

- [ ] **Step 1: 全量单测**

Run: `node --test src/store/`
Expected: PASS（runs.test.js 3 个 + history.test.js 2 个）

- [ ] **Step 2: 语法终检**

Run: `node --check public/app.js && node --check src/entrypoints/web/server.js && node --check src/store/runs.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 手工验证清单（需用户或有头环境执行）**

启动 `npm start`，浏览器打开执行台，逐项确认：

视图切换：
1. 顶栏 ⚙ → 设置视图占满消息区（无遮罩），tab 在 飞书凭证/机器人文案/Claude账号 间切换正常；
2. 再点 ⚙ / 点 ✕ / 按 Esc → 回到对话；目录弹层打开时按 Esc 只关弹层；
3. 需求/故障、访问日志按钮同理；任务视图打开时红点消失（已读）、4s 轮询刷新；
4. 面板视图下点侧栏会话 / 新对话 / 发送消息 → 自动回到对话视图；
5. token 异常时 ⚙ 红点与「Claude 账号」tab 红点同步显示。

即时生效：
6. 会话 A 改模型为 Opus → 切会话 B 再切回 A → 右下角仍是 Opus（写穿生效）；
7. 打开偏好不同的会话 → toast「已还原此会话偏好：…」，值相同时不弹；
8. 「询问」模式跑一个会调工具的任务，弹出审批时把模式切到「自动」→ toast「当前任务已切换为「自动」」，审批弹窗自动消失、任务继续跑且不再询问；
9. 以「自动」起跑的任务中途切回「询问」→ toast「当前任务无法中途切换，将从下一条消息生效」；
10. 运行中改模型/拖强度 → toast「将从下一条消息生效」；
11. 访问日志中出现「切换权限模式」条目。

---

## Self-Review 记录

- **Spec 覆盖**：视图切换层（Task 4/5）、扁平样式+tab（Task 6）、写穿/还原可见化/set-mode（Task 1/2/3）、日志标签（Task 3 Step 7）、tab 红点（Task 5 Step 6）、测试（Task 1/7）——spec 全部条目有对应任务。
- **类型一致性**：`setRunMode(runId, mode) → boolean` 在 runs.js/server.js/测试三处一致；`run.mode`/`run.startMode` 字段名一致；前端 `d.applied` 与后端 `{ applied }` 一致；`MODE_LABELS`/`persistPrefsToConv`/`showView`/`toggleView`/`loadLogs`/`startTaskPolling`/`stopTaskPolling` 各定义与调用点名称一致。
- **无占位符**：所有代码步骤均为完整可粘贴代码；行号为写计划时快照，执行时以锚点文本为准。
