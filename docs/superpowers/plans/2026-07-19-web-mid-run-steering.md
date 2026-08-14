# web 端执行中插话（steering）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web 端在 Claude 执行过程中可继续发送消息，消息注入正在运行的会话（与 CLI steering 一致），不必等对话结束。

**Architecture:** `claude.js` 新增推送式输入队列，调用方传 `onInputHandle` 时以 SDK 流式输入模式启动 query（result 且无积压时自动关流，行为与现状一致）；`server.js` 新增 `POST /api/run/send` 把插话推入运行中的 run；前端解锁发送按钮，插话时定稿当前助手气泡、新建占位气泡并按 `textBase` 偏移切分渲染。`runs.js` 零改动。

**Tech Stack:** Node.js（原生 http）、`@anthropic-ai/claude-agent-sdk@0.3.210`（流式输入模式）、原生前端（EventSource + localStorage）、`node:test`。

**Spec:** `docs/superpowers/specs/2026-07-19-web-mid-run-steering-design.md`

**工程约束（覆盖模板默认）：** 本项目规则为「用户未主动要求时绝不执行 git 提交」。本计划所有任务均**不包含 commit 步骤**，改动留在工作区由用户自行提交。

---

### Task 1: 输入队列 `createInputQueue`（TDD）

**Files:**
- Modify: `src/integrations/claude.js`（新增导出函数，不动 `runClaude`）
- Test: `src/integrations/claude.test.js`（新建）

- [ ] **Step 1: 写失败测试**

新建 `src/integrations/claude.test.js`：

```js
/**
 * createInputQueue（插话输入队列）单测。
 * 语义：首条为初始 prompt；运行中可 push 插话；result 到达时 autoClose——
 * 无积压才关流（有刚插入的消息则继续下一轮），close 后 push 无效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputQueue } from './claude.js';

test('初始 prompt 与插话按序产出，close 后流结束', async () => {
  const q = createInputQueue('第一条');
  q.push('插话一');
  q.push('插话二');
  q.close();
  const out = [];
  for await (const m of q) out.push(m.message.content);
  assert.deepEqual(out, ['第一条', '插话一', '插话二']);
});

test('产出符合 SDK 用户消息结构', async () => {
  const q = createInputQueue('你好');
  q.close();
  const out = [];
  for await (const m of q) out.push(m);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    type: 'user',
    message: { role: 'user', content: '你好' },
    parent_tool_use_id: null,
  });
});

test('autoClose：无积压时关闭流', async () => {
  const q = createInputQueue('任务');
  const out = [];
  for await (const m of q) {
    out.push(m.message.content);
    q.autoClose(); // 模拟 result 到达
  }
  assert.deepEqual(out, ['任务']);
});

test('autoClose：有积压插话时不关闭，继续产出', async () => {
  const q = createInputQueue('任务');
  const out = [];
  for await (const m of q) {
    out.push(m.message.content);
    if (out.length === 1) {
      q.push('补充要求'); // result 前恰好插话（竞态）
      q.autoClose(); // 有积压 → 不得关闭
    } else {
      q.autoClose(); // 第二轮 result：无积压 → 关闭
    }
  }
  assert.deepEqual(out, ['任务', '补充要求']);
});

test('push 挂起中的消费者会被唤醒', async () => {
  const q = createInputQueue('任务');
  const out = [];
  const consumer = (async () => {
    for await (const m of q) out.push(m.message.content);
  })();
  await new Promise((r) => setTimeout(r, 10)); // 消费者消费完初始 prompt 后挂起
  q.push('插话');
  q.close();
  await consumer;
  assert.deepEqual(out, ['任务', '插话']);
});

test('close 后 push 返回 false 且不产出', async () => {
  const q = createInputQueue('任务');
  q.close();
  assert.equal(q.push('迟到'), false);
  const out = [];
  for await (const m of q) out.push(m.message.content);
  assert.deepEqual(out, ['任务']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/integrations/claude.test.js`
