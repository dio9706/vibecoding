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
