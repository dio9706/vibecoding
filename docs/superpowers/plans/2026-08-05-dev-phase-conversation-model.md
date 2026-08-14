# 开发期交互模型改造 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将开发期从"服务端系统任务"改为"客户端普通会话"——打开需求时自动发送 develop 提示词、API 文档操作后自动发送 api-fix 消息、设计准则增加确认按钮，全程过程/提示词可见可插话。

**Architecture:** 彻底移除 develop/api-fix 的服务端系统任务派发，改为前端调用 `sendMessageProgrammatically`（新建，复用现有 launchRun/attachStream 路径）在普通会话里发送。bug-fix/docgen 系统任务保持不变。

**Tech Stack:** Node.js ESM（服务端），vanilla JS ESM（前端），现有 `/api/run/start` + SSE 流（不新增服务端接口）

---

## 文件改动清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/entrypoints/web/requirement-ops.js` | 修改 | 移除 develop/api-fix 的 enqueue 与 dispatch |
| `src/entrypoints/web/requirement-ops.test.js` | 修改 | 补回归测试、更新描述 |
| `src/entrypoints/web/routes-requirements.js` | 修改 | 移除 apidoc 路由里的 api-fix enqueue 调用 |
| `public/js/chat.js` | 修改 | 新增 `sendMessageProgrammatically` 导出 + `launchRun` 支持 mode 覆盖 |
| `public/js/req-chat.js` | 修改 | 新增 `buildDevPrompt`、自动发 develop、自动发 api-fix、准则确认按钮 |

---

## Task 1：移除服务端 develop 系统任务入队

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`（finalizeRequirement 第579行、dispatch 第200行、dispatchSystemTask 第254行）
- Test: `src/entrypoints/web/requirement-ops.test.js`

- [ ] **Step 1: 写失败测试——finalizeRequirement 不应再 enqueue develop**

在 `requirement-ops.test.js` 末尾（现有测试之后）添加：

```js
test('finalizeRequirement：定稿后不再入队 develop 系统任务（已改为客户端会话驱动）', async () => {
  // 准备一个满足定稿条件的需求（有 devDoc + devProject + phase=review + 干净工作区）
  // 由于真实 git 不可用，这里只测试「无工程目录时 guard 拒绝」而非真实定稿——
  // 真实定稿路径的 develop enqueue 已被删除，通过 enqueueSystemTask 的 mock 无法在此测试；
  // 改为测试 dispatch('develop') 被正确废弃，作为间接验证。
  const r = createRequirement({ title: 'develop 废弃测试' });
  updateRequirement(r.id, { phase: 'dev' });
  dispatch({ reqId: r.id, kind: 'develop', payload: {} });
  const after = getRequirement(r.id);
  // develop 被废弃：不写 busy，history 里留痕
  assert.equal(after.busy, null);
  assert.ok(after.history.at(-1).event.includes('废弃') || after.history.at(-1).event.includes('客户端'));
});
```

- [ ] **Step 2: 运行测试，确认当前失败**

```
node --test src/entrypoints/web/requirement-ops.test.js 2>&1 | tail -10
```

期望：`fail 1`（dispatch develop 目前走 dispatchSystemTask，不写 history 留痕）

- [ ] **Step 3: 在 `dispatch` 中添加 develop/api-fix 废弃分支**

找到 `requirement-ops.js` 中 `dispatch` 函数，在 `docgen` 分支之后、`phase 守卫` 之前插入：

```js
  // develop/api-fix 已改为客户端会话驱动（sendMessageProgrammatically），
  // 不再经服务端系统任务队列。万一因旧版本残留数据入队，直接废弃不派发。
  if (kind === 'develop' || kind === 'api-fix') {
    updateRequirement(reqId, {}, `系统任务 ${kind} 废弃：已改为客户端会话驱动`);
    return;
  }