Expected: FAIL —— `createInputQueue` 未从 `./claude.js` 导出（SyntaxError: The requested module does not provide an export named 'createInputQueue'）。

- [ ] **Step 3: 实现 `createInputQueue`**

在 `src/integrations/claude.js` 顶部 import 之后、`runClaude` JSDoc 之前插入：

```js
/**
 * 插话（steering）输入队列 —— SDK 流式输入模式的 prompt 源。
 * 首条为初始 prompt；运行中可随时 push 插话；result 到达时调 autoClose：
 * 无积压才关流结束 query，有刚插入的消息则继续同一 run 的下一轮。
 */
export function createInputQueue(initialText) {
  const buffered = [initialText]; // 待消费文本
  let closed = false;
  let wake = null; // 消费者挂起时的唤醒函数
  const notify = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  const push = (text) => {
    if (closed) return false;
    buffered.push(text);
    notify();
    return true;
  };
  const close = () => {
    closed = true;
    notify();
  };
  const autoClose = () => {
    if (!buffered.length) close();
  };
  async function* iterate() {
    while (true) {
      while (buffered.length) {
        yield {
          type: 'user',
          message: { role: 'user', content: buffered.shift() },
          parent_tool_use_id: null,
        };
      }
      if (closed) return;
      await new Promise((r) => {
        wake = r;
      });
    }
  }
  return { push, close, autoClose, [Symbol.asyncIterator]: iterate };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/integrations/claude.test.js`
Expected: PASS，6 个测试全绿。

---

### Task 2: `runClaude` 接入 `onInputHandle`

**Files:**
- Modify: `src/integrations/claude.js`（`runClaude` 函数体 + JSDoc）

- [ ] **Step 1: JSDoc 增加参数说明**

在 `runClaude` 的 JSDoc 中 `@param {AbortController} [opts.abortController]` 一行之后插入：

```js
 * @param {Function} [opts.onInputHandle]  插话（steering）：提供时以流式输入模式启动，
 *                                          回调收到 { push(text), close() }，运行中可注入用户消息
```

- [ ] **Step 2: 解构新参数**

`runClaude` 内解构块中，在 `abortController,` 之后加一行：

```js
    onInputHandle,
```

- [ ] **Step 3: 构建队列并切换 prompt 来源**

把：

```js
  const q = query({
    prompt,
    options: {
```

改为：

```js
  // 插话（steering）：调用方要 handle 时启用流式输入——prompt 变为可持续注入的消息流
  const inputQueue = onInputHandle ? createInputQueue(prompt) : null;
  if (inputQueue) onInputHandle({ push: inputQueue.push, close: inputQueue.close });

  const q = query({
    prompt: inputQueue || prompt,
    options: {
```

- [ ] **Step 4: result 分支触发 autoClose**

在 `runClaude` 的 for-await 循环 `if (message.type === 'result') {` 分支内，`onResult?.({ ... });` 调用之后（分支收尾处）加：

```js
      inputQueue?.autoClose(); // 无积压插话 → 关闭输入流，query 随之收尾（行为与字符串模式一致）
```

- [ ] **Step 5: 验证**

Run: `node --check src/integrations/claude.js && node --test src/integrations/claude.test.js`
Expected: 语法检查通过；6 个测试仍全绿（未传 `onInputHandle` 的调用方走原字符串路径，`classifyTier`/task-ops/feishu 零影响）。

---

### Task 3: `server.js` 注入端点 `/api/run/send`

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: `startClaudeRun` 挂 handle**

在 `startClaudeRun` 内 `runClaude(prompt, {` 的选项中，`abortController: run.abortController,` 一行之后插入：

```js
    onInputHandle: (h) => {
      run._input = h; // 插话入口：/api/run/send 经此注入运行中的 query
    },
```

- [ ] **Step 2: 注册路由**

在 `if (url.pathname === '/api/run/decision') return handleRunDecision(req, res);` 之后插入：

```js
  if (url.pathname === '/api/run/send') return handleRunSend(req, res);
```

