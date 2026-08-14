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

// ── abort 中途的工具循环 ────────────────────────────────────────
// 背景：外层 for(step) 开头有 `if (signal?.aborted) break`，但**内层 toolCalls 循环没有**。
// 一轮返回多个 tool-call 时，用户在第 1 个执行中途点「停止」，第 2 个仍会继续：
//   - 命中 autoAllow → 停止后仍真实执行工具（写文件/发请求的幽灵副作用）
//   - 未命中 → 走 canUseTool → askUser 新建 pending Promise，而 drainAsks 已经跑完且不会再跑
//     → 该 Promise 永不 resolve → runAgentLoop 永不返回 → run-openai 的
//       .finally(() => mcp.close()) 永不执行 → MCP stdio 子进程成孤儿。

test('abort：内层工具循环立即停止，不再执行后续工具', async () => {
  const ac = new AbortController();
  const executed = [];
  const model = recordingModel([
    {
      toolCalls: [
        { toolCallId: 't1', toolName: 'write', input: { n: 1 } },
        { toolCallId: 't2', toolName: 'write', input: { n: 2 } },
        { toolCallId: 't3', toolName: 'write', input: { n: 3 } },
      ],
      finishReason: 'tool-calls',
    },
  ]);
  const r = await runAgentLoop(
    {
      messages: [{ role: 'user', content: 'go' }],
      modelRun: model,
      signal: ac.signal,
      executeTool: async (name, input) => {
        executed.push(input.n);
        if (input.n === 1) ac.abort(); // 第 1 个执行中途用户点了停止
        return 'ok';
      },
    },
    {},
  );
  assert.deepEqual(executed, [1], `停止后不应继续执行工具，实际执行了：${executed}`);
  assert.equal(r.aborted, true);
});

test('abort：内层循环不再询问审批（否则产生永不 resolve 的悬空 ask）', async () => {
  const ac = new AbortController();
  const asked = [];
  const model = recordingModel([
    {
      toolCalls: [
        { toolCallId: 't1', toolName: 'write', input: { n: 1 } },
        { toolCallId: 't2', toolName: 'write', input: { n: 2 } },
      ],
      finishReason: 'tool-calls',
    },
  ]);
  await runAgentLoop(
    {
      messages: [{ role: 'user', content: 'go' }],
      modelRun: model,
      signal: ac.signal,
      executeTool: async () => 'ok',
    },
    {
      canUseTool: async (name, input) => {
        asked.push(input.n);
        if (input.n === 1) ac.abort();
        return { behavior: 'allow' };
      },
    },
  );
  assert.deepEqual(asked, [1], `停止后不应再发审批请求，实际问了：${asked}`);
});

test('abort：被跳过的工具仍补齐 tool-result，会话保持良构（可续跑）', async () => {
  const ac = new AbortController();
  const model = recordingModel([
    {
      toolCalls: [
        { toolCallId: 't1', toolName: 'write', input: { n: 1 } },
        { toolCallId: 't2', toolName: 'write', input: { n: 2 } },
      ],
      finishReason: 'tool-calls',
    },
  ]);
  const r = await runAgentLoop(
    {
      messages: [{ role: 'user', content: 'go' }],
      modelRun: model,
      signal: ac.signal,
      executeTool: async (name, input) => {
        if (input.n === 1) ac.abort();
        return 'ok';
      },
    },
    {},
  );
  // OpenAI 兼容协议要求：带 tool_calls 的 assistant 消息后，每个 toolCallId 都必须有对应结果，
  // 否则下一次请求直接 400。中断也不能留下半截。
  const resultIds = r.messages
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content.map((c) => c.toolCallId));
  assert.deepEqual(resultIds.sort(), ['t1', 't2'], `tool-result 缺失，会话无法续跑：${JSON.stringify(resultIds)}`);
});

// ── onPulse 心跳（看门狗误杀防线）────────────────────────────────
// 背景：run-openai.js:49 传入了 onPulse: () => runPulse(run)，
// 但 agent-loop 全文只用了 onText / onActivity / onResult，**从未调用 hooks.onPulse**。
// 后果：MCP 工具执行超过 15 分钟且期间无文本增量时，run.lastProgressAt 不刷新
// → 看门狗按「静默」abortRun，把正在正常干活的任务误杀。
// Claude 路径靠自己的 runPulse 规避了同类问题，openai 路径一直裸奔。

test('onPulse：工具执行前后都要打心跳（长工具不被看门狗误判为静默）', async () => {
  let pulses = 0;
  const model = recordingModel([
    { toolCalls: [{ toolCallId: 't1', toolName: 'slowTool', input: {} }], finishReason: 'tool-calls' },
    { text: 'done', finishReason: 'stop' },
  ]);
  await runAgentLoop(
    {
      messages: [{ role: 'user', content: 'go' }],
      modelRun: model,
      executeTool: async () => 'ok',
    },
    { onPulse: () => pulses++ },
  );
  assert.ok(pulses > 0, 'onPulse 从未被调用 —— 长工具执行会被看门狗误杀');
});

test('onPulse：每一步都打心跳，步数越多心跳越多', async () => {
  let pulses = 0;
  const model = recordingModel([
    { toolCalls: [{ toolCallId: 'a', toolName: 'x', input: {} }], finishReason: 'tool-calls' },
    { toolCalls: [{ toolCallId: 'b', toolName: 'x', input: {} }], finishReason: 'tool-calls' },
    { text: 'done', finishReason: 'stop' },
  ]);
  await runAgentLoop(
    { messages: [{ role: 'user', content: 'go' }], modelRun: model, executeTool: async () => 'ok' },
    { onPulse: () => pulses++ },
  );
  assert.ok(pulses >= 2, `多步执行应有多次心跳，实际 ${pulses} 次`);
});

test('onPulse：未提供该钩子时不抛异常（可选钩子）', async () => {
  const model = recordingModel([{ text: 'hi', finishReason: 'stop' }]);
  await runAgentLoop({ messages: [], modelRun: model, executeTool: async () => 'ok' }, {});
});
