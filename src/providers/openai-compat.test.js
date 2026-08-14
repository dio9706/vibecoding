import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createOpenAiCompatProvider, OPENAI_COMPAT_CAPABILITIES } from './openai-compat.js';
import { streamTextToModelRun } from './openai-compat-model.js';

test('capabilities：stream + agentic/tools/fileIO/permissions=true；resume/rateLimitAware/compaction=false', () => {
  for (const k of ['stream', 'agentic', 'tools', 'fileIO', 'permissions']) {
    assert.equal(OPENAI_COMPAT_CAPABILITIES[k], true, `${k} 应为 true`);
  }
  for (const k of ['resume', 'rateLimitAware', 'compaction']) {
    assert.equal(OPENAI_COMPAT_CAPABILITIES[k], false, `${k} 应为 false`);
  }
});

test('id 为 openai-compat', () => {
  assert.equal(createOpenAiCompatProvider().id, 'openai-compat');
});

test('run：用注入的 modelRun 跑通 loop，返回 {done,abort} 并透出文本', async () => {
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

test('abort：调用 input.abortController.abort（与 claude-agent 命名对齐）', () => {
  let aborted = false;
  const provider = createOpenAiCompatProvider({ buildModelRun: () => () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }) });
  const ac = { abort: () => { aborted = true; } };
  provider.run({ messages: [], abortController: ac }, {}).abort();
  assert.equal(aborted, true);
});

test('真 abort：AbortController 中途打断 streamText → done 静默 resolve({aborted:true})，流被截断', async () => {
  // 真 streamText + 真 AbortController，只 mock 语言模型本体（AI SDK 官方测试替身）。
  // ai@7.0.35 实测：abort 时 fullStream 发 {type:'abort'} part 后干净收流（不抛），
  // 而 finishReason/responseMessages 以 AbortError 拒绝 → agent-loop 的 await finished
  // 抛出后走 signal.aborted 静默收尾分支——本用例钉住这条链。
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          ...Array.from({ length: 40 }, (_, i) => ({ type: 'text-delta', id: '1', delta: 'x' + i })),
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        ],
        chunkDelayInMs: 25, // 慢流：给中途 abort 留窗口
      }),
    }),
  });
  const ac = new AbortController();
  const provider = createOpenAiCompatProvider({
    buildModelRun: (input) => streamTextToModelRun(model, undefined, input.abortController.signal),
  });
  const texts = [];
  let resultHook = null;
  const handle = provider.run(
    { messages: [{ role: 'user', content: 'hi' }], abortController: ac },
    {
      onText: (t) => {
        texts.push(t);
        if (texts.length === 3) handle.abort(); // 流进行中真实中断
      },
      onResult: (r) => (resultHook = r),
    },
  );
  const t0 = Date.now();
  const out = await handle.done;
  assert.equal(out.aborted, true, 'abort 应走静默收尾分支');
  assert.equal(resultHook, null, 'abort 不应触发 onResult（终结由上层 stopRun 负责）');
  assert.ok(texts.length >= 3 && texts.length < 40, `流应被截断（收到 ${texts.length}/40）`);
  assert.ok(Date.now() - t0 < 3000, 'abort 后应快速返回，而非放完整条慢流');
});

test('run：把 input.abortController 透传给 buildModelRun', () => {
  let seenInput = null;
  const provider = createOpenAiCompatProvider({
    buildModelRun: (input) => { seenInput = input; return () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop', responseMessages: [] }) }); },
  });
  const ac = new AbortController();
  provider.run({ messages: [], abortController: ac }, {});
  assert.equal(seenInput.abortController, ac);
});