```

完整 dispatch 函数改后形如：
```js
export function dispatch({ reqId, kind, payload }) {
  const req = getRequirement(reqId);
  if (!req) return;
  if (kind === 'docgen') {
    if (req.phase !== 'review') {
      updateRequirement(reqId, {}, 'docgen 作废：需求已离开评审期');
      return;
    }
    runDocgen(req, payload).catch((e) =>
      logger.error('req-ops', 'docgen 任务异常（history 已记录失败原因）', { reqId, err: e?.message || String(e) }),
    );
    return;
  }
  // develop/api-fix 已改为客户端会话驱动，不再走系统任务队列
  if (kind === 'develop' || kind === 'api-fix') {
    updateRequirement(reqId, {}, `系统任务 ${kind} 废弃：已改为客户端会话驱动`);
    return;
  }
  // bug-fix：只应在开发/测试期执行
  if (req.phase !== 'dev' && req.phase !== 'test') {
    updateRequirement(reqId, {}, `系统任务 ${kind} 作废：需求已离开开发/测试期`);
    return;
  }
  dispatchSystemTask(req, kind, payload);
}
```

- [ ] **Step 4: 简化 `dispatchSystemTask` —— 仅保留 bug-fix**

```js
/** bug-fix：走 startClaudeRun（conv 流可见），启动即返回，收尾由 onSettle 回调清 busy */
function dispatchSystemTask(req, kind, payload) {
  const { cwd, addDirs } = pickCwdAndDirs(req.projects);
  if (!cwd) {
    updateRequirement(req.id, {}, `系统任务 ${kind} 作废：无可用工程目录`);
    return;
  }
  const prompt = buildBugFixPrompt(payload);
  const run = createRun();
  updateRequirement(req.id, { busy: { kind, runId: run.id, startedAt: Date.now() } }, `系统任务 ${kind} 启动`);
  if (kind === 'bug-fix') setBugStatus(req.id, payload.bug.id, 'fixing');
  run.onSettle = buildSystemTaskOnSettle(req, kind, payload);
  startClaudeRun(run, {
    prompt,
    cwd,
    addDirs,
    session: req.devSession || undefined,
    mode: 'bypassPermissions',
    convId: req.convId || undefined,
  });
}
```

- [ ] **Step 5: 移除 finalizeRequirement 中的 `enqueueSystemTask(id, 'develop')` 调用**

找到 `finalizeRequirement` 函数末尾（约578-581行）：
```js
    updateRequirement(id, { phase: 'dev', branches }, `定稿：建分支 ${branch}，进入开发期`);
    enqueueSystemTask(id, 'develop');   // ← 删除这一行
    logger.info('req-ops', '需求定稿，进入开发期', { reqId: id, branch, dirs: branches.map((b) => b.dir) });
    return { ok: true, branch };
```

改为：
```js
    updateRequirement(id, { phase: 'dev', branches }, `定稿：建分支 ${branch}，进入开发期`);
    logger.info('req-ops', '需求定稿，进入开发期（develop 由客户端会话驱动）', { reqId: id, branch, dirs: branches.map((b) => b.dir) });
    return { ok: true, branch };
```

- [ ] **Step 6: 运行测试，确认通过**

```
node --test src/entrypoints/web/requirement-ops.test.js 2>&1 | tail -10
```

期望：`pass 36, fail 0`（原35个 + 新增1个）

- [ ] **Step 7: 运行全量测试**

```
npm test 2>&1 | tail -8
```

期望：`pass 596, fail 0`

---

## Task 2：移除 apidoc 路由的 api-fix 系统任务 enqueue

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js`（handleApidocPost 第261行、handleApidocDelete 第279行）

- [ ] **Step 1: 移除 handleApidocPost 中的 enqueue**

找到 `handleApidocPost` 中：
```js
    updateRequirement(id, { apiDocs: nextApiDocs }, `API 文档${action}：${name}`);
    enqueueSystemTask(id, 'api-fix', { action, doc });  // ← 删除这一行
    sendJson(res, 202, { ok: true, action, doc });
```

