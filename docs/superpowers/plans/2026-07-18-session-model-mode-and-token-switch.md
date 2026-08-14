# 会话级模型/模式还原 + 设置页账号切换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 切回历史会话时右下角模型/强度/询问模式自动还原；设置页可一键把某账号置为首选（立即成为 active）。

**Architecture:** 前端为主：本地会话条目照 `cwd` 先例快照/还原三个偏好字段；磁盘历史由后端 `getHistorySession()` 在现有逐行遍历中顺带提取 `model`/`permissionMode` 透传给前端。账号切换复用现有 `reorder` API（置顶=首选），零后端改动。

**Tech Stack:** 原生 JS（public/app.js）、Node ESM（src/store/history.js）、node:test。

**规约：** 本项目不主动执行 git 提交（用户明确要求），计划里没有 commit 步骤。

设计文档：`docs/superpowers/specs/2026-07-18-session-model-mode-and-token-switch-design.md`

---

### Task 1: 后端 — getHistorySession 提取 model / permissionMode

**Files:**
- Modify: `src/store/history.js:190-217`（getHistorySession 的遍历循环与返回值）
- Test: `src/store/history.test.js`（新建）

- [ ] **Step 1: 写失败测试**

新建 `src/store/history.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getHistoryDir, getHistorySession } from './history.js';

// 用带 pid 的假 cwd 隔离出专用 project 目录，测完整体删除
const FAKE_CWD = 'C:\\__history-test-' + process.pid;
const SID = 'testsession';

function writeFixture(lines) {
  const dir = getHistoryDir(FAKE_CWD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), lines.map((o) => JSON.stringify(o)).join('\n'));
  return dir;
}

test('getHistorySession 提取最后的 model 与 permissionMode', async (t) => {
  const dir = writeFixture([
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', message: { content: '你好' } },
    { type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'permission-mode', permissionMode: 'acceptEdits' },
    // 最后一条 assistant 只有 tool_use 无文本：不进 messages，但 model 仍应被采纳
    { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use' }] } },
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = await getHistorySession(SID, FAKE_CWD);
  assert.equal(s.model, 'claude-sonnet-4-6');
  assert.equal(s.permissionMode, 'acceptEdits');
});

test('无相关行时 model/permissionMode 为空串', async (t) => {
  const dir = writeFixture([{ type: 'user', message: { content: 'hi' } }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = await getHistorySession(SID, FAKE_CWD);
  assert.equal(s.model, '');
  assert.equal(s.permissionMode, '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/history.test.js`
Expected: FAIL（`s.model` 为 undefined ≠ 'claude-sonnet-4-6'）

- [ ] **Step 3: 实现提取逻辑**

`src/store/history.js` getHistorySession 内（`const events = []` 处起）改为：

```js
    const events = [];
    const messages = [];
    let model = ''; // 最后一条 assistant 消息所用模型
    let permissionMode = ''; // 最后一次询问模式（permission-mode 行）

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        events.push(obj);

        // 提取消息流：靠 obj.type 区分 user / assistant，文本由 extractText 从 message.content 提取
        if (obj.type === 'user') {
          const text = extractText(obj.message?.content);
          if (text) {
            messages.push({ role: 'user', content: text, timestamp: obj.timestamp });
          }
        } else if (obj.type === 'assistant') {
          // model 在 push 判断之前采纳：纯 tool_use/thinking 的 assistant 行也带模型信息
          if (typeof obj.message?.model === 'string') model = obj.message.model;
          const text = extractText(obj.message?.content);
          // 跳过只有 thinking/tool_use 而无文本的助手记录，避免大量空气泡
          if (text) {
            messages.push({ role: 'assistant', content: text, timestamp: obj.timestamp });
          }
        } else if (obj.type === 'permission-mode' && typeof obj.permissionMode === 'string') {
          permissionMode = obj.permissionMode;
        }
        // 其它类型仅保留在 events 中，不计入 messages
      } catch {
        // 跳过损坏的 JSON 行
      }
    }

    return { sessionId, messages, events, messageCount: messages.length, model, permissionMode };
```

（`/api/history/:id` 路由 `handleHistoryDetail` 透传整个 session 对象，新字段自动带出，server.js 无需改动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/history.test.js`
Expected: 2 passed

---

### Task 2: 前端 — 本地会话快照与还原

**Files:**
- Modify: `public/app.js:289-292`（recordMessage：快照三字段）
- Modify: `public/app.js:302-306`（openConv：还原）
- Modify: `public/app.js:1129` 附近（syncModelUI 之后：新增 applySessionPrefs）

- [ ] **Step 1: 新增 applySessionPrefs 辅助函数**

在 `syncModelUI();`（app.js 约 1129 行）之后加：

```js
      // 会话级偏好还原：仅接受白名单内的值（未知模型/模式一律忽略），有变化才刷 UI
      function applySessionPrefs(prefs) {
        let changed = false;
        if (prefs.model && MODEL_LABELS[prefs.model]) {
          chatModel = prefs.model;
          localStorage.setItem('claude_model', chatModel);
          changed = true;
        }
        if (prefs.effort && EFFORTS.includes(prefs.effort)) {
          chatEffort = prefs.effort;
          localStorage.setItem('claude_effort', chatEffort);
          changed = true;
        }
        if (prefs.mode && MODES.includes(prefs.mode)) {
          chatMode = prefs.mode;
          localStorage.setItem('claude_mode', chatMode);
          changed = true;
        }
        if (changed) syncModelUI();
      }
