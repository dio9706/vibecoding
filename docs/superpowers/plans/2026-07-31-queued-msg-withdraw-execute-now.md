# 排队消息「撤回 / 立即生效」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运行中插话消息先在服务端持有（可撤回 / 可立即生效打断当前轮），排队气泡有区分样式与操作按钮。

**Architecture:** 插话不再直接推给 SDK，先存 `run.heldMsgs[]`；当前轮 result 到达时（`autoClose` 之前）同步 flush 进 SDK 输入流——进入任务的时机与现状完全一致。撤回 = 从持有区移除；立即生效 = flush + SDK `interrupt()` 轮内打断。前端气泡三态：排队中 / 已进入任务 / 未发送。

**Tech Stack:** Node ESM（原生 http + SSE）、@anthropic-ai/claude-agent-sdk 0.3.210（流式输入 + interrupt）、原生 JS 前端（无框架）、node --test。

**规则约束（覆盖模板默认）：**
- ⚠️ **本项目规则：绝不执行 git commit / branch 等操作**（用户全局指示）。计划中无任何提交步骤，改动留在工作区。
- 设计依据：`docs/superpowers/specs/2026-07-31-queued-msg-withdraw-execute-now-design.md`
- 测试命令：`npm test`（即 `node --test "src/**/*.test.js"`）；单文件跑 `node --test <path>`。
- 前端（public/js）无自动化测试设施，前端任务以人工走查验证（Task 8 清单）。
- 代码注释一律中文，风格对齐所在文件现状。

**约定的协议对象（全计划统一，不得改名）：**
- SSE 事件：`queue` `{ held: [msgId] }`；`consumed` `{ msgIds: [msgId] }`；`done` 增加可选 `unsent: [msgId]`；`replay` 增加 `held: [msgId]`。
- 端点：`POST /api/run/msg/withdraw` `{runId, msgId}` → `{ok}`；`POST /api/run/msg/now` `{runId}` → `{ok}`；`POST /api/run/send` 返回增加 `msgId`。
- run 新字段：`heldMsgs: [{id, text}]`、`steerHold: true`（Claude 运行标记）。
- 会话存储用户消息新字段：`queued`（排队中）、`unsent`（未发送）、`msgId`、`runId`。

---

### Task 1: runs.js — 持有缓冲存储函数（TDD）

**Files:**
- Modify: `src/store/runs.js`
- Test: `src/store/runs-held.test.js`（新建）

- [ ] **Step 1: 写失败测试**

新建 `src/store/runs-held.test.js`：

```js
/**
 * heldMsgs（插话持有缓冲）单测。
 * 语义：插话消息先存服务端 run.heldMsgs（可撤回）；flush 时按序推进 SDK 输入流。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdMsg, withdrawHeldMsg, flushHeldMsgs, consumeHeldMsgs } from './runs.js';

// 最小 run 假件：绕过 createRun（其看门狗 setInterval 会挂住测试进程）
function fakeRun(input) {
  return {
    id: 'run_test',
    status: 'running',
    heldMsgs: [],
    _input: input || null,
    subscribers: new Set(),
    updatedAt: 0,
    lastProgressAt: 0,
  };
}

test('holdMsg 追加并返回 msgId；withdrawHeldMsg 移除，重复撤回返回 false', () => {
  const run = fakeRun();
  const id1 = holdMsg(run, '第一条');
  const id2 = holdMsg(run, '第二条');
  assert.equal(run.heldMsgs.length, 2);
  assert.ok(id1 && id2 && id1 !== id2);
  assert.equal(withdrawHeldMsg(run, id1), true);
  assert.deepEqual(run.heldMsgs.map((m) => m.text), ['第二条']);
  assert.equal(withdrawHeldMsg(run, id1), false); // 已移除 → 撤回失败
});

test('flushHeldMsgs 按序推进 _input 并清空持有区，返回已消费 id', () => {
  const pushed = [];
  const run = fakeRun({ push: (t) => (pushed.push(t), true) });
  const id1 = holdMsg(run, 'a');
  const id2 = holdMsg(run, 'b');
  const ids = flushHeldMsgs(run);
  assert.deepEqual(pushed, ['a', 'b']);
  assert.deepEqual(ids, [id1, id2]);
  assert.equal(run.heldMsgs.length, 0);
});

test('flushHeldMsgs 无 _input 时不消费（判档窗口内消息继续持有）', () => {
  const run = fakeRun(null);
  holdMsg(run, 'a');
  assert.deepEqual(flushHeldMsgs(run), []);
  assert.equal(run.heldMsgs.length, 1);
});

test('flushHeldMsgs push 失败的消息保留在持有区（输入流已关的窄窗口）', () => {
  const run = fakeRun({ push: () => false });
  holdMsg(run, 'a');
  assert.deepEqual(flushHeldMsgs(run), []);
  assert.equal(run.heldMsgs.length, 1);
});

test('consumeHeldMsgs 取空持有区并返回消息（额度用尽续跑打包用）', () => {
  const run = fakeRun();
  holdMsg(run, 'x');
  holdMsg(run, 'y');
  const msgs = consumeHeldMsgs(run);
  assert.deepEqual(msgs.map((m) => m.text), ['x', 'y']);
  assert.equal(run.heldMsgs.length, 0);
  assert.deepEqual(consumeHeldMsgs(run), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/runs-held.test.js`
