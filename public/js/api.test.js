import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getJson, postJson, putJson, delJson, postJsonQuiet } from './api.js';

/**
 * api.js 的契约测试。
 *
 * 重点不在「能发请求」，而在几个容易悄悄搞错的边界：
 * headers 合并方向、init 透传（`__skipGuard` 丢了会让启动期探测把掉线罩顶上来）、
 * 以及非 JSON 响应必须给 null 而不是抛 SyntaxError（抛了会被调用方当成后端不可达）。
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 装一个假 fetch，记录收到的参数，回指定响应 */
function stubFetch({ status = 200, body = '{}', contentType = 'application/json' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (contentType !== 'application/json') throw new SyntaxError('Unexpected token < in JSON');
        return JSON.parse(body);
      },
    };
  };
  return calls;
}

// ── postJson 的请求构造 ────────────────────────────────────────

test('postJson：自动带上 method / Content-Type / 序列化后的 body', async () => {
  const calls = stubFetch();
  await postJson('/api/x', { a: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/x');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"a":1}');
});

test('postJson：调用方的同名 header 优先（否则无法覆盖 Content-Type）', async () => {
  const calls = stubFetch();
  await postJson('/api/x', { a: 1 }, { headers: { 'Content-Type': 'text/plain', 'X-T': '1' } });
  assert.equal(calls[0].init.headers['Content-Type'], 'text/plain');
  assert.equal(calls[0].init.headers['X-T'], '1', '自定义 header 不能被丢掉');
});

test('postJson：init 的其余字段原样透传（__skipGuard 丢了会误顶掉线罩）', async () => {
  const calls = stubFetch();
  const ac = new AbortController();
  await postJson('/api/x', {}, { __skipGuard: true, signal: ac.signal, keepalive: true });
  assert.equal(calls[0].init.__skipGuard, true);
  assert.equal(calls[0].init.signal, ac.signal);
  assert.equal(calls[0].init.keepalive, true);
});

test('postJson：body 为 undefined 时既不带请求体也不带 Content-Type', async () => {
  const calls = stubFetch();
  await postJson('/api/x', undefined);
  assert.equal('body' in calls[0].init, false);
  assert.equal(calls[0].init.headers['Content-Type'], undefined, '无体请求不该声明 JSON 类型');
});

test('putJson：method 为 PUT，其余与 postJson 一致', async () => {
  const calls = stubFetch();
  await putJson('/api/bots/abc', { enabled: true });
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"enabled":true}');
});

test('delJson：method 为 DELETE，无请求体、无 Content-Type', async () => {
  const calls = stubFetch();
  await delJson('/api/bots/abc');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal('body' in calls[0].init, false);
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
});

test('delJson：init 仍然透传（signal 等）', async () => {
  const calls = stubFetch();
  const ac = new AbortController();
  await delJson('/api/x', { signal: ac.signal });
  assert.equal(calls[0].init.signal, ac.signal);
});

test('postJson：body 为 null 时仍然序列化（null 是合法 JSON，与 undefined 不同）', async () => {
  const calls = stubFetch();
  await postJson('/api/x', null);
  assert.equal(calls[0].init.body, 'null');
});

// ── 响应解析 ──────────────────────────────────────────────────

test('返回 ok / status / data 三元组', async () => {
  stubFetch({ status: 200, body: '{"n":7}' });
  const r = await postJson('/api/x', {});
  assert.deepEqual(r, { ok: true, status: 200, data: { n: 7 } });
});

test('非 2xx 不抛错，data 照样解析（后端的错误体一般也是 JSON）', async () => {
  stubFetch({ status: 400, body: '{"error":"path 不能为空"}' });
  const r = await postJson('/api/x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'path 不能为空');
});

test('非 JSON 响应 → data 为 null 且不抛（抛了会被当成后端不可达）', async () => {
  stubFetch({ status: 500, contentType: 'text/html' });
  const r = await getJson('/api/x');
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.data, null);
});

test('204 空响应 → data 为 null，不当成解析失败', async () => {
  stubFetch({ status: 204 });
  const r = await postJson('/api/x', {});
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
});

// ── 错误传播 ──────────────────────────────────────────────────

test('fetch reject 一律向上抛 —— 分类与掉线上报是全局包装的职责，这里不吞', async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new Error('后端未连接'), { isNetworkError: true });
  };
  await assert.rejects(() => postJson('/api/x', {}), /后端未连接/);
  await assert.rejects(() => getJson('/api/x'), /后端未连接/);
});

test('postJsonQuiet：网络失败返回 false 而不抛', async () => {
  globalThis.fetch = async () => {
    throw new Error('boom');
  };
  assert.equal(await postJsonQuiet('/api/x', {}), false);
});

test('postJsonQuiet：非 2xx 返回 false，2xx 返回 true', async () => {
  stubFetch({ status: 500, body: '{}' });
  assert.equal(await postJsonQuiet('/api/x', {}), false);
  stubFetch({ status: 200, body: '{}' });
  assert.equal(await postJsonQuiet('/api/x', {}), true);
});

// ── GET ───────────────────────────────────────────────────────

test('getJson：不带 method 与 Content-Type（GET 带 body 头会被某些代理拒绝）', async () => {
  const calls = stubFetch();
  await getJson('/api/dirs/saved');
  assert.equal(calls[0].init, undefined);
});

test('getJson：init 原样透传', async () => {
  const calls = stubFetch();
  await getJson('/api/ping', { __skipGuard: true });
  assert.equal(calls[0].init.__skipGuard, true);
});
