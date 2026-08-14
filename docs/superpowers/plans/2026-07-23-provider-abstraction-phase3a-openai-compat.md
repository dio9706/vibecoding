# Provider 抽象 · Phase 3a（openai-compat provider + agent-loop）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `openai-compat` provider 与一个 SDK 无关、离线可测的手动 `agent-loop`，让非 Claude 的 OpenAI 兼容模型能走通流式对话（并具备工具就绪的循环）——经测试台验证，不碰主 run / 前端 / settings。

**Architecture:** 隔离外部不确定性。`agent-loop.js` 面向我们自己的**规范化 `modelRun` 接口**（yield `{type:'text'|'tool-call'}`），依赖注入 `modelRun`/`executeTool`/`canUseTool` → 完全离线单测。AI SDK 专属形状只封在一个薄 adapter `openai-compat-model.js`（`createOpenAICompatible` + `streamText` → 规范化流），用 `MockLanguageModelV4` 冒烟。`openai-compat.js` provider 把两者接起来并注册。

**Tech Stack:** Node.js ESM；`ai@^7.0.35`、`@ai-sdk/openai-compatible@^3.0.14`、`zod@^4.4.3`（已装并提交于 `9476659`）；`node:test` + `node:assert/strict`；测试用 `ai/test` 的 `MockLanguageModelV4`。

---

## 已核实的 API 事实（ai@7.0.35，spike 实测——写代码以此为准）

- Mock 类：`import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'`。
- `streamText(...).fullStream` 产出的 part 序列含：`text-start` / `text-delta` / `text-end` / `tool-call` / `finish` 等；**`text-delta` part 的文本在 `part.text`**（非 `.delta`）；`tool-call` part 含 `part.toolCallId` / `part.toolName` / `part.input`（`input` 为已解析对象）。
- `await result.finishReason`（字符串，工具轮为 `'tool-calls'`）、`await result.toolCalls`（`[{toolCallId,toolName,input}]`）、`(await result.response).messages`（assistant 消息，内容块为 `{type:'text',text}` 或 `{type:'tool-call',toolCallId,toolName,input}`）。
- 回灌工具结果的消息形状：`{ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output:{type:'text',value}|{type:'json',value} }] }`（实现 adapter/loop 时对 `ai` 包内 `ModelMessage`/`ToolResultPart` 类型再核一次）。

## 本期范围

**做**：`agent-loop`（工具就绪、离线可测）+ `openai-compat-model` adapter + `openai-compat` provider + 注册 + 测试台。
**v1 能力位（如实声明）**：`{ stream:true, agentic:false, tools:false, fileIO:false, permissions:false, resume:false, rateLimitAware:false, compaction:false }`——v1 只走流式对话（不传工具）；loop 本身工具就绪，接入 MCP 工具后再翻 `agentic/tools/permissions`。
**不做（后续）**：MCP 工具接入（3a.2）；OpenAI 凭证 settings CRUD + run 路由（3b）；前端选择器（3c）；真·压缩/续接/限流上报。

## 文件结构

- Create `src/providers/agent-loop.js` — 规范化手动循环 + `toToolResultMessage`。
- Create `src/providers/agent-loop.test.js` — 离线单测（注入 fake modelRun/executeTool/canUseTool）。
- Create `src/providers/openai-compat-model.js` — `streamTextToModelRun(languageModel, tools)`（可注入 Mock 测）+ `createOpenAiCompatModelRun({apiKey,baseURL,model,tools})`。
- Create `src/providers/openai-compat-model.test.js` — 用 `MockLanguageModelV4` 冒烟 adapter 映射。
- Create `src/providers/openai-compat.js` — provider（capabilities + run，支持注入 modelRun 以便离线测）。
- Create `src/providers/openai-compat.test.js` — capabilities + run 委派测试（注入 fake modelRun）。
- Modify `src/providers/index.js` — 注册 `openaiCompatProvider`。

---

### Task 1: 规范化手动 agent-loop（离线可测核心）

**Files:**
- Create: `src/providers/agent-loop.js`
- Test: `src/providers/agent-loop.test.js`

