// 端到端：输入框草稿必须按会话隔离。
// bug 现象——#prompt 是页面级单例 DOM，openConv 只重建消息区、从不碰它，
// 于是在会话 B 里写下的未发送内容会被原样带进会话 A（草稿"跟着人走"而不是"跟着会话走"）。
//
// 加载真实前端（服务端须在 localhost:3000 运行），仅 stub 网络（EventSource + fetch），不需要真实 Claude token。
// 运行：node tests/e2e-composer-draft.mjs
import { chromium } from 'playwright';

// 用 127.0.0.1 而非 localhost：本机 HTTP 代理会截 localhost 请求（curl 实测 502）
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000/';
const DRAFT_A = 'DRAFT_IN_CONV_A_7f3c';
const DRAFT_B = 'DRAFT_IN_CONV_B_91ab';

const initScript = () => {
  // addInitScript 在每次导航/reload 时都会重跑，无条件 clear 会把「跨刷新存活」用例要验的数据抹掉，
  // 让产品代码看起来有 bug（实测踩过）。故只在首帧清一次。
  try {
    if (!localStorage.getItem('__e2e_draft_inited')) {
      localStorage.clear();
      localStorage.setItem('__e2e_draft_inited', '1');
    }
  } catch {}
  window.__sse = [];
  class MockES {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 1;
      window.__sse.push(this);
    }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const a = this.listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    close() { this.readyState = 2; }
    emit(t, data) { const ev = { data: JSON.stringify(data) }; (this.listeners[t] || []).forEach((fn) => fn(ev)); }
  }
  window.EventSource = MockES;
  window.__emit = (t, data) => { const es = window.__sse[window.__sse.length - 1]; if (es) es.emit(t, data); };
  let runSeq = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (u.includes('/api/run/start')) return json({ runId: 'draft-run-' + (++runSeq), model: 'claude-sonnet-4', effort: 'medium' });
    if (u.includes('/api/run/send')) return json({ ok: true });
    return realFetch(url, opts);
  };
};

const typeDraft = async (page, text) => {
  await page.evaluate((t) => {
    const el = document.querySelector('#prompt');
    el.textContent = t;
    el.dispatchEvent(new Event('input', { bubbles: true })); // 触发 composer 的草稿写穿（debounce 300ms）
  }, text);
  await page.waitForTimeout(400); // 等 debounce 落库，否则切会话时草稿还没写进记录
};

const promptText = (page) => page.evaluate(() => document.querySelector('#prompt').innerText.trim());

// 发一条消息把当前会话落地（首条消息才会生成 conv 记录与侧栏行）
const sendOnce = async (page, text) => {
  await page.evaluate((t) => {
    const el = document.querySelector('#prompt');
    el.textContent = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.click('#sendBtn');
  await page.waitForFunction((n) => window.__sse && window.__sse.length >= n, 1, { timeout: 5000 });
  await page.evaluate(() => window.__emit('session', { session_id: 'sess-' + Math.random().toString(36).slice(2) }));
  await page.evaluate(() => window.__emit('done', { ok: true }));
  await page.waitForTimeout(200);
};

const convIds = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#convList .conv-item')].map((r) => r.dataset.convId).filter(Boolean));

const openConvRow = async (page, convId) => {
  await page.click(`#convList .conv-item[data-conv-id="${convId}"]`);
  await page.waitForTimeout(300);
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  await page.addInitScript(initScript);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // ── 准备两个已落地的会话 ──
  await sendOnce(page, 'TASK_A');
  const afterA = await convIds(page);
  await page.click('#sidebarNew');
  await page.waitForTimeout(200);
  await sendOnce(page, 'TASK_B');
  const both = await convIds(page);
  const convA = afterA[0];
  const convB = both.find((id) => id !== convA);
  if (!convA || !convB) {
    console.log('❌ 前置失败：没能建出两个会话', { afterA, both });
    await browser.close();
    process.exit(2);
  }
  console.log(`会话 A=${convA} B=${convB}\n`);

  // ── 用例 1：B 的草稿不得跟到 A ──
  await openConvRow(page, convB);
  await typeDraft(page, DRAFT_B);
  await openConvRow(page, convA);
  const inA = await promptText(page);
  check('切到会话 A 后输入框为空（B 的草稿没跟着走）', inA === '', `实际=${JSON.stringify(inA)}`);

  // ── 用例 2：A 自己的草稿独立保存 ──
  await typeDraft(page, DRAFT_A);
  await openConvRow(page, convB);
  const backInB = await promptText(page);
  check('切回会话 B 时 B 的草稿原样回来', backInB === DRAFT_B, `实际=${JSON.stringify(backInB)}`);

  await openConvRow(page, convA);
  const backInA = await promptText(page);
  check('切回会话 A 时 A 的草稿原样回来', backInA === DRAFT_A, `实际=${JSON.stringify(backInA)}`);

  // ── 用例 3：发送后草稿作废，不得被重新灌回 ──
  await sendOnce(page, 'SENT_FROM_A');
  const afterSend = await promptText(page);
  check('发送后输入框清空', afterSend === '', `实际=${JSON.stringify(afterSend)}`);
  await openConvRow(page, convB);
  await openConvRow(page, convA);
  const afterRoundTrip = await promptText(page);
  check('已发出的内容不会被当成草稿灌回', afterRoundTrip === '', `实际=${JSON.stringify(afterRoundTrip)}`);

  // ── 用例 4：草稿跨刷新存活（存在会话记录里，不是内存态）──
  await typeDraft(page, DRAFT_A + '_PERSIST');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload'))); // flushConvs 强制落盘
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800); // 等启动恢复上次会话
  const afterReload = await promptText(page);
  check('刷新后草稿仍在（写进了会话记录）', afterReload === DRAFT_A + '_PERSIST', `实际=${JSON.stringify(afterReload)}`);

  check('无 pageerror', pageErrors.length === 0, pageErrors.join(' | '));

  const pass = results.every((r) => r.ok);
  console.log(pass ? '\n✅ PASS：草稿按会话隔离' : '\n❌ FAIL：草稿隔离不成立');
  await browser.close();
  process.exit(pass ? 0 : 1);
};

run().catch((e) => { console.error('测试异常:', e); process.exit(2); });