Expected: FAIL（`holdMsg` 等未导出，SyntaxError: The requested module does not provide an export named 'holdMsg'）

- [ ] **Step 3: 实现**

`src/store/runs.js` 三处改动：

(1) `createRun()` 的 run 字面量中，`todos: [],` 一行之后新增：

```js
    heldMsgs: [], // 插话持有缓冲：[{id,text}]，未进任务可撤回；本轮 result 时 flush 进 SDK
```

(2) 在 `runResult` 函数之后、`finishRun` 之前新增一节：

```js
// ---- 插话持有缓冲：消息先存服务端，当前轮 result 时统一 flush 进 SDK ----
let heldSeq = 0;
/** 持有一条插话消息（未进任务，可撤回/立即生效），广播最新排队列表；返回 msgId */
export function holdMsg(run, text) {
  const id = 'hm_' + Date.now().toString(36) + '_' + ++heldSeq;
  run.heldMsgs.push({ id, text });
  touch(run);
  fanout(run, 'queue', { held: run.heldMsgs.map((m) => m.id) });
  return id;
}
/** 撤回一条持有中的消息；已 flush（不存在）返回 false */
export function withdrawHeldMsg(run, msgId) {
  const i = run.heldMsgs.findIndex((m) => m.id === msgId);
  if (i < 0) return false;
  run.heldMsgs.splice(i, 1);
  touch(run);
  fanout(run, 'queue', { held: run.heldMsgs.map((m) => m.id) });
  return true;
}
/** 全部持有消息按序推进 SDK 输入流（进入任务），广播 consumed；返回已消费 id。
 *  须在 result 处理链内同步调用（autoClose 之前），输入流非空则同一 run 续下一轮 */
export function flushHeldMsgs(run) {
  if (!run.heldMsgs.length || !run._input || typeof run._input.push !== 'function') return [];
  const ids = [];
  for (const m of run.heldMsgs) if (run._input.push(m.text)) ids.push(m.id);
  run.heldMsgs = run.heldMsgs.filter((m) => !ids.includes(m.id));
  if (ids.length) {
    touch(run);
    fanout(run, 'consumed', { msgIds: ids });
  }
  return ids;
}
/** 额度用尽路径：取出持有消息并按「已进入任务」广播（文本将并入待续跑 prompt） */
export function consumeHeldMsgs(run) {
  const msgs = run.heldMsgs.splice(0);
  if (msgs.length) fanout(run, 'consumed', { msgIds: msgs.map((m) => m.id) });
  return msgs;
}
/** 立即生效打断当前轮后：作废该轮挂起的 ask（按默认值兜底），并通知前端撤下弹窗 */
export function cancelPendingAsks(run) {
  if (!run.pending && !run.pendingQueue.length) return;
  drainAsks(run);
  fanout(run, 'ask', null);
}
/** done 广播公共字段：附带未消费的持有消息 id（前端标「未发送」）并清空持有区 */
function unsentField(run) {
  if (!run.heldMsgs || !run.heldMsgs.length) return {};
  return { unsent: run.heldMsgs.splice(0).map((m) => m.id) };
}
```

(3) 四个终结函数的 `fanout(run, 'done', {...})` 调用各追加 `...unsentField(run)`：

- `finishRun`：`fanout(run, 'done', { result: run.result || run.text, is_error: run.is_error, subtype: run.subtype, ...unsentField(run) });`
- `failRun`：`fanout(run, 'done', { result: run.text, is_error: true, subtype: run.subtype, ...unsentField(run) });`
- `blockRun`：`fanout(run, 'done', { result: run.text, is_error: false, subtype: 'quota_blocked', ...unsentField(run) });`
- `stopRun`：`fanout(run, 'done', { result: run.text, is_error: false, subtype: 'stopped', ...unsentField(run) });`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/runs-held.test.js`
Expected: PASS（5 个用例；Task 4 附加 stopRun→unsent 用例后为 6 个）

Run: `npm test`
Expected: 全部 PASS（既有 claude.test.js 等不受影响）

---

### Task 2: claude.js — 暴露 interrupt 句柄

**Files:**
- Modify: `src/integrations/claude.js:126-128`

- [ ] **Step 1: 挪动 onInputHandle 调用时机并加 interrupt**

现状（126-128 行，onInputHandle 在 `query()` 之前调用）：

```js
  // 插话（steering）：调用方要 handle 时启用流式输入——prompt 变为可持续注入的消息流
  const inputQueue = onInputHandle ? createInputQueue(prompt) : null;
  if (inputQueue) onInputHandle({ push: inputQueue.push, close: inputQueue.close });
