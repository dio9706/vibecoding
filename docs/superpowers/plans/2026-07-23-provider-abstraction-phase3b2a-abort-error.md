# Provider 抽象 · Phase 3b-2 片 A（provider abort + 错误通道加固）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Phase 3a 审查标记的两项前置债——非 Claude agent-loop 的失败要发 `onResult({subtype:'error'})`（终结通道对称）、abort 要真实生效（`abortSignal` 穿进 `streamText` + loop 步间检查 + provider 用 `abortController` 修命名）——为片 C 的 `startOpenAiRun` 正确终结/中断打底。

**Architecture:** 全部改在 `src/providers/` 三个文件，`startOpenAiRun`/server.js 不动（那是片 C）。loop 加 `signal` 与 try/catch 错误通道（用注入 fake 离线测）；adapter 接 `abortSignal` 透传 `streamText` + 处理 `fullStream` 的 `error` part；provider 把 `input.abortController.signal` 穿给 adapter、`abort()` 改调 `abortController.abort()`（与 claude-agent 命名对齐）。

**Tech Stack:** Node.js ESM；`node:test` + `node:assert/strict`；`ai@7.0.35` / `ai/test`（`MockLanguageModelV4`）。

## 本期范围
补 3a 审查项：agent-loop 错误通道 + abort；adapter abort 透传 + error part；provider abort 命名。**不含** startOpenAiRun / 路由 / 凭证 CRUD（片 B/C）。

## 文件结构
- Modify `src/providers/agent-loop.js`(+test) — 加 `signal` 步间检查 + try/catch 错误通道（onResult error）。
- Modify `src/providers/openai-compat-model.js`(+test) — `streamTextToModelRun(lm, tools, abortSignal)` / `createOpenAiCompatModelRun({...,abortSignal})` 透传 `abortSignal`；`fullStream` 的 `error` part 抛出。
- Modify `src/providers/openai-compat.js`(+test) — `run` 用 `input.abortController`，把 `.signal` 穿给 adapter，`abort()`→`input.abortController?.abort?.()`。

---

### Task 1: agent-loop 错误通道 + abort 信号检查

**Files:**
- Modify: `src/providers/agent-loop.js`（`runAgentLoop` 参数 + 循环体）
- Test: `src/providers/agent-loop.test.js`（追加 2 用例）

- [ ] **Step 1: 写失败测试** — 在 `src/providers/agent-loop.test.js` 末尾追加：

```js
test('modelRun 抛错 → 发 onResult(error) 且 runAgentLoop reject', async () => {
  let result = null;
  await assert.rejects(
    runAgentLoop(
      { messages: [], modelRun: () => { throw new Error('net down'); }, executeTool: async () => {} },
      { onResult: (r) => { result = r; } },
    ),
    /net down/,
  );
  assert.equal(result.subtype, 'error');
  assert.equal(result.is_error, true);
  assert.match(result.error, /net down/);
});

test('signal 已 abort → 不调用 modelRun、不发 onResult、静默 resolve', async () => {
  let modelCalled = false;
  let resulted = false;
  const r = await runAgentLoop(
    { messages: [], modelRun: () => { modelCalled = true; return { stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }; }, executeTool: async () => {}, signal: { aborted: true } },
    { onResult: () => { resulted = true; } },
  );
  assert.equal(modelCalled, false);
  assert.equal(resulted, false);
  assert.equal(r.aborted, true);
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/providers/agent-loop.test.js"` — Expected: 两个新用例 FAIL（当前无错误通道 / 无 signal 检查），原 6 个 PASS。

- [ ] **Step 3: 写最小实现** — 把 `src/providers/agent-loop.js` 的 `runAgentLoop` 整体替换为：

```js
export async function runAgentLoop({ messages, modelRun, executeTool, maxSteps = 8, signal }, hooks = {}) {
  const convo = Array.isArray(messages) ? messages.slice() : [];
  let lastText = '';
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) break; // 用户中断：不再起新一步
      const { stream, finished } = modelRun(convo);
      let stepText = '';
      for await (const ev of stream) {
        if (ev.type === 'text') {
          stepText += ev.text;
          hooks.onText?.(ev.text);
        } else if (ev.type === 'tool-call') {
          hooks.onActivity?.({ name: ev.toolName, input: ev.input });
        }
      }
      const done = (await finished) || {};
      if (stepText) lastText = stepText;
      if (Array.isArray(done.responseMessages)) convo.push(...done.responseMessages);
      if (done.finishReason !== 'tool-calls') break;
      for (const call of done.toolCalls || []) {
        const decision = hooks.canUseTool ? await hooks.canUseTool(call.toolName, call.input) : { behavior: 'allow' };
        let output;
        if (decision?.behavior === 'allow') {
          try {
            output = await executeTool(call.toolName, call.input);
          } catch (e) {
            output = { error: String(e?.message || e) };
          }
        } else {
          output = { error: decision?.message || '用户拒绝了该操作' };
        }
        convo.push(toToolResultMessage(call, output));
      }
    }
  } catch (e) {
    // 用户中断（abort）走静默收尾——终结由上层 stopRun 负责，不当失败上报
    if (signal?.aborted) return { result: lastText, messages: convo, aborted: true };
    hooks.onResult?.({ subtype: 'error', is_error: true, result: lastText, error: String(e?.message || e) });
    throw e; // 让上层 .done.catch → failRun 广播失败（带消息）
  }
  if (signal?.aborted) return { result: lastText, messages: convo, aborted: true };
  hooks.onResult?.({ subtype: 'success', result: lastText, is_error: false });
  return { result: lastText, messages: convo };
}
```