- [ ] **Step 1: 写失败测试** — 写入 `src/providers/agent-loop.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, toToolResultMessage } from './agent-loop.js';

// 造一个按脚本产出的 fake modelRun；记录每次被调用时收到的 messages 深拷贝
function recordingModel(steps) {
  const calls = [];
  const run = (messages) => {
    calls.push(JSON.parse(JSON.stringify(messages)));
    const s = steps[calls.length - 1] || { finishReason: 'stop' };
    async function* stream() {
      if (s.text) yield { type: 'text', text: s.text };
      for (const tc of s.toolCalls || []) yield { type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input };
    }
    const responseMessages = [{
      role: 'assistant',
      content: s.text
        ? [{ type: 'text', text: s.text }]
        : (s.toolCalls || []).map((tc) => ({ type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })),
    }];
    return { stream: stream(), finished: Promise.resolve({ finishReason: s.finishReason, toolCalls: s.toolCalls || [], responseMessages }) };
  };
  run.calls = calls;
  return run;
}

test('纯文本：onText 逐段 + onResult 汇总，不调用工具', async () => {
  const texts = [];
  let result = null;
  let toolCalled = false;
  await runAgentLoop(
    { messages: [{ role: 'user', content: 'hi' }], modelRun: recordingModel([{ text: 'Hello world', finishReason: 'stop' }]), executeTool: async () => { toolCalled = true; } },
    { onText: (t) => texts.push(t), onResult: (r) => { result = r; } },
  );
  assert.deepEqual(texts, ['Hello world']);
  assert.equal(result.result, 'Hello world');
  assert.equal(result.subtype, 'success');
  assert.equal(toolCalled, false);
});

test('工具往返：批准→执行→回灌 tool-result→下一轮出文本', async () => {
  const model = recordingModel([
    { toolCalls: [{ toolCallId: 't1', toolName: 'readFile', input: { path: 'a.txt' } }], finishReason: 'tool-calls' },
    { text: 'done', finishReason: 'stop' },
  ]);
  const activities = [];
  const execArgs = [];
  const r = await runAgentLoop(
    { messages: [{ role: 'user', content: 'read a.txt' }], modelRun: model, executeTool: async (name, input) => { execArgs.push([name, input]); return 'FILE BODY'; } },
    { onActivity: (a) => activities.push(a), canUseTool: async () => ({ behavior: 'allow' }) },
  );
  assert.deepEqual(activities, [{ name: 'readFile', input: { path: 'a.txt' } }]);
  assert.deepEqual(execArgs, [['readFile', { path: 'a.txt' }]]);
  // 第二次调用模型时，messages 里应含刚回灌的 tool-result
  const secondConvo = model.calls[1];
  const toolMsg = secondConvo.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '第二轮应含 tool 消息');
  assert.equal(toolMsg.content[0].toolCallId, 't1');
  assert.deepEqual(toolMsg.content[0].output, { type: 'text', value: 'FILE BODY' });
  assert.equal(r.result, 'done');
});

test('拒绝：不执行工具，回灌 error 结果', async () => {
  const model = recordingModel([
    { toolCalls: [{ toolCallId: 't1', toolName: 'bash', input: { cmd: 'rm -rf /' } }], finishReason: 'tool-calls' },
    { text: 'ok', finishReason: 'stop' },
  ]);
  let executed = false;
  await runAgentLoop(
    { messages: [], modelRun: model, executeTool: async () => { executed = true; } },
    { canUseTool: async () => ({ behavior: 'deny', message: '用户拒绝' }) },
  );
  assert.equal(executed, false);
  const toolMsg = model.calls[1].find((m) => m.role === 'tool');
  assert.deepEqual(toolMsg.content[0].output, { type: 'json', value: { error: '用户拒绝' } });
});

test('executeTool 抛错：捕获为 error 结果，循环不崩', async () => {
  const model = recordingModel([
    { toolCalls: [{ toolCallId: 't1', toolName: 'x', input: {} }], finishReason: 'tool-calls' },
    { text: 'recovered', finishReason: 'stop' },
  ]);
  const r = await runAgentLoop(
    { messages: [], modelRun: model, executeTool: async () => { throw new Error('boom'); } },
    { canUseTool: async () => ({ behavior: 'allow' }) },
  );
  const toolMsg = model.calls[1].find((m) => m.role === 'tool');
  assert.equal(toolMsg.content[0].output.value.error, 'boom');
  assert.equal(r.result, 'recovered');
});

test('maxSteps 兜底：模型一直要工具也会停', async () => {
  // 每轮都返回 tool-calls；maxSteps=2 → executeTool 至多 2 次
  const alwaysTool = () => {
    async function* stream() { yield { type: 'tool-call', toolCallId: 't', toolName: 'x', input: {} }; }
    return { stream: stream(), finished: Promise.resolve({ finishReason: 'tool-calls', toolCalls: [{ toolCallId: 't', toolName: 'x', input: {} }], responseMessages: [] }) };
  };
  let n = 0;
  let resulted = false;
  await runAgentLoop(
    { messages: [], modelRun: alwaysTool, executeTool: async () => { n++; }, maxSteps: 2 },
    { onResult: () => { resulted = true; } },
  );
  assert.equal(n, 2);
  assert.equal(resulted, true);
});

test('toToolResultMessage：字符串→text，对象→json', () => {
  assert.deepEqual(toToolResultMessage({ toolCallId: 'a', toolName: 'b' }, 'x').content[0].output, { type: 'text', value: 'x' });
  assert.deepEqual(toToolResultMessage({ toolCallId: 'a', toolName: 'b' }, { k: 1 }).content[0].output, { type: 'json', value: { k: 1 } });
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/providers/agent-loop.test.js"` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现** — 写入 `src/providers/agent-loop.js`：