- [ ] **Step 3: 实现 handler**

在 `handleRunDecision` 函数之后插入：

```js
/** 插话：把用户消息注入正在运行的 run（SDK 流式输入）。run 已结束/关流返回 ok:false，由前端降级为新一轮 */
function handleRunSend(req, res) {
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
    const text = (data.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text 不能为空' });
    const run = getRun((data.runId || '').trim());
    const ok = !!(run && run.status === 'running' && run._input && run._input.push(text));
    if (ok) runPulse(run); // 喂看门狗：插话视为活动
    sendJson(res, 200, { ok });
  });
}
```

注：`getRun`、`runPulse`、`sendJson` 均已在文件内导入/定义，无需新增 import。

- [ ] **Step 4: 验证**

Run: `node --check src/entrypoints/web/server.js`，然后启动服务（`npm start`，默认 `http://127.0.0.1:3000`，端口以 `.env` 的 `PORT` 为准），执行：

```bash
curl -s -X POST http://127.0.0.1:3000/api/run/send -H "Content-Type: application/json" -d '{"runId":"run_bogus","text":"hi"}'
```

Expected: `{"ok":false}`（run 不存在）。再发空 text：

```bash
curl -s -X POST http://127.0.0.1:3000/api/run/send -H "Content-Type: application/json" -d '{"runId":"x","text":""}'
```

Expected: `{"error":"text 不能为空"}`。验证完停掉服务。

---

### Task 4: 前端插话分支与气泡切分

**Files:**
- Modify: `public/app.js`

本任务全部改动围绕一个不变式：**`job.text` 始终镜像服务端 run 全文；`job.base` 是当前气泡在全文中的起始偏移（持久化为消息字段 `textBase`）；`job.shown` 是全文中的已显示位置（恒 ≥ `job.base`）。** 所有「写当前气泡」的位置统一按 `job.base` 切分。

- [ ] **Step 1: `updateComposerRunning` 解锁发送按钮**

把：

```js
      function updateComposerRunning() {
        const running = !!(currentConvId && runningJobs[currentConvId]);
        sendBtn.disabled = running;
        stopBtn.hidden = !running;
        updateLottieState();
      }
```

改为：

```js
      function updateComposerRunning() {
        const job = currentConvId ? runningJobs[currentConvId] : null;
        // 运行中不再禁发：拿到 runId 即可插话（steering）；仅 start 往返期间短暂禁用
        sendBtn.disabled = !!(job && !job.runId);
        sendBtn.title = job ? '插话：消息将注入正在运行的任务' : '发送';
        stopBtn.hidden = !job;
        updateLottieState();
      }
```

- [ ] **Step 2: 渲染/落库统一按 `base` 切分**

四处修改：

1. `jobStatusText`，把 `if (job.text) return tag + '生成中…';` 改为：

```js
        if (job.text.length > job.base) return tag + '生成中…'; // 本段已有产出
```

2. `paintJob`，把 `renderMarkdown(vb, job.text.slice(0, job.shown));` 改为：

```js
        renderMarkdown(vb, job.text.slice(job.base, job.shown));
```

3. `endJob`，把 `renderMarkdown(vb, job.text); // 定稿：完整 markdown、去掉运行状态行` 改为：

```js
            renderMarkdown(vb, job.text.slice(job.base)); // 定稿：本段完整 markdown、去掉运行状态行
```

4. `send()` 中占位 job 对象字面量，在 `shown: 0,` 之后加一行：

```js
          base: 0,
```

- [ ] **Step 3: `send()` 改插话分支 + 抽 `launchRun` 消重**

把 `send()` 中的运行守卫：

```js
        // 当前会话正在运行则禁止重复发送
        if (currentConvId && runningJobs[currentConvId]) return;
```

改为：

```js
        // 当前会话正在运行 → 插话：注入正在运行的任务（steering）
        const running = currentConvId && runningJobs[currentConvId];
        if (running) return steer(running, text);
```