```

改为（`if (inputQueue) onInputHandle(...)` 一行移到 `const q = query({...});` 之后，紧贴其下）：

```js
  // 插话（steering）：调用方要 handle 时启用流式输入——prompt 变为可持续注入的消息流
  const inputQueue = onInputHandle ? createInputQueue(prompt) : null;
```

```js
  // 句柄在 query 创建后交给调用方：interrupt 直接绑定 q（轮内打断，run 存活，队列消息继续跑）
  if (inputQueue) onInputHandle({ push: inputQueue.push, close: inputQueue.close, interrupt: () => q.interrupt() });
```

影响面已核实：`onInputHandle` 仅 `src/entrypoints/web/run-claude.js:78` 一处消费，且只做 `run._input = h` 赋值，对调用时机不敏感（判档窗口的 preInput 回放将在 Task 3 一并删除）。

- [ ] **Step 2: 回归**

Run: `npm test`
Expected: 全部 PASS（createInputQueue 行为未动）

---

### Task 3: 插话改持有 + result 时 flush + 额度续跑打包

**Files:**
- Modify: `src/entrypoints/web/routes-run.js`（handleRunStart / handleRunSend）
- Modify: `src/entrypoints/web/run-claude.js`（startClaudeRun / settleRun / doResume）

- [ ] **Step 1: routes-run.js — handleRunStart 删 preInput、标记 steerHold**

imports 处：`runPulse` 之后加 `holdMsg,`（从 `../../store/runs.js`）。

`handleRunStart` 中（现 54-67 行）：

```js
    const auto = model === 'auto';
    run.steerHold = true; // Claude 运行：插话走服务端持有缓冲（可撤回/立即生效）
    // 立即返回 runId：auto 判档（Haiku，最长 8s）异步进行，期间 run 已可停止、可插话
    //（插话进持有缓冲 heldMsgs，本轮 result 时统一 flush；判档结果经 model 事件补告前端）
    sendJson(res, 200, { runId: run.id, model: auto ? '' : model, effort: auto ? '' : effort });
    if (auto) {
      const tier = await classifyTier(prompt); // 内部自带超时/失败 → medium 兜底
      model = tier.model;
      effort = tier.effort;
    }
    if (run.status !== 'running') return; // 判档窗口内被手动停止
    if (auto) runModel(run, { model, effort });
    startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId });
```

要点：删除 `const preInput = [];` 与 `run._input = { push: ... };` 两行；`startClaudeRun` 调用去掉 `preInput`。判档窗口内被停止时，`stopRun` 的 `unsentField` 已兜底把持有消息标未发送。

- [ ] **Step 2: routes-run.js — handleRunSend 改持有**

替换 `handleRunSend` 的 `req.on('end', ...)` 内主体（注释一并更新）：

```js
/** 插话：消息进服务端持有缓冲（可撤回/立即生效），本轮 result 时统一进入任务。
 *  run 已结束 / 不支持持有（openai-compat）返回 ok:false，由前端降级为新一轮。 */
