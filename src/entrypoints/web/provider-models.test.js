/**
 * 模型列表拉取运行时单测：全部注入 fetchImpl，零网络。
 * 覆盖：请求形状（URL/头/信号）、无 key 免鉴权、错误人话化、响应上限（text 回落与流式两条路）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProviderModels } from './provider-models.js';

const okRes = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

test('fetchProviderModels：成功 — 拼 /models、GET、Bearer、带超时信号、解析出列表', async () => {
  let seen = null;
  const models = await fetchProviderModels({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return okRes({ object: 'list', data: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }] });
    },
  });
  assert.deepEqual(models, [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }]);
  assert.equal(seen.url, 'https://api.deepseek.com/v1/models');
  assert.equal(seen.opts.method, 'GET');
  assert.equal(seen.opts.headers.Authorization, 'Bearer sk-test');
  assert.ok(seen.opts.signal, '带 AbortSignal.timeout 信号');
});

test('fetchProviderModels：无 key（本地端点）不发 Authorization', async () => {
  let seen = null;
  await fetchProviderModels({
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKey: '   ',
    fetchImpl: async (url, opts) => {
      seen = opts;
      return okRes({ data: [] });
    },
  });
  assert.equal('Authorization' in seen.headers, false);
});

test('fetchProviderModels：非法 baseURL 直接抛错且不发请求', async () => {
  let called = false;
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'ftp://x/v1', fetchImpl: async () => { called = true; } }),
    /baseURL 无效/,
  );
  assert.equal(called, false);
});

test('fetchProviderModels：错误人话化 — 401/403 鉴权、404 无端点、超时、网络', async () => {
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'https://a.com/v1', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /鉴权失败（HTTP 401）/,
  );
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'https://a.com/v1', fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /无 \/models 端点/,
  );
  await assert.rejects(
    () => fetchProviderModels({
      baseURL: 'https://a.com/v1',
      fetchImpl: async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; },
    }),
    /请求超时/,
  );
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'https://a.com/v1', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
    /无法连接/,
  );
});

test('fetchProviderModels：坏 JSON / 无法识别形状 / 响应过大（text 回落路径）', async () => {
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'https://a.com/v1', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>oops</html>' }) }),
    /不是合法 JSON/,
  );
  await assert.rejects(
    () => fetchProviderModels({ baseURL: 'https://a.com/v1', fetchImpl: async () => okRes({ hello: 1 }) }),
    /无法识别/,
  );
  await assert.rejects(
    () => fetchProviderModels({
      baseURL: 'https://a.com/v1',
      maxBytes: 8,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'x'.repeat(50) }] }) }),
    }),
    /响应过大/,
  );
});

test('fetchProviderModels：流式读取路径同样有上限（有 body.getReader 时）', async () => {
  const chunk = new TextEncoder().encode('x'.repeat(64));
  const reader = { read: async () => ({ done: false, value: chunk }), cancel: async () => {} };
  await assert.rejects(
    () => fetchProviderModels({
      baseURL: 'https://a.com/v1',
      maxBytes: 100,
      fetchImpl: async () => ({ ok: true, status: 200, body: { getReader: () => reader } }),
    }),
    /响应过大/,
  );
});