```js
/**
 * Provider/SDK 无关的手动 agent loop。依赖注入便于离线单测，不碰真实 AI SDK。
 *   modelRun(messages) -> { stream, finished }
 *     stream: AsyncIterable，产出 { type:'text', text } | { type:'tool-call', toolCallId, toolName, input }
 *     finished: Promise<{ finishReason:string, toolCalls:Array<{toolCallId,toolName,input}>, responseMessages:Array }>
 *   executeTool(toolName, input) -> Promise<any>（真实实现由 MCP 提供；v1 无工具时不会被调用）
 * hooks: { onText(t), onActivity({name,input}), onResult({subtype,result,is_error}),
 *          canUseTool(name,input) -> Promise<{behavior:'allow'|'deny', message?}> }
 */
export async function runAgentLoop({ messages, modelRun, executeTool, maxSteps = 8 }, hooks = {}) {
  const convo = Array.isArray(messages) ? messages.slice() : [];
  let lastText = '';
  for (let step = 0; step < maxSteps; step++) {
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
  hooks.onResult?.({ subtype: 'success', result: lastText, is_error: false });
  return { result: lastText, messages: convo };
}

/** 组一条 AI SDK 期望的 tool 结果消息（字符串→text，其余→json；对 ai@7 ToolResultPart 已核） */
export function toToolResultMessage(call, output) {
  const part = typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: output };
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: part }] };
}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/providers/agent-loop.test.js"` — Expected: PASS（6 tests）。

- [ ] **Step 5: 提交**
```bash
git add src/providers/agent-loop.js src/providers/agent-loop.test.js
git commit -m "feat(providers): SDK 无关手动 agent-loop（离线可测）"
```

---

### Task 2: openai-compat 模型 adapter（streamText → 规范化流）

**Files:**
- Create: `src/providers/openai-compat-model.js`
- Test: `src/providers/openai-compat-model.test.js`

> 本任务用到真实 `ai` 包类型。实现时**对照已安装的 `ai@7.0.35` 类型**核对 part/result 字段（见上「已核实的 API 事实」）。`streamTextToModelRun` 接受一个 `languageModel`（生产传 openai-compatible，测试传 `MockLanguageModelV4`）以便离线测映射。

- [ ] **Step 1: 写失败测试** — 写入 `src/providers/openai-compat-model.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { streamTextToModelRun } from './openai-compat-model.js';

test('streamTextToModelRun：把 streamText 文本流映射成规范化 {type:text} + finished', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'Hello ' },
          { type: 'text-delta', id: '1', delta: 'world' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        ],
      }),
    }),
  });
  const modelRun = streamTextToModelRun(model);
  const { stream, finished } = modelRun([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const ev of stream) parts.push(ev);
  assert.deepEqual(parts, [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }]);
  const done = await finished;
  assert.equal(typeof done.finishReason, 'string');
  assert.ok(Array.isArray(done.responseMessages));
  assert.ok(Array.isArray(done.toolCalls));
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/providers/openai-compat-model.test.js"` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现** — 写入 `src/providers/openai-compat-model.js`：