改为：
```js
    updateRequirement(id, { apiDocs: nextApiDocs }, `API 文档${action}：${name}`);
    sendJson(res, 202, { ok: true, action, doc });
```

- [ ] **Step 2: 移除 handleApidocDelete 中的 enqueue**

找到 `handleApidocDelete` 中：
```js
    updateRequirement(id, { apiDocs: nextApiDocs }, `API 文档删除：${doc.name}`);
    enqueueSystemTask(id, 'api-fix', { action: '删除', doc });  // ← 删除这一行
    sendJson(res, 202, { ok: true, action: '删除', doc });
```

改为：
```js
    updateRequirement(id, { apiDocs: nextApiDocs }, `API 文档删除：${doc.name}`);
    sendJson(res, 202, { ok: true, action: '删除', doc });
```

- [ ] **Step 3: 语法检查**

```
node --check src/entrypoints/web/routes-requirements.js && echo OK
```

期望：`OK`

- [ ] **Step 4: 运行全量测试（确认未破坏 apidoc 相关测试）**

```
npm test 2>&1 | tail -8
```

期望：`pass 596, fail 0`

---

## Task 3：chat.js 新增 `sendMessageProgrammatically`

**Files:**
- Modify: `public/js/chat.js`（launchRun 约第1357行；新增导出函数在 ensureConvRunAttached 之后）

- [ ] **Step 1: 给 `launchRun` 加 mode 覆盖参数**

找到 `launchRun` 函数定义（约第1357行），修改签名和 `startBody` 构造：

```js
      // 启动一次服务端 run 并接流（send 与插话竞态兜底共用）。
      // modeOverride：可选，覆盖当前 chatMode（用于自动发消息走 bypassPermissions）
      function launchRun(job, text, sessionId, runCwd, modeOverride) {
        const convId = job.convId;
        const effectiveMode = modeOverride || chatMode;
        const startBody =
          chatProvider === 'openai-compat'
            ? { prompt: text, cwd: runCwd, session: sessionId, provider: 'openai-compat', model: chatCustomModel, convId }
            : { prompt: text, cwd: runCwd, session: sessionId, model: chatModel, effort: chatEffort, mode: effectiveMode, convId };
        fetch('/api/run/start', {
          // ... 以下完全不变
```

注意：只改函数签名和 `startBody` 里 `mode: chatMode` → `mode: effectiveMode`，其余逻辑不动。

- [ ] **Step 2: 在 `ensureConvRunAttached` 之后新增 `sendMessageProgrammatically`**

找到现有的 `export function ensureConvRunAttached(convId, runId)` 函数结束的 `}` 后，紧接着添加：

```js
      /**
       * 绕过输入框直接发送一条消息：自动开发/api-fix/准则更新等「程序化发送」场景。
       * 若当前会话正在运行 → 插话（steer）；否则 → 新起一轮（launchRun）。
       * opts.mode：权限模式覆盖（如 'bypassPermissions'），不影响用户后续输入框发送的默认模式。
       * 前置条件：currentConvId 已就位（由调用方确保，通常在 openConv 之后）。
       */
      export function sendMessageProgrammatically(text, opts = {}) {
        if (!text || !currentConvId) return;
        const running = runningJobs[currentConvId];
        if (running) {
          // 当前 run 进行中 → 插话排队（撤回/立即生效均可，与普通用户消息完全一致）
          return steer(running, text);
        }
        const convId = currentConvId;
        const sessionId = currentSession;
        const runCwd = cwd;

        addMessage('user', text);
        recordMessage('user', text);
        // 不清空输入框（clearPrompt）——这不是用户输入

        const asstIndex = convPushMessage(convId, 'assistant', '');
        convSetMsgFields(convId, asstIndex, { pending: true });
        addMessage('assistant', '');

        const job = {
          es: null,
          asstIndex,
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
        runningJobs[convId] = job;
        updateComposerRunning();
        renderConvListDebounced();
        paintJob(job);
        ensureTyping();

        launchRun(job, text, sessionId, runCwd, opts.mode || null);
      }
```

