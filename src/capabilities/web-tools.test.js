/**
 * 联网工具运行时单测：全部注入 fetchImpl，零网络。
 * 覆盖 WebFetch 成功/非法 URL/非 2xx/超时/非 HTML，WebSearch 成功/未配置/401/坏形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebTools } from './web-tools.js';

const htmlRes = (body, { status = 200, contentType = 'text/html' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => body,
});

test('WebFetch：抓取成功 → HTML 转文本 + URL/Status/Title 头', async () => {
  let seen = null;
  const web = createWebTools({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return htmlRes('<title>T</title><p>正文</p><script>bad()</script>');
    },
  });
  const out = await web.executeTool('WebFetch', { url: 'https://example.com/page' });
  assert.equal(seen.url, 'https://example.com/page');
  assert.equal(seen.init.method, 'GET');
  assert.match(out, /URL: https:\/\/example\.com\/page/);
  assert.match(out, /Status: 200/);
  assert.match(out, /Title: T/);
  assert.match(out, /正文/);
  assert.ok(!out.includes('bad()'), 'script 不应出现在正文');
});

test('WebFetch：非法 URL / 非 2xx / 超时 / 非 HTML（JSON 原样透出）', async () => {
  const web = createWebTools({ fetchImpl: async () => htmlRes('x') });
  assert.match(await web.executeTool('WebFetch', { url: 'ftp://x' }), /只支持 http\/https/);

  const bad = createWebTools({ fetchImpl: async () => htmlRes('nope', { status: 404 }) });
  assert.match(await bad.executeTool('WebFetch', { url: 'https://a' }), /HTTP 404/);

  const to = createWebTools({
    fetchImpl: async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    },
  });
  assert.match(await to.executeTool('WebFetch', { url: 'https://a' }), /超时/);

  const json = createWebTools({ fetchImpl: async () => htmlRes('{"k":1}', { contentType: 'application/json' }) });
  assert.match(await json.executeTool('WebFetch', { url: 'https://a' }), /\{"k":1\}/);
});

test('WebSearch：成功（tavily 桩）→ 请求形状 + 解析格式化；未配置 → 指引文案', async () => {
  let seen = null;
  const web = createWebTools({
    search: { provider: 'tavily', apiKey: 'k' },
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return htmlRes(JSON.stringify({ results: [{ title: 'T', url: 'https://a', content: 'C' }] }), { contentType: 'application/json' });
    },
  });
  const out = await web.executeTool('WebSearch', { query: 'q' });
  assert.equal(seen.url, 'https://api.tavily.com/search');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.match(out, /1\. T/);

  const none = createWebTools({});
  assert.match(await none.executeTool('WebSearch', { query: 'q' }), /未配置搜索/);
});

test('WebSearch：上游 401 → 提示检查 key；无法识别格式 → 错误', async () => {
  const bad = createWebTools({
    search: { provider: 'brave', apiKey: 'k' },
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.match(await bad.executeTool('WebSearch', { query: 'q' }), /HTTP 401（请检查 API key）/);

  const weird = createWebTools({
    search: { provider: 'brave', apiKey: 'k' },
    fetchImpl: async () => htmlRes(JSON.stringify({ nope: 1 }), { contentType: 'application/json' }),
  });
  assert.match(await weird.executeTool('WebSearch', { query: 'q' }), /无法识别/);
});

test('工具定义：WebFetch/WebSearch 的 description 与 schema 在场；未配置时描述明示去设置页', async () => {
  const none = createWebTools({});
  assert.ok(none.toolDefs.WebFetch?.description.includes('http/https'));
  assert.ok(none.toolDefs.WebSearch?.description.includes('设置 > 基础 > 联网搜索'));
  const cfg = createWebTools({ search: { provider: 'bocha', apiKey: 'k' } });
  assert.ok(cfg.toolDefs.WebSearch.description.includes('bocha'));
});