（`toToolResultMessage` 保持不变。）

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/providers/agent-loop.test.js"` — Expected: PASS（原 6 + 新 2 = 8 tests）。原用例不传 signal → `signal?.aborted` 为 undefined（假）→ 行为与之前逐字一致。

- [ ] **Step 5: 提交**
```bash
git add src/providers/agent-loop.js src/providers/agent-loop.test.js
git commit -m "feat(providers): agent-loop 错误通道(onResult error) + abort 信号检查"
```

---

### Task 2: adapter 透传 abortSignal + 处理 error part

**Files:**
- Modify: `src/providers/openai-compat-model.js`（两个导出函数签名 + 流映射）
- Test: `src/providers/openai-compat-model.test.js`（追加 error-part 用例）

- [ ] **Step 1: 写失败测试** — 在 `src/providers/openai-compat-model.test.js` 末尾追加：

```js
test('streamTextToModelRun：fullStream 的 error part → stream 抛出', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'partial' },
          { type: 'error', error: new Error('provider exploded') },
        ],
      }),
    }),
  });
  const { stream } = streamTextToModelRun(model)([{ role: 'user', content: 'hi' }]);
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } }, /provider exploded/);
});
```

> 说明：若 ai@7 的 `fullStream` error part 形状与上不同（如 `part.error` 非 Error、或 error 事件走 `throw` 而非 part），实现时**对照已安装 `node_modules/ai` 的 `TextStreamPart` 中 `error` 分支类型微调**（`3a` 已确认 `error` 是 `fullStream` 的一种 part），保持"error → stream 抛出"的行为不变，再过测试。

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/providers/openai-compat-model.test.js"` — Expected: 新用例 FAIL（当前 error part 被静默丢弃，stream 正常结束不抛），原用例 PASS。

- [ ] **Step 3: 写最小实现** — 把 `src/providers/openai-compat-model.js` 的两个导出函数替换为：

```js
/** 用一个已构造的 languageModel 生成 modelRun（生产=openai-compatible；测试=MockLanguageModelV4）。
 *  tools 省略即纯对话；abortSignal 透传给 streamText 以支持真实中断。 */
export function streamTextToModelRun(languageModel, tools, abortSignal) {
  return (messages) => {
    const result = streamText({
      model: languageModel,
      messages,
      ...(tools ? { tools } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
    async function* stream() {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') yield { type: 'text', text: part.text };
        else if (part.type === 'tool-call') yield { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
        else if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error?.message || part.error || '模型流错误'));
      }
    }
    const finished = (async () => ({
      finishReason: await result.finishReason,
      toolCalls: await result.toolCalls,
      responseMessages: await result.responseMessages,
    }))();
    return { stream: stream(), finished };
  };
}

/** 生产用：按凭证造 openai-compatible 模型再包成 modelRun。 */
export function createOpenAiCompatModelRun({ apiKey, baseURL, model, tools, abortSignal }) {
  const provider = createOpenAICompatible({ name: 'openai-compat', apiKey, baseURL });
  return streamTextToModelRun(provider(model), tools, abortSignal);
}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/providers/openai-compat-model.test.js"` — Expected: PASS（原 1 + 新 1 = 2 tests）。若 error-part 形状与测试假设不符，按 Step 1 说明对照安装类型微调后再过。

- [ ] **Step 5: 提交**
```bash
git add src/providers/openai-compat-model.js src/providers/openai-compat-model.test.js
git commit -m "feat(providers): adapter 透传 abortSignal + fullStream error part 抛出"
```

---

### Task 3: openai-compat provider 用 abortController（修命名 + 穿信号）

**Files:**
- Modify: `src/providers/openai-compat.js`（`run` 的 abort 与 modelRun 构造）
- Test: `src/providers/openai-compat.test.js`（改 abort 用例 + 加信号透传断言）

- [ ] **Step 1: 改测试** — 在 `src/providers/openai-compat.test.js` 中，把现有 `abort` 测试：