把 `send()` 尾部整段 `fetch('/api/run/start', { ... }).then(...).catch(...)`（从 `// 两步启动：...` 注释起到函数末尾）替换为一行调用：

```js
        launchRun(job, text, sessionId, runCwd);
```

在 `send()` 函数之后新增 `launchRun`（原 send 尾部逻辑原样搬入，仅把闭包 `asstIndex`/`convId` 改为 `job.asstIndex`/`job.convId`，并在拿到 runId 后刷新按钮态）：

```js
      // 启动一次服务端 run 并接流（send 与插话竞态兜底共用）。
      // 两步启动：先 POST /start 拿 runId（落库，关网页后可按它重连），再 attach SSE
      function launchRun(job, text, sessionId, runCwd) {
        const convId = job.convId;
        fetch('/api/run/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: text,
            cwd: runCwd,
            session: sessionId,
            model: chatModel,
            effort: chatEffort,
            mode: chatMode,
            convId,
          }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.runId) throw new Error(d.error || '启动失败');
            job.runId = d.runId;
            if (d.model) {
              job.pickLabel = shortModel(d.model, d.effort); // 显示实际所用模型（自动模式尤其有用）
              job._paintedStatus = '';
            }
            convSetMsgFields(convId, job.asstIndex, { runId: d.runId });
            attachStream(convId, job.asstIndex, d.runId, job);
            updateComposerRunning(); // runId 就绪 → 解锁插话
            if (job.stopping) abortRun(d.runId); // 期间点了停止 → 拿到 runId 后补发
          })
          .catch((err) => {
            job.text = '⚠️ ' + (err && err.message ? err.message : '启动失败');
            job.err = true;
            job.shown = job.text.length;
            convSetMessage(convId, job.asstIndex, job.text);
            convSetMsgFields(convId, job.asstIndex, { pending: false });
            endJob(convId, true);
          });
      }
```

- [ ] **Step 4: 新增 `steer` 与 `restartAsNewRun`**

在 `launchRun` 之后插入：

```js
      // 插话（steering）：消息注入正在运行的 run；当前助手气泡定稿，新开占位气泡接后续输出
      function steer(job, text) {
        if (!job.runId) return; // start 往返期间按钮已禁用，兜底
        const convId = job.convId;
        addMessage('user', text);
        recordMessage('user', text);
        clearPrompt();
        // 定稿当前助手气泡：写入本段全文（按 base 切分），刷新重连后顺序保持正确
        convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
        convSetMsgFields(convId, job.asstIndex, { pending: false });
        const vb = bubbleAt(job.asstIndex);
        if (vb) renderMarkdown(vb, job.text.slice(job.base));
        // 新占位气泡：记录 textBase（本气泡在 run 全文中的起点），后续输出切到这里
        const asstIndex = convPushMessage(convId, 'assistant', '');
        addMessage('assistant', '');
        job.base = job.text.length;
        if (job.shown < job.base) job.shown = job.base;
        convSetMsgFields(convId, asstIndex, { pending: true, runId: job.runId, textBase: job.base });
        job.asstIndex = asstIndex;
        job._paintedShown = -1;
        paintJob(job);
        ensureTyping();
        fetch('/api/run/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: job.runId, text }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) restartAsNewRun(job, text); // run 恰好结束 → 降级为新一轮（resume 续接）
          })
          .catch(() => restartAsNewRun(job, text));
      }

      // 插话竞态兜底：run 已在注入前结束 → 把这条消息作为新一轮发出（resume 续接），复用占位气泡
      function restartAsNewRun(job, text) {
        const convId = job.convId;
        // 先关旧流：防止旧 run 的 done 事件把新登记的 job 误终结
        try {
          if (job.es) job.es.close();
        } catch {}
        delete runningJobs[convId];
        const conv = loadConvs().find((x) => x.id === convId);
        const newJob = {
          es: null,
          asstIndex: job.asstIndex,
          convId,
          text: '',
          shown: 0,
          base: 0,
          activities: [],
          todos: [],
          ask: null,
          rev: 0,
          err: false,
          runId: null,
        };
        convSetMsgFields(convId, job.asstIndex, { pending: true, runId: null, textBase: 0 });
        runningJobs[convId] = newJob;
        updateComposerRunning();
        renderConvList();
        paintJob(newJob);
        ensureTyping();
        launchRun(newJob, text, (conv && conv.session) || currentSession, (conv && conv.cwd) || cwd);
      }
```