```

（function 声明提升，openConv/resumeHistorySession 定义在它前面也能调用；实际调用发生在用户交互时，常量均已初始化。）

- [ ] **Step 2: recordMessage 快照当前偏好**

`recordMessage()` 中 `c.session = currentSession;` / `c.cwd = cwd;` 之后加：

```js
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
```

- [ ] **Step 3: openConv 还原**

`openConv()` 中恢复 cwd 的 `if (typeof c.cwd === 'string') { ... }` 块之后加：

```js
        applySessionPrefs(c); // 还原该会话的模型/强度/模式（缺失或不认识则保持现状）
```

- [ ] **Step 4: 浏览器验证**

1. 打开 web 页，新建会话 A：模型选 Haiku 4.5、模式选「计划」，发一条消息。
2. 新建会话 B：模型切 Opus 4.8、模式「询问」，发一条消息。
3. 左栏点回会话 A → 右下角显示 Haiku 4.5，弹层内模式高亮「计划」；点回 B → Opus 4.8 +「询问」。
4. 点开一条改动前的老会话（无新字段）→ 选择器保持当前值不变，无报错。

---

### Task 3: 前端 — 磁盘历史续接时还原

**Files:**
- Modify: `public/app.js:129-131`（resumeHistorySession：拿到详情后还原）

- [ ] **Step 1: resumeHistorySession 调用还原**

`const session = json.data;` 之后（`currentConvId = ...` 之前）加：

```js
          // CLI 历史：还原其模型与询问模式（CLI 模型 ID 不在 web 白名单内则忽略；无 effort 概念）
          applySessionPrefs({ model: session.model, mode: session.permissionMode });
```

（必须在下面的 recordMessage 循环之前：续接落库的新本地条目才会快照到还原后的值。）

- [ ] **Step 2: 浏览器验证**

1. 左栏点一条 web 徽标的磁盘历史（此前由 web 以特定模型/模式跑过的会话）→ 右下角选择器变为该会话的模型/模式。
2. 点一条 CLI 跑的历史（model 为 `claude-fable-5` 等非白名单值）→ 模型选择器保持不变，模式若是 default/acceptEdits/plan/bypassPermissions 则还原，无报错。
3. curl 抽查接口字段：
   `curl "http://localhost:3000/api/history/<sessionId>?cwd=" | grep -o '"model":"[^"]*"'`（端口以实际为准）
   Expected: 返回体含 `model` 与 `permissionMode` 字段。

---

### Task 4: 设置页 — 「设为当前」账号按钮

**Files:**
- Modify: `public/app.js:1587-1613`（renderTokenList：首行标记 + 按钮）
- Modify: `public/app.js:1682` 附近（deleteToken 之后：新增 makePrimary）
- Modify: `public/app.css:1300` 附近（.t-primary / .make-primary 样式）

- [ ] **Step 1: renderTokenList 加首选标记与按钮**

`tokens.forEach((t) => {` 改为 `tokens.forEach((t, i) => {`；`row.innerHTML` 赋值改为（在 spacer 之后、rename 之前插入）：

```js
          row.innerHTML =
            '<span class="drag" title="拖拽调整优先级">⠿</span>' +
            '<span class="t-badge ' + t.status + '">' + badgeText + util + '</span>' +
            '<span class="t-label"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="t-reset">' + (t.status !== 'healthy' ? fmtReset(t.resetsAt) : '') + '</span>' +
            '<span class="spacer"></span>' +
            (i === 0
              ? '<span class="t-primary" title="列表首位 = 偏好最高">★ 首选</span>'
              : '<button class="t-act make-primary" title="置顶为首选账号">设为当前</button>') +
            '<button class="t-act rename" title="改名">✎</button>' +
            '<button class="t-act del" title="删除">🗑</button>';
```

事件绑定（`row.querySelector('.del').onclick = ...` 之后）：

```js
          const mk = row.querySelector('.make-primary');
          if (mk) mk.onclick = () => makePrimary(t);
```

- [ ] **Step 2: 新增 makePrimary**

`deleteToken()` 之后加：

```js
      // 置顶 = 设为首选：复用 reorder，pickActive 顺序优先 → 可用则立即成为 active
      async function makePrimary(t) {
        const ids = [...$('#tokenList').querySelectorAll('.token-row')].map((r) => r.dataset.id);
        const next = [t.id, ...ids.filter((id) => id !== t.id)];
        if (await postSettings({ section: 'tokens', action: 'reorder', ids: next })) {
          if (t.status === 'exhausted') toast('该账号额度已耗尽，已设为首选，恢复后自动启用');
          await loadSettings();
        }
      }
```

- [ ] **Step 3: CSS**

`public/app.css` `.token-row .t-act:hover` 规则（约 1300 行）之后加：

```css
      .token-row .t-primary { font-size: 11px; color: #f08c00; white-space: nowrap; }
      .token-row .make-primary { font-size: 12px; white-space: nowrap; }
```

- [ ] **Step 4: 浏览器验证**

1. 设置页 ⚙ 打开：首位账号显示「★ 首选」，其余行显示「设为当前」按钮。
2. 点第二个账号的「设为当前」→ 列表刷新后它排首位并带「★ 首选」；顶部「当前：xxx」变为该账号（若其可用）。
3. 对 exhausted 账号点「设为当前」→ 置顶成功 + toast 提示；「当前：xxx」仍显示实际可用的账号。
4. 拖拽排序功能不受影响。

---

## Self-Review 结论

- 覆盖检查：spec 功能 A 本地（Task 2）、磁盘（Task 1+3）、功能 B（Task 4）全覆盖；「不做的事」无对应任务，符合预期。
- 无占位符；`applySessionPrefs` 签名在 Task 2 定义、Task 3 使用，一致。
- 后端返回字段 `model`/`permissionMode` 与前端读取字段名一致。
