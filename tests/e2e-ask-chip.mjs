// 端到端复现：顶栏审批徽标（#askChip）在面板视图下的显隐与交互。
// 场景：run 挂起一个交互式审批（ask 事件）→ 切到面板视图（tasks/logs）应显示「⏳ N 待确认」→
//       聊天视图下应保持隐藏 → 点击徽标应回到聊天视图并把 ask-card 滚入可视区 →
//       提交决策后徽标应消失。
// 加载真实 public/app.js（服务端须在 localhost:3000 运行），仅 stub 网络（EventSource + fetch），
// 不需要真实 Claude token。运行：node tests/e2e-ask-chip.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000/';
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};

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
  // —— Stub fetch：仅接管 run 启停 + 决策提交，其余透传真实服务端 ——
  window.__decisionCalls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (u.includes('/api/run/start')) return json({ runId: 'test-run-ask', model: 'claude-sonnet-4', effort: 'medium' });
    if (u.includes('/api/run/send')) return json({ ok: true });
    if (u.includes('/api/run/decision')) {
      try { window.__decisionCalls.push(JSON.parse(opts.body)); } catch {}
      return json({ ok: true });
    }
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

const askChipState = async (page) => page.evaluate(() => {
  const el = document.getElementById('askChip');
  return el ? { hidden: el.hidden, text: el.textContent } : null;
});

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(initScript);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#askChip', { state: 'attached', timeout: 5000 });

    // 0) 初始态：#askChip 隐藏
    let chip = await askChipState(page);
    if (!chip || !chip.hidden) fail('初始态 #askChip 应隐藏，实际: ' + JSON.stringify(chip));

    // 1) 起一个 run
    await type(page, 'ASK_CHIP_TASK');
    await page.click('#sendBtn');
    await page.waitForFunction(() => window.__sse && window.__sse.length >= 1, null, { timeout: 5000 });
    await page.evaluate(() => window.__emit('session', { session_id: 'sess-ask' }));

    // 2) 服务端推 ask 事件：挂起一个交互式审批
    await page.evaluate(() => window.__emit('ask', {
      reqId: 'req-1',
      kind: 'permission',
      title: '需要你的确认',
      body: '是否允许执行该操作？',
      options: [
        { id: 'allow', label: '允许' },
        { id: 'deny', label: '拒绝' },
      ],
    }));
    await page.waitForTimeout(200);

    // 3) 仍在聊天视图：#askChip 应保持隐藏（即便有挂起审批）
    chip = await askChipState(page);
    if (!chip.hidden) fail('聊天视图下 #askChip 不应显示，实际: ' + JSON.stringify(chip));

    // 4) 切到任务面板视图：#askChip 应显示「⏳ 1 待确认」
    await page.click('#taskBtn');
    await page.waitForTimeout(150);
    chip = await askChipState(page);
    if (chip.hidden) fail('任务视图下 #askChip 应显示');
    if (!/⏳\s*1\s*待确认/.test(chip.text)) fail('#askChip 文案不符预期: ' + chip.text);

    // 5) 切到日志视图：#askChip 仍应显示（离开聊天视图即算）
    await page.click('#logBtn');
    await page.waitForTimeout(150);
    chip = await askChipState(page);
    if (chip.hidden) fail('日志视图下 #askChip 应显示');

    // 6) 点击徽标：回聊天视图 + 定位到 ask-card
    await page.click('#askChip');
    await page.waitForTimeout(250);
    const inChat = await page.evaluate(() => !document.querySelector('.app').classList.contains('in-panel'));
    if (!inChat) fail('点击 #askChip 后应回到聊天视图');
    const askCardVisible = await page.isVisible('.ask-card');
    if (!askCardVisible) fail('点击 #askChip 后应能看到 .ask-card');
    chip = await askChipState(page);
    if (!chip.hidden) fail('回到聊天视图后 #askChip 应重新隐藏');

    // 7) 提交决策：点击第一个选项按钮
    await page.click('.ask-card .ask-opt');
    await page.waitForTimeout(150);
    const decisionCalls = await page.evaluate(() => window.__decisionCalls);
    if (!decisionCalls.length || decisionCalls[0].reqId !== 'req-1') {
      fail('决策未正确提交到 /api/run/decision: ' + JSON.stringify(decisionCalls));
    }
    const askCardGone = await page.evaluate(() => !document.querySelector('.ask-card'));
    if (!askCardGone) fail('提交决策后 .ask-card 应被移除');

    // 8) 决策后再切到面板视图：#askChip 应保持隐藏（无挂起审批）
    await page.click('#taskBtn');
    await page.waitForTimeout(150);
    chip = await askChipState(page);
    if (!chip.hidden) fail('决策提交后面板视图下 #askChip 应隐藏，实际: ' + JSON.stringify(chip));
    await page.click('#taskBtn'); // 收起，回聊天

    if (pageErrors.length) fail('出现页面错误：\n  ' + pageErrors.join('\n  '));

    console.log(failures ? `E2E FAIL（${failures} 处）` : 'E2E PASS：#askChip 显隐与交互全流程通过');
  } catch (e) {
    console.error('FAIL(异常): ' + e.message);
    failures++;
  } finally {
    await browser.close();
  }
  process.exit(failures ? 1 : 0);
};

run();