```js
test('abort：调用 input.signal.abort', () => {
  let aborted = false;
  const provider = createOpenAiCompatProvider({ buildModelRun: () => () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }) });
  provider.run({ messages: [], signal: { abort: () => { aborted = true; } } }, {}).abort();
  assert.equal(aborted, true);
});
```

整体替换为：

```js
test('abort：调用 input.abortController.abort（与 claude-agent 命名对齐）', () => {
  let aborted = false;
  const provider = createOpenAiCompatProvider({ buildModelRun: () => () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }) });
  const ac = { abort: () => { aborted = true; } };
  provider.run({ messages: [], abortController: ac }, {}).abort();
  assert.equal(aborted, true);
});

test('run：把 input.abortController.signal 透传给 buildModelRun', () => {
  let seenInput = null;
  const provider = createOpenAiCompatProvider({
    buildModelRun: (input) => { seenInput = input; return () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }); },
  });
  const ac = new AbortController();
  provider.run({ messages: [], abortController: ac }, {});
  assert.equal(seenInput.abortController, ac);
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/providers/openai-compat.test.js"` — Expected: 新的 abortController 用例 FAIL（当前用 `input.signal?.abort?.()`）。

- [ ] **Step 3: 写最小实现** — 在 `src/providers/openai-compat.js` 中，把 `createOpenAiCompatProvider` 里的默认 `buildModelRun` 与 `run` 改为透传 abortController 的 signal、abort 调 abortController：

找到：
```js
  const buildModelRun =
    deps.buildModelRun ||
    ((input) => createOpenAiCompatModelRun({ apiKey: input.apiKey, baseURL: input.baseURL, model: input.model, tools: input.tools }));
```
改为：
```js
  const buildModelRun =
    deps.buildModelRun ||
    ((input) => createOpenAiCompatModelRun({ apiKey: input.apiKey, baseURL: input.baseURL, model: input.model, tools: input.tools, abortSignal: input.abortController?.signal }));
```

找到：
```js
    run(input = {}, hooks = {}) {
      const modelRun = buildModelRun(input);
      const executeTool = input.executeTool || (async () => { throw new Error('openai-compat v1 暂未接入工具执行'); });
      const done = runAgentLoop({ messages: input.messages || [], modelRun, executeTool, maxSteps: input.maxSteps }, hooks);
      return { done, abort: () => input.signal?.abort?.() };
    },
```
改为（loop 传 signal；abort 调 abortController）：
```js
    run(input = {}, hooks = {}) {
      const modelRun = buildModelRun(input);
      const executeTool = input.executeTool || (async () => { throw new Error('openai-compat v1 暂未接入工具执行'); });
      const done = runAgentLoop(
        { messages: input.messages || [], modelRun, executeTool, maxSteps: input.maxSteps, signal: input.abortController?.signal },
        hooks,
      );
      return { done, abort: () => input.abortController?.abort?.() };
    },
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/providers/openai-compat.test.js"` — Expected: PASS（capabilities/id/run/abort/透传 = 5 tests）。

- [ ] **Step 5: 全量 provider 回归 + 语法检查** — Run: `node --test "src/providers/*.test.js" && node --check src/providers/openai-compat.js` — Expected: 全绿（agent-loop 8 + openai-compat-model 2 + openai-compat 5 + registry 5 + claude-agent 5 + index 3 = 28），`node --check` 无输出。

- [ ] **Step 6: 提交**
```bash
git add src/providers/openai-compat.js src/providers/openai-compat.test.js
git commit -m "feat(providers): openai-compat 用 abortController + 透传 signal 到 adapter/loop"
```

---

## 自检（对照 3a/3b 审查遗留）
- 错误通道对称（onResult error）→ Task 1 ✅
- 真实 abort（signal 穿 streamText + loop 步间检查 + provider abortController）→ Task 1+2+3 ✅
- adapter error part 不再吞 → Task 2 ✅
- abort 命名与 claude-agent 对齐（abortController）→ Task 3 ✅
- **行为保真**：agent-loop 原 6 用例不传 signal → 逐字等价；adapter 原 text 用例 abortSignal 省略 → 不变；provider 其余用例不变。

## 占位符扫描：无 TBD；每步含完整代码/命令/预期。Task 2 的"对照安装类型微调 error part"是对外部库的正当核对（已给参考 + 3a 已确认 error 是 fullStream part）。

## 命名一致性：`signal`（AbortSignal，loop/adapter）vs `abortController`（provider input，与 claude-agent 一致）；`abortSignal`（streamText 参数名）。

## 验证命令注意：一律引号 glob `node --test "src/providers/*.test.js"`；不用裸/目录形式。
## 提交纪律：只 add 每 Task 列出文件，不用 `git add -A`；分支 `feat/config-import-export`。