- [ ] **Step 5: `attachStream` 用 `job.asstIndex`/`job.base` 取代闭包 `asstIndex`**

五处修改（均在 `attachStream` 内）：

1. 重连自建 job 时从持久化 `textBase` 恢复偏移，把：

```js
        if (!job) {
          job = {
            es,
            asstIndex,
            convId,
            text: '',
            shown: 0,
```

改为：

```js
        if (!job) {
          const conv = loadConvs().find((x) => x.id === convId);
          const msg = conv && conv.messages[asstIndex];
          job = {
            es,
            asstIndex,
            convId,
            text: '',
            shown: 0,
            base: (msg && msg.textBase) || 0, // 插话切段后重连：从持久化偏移恢复
```

（对象字面量其余字段不变。）

2. `saveThrottled`，把 `convSetMessage(convId, asstIndex, job.text);` 改为：

```js
              convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
```

3. `replay` 处理器，把 `convSetMessage(convId, asstIndex, job.text);` 改为：

```js
          convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
```

4. `done` 处理器，把：

```js
          convSetMessage(convId, asstIndex, job.text);
          convSetMsgFields(convId, asstIndex, { pending: false });
```

改为：

```js
          convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          convSetMsgFields(convId, job.asstIndex, { pending: false });
```

5. `error` 处理器（`if (e.data)` 分支），把：

```js
            convSetMessage(convId, asstIndex, job.text);
            convSetMsgFields(convId, asstIndex, { pending: false });
```

改为：

```js
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
            convSetMsgFields(convId, job.asstIndex, { pending: false });
```

- [ ] **Step 6: 语法验证**

Run: `node --check public/app.js`
Expected: 无输出（语法通过）。

---

### Task 5: 端到端手工验收

**Files:** 无代码改动。启动服务（`npm start`），浏览器打开 `http://127.0.0.1:3000`。

- [ ] **Step 1: 基础插话**

发起一个长任务（如「通读 src/ 下所有文件并总结架构，最后写一份要点清单」），执行中在输入框再发「总结时顺便统计一下代码行数」。
Expected: 发送按钮可用；用户气泡立即出现，其上方助手气泡定稿，下方新助手气泡继续流式输出；Claude 后续产出体现插话要求（会话 jsonl 中能看到注入的 user 消息）。

- [ ] **Step 2: 刷新重连**

在插话后的输出过程中刷新页面，重新打开该会话。
Expected: 气泡顺序正确（助手段一 → 用户插话 → 助手段二），段二从持久化 `textBase` 偏移续接流式，无重复文本。

- [ ] **Step 3: 竞态兜底**

发一个短任务（如「用一句话介绍这个项目」），在它即将/刚刚结束时快速插话。
Expected: 若 run 已结束，前端自动降级为新一轮（`resume` 续接 session），消息不丢，新气泡正常流式；服务端日志无异常。

- [ ] **Step 4: 审批等待中插话**

「询问」模式下发起会触发写操作的任务，出现审批卡片时先插话再批准。
Expected: 插话不打断审批卡片；批准后 Claude 在后续决策点看到插话内容。

- [ ] **Step 5: 停止按钮回归**

运行中点「停止」。
Expected: run 中断、气泡显示「⏹ 已手动停止」，行为与改动前一致。

- [ ] **Step 6: 回归测试**

Run: `node --test "src/**/*.test.js"`（注：`node --test src/` 在 Node 24/Windows 下会把 src 当模块入口，报 MODULE_NOT_FOUND）
Expected: 全部测试（含既有 runs/history 用例与新增 claude 用例）通过。