```

```js
    const text = (data.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text 不能为空' });
    const run = getRun((data.runId || '').trim());
    if (!run || run.status !== 'running' || !run.steerHold) return sendJson(res, 200, { ok: false });
    const msgId = holdMsg(run, text);
    runPulse(run); // 喂看门狗：插话视为活动
    sendJson(res, 200, { ok: true, msgId });
```

- [ ] **Step 3: run-claude.js — flush 时机 + 续跑打包**

imports：`store/runs.js` 导入列表追加 `flushHeldMsgs, consumeHeldMsgs`。

(1) `startClaudeRun` 签名去掉 `preInput`：

```js
export function startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId, resumePendingId, resumeAttempt = 0 }) {
```

(2) `onInputHandle` 简化（删除回放行）：

```js
    onInputHandle: (h) => {
      run._input = h; // 插话入口：/api/run/msg/* 经此注入/打断运行中的 query
    },
```

(3) `onResult` 替换为：

```js
    onResult: (info) => {
      // 排队消息在本轮 result 时统一进入任务：autoClose 之前同步 push，同一 run 续下一轮。
      // 额度用尽（rejected）不 flush——settleRun 会把持有消息打包进待续跑 prompt
      if (!lastRate || lastRate.status !== 'rejected') flushHeldMsgs(run);
      runResult(run, info);
    },
```

(4) `settleRun` 的 rejected 分支，`addPending` 调用前取持有消息、并入 prompt：

```js
    const heldTexts = consumeHeldMsgs(run).map((m) => m.text); // 排队消息随续跑带入（consumed 已广播）
    const entry = addPending({
      convId: params.convId,
      session_id: sid,
      cwd: params.cwd,
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      attempts: params.resumeAttempt || 0, // 继承当前续跑代次：跨额度事件保留重启计数（额度循环本身不递增，仅孤儿恢复 +1）
      prompt: heldTexts.length ? heldTexts.join('\n\n') : undefined,
      resetsAt,
    });
```

(5) `doResume` 的 `startClaudeRun` 调用改：

```js
    prompt: entry.prompt || '继续',
```

- [ ] **Step 4: 回归 + 语法检查**

Run: `npm test`
Expected: 全部 PASS

Run: `node --check src/entrypoints/web/routes-run.js && node --check src/entrypoints/web/run-claude.js`
Expected: 无输出（语法 OK）

---

### Task 4: 撤回 / 立即生效端点 + replay 快照带 held

**Files:**
- Modify: `src/entrypoints/web/routes-run.js`（新增两个 handler + handleRunAttach）
- Modify: `src/entrypoints/web/server.js`（imports + 两条路由）

- [ ] **Step 1: routes-run.js 新增 handler**

imports 追加 `withdrawHeldMsg, flushHeldMsgs, cancelPendingAsks`。在 `handleRunSend` 之后新增：

```js
/** 撤回一条尚未进入任务的插话消息；已 flush 返回 ok:false（前端提示无法撤回） */
export function handleRunMsgWithdraw(req, res) {
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
    const run = getRun((data.runId || '').trim());
    const ok = !!(run && run.status === 'running' && withdrawHeldMsg(run, (data.msgId || '').trim()));
    sendJson(res, 200, { ok });
  });
}

/** 立即生效：全部持有消息按序 flush 进任务 + interrupt 打断当前轮，排队消息作为下一轮马上执行。
 *  先 flush 后打断：打断请求即使失败，消息已入流，最迟下一轮生效。 */
export function handleRunMsgNow(req, res) {
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
    const run = getRun((data.runId || '').trim());
    if (!run || run.status !== 'running' || !run._input || typeof run._input.interrupt !== 'function') {
      return sendJson(res, 200, { ok: false }); // 含判档窗口（_input 未就绪）：消息继续持有，首轮 result 自动进入
    }
    flushHeldMsgs(run);
    cancelPendingAsks(run); // 被打断轮的挂起审批按默认值作废，避免悬空
    run._input.interrupt().catch(() => {}); // 打断失败不致命（见上）
    runPulse(run);
    sendJson(res, 200, { ok: true });
  });
}
```

- [ ] **Step 2: handleRunAttach 的 replay 快照加 held**

`sendTo(res, 'replay', {...})` 对象中 `status: run.status,` 之前加：

```js
    held: (run.heldMsgs || []).map((m) => m.id), // 排队消息对账：前端据此还原/清除排队态
```

- [ ] **Step 3: server.js 注册路由**

imports（routes-run.js 段）追加 `handleRunMsgWithdraw, handleRunMsgNow`。路由表 `/api/run/send` 一行之后加：

```js
  if (url.pathname === '/api/run/msg/withdraw') return handleRunMsgWithdraw(req, res);
  if (url.pathname === '/api/run/msg/now') return handleRunMsgNow(req, res);
```

- [ ] **Step 4: 回归 + 语法检查**

Run: `npm test && node --check src/entrypoints/web/routes-run.js && node --check src/entrypoints/web/server.js`
Expected: 测试全 PASS，语法无输出

---

### Task 5: conv-store — removeMessageAt（撤回删消息的双侧原子操作）

**Files:**
- Modify: `public/js/conv-store.js`（`moveMessageToEnd` 之后新增）

- [ ] **Step 1: 实现**

```js
      /** 存储+_bubbleMap 两侧同步删除第 index 条消息（DOM removeChild 由调用方执行）；成功返回 true。
       *  与 moveMessageToEnd 同为三方同序不变量的守护操作，禁止在调用方拆开做。 */
      export function removeMessageAt(convId, index) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c || !c.messages[index]) return false;
        c.messages.splice(index, 1);
        c.updatedAt = Date.now();
        saveConvs(list);
        const arr = _bubbleMap.get(convId);
        if (arr && index < arr.length) arr.splice(index, 1);
        return true;
      }
