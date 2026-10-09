import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
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

// ── 工具调用映射 + 校验结论（2026-09-30 按 ai@7 实测补）──────────────────
// 实测事实：finishReason 是对象形态 { unified, raw }；zod 形态的 inputSchema 会被 AI SDK
// 校验，不匹配时调用带 invalid:true，且 responseMessages 里自动补一条 error 结果。

test('工具调用映射：合法调用 input 为对象；unified finishReason 透传到 finished', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: JSON.stringify({ path: 'a.txt' }) },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
  const tools = { Read: { description: 'r', inputSchema: z.object({ path: z.string() }) } };
  const { stream, finished } = streamTextToModelRun(model, tools)([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const p of stream) parts.push(p);
  assert.deepEqual(parts, [
    { type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: { path: 'a.txt' }, invalid: false },
  ]);
  const done = await finished;
  assert.equal(done.finishReason, 'tool-calls');
  assert.equal(done.toolCalls.length, 1);
});

test('工具调用映射：schema 不匹配 → invalid=true + errorText；AI SDK 已自带 error 结果', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'tool-call', toolCallId: 't2', toolName: 'Read', input: JSON.stringify({ path: 123 }) },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
  const tools = { Read: { description: 'r', inputSchema: z.object({ path: z.string() }) } };
  const { stream, finished } = streamTextToModelRun(model, tools)([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const p of stream) parts.push(p);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].invalid, true);
  assert.match(parts[0].errorText, /Invalid input|Type validation failed/);
  const done = await finished;
  assert.equal(done.toolCalls[0].invalid, true);
  const toolMsg = done.responseMessages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'AI SDK 应为无效调用自动生成 error 结果（loop 不得再追加第二条）');
});

// ── system 消息拆分（ai@7 硬约束回归）──────────────────────────
// 2026-10-08 P3 真端点冒烟实锤：生产路径（run-openai 的 modelMessages）把 system 放在 messages
// 首条，ai@7 的 streamText 直接抛 InvalidPromptError（「System messages are not allowed...
// Use the instructions option instead」）——真实模型调用必失败，此前单测用 mock 且从未带 system 形态而漏网。
test('system 消息：拆到 instructions，不触发 InvalidPromptError，且确实到达模型', async () => {
  let seenPromptRoles = null;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seenPromptRoles = (options.prompt || []).map((m) => m.role);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      };
    },
  });
  const { stream, finished } = streamTextToModelRun(model)([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'hi' },
  ]);
  const parts = [];
  for await (const p of stream) parts.push(p);
  assert.deepEqual(parts, [{ type: 'text', text: 'ok' }]);
  await finished;
  assert.deepEqual(seenPromptRoles, ['system', 'user'], 'instructions 必须真的进了模型提示词');
});