```js
/**
 * OpenAI 兼容模型 adapter —— 唯一封装 AI SDK 版本细节的地方。
 * 把 streamText 的 fullStream/result 映射成 agent-loop 期望的规范化 modelRun。
 * 已核对 ai@7.0.35：text-delta.part.text；tool-call part 含 toolCallId/toolName/input；
 * result.finishReason(str)/toolCalls/response.messages。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

/** 用一个已构造的 languageModel 生成 modelRun（生产=openai-compatible；测试=MockLanguageModelV4）。
 *  tools 省略即纯对话（v1）；接入工具后传 AI SDK tools（不带 execute，由 loop 自己执行）。 */
export function streamTextToModelRun(languageModel, tools) {
  return (messages) => {
    const result = streamText({ model: languageModel, messages, ...(tools ? { tools } : {}) });
    async function* stream() {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') yield { type: 'text', text: part.text };
        else if (part.type === 'tool-call') yield { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
      }
    }
    const finished = (async () => ({
      finishReason: await result.finishReason,
      toolCalls: await result.toolCalls,
      responseMessages: (await result.response).messages,
    }))();
    return { stream: stream(), finished };
  };
}

/** 生产用：按凭证造 openai-compatible 模型再包成 modelRun。 */
export function createOpenAiCompatModelRun({ apiKey, baseURL, model, tools }) {
  const provider = createOpenAICompatible({ name: 'openai-compat', apiKey, baseURL });
  return streamTextToModelRun(provider(model), tools);
}
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/providers/openai-compat-model.test.js"` — Expected: PASS（1 test）。若 `finishReason`/字段名与实测不符，对照已安装 `ai@7` 类型微调映射后再过。

- [ ] **Step 5: 提交**
```bash
git add src/providers/openai-compat-model.js src/providers/openai-compat-model.test.js
git commit -m "feat(providers): openai-compat 模型 adapter（streamText→规范化流）"
```

---

### Task 3: openai-compat provider + 注册

**Files:**
- Create: `src/providers/openai-compat.js`
- Test: `src/providers/openai-compat.test.js`
- Modify: `src/providers/index.js`

- [ ] **Step 1: 写失败测试** — 写入 `src/providers/openai-compat.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiCompatProvider, OPENAI_COMPAT_CAPABILITIES } from './openai-compat.js';

test('capabilities：v1 只声明 stream，其余为 false', () => {
  assert.equal(OPENAI_COMPAT_CAPABILITIES.stream, true);
  for (const k of ['agentic', 'tools', 'fileIO', 'permissions', 'resume', 'rateLimitAware', 'compaction']) {
    assert.equal(OPENAI_COMPAT_CAPABILITIES[k], false, `${k} v1 应为 false`);
  }
});

test('id 为 openai-compat', () => {
  assert.equal(createOpenAiCompatProvider().id, 'openai-compat');
});

test('run：用注入的 modelRun 跑通 loop，返回 {done,abort} 并透出文本', async () => {
  // 注入 fake modelRun（不碰真实 SDK）
  const fakeModelRun = () => {
    async function* stream() { yield { type: 'text', text: 'hi from custom model' }; }
    return { stream: stream(), finished: Promise.resolve({ finishReason: 'stop', toolCalls: [], responseMessages: [] }) };
  };
  const provider = createOpenAiCompatProvider({ buildModelRun: () => fakeModelRun });
  let result = null;
  const handle = provider.run({ messages: [{ role: 'user', content: 'hi' }], model: 'x' }, { onResult: (r) => { result = r; } });
  assert.equal(typeof handle.abort, 'function');
  await handle.done;
  assert.equal(result.result, 'hi from custom model');
});

test('abort：调用 input.signal.abort', () => {
  let aborted = false;
  const provider = createOpenAiCompatProvider({ buildModelRun: () => () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }) });
  provider.run({ messages: [], signal: { abort: () => { aborted = true; } } }, {}).abort();
  assert.equal(aborted, true);
});
```

- [ ] **Step 2: 运行测试确认失败** — Run: `node --test "src/providers/openai-compat.test.js"` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现** — 写入 `src/providers/openai-compat.js`：