```

- [ ] **Step 2: 语法检查**

Run: `node --check public/js/conv-store.js`
Expected: 无输出

---

### Task 6: 前端渲染层 — 气泡三态装饰 + 操作按钮 + CSS

**Files:**
- Modify: `public/js/chat.js`（addMessage、openConv 重建循环、新增 4 个函数、conv-store 导入）
- Modify: `public/app.css`（`.bubble.err` 附近新增样式块）

- [ ] **Step 1: chat.js 导入 removeMessageAt**

顶部 conv-store 导入列表（第 8 行附近）`moveMessageToEnd,` 之后加 `removeMessageAt,`。

- [ ] **Step 2: addMessage 加 meta 参数 + 用户消息操作按钮 + 返回 msg 元素**

签名改 `function addMessage(role, text, meta)`。在 `bubbleRow` 组装处，用户分支改为（在复制按钮之前插入按钮组）：

```js
        if (role === 'user') {
          // 排队操作按钮组（仅排队态显示，applyQueuedDecor 控制显隐）
          const actions = document.createElement('span');
          actions.className = 'q-actions';
          actions.innerHTML =
            '<button class="q-btn q-withdraw" title="撤回：消息尚未进入任务，点击作废">↩</button>' +
            '<button class="q-btn q-now" title="立即生效：打断当前任务轮，马上处理排队消息">⚡</button>';
          actions.querySelector('.q-withdraw').addEventListener('click', (e) => {
            e.stopPropagation();
            withdrawQueuedMsg(msg);
          });
          actions.querySelector('.q-now').addEventListener('click', (e) => {
            e.stopPropagation();
            effectNowQueuedMsg(msg);
          });
          bubbleRow.appendChild(actions);
          bubbleRow.appendChild(copyBtn);
          bubbleRow.appendChild(bubble);
        } else {
          bubbleRow.appendChild(bubble);
          bubbleRow.appendChild(copyBtn);
        }
```

函数末尾（`bubblePush` 之后）追加：

```js
        if (meta && meta.msgId) msg.dataset.msgId = meta.msgId;
        if (role === 'user') applyQueuedDecor(msg, meta && meta.unsent ? 'unsent' : meta && meta.queued ? 'queued' : null);
        return msg;
```

- [ ] **Step 3: openConv 重建循环传 meta**

`for (const m of c.messages) addMessage(m.role, m.text);` 改为：

```js
        for (const m of c.messages) addMessage(m.role, m.text, m);
```

- [ ] **Step 4: 新增装饰/状态/按钮行为四函数**

放在 `addMessage` 定义之后：

```js
      // 排队/未发送装饰：气泡样式 + 提示文字 + 操作按钮显隐（state: 'queued' | 'unsent' | null）
      function applyQueuedDecor(msgEl, state) {
        const bubble = msgEl.querySelector('.bubble');
        const actions = msgEl.querySelector('.q-actions');
        if (bubble) {
          bubble.classList.toggle('queued', state === 'queued');
          bubble.classList.toggle('unsent', state === 'unsent');
        }
        if (actions) actions.style.display = state === 'queued' ? '' : 'none';
        let hint = msgEl.querySelector('.q-hint');
        if (state) {
          if (!hint) {
            hint = document.createElement('div');
            hint.className = 'q-hint';
            msgEl.appendChild(hint);
          }
          hint.textContent = state === 'queued' ? '等待进入任务' : '未发送';
          hint.classList.toggle('unsent', state === 'unsent');
        } else if (hint) {
          hint.remove();
        }
      }

      // 三态切换：存储字段与可见气泡装饰一致更新（后台会话只动存储，切回时 openConv 按存储重建）
      function setMsgQueuedState(convId, index, state) {
        convSetMsgFields(convId, index, { queued: state === 'queued', unsent: state === 'unsent' });
        if (convId !== currentConvId) return;
        const b = bubbleGet(convId, index);
        const msgEl = b && b.closest ? b.closest('.msg') : null;
        if (msgEl) applyQueuedDecor(msgEl, state);
      }

      // 撤回排队消息：服务端移除成功 → 存储+DOM 同步删除；已进入任务 → 提示并清除排队态
      async function withdrawQueuedMsg(msgEl) {
        if (msgEl.dataset.qBusy) return; // 在途防抖：防连点重复请求
        msgEl.dataset.qBusy = '1';
        try {
          const convId = currentConvId;
          const msgId = msgEl.dataset.msgId;
          const conv = loadConvs().find((x) => x.id === convId);
          const idx = conv && msgId ? conv.messages.findIndex((m) => m.msgId === msgId) : -1;
          const m = idx >= 0 ? conv.messages[idx] : null;
          if (!m || !m.queued) return toast('消息已进入任务，无法撤回');
          let d;
          try {
            d = await (
              await fetch('/api/run/msg/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId: m.runId, msgId }),
              })
            ).json();
          } catch {
            d = { ok: false };
          }
          // await 期间存储可能已变（另一条撤回/切段搬移），按 msgId 重新定位，不得复用旧 idx
          const conv2 = loadConvs().find((x) => x.id === convId);
          const idx2 = conv2 ? conv2.messages.findIndex((x) => x.msgId === msgId) : -1;
          if (idx2 < 0) return; // 消息已不在（已被移除/撤回），静默返回
          if (!d.ok) {
            setMsgQueuedState(convId, idx2, null);
            return toast('已进入任务，无法撤回');
          }
          if (removeMessageAt(convId, idx2)) {
            const job = runningJobs[convId];
            if (job && idx2 < job.asstIndex) job.asstIndex -= 1; // 防御：正常流程排队消息恒在占位气泡之后
            msgEl.remove();
          }
        } finally {
          delete msgEl.dataset.qBusy;
        }
      }

      // 立即生效：flush 全部排队消息 + 打断当前轮；成功路径的状态翻转由 consumed 事件驱动
      async function effectNowQueuedMsg(msgEl) {
        if (msgEl.dataset.qBusy) return; // 在途防抖：防连点重复请求
        msgEl.dataset.qBusy = '1';
        try {
          const convId = currentConvId;
          const conv = loadConvs().find((x) => x.id === convId);
          const m = conv && conv.messages.find((x) => x.msgId === msgEl.dataset.msgId);
          if (!m || !m.queued) return;
          let d;
          try {
            d = await (
              await fetch('/api/run/msg/now', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId: m.runId }),
              })
            ).json();
          } catch {
            d = { ok: false };
          }
          if (!d.ok) toast('暂无法立即生效：任务未在运行或正在启动');
        } finally {
          delete msgEl.dataset.qBusy;
        }
      }
