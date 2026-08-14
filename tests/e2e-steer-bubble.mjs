// 端到端复现：运行中插话（steering）后，Claude 流式输出被渲染进「用户消息气泡」而非「助手气泡」。
// 加载真实 public/app.js（服务端须在 localhost:3000 运行），仅 stub 网络（EventSource + fetch），
// 不需要真实 Claude token。运行：node tests/e2e-steer-bubble.mjs
import { chromium } from 'playwright';

const MARKER = 'CLAUDE_STREAM_MARKER_9d2f';
const BASE = 'http://localhost:3000/';

const initScript = () => {
  try { localStorage.clear(); } catch {}
  // —— Mock EventSource：记录实例、可由测试驱动 emit ——
  window.__sse = [];
  class MockES {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 1;
      try { this.runId = new URL(url, location.origin).searchParams.get('runId'); } catch { this.runId = null; }
      window.__sse.push(this);
    }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const a = this.listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    close() { this.readyState = 2; }
    emit(t, data) { const ev = { data: JSON.stringify(data) }; (this.listeners[t] || []).forEach((fn) => fn(ev)); }
  }
  window.EventSource = MockES;
  window.__emit = (t, data) => { const es = window.__sse[window.__sse.length - 1]; if (es) es.emit(t, data); };
  // —— Stub fetch：仅接管 run 启停，其余透传真实服务端 ——
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (u.includes('/api/run/start')) return json({ runId: 'test-run-1', model: 'claude-sonnet-4', effort: 'medium' });
    if (u.includes('/api/run/send')) return json({ ok: true });
    return realFetch(url, opts);
  };
};

const type = async (page, text) => {
  await page.evaluate((t) => {
    const el = document.querySelector('#prompt');
    el.textContent = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(initScript);
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(BASE, { waitUntil: 'load' });

  // 1) 首条消息：新建 run
  await type(page, 'FIRST_TASK');
  await page.click('#sendBtn');
  // 等待 attachStream 建好 EventSource（job.runId 就绪，方可插话）
  await page.waitForFunction(() => window.__sse && window.__sse.length >= 1, null, { timeout: 5000 });
  await page.evaluate(() => window.__emit('session', { session_id: 'sess-1' }));
  // 助手占位气泡在场、但没有正文（模拟「还在跑工具/等首个 token」）—— 触发 steer 的 else 分支
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 2, null, { timeout: 5000 });

  // 2) 运行中插话
  await type(page, 'STEER_MSG');
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 3, null, { timeout: 5000 });

  // 3) 插话后 Claude 继续流式输出
  await page.evaluate((m) => window.__emit('chunk', { text: m }), MARKER);
  await page.waitForTimeout(1000); // 等打字机把 marker 显示完

  // 4) 断言：marker 必须出现在「助手气泡」，且不得出现在任何「用户气泡」
  const state = await page.evaluate((marker) => {
    const msgs = [...document.querySelectorAll('#messages .msg')];
    const rows = msgs.map((m) => ({
      role: m.classList.contains('user') ? 'user' : 'assistant',
      text: (m.querySelector('.bubble')?.innerText || '').trim(),
    }));
    return {
      rows,
      inAssistant: rows.some((r) => r.role === 'assistant' && r.text.includes(marker)),
      inUser: rows.some((r) => r.role === 'user' && r.text.includes(marker)),
    };
  }, MARKER);

  console.log('DOM 消息序列:');
  state.rows.forEach((r, i) => console.log(`  [${i}] ${r.role}: ${JSON.stringify(r.text.slice(0, 60))}`));

  const pass = state.inAssistant && !state.inUser;
  console.log(`\nmarker 在助手气泡: ${state.inAssistant} | marker 在用户气泡(污染): ${state.inUser}`);
  console.log(pass ? '\n✅ PASS：Claude 流式输出正确渲染进助手气泡' : '\n❌ FAIL：Claude 流式输出渲染进了用户气泡（bug 复现）');

  await browser.close();
  process.exit(pass ? 0 : 1);
};

run().catch((e) => { console.error('测试异常:', e); process.exit(2); });
