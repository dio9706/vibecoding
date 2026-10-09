/**
 * 联网工具纯函数层单测：URL 校验 / HTML→文本 / 三家搜索请求构造与响应解析 / 结果格式化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFetchUrl,
  decodeEntities,
  htmlToText,
  clipText,
  buildSearchRequest,
  parseSearchResults,
  formatSearchResults,
} from './web-tools.logic.js';

test('normalizeFetchUrl：仅 http/https；非法/缺协议 → null', () => {
  assert.equal(normalizeFetchUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeFetchUrl(' http://127.0.0.1:8080/x '), 'http://127.0.0.1:8080/x');
  assert.equal(normalizeFetchUrl('ftp://x'), null);
  assert.equal(normalizeFetchUrl('file:///etc/passwd'), null);
  assert.equal(normalizeFetchUrl('example.com'), null);
  assert.equal(normalizeFetchUrl(''), null);
  assert.equal(normalizeFetchUrl(null), null);
});

test('decodeEntities：命名/十进制/十六进制；未知原样保留', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &nbsp;'), 'a & b <c> AB  ');
  assert.equal(decodeEntities('&unknown; &;'), '&unknown; &;');
});

test('htmlToText：去 script/style/注释、块级转换行、剥标签、压空白、取 title', () => {
  const html = `<html><head><title> 测试 页 </title><style>body{color:red}</style><script>alert(1)</script></head>
    <body><h1>标题</h1><p>第一段&nbsp;文字</p><div><ul><li>条目一</li><li>条目二</li></ul></div>
    <!-- comment --><pre>  保留   空格  </pre></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, '测试 页');
  assert.match(text, /标题/);
  assert.match(text, /第一段 文字/);
  assert.match(text, /条目一\n条目二/);
  assert.ok(!text.includes('alert'), 'script 应被剔除');
  assert.ok(!text.includes('color:red'), 'style 应被剔除');
  assert.ok(!text.includes('comment'), '注释应被剔除');
});

test('htmlToText / clipText：超限头尾截断并标注', () => {
  const { text } = htmlToText('<p>' + 'x'.repeat(5000) + '</p>', { maxChars: 1000 });
  assert.ok(text.length <= 1100, `截断后长度异常：${text.length}`);
  assert.match(text, /略 \d+ 字符/);
  assert.equal(clipText('abc', 100), 'abc');
  assert.equal(clipText('', 10), '');
});

test('buildSearchRequest：三家请求构造（URL/头/体）；count 收敛；缺 key/空 query/未知 provider → {error}', () => {
  const t = buildSearchRequest('tavily', { query: 'ai news', count: 3, apiKey: 'tvly-x' });
  assert.equal(t.url, 'https://api.tavily.com/search');
  assert.equal(t.init.headers.Authorization, 'Bearer tvly-x');
  assert.deepEqual(JSON.parse(t.init.body), { query: 'ai news', max_results: 3, search_depth: 'basic' });

  const b = buildSearchRequest('brave', { query: 'a b', apiKey: 'bk' });
  assert.match(b.url, /q=a%20b&count=5/);
  assert.equal(b.init.headers['X-Subscription-Token'], 'bk');
  assert.equal(b.init.method, 'GET');

  const c = buildSearchRequest('bocha', { query: 'q', count: 99, apiKey: 'bk' });
  assert.deepEqual(JSON.parse(c.init.body), { query: 'q', count: 10, summary: false }, 'count 封顶 10');

  assert.ok(buildSearchRequest('tavily', { query: '', apiKey: 'x' }).error);
  assert.ok(buildSearchRequest('tavily', { query: 'q', apiKey: '' }).error);
  assert.ok(buildSearchRequest('serper', { query: 'q', apiKey: 'x' }).error);
});

test('parseSearchResults：三家响应形状 → 统一列表；坏形状 → null', () => {
  assert.deepEqual(parseSearchResults('tavily', { results: [{ title: 'T', url: 'https://a', content: 'C' }] }), [
    { title: 'T', url: 'https://a', snippet: 'C' },
  ]);
  assert.deepEqual(parseSearchResults('brave', { web: { results: [{ title: 'T', url: 'https://b', description: 'D' }] } }), [
    { title: 'T', url: 'https://b', snippet: 'D' },
  ]);
  assert.deepEqual(parseSearchResults('bocha', { data: { webPages: { value: [{ name: 'N', url: 'https://c', snippet: 'S' }] } } }), [
    { title: 'N', url: 'https://c', snippet: 'S' },
  ]);
  assert.equal(parseSearchResults('tavily', { nope: 1 }), null);
  assert.equal(parseSearchResults('brave', null), null);
  assert.equal(parseSearchResults('bocha', { data: {} }), null);
});

test('formatSearchResults：编号列表 + 摘要截断；空结果文案', () => {
  const out = formatSearchResults('q', [{ title: 'T', url: 'https://a', snippet: 's'.repeat(500) }]);
  assert.match(out, /^搜索「q」的结果：/);
  assert.match(out, /1\. T/);
  assert.match(out, /https:\/\/a/);
  assert.ok(out.length < 600, '摘要应被截断');
  assert.match(formatSearchResults('q', []), /没有搜索结果/);
});