```

- [ ] **Step 5: app.css 新增样式**

`.bubble.err` 规则之后追加：

```css
      /* ---- 插话排队态：未进任务（虚线+降透明）/ 未发送（灰化）+ 操作按钮 ---- */
      .msg.user .bubble.queued {
        border-style: dashed;
        border-color: rgba(217, 119, 87, 0.55);
        opacity: 0.75;
      }
      .msg.user .bubble.unsent {
        background: transparent;
        border-color: var(--border-soft);
        color: var(--muted);
        opacity: 0.65;
      }
      .q-hint {
        font-size: 11px;
        color: var(--muted);
        margin: 3px 4px 0;
      }
      .q-hint.unsent {
        color: var(--faint);
      }
      .q-actions {
        display: flex;
        gap: 4px;
        align-items: center;
        flex-shrink: 0;
      }
      .q-btn {
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        line-height: 1;
        background: var(--panel);
        border: 1px solid var(--border-soft);
        border-radius: 6px;
        color: var(--muted);
        cursor: pointer;
        padding: 0;
      }
      .q-btn:hover {
        color: #fff;
        border-color: rgba(217, 119, 87, 0.55);
      }
```

- [ ] **Step 6: 语法检查**

Run: `node --check public/js/chat.js`
Expected: 无输出

---

### Task 7: 前端行为层 — steer 重写 + splitSegment + SSE 事件

**Files:**
- Modify: `public/js/chat.js`（steer、新增 splitSegment、attachStream 的 4 处事件、updateComposerRunning 提示语）

- [ ] **Step 1: 抽取 splitSegment（原 steer 内切段逻辑 → 支持后台会话）**

在 `steer` 之前新增（原 steer 1045-1076 行的切段代码迁移于此，DOM 操作仅对可见会话执行）：

```js
      // 切段：当前助手气泡定稿，新开占位气泡接后续输出（排队消息进入任务时调用）。
      // 后台会话只动存储侧（_bubbleMap/DOM 由 openConv 重建），可见会话双侧同步。
      function splitSegment(job) {
        const convId = job.convId;
        const visible = convId === currentConvId;
        if (job.text.length > job.base) {
          // 本段已有文本 → 定稿当前助手气泡：写入本段全文（按 base 切分），刷新重连后顺序保持正确
          convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          convSetMsgFields(convId, job.asstIndex, { pending: false });
          if (visible) {
            const vb = bubbleAt(job.asstIndex);
            if (vb) {
              // 与 endJob 定稿一致：先停流式 scramble 动画，再渲染定稿内容
              AnimeAnimations.stopStreamScramble();
              renderMarkdown(vb, job.text.slice(job.base));
            }
          }
          // 新占位气泡：记录 textBase（本气泡在 run 全文中的起点），后续输出切到这里
          const asstIndex = convPushMessage(convId, 'assistant', '');
          if (visible) addMessage('assistant', '');
          job.base = job.text.length;
          if (job.shown < job.base) job.shown = job.base;
          convSetMsgFields(convId, asstIndex, { pending: true, runId: job.runId, textBase: job.base });
          job.asstIndex = asstIndex;
        } else {
          // 本段尚无文本（还在跑工具/等首个 token）→ 定稿只会留下空白气泡；
          // 改为把现有占位气泡（含工具日志）挪到排队消息之后继续接收输出。
          // 存储与 DOM 必须同步移动，维持「存储索引=DOM 索引」不变量
          const oldIndex = job.asstIndex;
          const msgEl = visible ? messagesEl.querySelectorAll('.msg')[oldIndex] : null;
          const newIndex = moveMessageToEnd(convId, oldIndex); // 存储+_bubbleMap 两侧在 conv-store 内同步搬移
          if (newIndex >= 0) {
            if (msgEl) messagesEl.appendChild(msgEl);
            job.asstIndex = newIndex;
            if (visible) scrollBottom();
          }
        }
        job._paintedShown = -1;
        if (visible) {
          paintJob(job);
          ensureTyping();
        }
      }