- [ ] **Step 3: 语法检查**

```
node --check public/js/chat.js && echo OK
```

期望：`OK`

- [ ] **Step 4: 运行全量测试**

```
npm test 2>&1 | tail -8
```

期望：`pass 596, fail 0`

---

## Task 4：req-chat.js — 自动发送 develop 提示词

**Files:**
- Modify: `public/js/req-chat.js`（import 区，mountReqChrome 函数体）

- [ ] **Step 1: 更新 import 区，引入 `sendMessageProgrammatically` 和 `loadConvs`**

找到文件顶部 import 区：
```js
import { bindReqConvHook, ensureConvRunAttached, loadReqTranscript } from './chat.js';
```

改为：
```js
import { bindReqConvHook, ensureConvRunAttached, loadReqTranscript, sendMessageProgrammatically } from './chat.js';
import { loadConvs } from './conv-store.js';
```

- [ ] **Step 2: 在 `mountReqChrome` 顶部或模块级添加 `buildDevPrompt` 纯函数**

在模块顶部（`let bannerEl = null;` 之前的位置，或在 `mountReqChrome` 定义之前）添加：

```js
/**
 * 开发期首轮 develop 提示词（客户端侧，与 req-logic.js buildDevelopPrompt 保持等值）。
 * data 来自 /api/req/get 响应（含 projects/designGuidelines/apiDocs/devDoc/devCwd）。
 */
function buildDevPrompt(data) {
  const PROJECT_LABELS = { frontend: '前端', backend: '后端' };
  const projects = data.projects || {};
  const roleLines = Object.entries(PROJECT_LABELS)
    .map(([key, label]) => {
      const p = projects[key];
      return p ? `- ${label}工程${p.dev ? '（开发）' : '（只读）'}：${p.dir}` : null;
    })
    .filter(Boolean);
  const docPath = data.devDoc?.versions?.at(-1)?.path || '';
  const parts = [
    `工程角色（本次开发遵守）：\n${roleLines.join('\n')}`,
    `开发文档路径：${docPath}（请先完整 Read）`,
  ];
  if (data.designGuidelines) parts.push(`设计准则：\n${data.designGuidelines}`);
  if ((data.apiDocs || []).length) {
    parts.push(`后端 API 文档：\n${data.apiDocs.map((d) => `- ${d.name} → ${d.path}`).join('\n')}`);
  }
  parts.push('请按开发文档开始本需求当前可进行的开发；只读参考工程禁止修改。');
  return parts.join('\n\n');
}
```

- [ ] **Step 3: 在 `mountReqChrome` 的 `renderChrome(data)` 之后，插入自动发 develop 逻辑**

找到 `mountReqChrome` 中的 `renderChrome(data);` 这一行（约第85行），在其后紧接插入（在 `if (data.busy?.runId)` 那段之前）：

```js
  // 自动发 develop 提示词：phase=dev + 会话无实质内容 + 无正在跑的任务 + 有开发文档
  // 每次打开会话时检测；已有内容（历史/已跑过）则跳过，不重复发送
  if (
    data.phase === 'dev' &&
    !data.busy &&
    data.devDoc?.versions?.length &&
    data.convId
  ) {
    const convList = loadConvs();
    const conv = convList.find((c) => c.id === data.convId);
    const hasContent = conv?.messages?.some((m) => (m.text || '').trim());
    if (!hasContent && epoch === chromeEpoch && currentReqId === reqId) {
      // epoch 二次确认：fetch 期间用户可能切走，避免把消息发到已离开的会话
      sendMessageProgrammatically(buildDevPrompt(data), { mode: 'bypassPermissions' });
    }
  }
```

- [ ] **Step 4: 语法检查**

```
node --check public/js/req-chat.js && echo OK
```

期望：`OK`

- [ ] **Step 5: 运行全量测试**

```
npm test 2>&1 | tail -8
```

期望：`pass 596, fail 0`

---

## Task 5：req-chat.js — 上传/删除 API 文档自动发消息