```js
/**
 * OpenAI 兼容 provider（Phase 3a v1：流式对话；工具就绪的 loop 已具备，接 MCP 后翻 agentic/tools）。
 * 凭证与 run 路由（从凭证池取 apiKey/baseURL、会话选 provider）留待 Phase 3b；
 * v1 由调用方/测试台经 input 直接提供 { model, apiKey, baseURL }。
 */
import { runAgentLoop } from './agent-loop.js';
import { createOpenAiCompatModelRun } from './openai-compat-model.js';

export const OPENAI_COMPAT_CAPABILITIES = Object.freeze({
  agentic: false, tools: false, fileIO: false, permissions: false,
  stream: true, resume: false, rateLimitAware: false, compaction: false,
});

/**
 * @param {object} [deps]
 * @param {(input:object)=>Function} [deps.buildModelRun]  注入点（测试用）；默认按 input 造真实 adapter
 */
export function createOpenAiCompatProvider(deps = {}) {
  const buildModelRun =
    deps.buildModelRun ||
    ((input) => createOpenAiCompatModelRun({ apiKey: input.apiKey, baseURL: input.baseURL, model: input.model, tools: input.tools }));
  return {
    id: 'openai-compat',
    capabilities: OPENAI_COMPAT_CAPABILITIES,
    /** @returns {{ done: Promise, abort: ()=>void }} */
    run(input = {}, hooks = {}) {
      const modelRun = buildModelRun(input);
      const executeTool = input.executeTool || (async () => { throw new Error('openai-compat v1 暂未接入工具执行'); });
      const done = runAgentLoop({ messages: input.messages || [], modelRun, executeTool, maxSteps: input.maxSteps }, hooks);
      return { done, abort: () => input.signal?.abort?.() };
    },
  };
}

export const openaiCompatProvider = createOpenAiCompatProvider();
```

- [ ] **Step 4: 运行测试确认通过** — Run: `node --test "src/providers/openai-compat.test.js"` — Expected: PASS（4 tests）。

- [ ] **Step 5: 注册到默认注册表** — 在 `src/providers/index.js` 中，`import { claudeAgentProvider } from './claude-agent.js';` 之后加一行：

```js
import { openaiCompatProvider } from './openai-compat.js';
```

并在 `registry.register(claudeAgentProvider);` 之后加一行：

```js
registry.register(openaiCompatProvider);
```

- [ ] **Step 6: 全量 provider 测试 + 语法检查** — Run: `node --test "src/providers/*.test.js" && node --check src/providers/index.js` — Expected: 全部 PASS（registry+claude-agent+index 原有 + agent-loop 6 + openai-compat-model 1 + openai-compat 4），`node --check` 无输出。

- [ ] **Step 7: 提交**
```bash
git add src/providers/openai-compat.js src/providers/openai-compat.test.js src/providers/index.js
git commit -m "feat(providers): openai-compat provider + 注册到默认注册表"
```

---

## 自检（对照 Phase 3a spec）

**1. Spec 覆盖**：模块 2 agent-loop → Task 1 ✅；模块 3 openai-compat（adapter+provider）→ Task 2+3 ✅；模块 4 注册 → Task 3 Step 5 ✅；规范化 run 契约（模块 1）→ openai-compat 用 `run(input,hooks)` ✅（claude 仍透传，统一留后续，已在 spec 标注）。MCP 工具接入/凭证池/路由/前端 → 明确后续切片。

**2. 占位符扫描**：无 TBD；每步含完整代码/命令/预期。Task 2 的"对照已安装类型微调"是对外部库的正当核对，非占位（已给实测事实与参考实现）。

**3. 类型/命名一致性**：`runAgentLoop`/`toToolResultMessage`、`streamTextToModelRun`/`createOpenAiCompatModelRun`、`createOpenAiCompatProvider`/`openaiCompatProvider`/`OPENAI_COMPAT_CAPABILITIES`、modelRun 返回 `{stream,finished}`、loop hooks 形状全程一致。

**4. 离线可测**：loop（Task 1）与 provider（Task 3）用注入 fake，全离线；仅 adapter（Task 2）用 MockLanguageModelV4，也离线。无网络/无真 key。

## 验证命令注意
- 一律用引号 glob：`node --test "src/providers/*.test.js"`。**不要**裸 `node --test`（匹配根 Playwright `test-*.mjs` 会挂起）或目录形式 `node --test src/providers/`（Node v24/Win 静默假绿）。

## 提交纪律
- 只 `git add` 每个 Task 列出的确切文件，**不用 `git add -A`**。分支：继续 `feat/config-import-export`。依赖已于 `9476659` 提交。