```

- [ ] **Step 2: 重写 steer**

整体替换 `steer` 函数（原切段代码已迁出）：

```js
      // 插话：消息先在服务端排队（气泡排队态，可撤回/立即生效），本轮 result 时进入任务。
      // 助手气泡此间继续在排队消息上方流式输出；切段推迟到 consumed 事件。
      function steer(job, text) {
        if (!job.runId) return toast('任务正在启动，稍候再发'); // Enter 不受按钮禁用约束，需给感知；文本留在输入框
        const convId = job.convId;
        const msgEl = addMessage('user', text, { queued: true });
        recordMessage('user', text);
        const conv0 = loadConvs().find((x) => x.id === convId);
        const idx = conv0.messages.length - 1;
        const msgRef = conv0.messages[idx]; // 跨 await 不得复用旧索引：按对象身份重定位（_convsCache 活对象，搬移不改变身份）
        convSetMsgFields(convId, idx, { queued: true, runId: job.runId });
        clearPrompt();
        // fetch 响应与 SSE 两条连接顺序无保证：响应回来后消息可能已被 consumed 切段搬移/别的撤回前移
        const locate = () => {
          const conv1 = loadConvs().find((x) => x.id === convId);
          return conv1 ? conv1.messages.indexOf(msgRef) : -1;
        };
        const degrade = () => {
          // run 恰好结束 → 降级为新一轮：清排队态 + 补切段（与旧流程一致）后重启
          const i2 = locate();
          if (i2 >= 0) setMsgQueuedState(convId, i2, null);
          splitSegment(job);
          restartAsNewRun(job, text);
        };
        fetch('/api/run/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: job.runId, text }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) return degrade();
            const i2 = locate();
            if (i2 >= 0) convSetMsgFields(convId, i2, { msgId: d.msgId });
            if (msgEl) msgEl.dataset.msgId = d.msgId; // 按钮回调据此定位消息
            // consumed 先到（msgId 尚未回填时不匹配）的补对账：回填后立即清排队态
            if (job._consumedIds && job._consumedIds.has(d.msgId) && i2 >= 0) setMsgQueuedState(convId, i2, null);
          })
          .catch(degrade);
      }
```

- [ ] **Step 3: attachStream 新增/扩展事件处理**

(1) `es.addEventListener('ratelimit', ...)` 之后新增 consumed：

```js
        // 排队消息进入任务：切段（定稿当前助手气泡+新占位）+ 清除排队标记
        es.addEventListener('consumed', (e) => {
          const ids = JSON.parse(e.data).msgIds || [];
          const conv = loadConvs().find((x) => x.id === convId);
          if (!conv) return; // 会话已删：跳过切段，避免 asstIndex 脏状态
          splitSegment(job);
          // 累积已消费 id：steer 的 msgId 回填晚于 consumed 到达时，回填侧据此补清排队态
          if (!job._consumedIds) job._consumedIds = new Set();
          ids.forEach((x) => job._consumedIds.add(x));
          conv.messages.forEach((m, i) => {
            if (m.queued && ids.includes(m.msgId)) setMsgQueuedState(convId, i, null);
          });
        });
```

(2) `replay` 处理器内（`refreshAskChip();` 之前）加对账。仅运行中对账——已结束 run 的 attach 事件序是 replay(held=[]) 先于补发 done(unsent)，不加守卫会先清 queued 导致 unsent 落空：

```js
          // 排队消息对账：仍在服务端持有的保留排队态；不在的已进入任务（关页期间被消费）。
          // 仅运行中对账——已结束 run 的补发 done 会带 unsent，交给 done 处理器标「未发送」
          if (d.status === 'running') {
            const held = Array.isArray(d.held) ? d.held : [];
            const conv = loadConvs().find((x) => x.id === convId);
            if (conv) {
              conv.messages.forEach((m, i) => {
                if (m.queued && m.runId === runId && !held.includes(m.msgId)) setMsgQueuedState(convId, i, null);
              });
            }
          }