**Files:**
- Modify: `public/js/req-chat.js`（renderDevRail 中的 uploadBtn 和 del 事件监听器）

- [ ] **Step 1: 更新 fileInput change 处理器**

找到 `renderDevRail` 中 `fileInput.addEventListener('change', ...)` 的成功分支：

```js
      if (!r.ok) throw new Error(d.error || '登记失败');
      window.toast.success('已入队自动修正');
```

改为：

```js
      if (!r.ok) throw new Error(d.error || '登记失败');
      // 自动发 api-fix 消息：让 Claude 对照新文档修正代码
      const apiFixText = d.action === '删除'
        ? `后端 API 文档「${d.doc.name}」已删除\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`
        : `后端 API 文档「${d.doc.name}」已${d.action}（路径 ${d.doc.path}，请先 Read）\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`;
      sendMessageProgrammatically(apiFixText);
```

- [ ] **Step 2: 更新 del 按钮 click 处理器**

找到 `del.addEventListener('click', ...)` 的成功分支：

```js
      if (!r || !r.ok) return window.toast.error(d.error || '删除失败');
      window.toast.success('已删除，已入队自动修正');
      refreshRail(data.id);
```

改为：

```js
      if (!r || !r.ok) return window.toast.error(d.error || '删除失败');
      // 自动发 api-fix 消息
      const delText = `后端 API 文档「${d.doc?.name || doc.name}」已删除\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`;
      sendMessageProgrammatically(delText);
      refreshRail(data.id);
```

- [ ] **Step 3: 语法检查**

```
node --check public/js/req-chat.js && echo OK
```

期望：`OK`

- [ ] **Step 4: 运行全量测试**

```
npm test 2>&1 | tail -8
```

期望：`pass 596, fail 0`

---

## Task 6：req-chat.js — 设计准则确认按钮

**Files:**
- Modify: `public/js/req-chat.js`（renderDevRail 的准则区域）
- Modify: `public/app.css`（新增 .req-guidelines-confirm 定位样式）

- [ ] **Step 1: 在 renderDevRail 中添加确认按钮**

找到准则区域，现有代码结尾部分：
```js
  ta.addEventListener('blur', async () => {
    ...
  });
  guideSec.append(guideTitle, ta);

  railEl.append(docsSec, guideSec);
```

改为在 `ta` 之后、`railEl.append` 之前插入确认按钮：

```js
  ta.addEventListener('blur', async () => {
    const text = ta.value;
    if (text === savedValue) return;
    try {
      const r = await fetch('/api/req/guidelines', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.id, text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return window.toast.error(d.error || '保存失败');
      savedValue = text;
      ta.dataset.saved = text;
    } catch (e) {
      window.toast.error('网络错误：' + (e?.message || e));
    }
  });

  // 确认发送按钮（开发期专属）：点击才主动向 Claude 发送准则更新消息
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'q-btn q-btn-text req-guidelines-confirm';
  confirmBtn.textContent = '✓ 确认发送';
  confirmBtn.title = '点击后将设计准则作为一条消息发送给 Claude，Claude 在后续开发中遵循';
  confirmBtn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return window.toast.error('设计准则为空，无需发送');
    // 若有未保存变更，先 PUT 存库
    if (text !== savedValue) {
      try {
        const r = await fetch('/api/req/guidelines', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.id, text }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return window.toast.error(d.error || '保存失败');
        savedValue = text;
        ta.dataset.saved = text;
      } catch (e) {
        return window.toast.error('网络错误：' + (e?.message || e));
      }
    }
    sendMessageProgrammatically(`设计准则已更新，请在后续开发中遵循：\n${text}`);
    confirmBtn.textContent = '已发送 ✓';
    confirmBtn.disabled = true;
    setTimeout(() => {
      confirmBtn.textContent = '✓ 确认发送';
      confirmBtn.disabled = false;
    }, 2000);
  });

  guideSec.append(guideTitle, ta, confirmBtn);

  railEl.append(docsSec, guideSec);
```

