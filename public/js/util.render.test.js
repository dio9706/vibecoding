import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

/**
 * 前端的第一个单测。
 *
 * 背景：renderMarkdown 直接 `el.innerHTML = marked.parse(s)`，全程无消毒。
 * marked 自 v5 起已移除 sanitize 选项，原始 HTML 默认透传，而喂进来的全是**不可信输入**：
 * 模型输出、模型读到的文件内容/网页抓取结果、飞书用户消息、AI 分析结论。
 * 会话还存在 localStorage 里，刷新即重放 → 存储型 XSS。
 *
 * 在 Tauri 下这条会升级成本机 RCE：tauri.conf.json 的 csp 为 null、
 * capabilities 授了 shell:allow-execute 且 args 不限制 → 注入脚本可直接执行任意命令。
 */

let dom;
let renderMarkdown;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  // 把 vendor 的 marked / DOMPurify 装进这个 window（两者都是 IIFE/UMD 全局）
  for (const f of ['public/vendor/marked.min.js', 'public/vendor/purify.min.js']) {
    dom.window.eval(fs.readFileSync(f, 'utf8'));
  }
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // 浏览器里 window 就是全局对象，裸标识符 `marked` / `DOMPurify` 能直接解析；
  // Node 里必须手动挂到 globalThis 才能还原这一语义。
  globalThis.marked = dom.window.marked;
  globalThis.DOMPurify = dom.window.DOMPurify;
  ({ renderMarkdown } = await import('./util.js'));
});

after(() => {
  delete globalThis.window;
  delete globalThis.document;
  dom?.window?.close();
});

const el = () => dom.window.document.createElement('div');

// ── 消毒 ────────────────────────────────────────────────────────

test('renderMarkdown：img 的 onerror 事件处理器被剥除（最常见的注入载荷）', () => {
  const d = el();
  renderMarkdown(d, '<img src=x onerror="window.__PWNED=1">');
  assert.equal(d.innerHTML.includes('onerror'), false, `未消毒：${d.innerHTML}`);
  assert.equal(dom.window.__PWNED, undefined);
});

test('renderMarkdown：script 标签不得进入 DOM', () => {
  const d = el();
  renderMarkdown(d, '正常文本<script>window.__PWNED=1</script>结尾');
  assert.equal(d.querySelector('script'), null, `未消毒：${d.innerHTML}`);
  assert.equal(dom.window.__PWNED, undefined);
});

test('renderMarkdown：javascript: 协议的链接被剥除', () => {
  const d = el();
  renderMarkdown(d, '[点我](javascript:window.__PWNED=1)');
  assert.equal(d.innerHTML.includes('javascript:'), false, `未消毒：${d.innerHTML}`);
});

test('renderMarkdown：svg/iframe 等其它注入载体同样被处理', () => {
  const d = el();
  renderMarkdown(d, '<svg onload="window.__PWNED=1"></svg><iframe src="javascript:1"></iframe>');
  assert.equal(d.innerHTML.includes('onload'), false, `未消毒：${d.innerHTML}`);
  assert.equal(d.querySelector('iframe'), null, `未消毒：${d.innerHTML}`);
});

test('renderMarkdown：模型输出里的代码块内含载荷时也不执行（真实高频场景）', () => {
  const d = el();
  renderMarkdown(d, '这是修复方案：\n\n<img src=x onerror="window.__PWNED=1">\n\n请确认。');
  assert.equal(d.innerHTML.includes('onerror'), false, `未消毒：${d.innerHTML}`);
  assert.equal(dom.window.__PWNED, undefined);
});

// ── 正常渲染不能被消毒误伤 ──────────────────────────────────────

test('renderMarkdown：正常 markdown 仍然渲染（加粗/标题/列表）', () => {
  const d = el();
  renderMarkdown(d, '# 标题\n\n**加粗** 与 *斜体*\n\n- 项一\n- 项二');
  assert.ok(d.querySelector('h1'), '标题应渲染');
  assert.ok(d.querySelector('strong'), '加粗应渲染');
  assert.equal(d.querySelectorAll('li').length, 2);
});

test('renderMarkdown：普通链接与代码块保留', () => {
  const d = el();
  renderMarkdown(d, '见 [文档](https://example.com/a)\n\n```js\nconst a = 1;\n```');
  const a = d.querySelector('a');
  assert.ok(a, '链接应保留');
  assert.equal(a.getAttribute('href'), 'https://example.com/a');
  assert.ok(d.querySelector('code'), '代码块应保留');
});

test('renderMarkdown：中文与 emoji 正常', () => {
  const d = el();
  renderMarkdown(d, '修复了**登录**问题 ✅');
  assert.match(d.textContent, /修复了登录问题/);
});

test('renderMarkdown：空值不抛异常', () => {
  for (const v of [null, undefined, '']) {
    const d = el();
    renderMarkdown(d, v);
    assert.equal(d.textContent, '');
  }
});