```

(3) `done` 处理器开头（`const d = JSON.parse(e.data);` 之后）加未发送标记。按 msgId 匹配、不依赖本地 queued 标记（unsent 列表由服务端保证从未进入任务）：

```js
          if (Array.isArray(d.unsent) && d.unsent.length) {
            // run 终结时仍未消费的排队消息 → 标「未发送」（手动停止/异常/看门狗/重连补发）
            const conv = loadConvs().find((x) => x.id === convId);
            if (conv) {
              conv.messages.forEach((m, i) => {
                if (m.msgId && d.unsent.includes(m.msgId)) setMsgQueuedState(convId, i, 'unsent');
              });
            }
          }
```

(4) `error` 处理器的「run 不存在」分支（`job.pending = true;` 之前）加兜底：

```js
              // 进程重启丢失持有区：本 run 的排队消息标「未发送」（续跑只续 session，不带排队消息）
              const conv = loadConvs().find((x) => x.id === convId);
              if (conv) {
                conv.messages.forEach((m, i) => {
                  if (m.queued && m.runId === runId) setMsgQueuedState(convId, i, 'unsent');
                });
              }
```

- [ ] **Step 4: 发送按钮提示语更新**

`updateComposerRunning` 中 title 一行改为：

```js
        sendBtn.title = job ? (job.runId ? '插话：消息将排队，可撤回或立即生效' : '正在启动，稍候可插话') : '发送';
```

- [ ] **Step 5: 语法检查 + 回归**

Run: `node --check public/js/chat.js && npm test`
Expected: 语法无输出，测试全 PASS

---

### Task 8: 人工走查（验收）

**前置：** `npm start` 启动（或按项目现行 pm2/Tauri 方式），浏览器打开执行台，选一个工作目录。

- [ ] **走查 1 — 排队态展示**：发起一个耗时任务（如「逐步分析这个项目的目录结构，每步都解释」）；运行中发一条插话。预期：用户气泡虚线边框+降透明、下方「等待进入任务」、左侧 ↩/⚡ 按钮常显；助手气泡继续在其上方流式输出。
- [ ] **走查 2 — 撤回**：点 ↩。预期：气泡消失；任务后续输出不包含该消息内容。
- [ ] **走查 3 — 立即生效**：再插话一条，点 ⚡。预期：当前输出很快中止并定稿，新占位气泡出现在排队消息之后接流，插话内容马上被处理；排队样式消失。
- [ ] **走查 4 — 自然进入任务**：插话后不操作，等当前轮结束。预期：轮结束时切段、排队样式自动消失，插话作为下一轮被处理（同一 run，不新建任务）。
- [ ] **走查 5 — 刷新对账**：插话后立刻 F5。预期：重连后排队气泡仍为排队态、按钮可用（replay.held 对账）；等 consumed 后恢复正常。
- [ ] **走查 6 — 停止标记未发送**：插话后点「停止」。预期：任务停止，排队气泡变灰、标「未发送」、按钮消失。
- [ ] **走查 7 — 审批模式交叉**：默认「询问」模式下插话后点 ⚡，若恰有工具审批弹窗挂起。预期：弹窗撤下（按默认拒绝作废），不出现悬空审批。
- [ ] **走查 8 — openai-compat 回退**：切自定义模型会话运行中插话。预期：走降级新任务路径（行为与改动前一致），无排队按钮残留。
- [ ] **走查 9 — 判档窗口**：模型选「auto」，启动后 8 秒内插话并点 ⚡。预期：提示「暂无法立即生效」，消息保持排队，首轮 result 后自动进入任务。

**已知可接受边界（记录，不修）：**
- 关页期间发生 flush：重连后多轮输出合并在切段前的同一助手气泡里（内容完整，仅排版折中）。
- 跨窗口同会话实时同步依赖 `queue` 事件，本期前端仅消费 `replay` 对账（一窗一项目下影响可忽略）。

---

## Self-Review 记录

- **Spec 覆盖**：持有缓冲（T1/T3）、撤回（T4/T6）、立即生效+interrupt（T2/T4/T6）、气泡三态样式（T6）、切段迁移（T7）、replay 对账（T4/T7）、停止未发送（T1/T7）、额度续跑打包（T3）、preInput 移除（T3）、openai 回退（T3/T8）——全覆盖。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型/命名一致性**：`holdMsg/withdrawHeldMsg/flushHeldMsgs/consumeHeldMsgs/cancelPendingAsks`、事件 `queue/consumed/held/unsent`、前端 `splitSegment/setMsgQueuedState/applyQueuedDecor/withdrawQueuedMsg/effectNowQueuedMsg/removeMessageAt`——各任务间引用一致。