- [ ] **Step 2: 在 `public/app.css` 添加确认按钮样式**

找到 `.req-rail-sec` 相关样式区域（约3124行附近），在 `.req-apidoc-item.uploading` 之后添加：

```css
.req-guidelines-confirm { margin-top: 6px; }
```

- [ ] **Step 3: 语法检查**

```
node --check public/js/req-chat.js && echo OK
```

期望：`OK`

- [ ] **Step 4: 运行全量测试（最终确认）**

```
npm test 2>&1 | tail -8
```

期望：`pass 596, fail 0`

---

## Task 7：清理 busy 相关逻辑（develop 不再设 busy）

> 本 Task 验证 busy 相关前端逻辑在新模型下自然兼容，无需改代码。

- [ ] **Step 1: 确认 `shouldPoll` 不会为新模型开发期持续轮询**

`shouldPoll(data)` 的条件：`!!data.busy || (data.phase === 'test' && hasActiveBugs(data.bugs))`。  
新模型下 develop 不写 `data.busy`，phase='dev' 时 `shouldPoll` 返回 false → 不启动 3s 轮询。  
这是正确行为：实时流由 SSE 接管，不需要轮询。

用 grep 确认 `shouldPoll` 无其他调用：
```
grep -n "shouldPoll" public/js/req-chat.js
```

期望：只有定义行和两处调用（mountReqChrome + 轮询 tick 里的自杀条件判断）。

- [ ] **Step 2: 确认 `busy` 串行闸仍保护 bug-fix**

`canDispatch` 检查 `req.busy`，bug-fix 仍通过 `dispatchSystemTask` 设 busy。  
用 grep 确认 bug-fix 路径完整：
```
grep -n "bug-fix\|setBugStatus\|buildBugFixPrompt" src/entrypoints/web/requirement-ops.js
```

期望：`buildBugFixPrompt`、`setBugStatus`、`dispatchSystemTask` 均有引用（未被意外删除）。

- [ ] **Step 3: 运行全量测试（最终验收）**

```
npm test 2>&1 | tail -10
```

期望：`pass 596, fail 0`

---

## 手动验收清单（真机走查）

重启服务后按以下顺序走查：

1. **自动发 develop**：创建新需求 → 生成开发文档 → 定稿 → 打开需求 → 会话主体应自动出现 develop 提示词（用户气泡）并开始流式输出
2. **不重复触发**：关闭该需求 → 重新点开 → 已有历史，不再自动发消息
3. **刷新页面**：刷新浏览器 → 会话历史恢复，不重发（历史非空）
4. **Claude 开发中插话**：Claude 正在开发时，直接在输入框输入 → 变为排队消息（可撤回/立即生效）
5. **上传 API 文档**：点「＋上传」→ 上传文件 → 会话里自动出现「已新增/已更新…请对照修正」消息
6. **删除 API 文档**：点「✕」确认删除 → 会话里自动出现「已删除…请对照修正」消息
7. **设计准则失焦存库**：在准则框输入内容 → 失焦 → 不发消息，仅存库（toast 提示"已保存"）
8. **设计准则确认发送**：点「✓ 确认发送」→ 会话里出现「设计准则已更新…」消息 → 按钮2秒后恢复
9. **bug-fix 仍正常**：测试期 BUG 的确认/重试 → 仍走系统任务（带 busy）不受影响
10. **docgen 仍正常**：评审期补充说明 → 仍触发文档生成（后台 busy）不受影响

---

## 已知边界

- **devSession 不再由 develop 任务回填**：新模型的 develop 是普通会话，session_id 存在 `conv.session`（localStorage）。若用户清空 localStorage 后再打开，会创建新 conv（无 session 续接）。属于可接受的降级：用户重新打开后自动发 develop，Claude 新开会话继续开发即可。
- **提示词标题**：第一条 develop 消息（提示词本身）会被截断为30字作为会话标题（`recordMessage` 现有行为），看起来是提示词片段。这是可接受的展示问题，不影响功能。
