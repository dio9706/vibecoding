/**
 * busy inbox follow-up 排队 e2e 回归门禁（T2-P4）。
 *
 * 守的链路（真实 chat.js + 真服务端，只桩接网络）：
 *  ① openai 运行中插话 → /api/run/send 回 mode:'follow_up' → 用户气泡保持「排队」态（可撤回/立即生效 UI 在场），
 *     不产生第二个 run、不做降级切段；
 *  ② 当前 run 终结（done）→ 前端提前轮询 /api/run/pending 的 followUps → 自动接上排空起的新 run（新 EventSource），
 *     排队标记清除、新增助手占位气泡；
 *  ③ 新 run 的流式输出渲染进助手气泡，不污染用户气泡（与 steer-bubble 同断言）。
 *
 * 自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR + 内核分配空闲端口），绝不触碰 3000 端口的真实服务。
 * 运行：node tests/e2e-follow-up-queue.mjs
 */
import { chromium } from 'playwright';
import { seedConfiguredSettings } from './helpers.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const CONV_ID = 'cFU';
const MARKER = 'FOLLOW_UP_STREAM_MARKER_7a1c';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};
const step = (msg) => console.log('  ✔ ' + msg);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForReady(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/api/ping');
      if (r.ok) return true;
    } catch {
      /* 还没监听上，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const port = Number(process.env.E2E_PORT) || (await findFreePort());
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-queue-e2e-'));
seedConfiguredSettings(dataDir);

let child = null;
let browser = null;
try {
  child = spawn(process.execPath, ['src/entrypoints/web/server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), APP_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (d) => (serverOutput += d));
  child.stderr.on('data', (d) => (serverOutput += d));
  if (!(await waitForReady(BASE))) throw new Error('自起的 web 服务器未在 20s 内就绪，输出：\n' + serverOutput);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // 种子会话：cwd 必须与 localStorage 一致，否则一窗一项目过滤会把会话藏起来
  await page.addInitScript(
    ({ cwd, convId }) => {
      try {
        localStorage.clear();
      } catch {}
      localStorage.setItem('claude_cwd', cwd);
      localStorage.setItem('claude_last_conv', convId);
      localStorage.setItem(
        'claude_convs',
        JSON.stringify([
          {
            id: convId,
            title: 'follow-up 测试会话',
            session: null,
            cwd,
            model: 'auto',
            effort: 'medium',
            mode: 'default',
            provider: 'claude-agent',
            messages: [],
            updatedAt: Date.now(),
          },
        ]),
      );

      // —— Mock EventSource：按 runId 定向 emit；记录实例供断言/驱动 ——
      window.__sse = [];
      class MockES {
        constructor(url) {
          this.url = url;
          this.listeners = {};
          this.readyState = 1;
          try {
            this.runId = new URL(url, location.origin).searchParams.get('runId');
          } catch {
            this.runId = null;
          }
          window.__sse.push(this);
        }
        addEventListener(t, fn) {
          (this.listeners[t] = this.listeners[t] || []).push(fn);
        }
        removeEventListener(t, fn) {
          const a = this.listeners[t];
          if (a) {
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        emit(t, data) {
          const ev = { data: JSON.stringify(data) };
          (this.listeners[t] || []).forEach((fn) => fn(ev));
        }
      }
      window.EventSource = MockES;
      window.__emitOn = (runId, t, data) => {
        const es = window.__sse.filter((e) => e.runId === runId && e.readyState === 1).at(-1);
        if (es) es.emit(t, data);
      };

      // —— Stub fetch：只接管 run 启停/插话，其余（pending 轮询路由由 Node 侧接管）透传 ——
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        const json = (o) =>
          Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        if (u.includes('/api/run/start')) return json({ runId: 'run-1', model: 'claude-sonnet-4', effort: 'medium' });
        // openai 运行中插话：busy inbox 排队（真实服务端会这么回，本门禁只验证前端消费侧）
        if (u.includes('/api/run/send')) return json({ ok: true, mode: 'follow_up', msgId: 'fu_1' });
        return realFetch(url, opts);
      };
    },
    { cwd: dataDir, convId: CONV_ID },
  );

  // /api/run/pending：初始无排空记录；测试切到第二阶段后回「排空已启动 run-2」。
  // convId 从 localStorage 实时读：首条消息发送时 chat.js 才把 currentConvId 写进 claude_last_conv，
  // 用种子 id 写死会在「种子会话未及时打开、chat 自行铸新 id」时对不上。
  let followUpsPhase = false;
  await page.route('**/api/run/pending', async (route) => {
    const convId = await page.evaluate(() => localStorage.getItem('claude_last_conv'));
    const body = {
      pending: [],
      followUps: followUpsPhase && convId ? [{ convId, runId: 'run-2', ids: ['fu_1'], at: Date.now() }] : [],
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('#dirLabel')?.textContent?.trim(), null, {
    timeout: 15000,
  });

  const type = (text) =>
    page.evaluate((t) => {
      const el = document.querySelector('#prompt');
      el.textContent = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);

  // 1) 首条消息起 run-1
  await type('FIRST_TASK');
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__sse.some((e) => e.runId === 'run-1'), null, { timeout: 5000 });
  await page.evaluate(() => window.__emitOn('run-1', 'session', { session_id: 'sess-1' }));
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 2, null, { timeout: 5000 });
  step('首条消息起 run-1，助手占位气泡就位');

  // 2) 运行中插话 → follow-up 排队：气泡带排队态与操作按钮，不起第二个 run
  await type('FOLLOW_UP_MSG');
  await page.click('#sendBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#messages .msg.user .bubble.queued').length === 1,
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(500); // 给 steer 的 fetch 响应处理器落定（msgId 回填）
  const queuedState = await page.evaluate(() => {
    const msg = document.querySelector('#messages .msg.user .bubble.queued')?.closest('.msg');
    const actions = msg?.querySelector('.q-actions');
    const hint = msg?.querySelector('.q-hint');
    const conv = JSON.parse(localStorage.getItem('claude_convs')).find((c) => c.id === localStorage.getItem('claude_last_conv'));
    const queuedStored = (conv?.messages || []).filter((m) => m.queued);
    return {
      hint: hint?.textContent || '',
      actionsShown: !!(actions && getComputedStyle(actions).display !== 'none'),
      sseCount: window.__sse.filter((e) => e.readyState === 1).length,
      msgId: msg?.dataset.msgId || null,
      stored: queuedStored.map((m) => ({ role: m.role, msgId: m.msgId, queued: m.queued })),
    };
  });
  if (!queuedState.hint.includes('等待进入任务')) fail('排队气泡未显示「等待进入任务」提示：' + JSON.stringify(queuedState));
  else step('排队气泡提示就位：' + queuedState.hint);
  if (!queuedState.actionsShown) fail('排队气泡缺少撤回/立即生效操作按钮');
  else step('撤回/立即生效操作按钮在场');
  if (queuedState.msgId !== 'fu_1') fail('排队气泡的 msgId 未回填（/send 响应处理器未落定）：' + JSON.stringify(queuedState));
  else step('msgId 已回填：' + queuedState.msgId);
  if (queuedState.sseCount !== 1) fail(`follow-up 排队不得起第二个 run（活 ES=${queuedState.sseCount}）`);
  else step('未并发起第二个 run（仅 run-1 一条流）');

  // 3) run-1 终结 → done 触发提前轮询 → 自动接上排空起的 run-2，排队标记清除
  followUpsPhase = true;
  await page.evaluate(() =>
    window.__emitOn('run-1', 'done', { result: '第一轮完成', is_error: false, subtype: 'success' }),
  );
  await page.waitForFunction(() => window.__sse.some((e) => e.runId === 'run-2'), null, { timeout: 5000 });
  step('done 后自动发现并接上排空 run-2（新 EventSource）');
  await page.waitForFunction(
    () => document.querySelectorAll('#messages .msg.user .bubble.queued').length === 0,
    null,
    { timeout: 5000 },
  );
  step('排队标记已清除');
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 4, null, { timeout: 5000 });
  step('新增助手占位气泡接住第二轮输出');

  // 4) run-2 流式输出 → 渲染进助手气泡，不污染用户气泡
  await page.evaluate((m) => window.__emitOn('run-2', 'chunk', { text: m }), MARKER);
  await page.waitForTimeout(1200); // 等打字机把 marker 显示完
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#messages .msg')].map((m) => ({
      role: m.classList.contains('user') ? 'user' : 'assistant',
      text: (m.querySelector('.bubble')?.innerText || '').trim(),
    })),
  );
  const inAssistant = rows.some((r) => r.role === 'assistant' && r.text.includes(MARKER));
  const inUser = rows.some((r) => r.role === 'user' && r.text.includes(MARKER));
  if (!inAssistant) fail('run-2 流式输出未渲染进助手气泡');
  else if (inUser) fail('run-2 流式输出污染了用户气泡');
  else step('run-2 流式输出只进助手气泡');

  if (pageErrors.length) fail('页面错误：\n  ' + pageErrors.join('\n  '));
  else step('零 pageerror');

  console.log(
    failures
      ? `E2E FAIL（${failures} 处）`
      : 'E2E PASS：follow-up 排队 → 排空自动接流全链路成立（无并发 run、无气泡污染）',
  );
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结果 */
  }
}
