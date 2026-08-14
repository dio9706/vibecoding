import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAgentProvider, CLAUDE_CAPABILITIES } from './claude-agent.js';

test('capabilities 八项全开', () => {
  for (const k of [
    'agentic', 'tools', 'fileIO', 'resume',
    'stream', 'permissions', 'rateLimitAware', 'compaction',
  ]) {
    assert.equal(CLAUDE_CAPABILITIES[k], true, `${k} 应为 true`);
  }
});

test('id 为 claude-agent', () => {
  const p = createClaudeAgentProvider(() => Promise.resolve());
  assert.equal(p.id, 'claude-agent');
});

test('run 把 prompt 与 opts 原样透传给 runFn，并返回 { done, abort }', async () => {
  let seen = null;
  const ret = Promise.resolve('ok');
  const p = createClaudeAgentProvider((prompt, opts) => {
    seen = { prompt, opts };
    return ret;
  });
  const opts = { cwd: '/tmp', model: 'x' };
  const handle = p.run('hello', opts);
  assert.equal(seen.prompt, 'hello');
  assert.equal(seen.opts, opts); // 同一引用，逐字透传
  assert.ok(handle.done instanceof Promise);
  assert.equal(handle.done, ret); // done 就是 runFn 的返回，未被再包裹
  assert.equal(await handle.done, 'ok'); // resolve 值逐字透传
  assert.equal(typeof handle.abort, 'function');
});

test('abort() 调用 opts.abortController.abort()', () => {
  let aborted = false;
  const ac = { abort: () => { aborted = true; } };
  const p = createClaudeAgentProvider(() => Promise.resolve());
  p.run('x', { abortController: ac }).abort();
  assert.equal(aborted, true);
});

test('abort() 在无 abortController 时不抛', () => {
  const p = createClaudeAgentProvider(() => Promise.resolve());
  assert.doesNotThrow(() => p.run('x', {}).abort());
});
