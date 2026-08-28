/**
 * 归档期「优化汇总」（retro map-reduce）回归。
 *
 * 用户实测反馈：点「优化汇总」进入一个**空对话**，没法跟踪汇总进度、也看不到汇总了哪些内容；
 * toast 提示「转录已截断，详见 retro 会话消息」，但那条消息根本找不到入口。
 *
 * 根因（都已修）：
 *   A. sendMessageBackground 只 convPushMessage 一条助手占位、从不建 DOM 气泡，且把 job 传给
 *      attachStream 正好绕过其内部唯一会补气泡 + paintJob + ensureTyping 的 `if (!job)` 分支
 *      → 整个流程期间对话区一个字都不画；用户提示词更是完全没落库。
 *   B. waitForRunCompletion 读 conv.messages[i].content，而 conv-store 存的字段叫 text
 *      → map 结果恒为 undefined → reduce 提示词拼成「1. undefined」→ extractPitfallsBlock
 *      抛 TypeError → **每一次汇总都在最后一步失败**。
 *   C. 归档页没有任何进度展示（req.busy 永远不会被写：map-reduce 全在前端编排）。
 *   D. retro 会话没有任何回看入口。
 *
 * 零 Claude 调用：/api/run/start 与 /api/history 都被 stub，SSE 用 MockEventSource 由测试驱动。
 * 自起独立 web 服务器（临时 APP_DATA_DIR + 随机端口），不碰 pm2 的 principal-web。
 *
 * 运行：node tests/e2e-retro-summary.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL: ' + msg); };
const ok = (msg) => console.log('  ✔ ' + msg);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}
async function waitForReady(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(baseUrl + '/api/ping')).ok) return true; } catch { /* 等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const port = await findFreePort();
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-e2e-'));
const reqFile = path.join(dataDir, 'requirements.json');
function patchReqOnDisk(id, mutate) {
  const data = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  mutate(data.find((r) => r.id === id));
  const tmp = reqFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, reqFile);
}

// 浏览器侧注入：stub run/start + history，SSE 由测试驱动
const initScript = () => {
  try {
    if (!localStorage.getItem('__e2e_retro_inited')) {
      localStorage.clear();
      localStorage.setItem('__e2e_retro_inited', '1');
    }
  } catch {}
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
  // 把「最后一条 SSE」当作当前 run 的通道；retro 是严格串行的（一步跑完才发下一步）
  window.__emitLast = (t, data) => {
    const es = window.__sse[window.__sse.length - 1];
    if (es) es.emit(t, data);
    return !!es;
  };
  window.__sseCount = () => window.__sse.length;

  let runSeq = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }));
    if (u.includes('/api/run/start')) return json({ runId: 'retro-run-' + (++runSeq), model: 'claude-sonnet-4', effort: 'medium' });
    // 转录：给一份足够长的假内容，触发截断分支（>30000 字符）
    if (u.includes('/api/history/')) {
      const long = 'x'.repeat(40000);
      return json({ ok: true, data: { messages: [{ role: 'user', content: '做了一些开发' }, { role: 'assistant', content: long }] } });
    }
    if (u.includes('/api/req/pitfalls/get')) return json({ content: '' });
    return realFetch(url, opts);
  };
};

/**
 * 驱动第 nth 条 run（1-based）跑完：等它的 SSE 建立 → 发 session/chunk/done。
 * 按绝对索引而不是「最后一条」：done 发出后 retro 会立刻起下一步的 run，
 * 用 last / 相对计数会打到下一条流上（实测踩过，等待条件直接错位）。
 */
async function driveOneRun(page, replyText, nth) {
  await page.waitForFunction((n) => window.__sseCount() >= n, nth, { timeout: 15000 });
  const emit = (t, data) => page.evaluate(([i, type, d]) => window.__sse[i - 1].emit(type, d), [nth, t, data]);
  await emit('session', { session_id: 'sess-retro-' + nth });
  await emit('chunk', { text: replyText });
  await page.waitForTimeout(250); // 让打字机吐出内容
  await emit('done', { subtype: 'success', result: replyText });
  await page.waitForTimeout(800); // waitForRunCompletion 是 500ms 轮询
}

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
  if (!(await waitForReady(BASE))) throw new Error('自起服务未在 20s 内就绪：\n' + serverOutput);

  // 造一个归档期需求，带 2 条有 sessionId 的子会话（retro 的汇总对象）
  const created = await (await fetch(BASE + '/api/req/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E 汇总需求 ' + Date.now() }),
  })).json();
  patchReqOnDisk(created.id, (r) => {
    r.phase = 'archiving';
    r.projects = { frontend: { dir: 'D:/e2e-fake/ui', dev: true }, backend: null };
    r.sessions = [
      { convId: 'c_main_e2e', sessionId: 'sess-main-1', title: '主开发会话', kind: 'main', createdAt: new Date().toISOString() },
      { convId: 'c_sub_e2e', sessionId: 'sess-sub-1', title: '子会话甲', kind: 'sub', createdAt: new Date().toISOString() },
    ];
  });

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  await page.addInitScript(initScript);
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
  });
  const assertNoErrors = (stage) => {
    if (pageErrors.length) { fail(`${stage} 阶段页面错误：\n  ` + pageErrors.join('\n  ')); pageErrors.length = 0; }
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600);

  // 打开归档期需求
  await page.evaluate(async (id) => {
    const mod = await import('/js/req-view.js');
    await mod.refreshReqList();
    await mod.openRequirement(id);
  }, created.id);
  await page.waitForSelector('.req-archiving-page', { state: 'visible', timeout: 5000 });
  ok('前置：进入归档期页面');
  // 汇总从未跑过 → 不该有「查看汇总会话」按钮
  if (await page.isVisible('.req-retro-view-btn')) fail('汇总从未跑过时不应出现「查看汇总会话」按钮');
  assertNoErrors('归档页');

  // ── 点「优化汇总」→ 进 retro 会话 ──
  const before = await page.evaluate(() => window.__sseCount());
  await page.click('.req-retro-summary-btn');
  await page.waitForTimeout(500);

  // ① 不再是空对话：第一步的用户气泡应当出现（含 [1/2] 与会话名）
  await page.waitForFunction(
    () => [...document.querySelectorAll('#messages .msg.user .bubble')].some((b) => /\[1\/2\]/.test(b.innerText)),
    null, { timeout: 15000 },
  ).catch(() => {});
  const firstUserBubble = await page.evaluate(() =>
    [...document.querySelectorAll('#messages .msg.user .bubble')].map((b) => b.innerText.trim())[0] || '');
  if (!/\[1\/2\]/.test(firstUserBubble)) fail(`①对话区没有出现汇总步骤气泡（空对话 bug 未修）：${JSON.stringify(firstUserBubble)}`);
  else ok(`①对话区出现汇总步骤气泡：${JSON.stringify(firstUserBubble.slice(0, 60))}`);

  // ② 截断信息写进气泡本身（转录 40000 字符 > 30000 上限）
  if (!/截断/.test(firstUserBubble)) fail('②截断说明未写进气泡（tips 指向的"retro 会话消息"仍不存在）');
  else ok('②截断说明已写进该步骤气泡');

  // ③ 助手占位气泡与进度块
  const asstCount = await page.evaluate(() => document.querySelectorAll('#messages .msg.assistant').length);
  if (asstCount < 1) fail('③助手占位气泡未建立');
  else ok('③助手占位气泡已建立');
  const progressText = await page.evaluate(() => document.getElementById('reqRetroProgress')?.textContent || '');
  if (!/\[1\/2\]|逐会话小结中/.test(progressText)) fail(`③归档页进度块未显示进度：${JSON.stringify(progressText)}`);
  else ok(`③归档页进度块显示：${JSON.stringify(progressText.slice(0, 40))}`);
  assertNoErrors('①②③ 首步');

  // ── 驱动 map ×2 + reduce ×1 ──
  await driveOneRun(page, '会话甲小结：注意 A 问题', 1);
  await driveOneRun(page, '会话乙小结：注意 B 问题', 2);
  // reduce 回复带 PITFALLS 标记块 → 触发预览弹层
  const reduceReply = '整体复盘报告正文。\n<!-- PITFALLS-BEGIN -->\n- [前端] 别再踩 A\n- [后端] 别再踩 B\n<!-- PITFALLS-END -->';
  await driveOneRun(page, reduceReply, 3);

  // ④ reduce 真的跑到了（字段 bug 修好的直接证据：老代码会在这里 toast「reduce 阶段失败」）
  // 选择器必须精确到 textareaDialog 自己的 textarea：页面里还有目录选择弹层等其它 .mask，
  // 用 .mask 会命中错的那个（实测取到「选择工作目录」）
  await page.waitForSelector('.textarea-dialog', { state: 'visible', timeout: 10000 }).catch(() => {});
  const maskText = await page.evaluate(() => document.querySelector('.textarea-dialog')?.value || '');
  if (!/别再踩 A/.test(maskText)) fail(`④避坑清单预览未出现或内容不对（.content/.text 字段 bug 未修？）：${JSON.stringify(maskText.slice(0, 200))}`);
  else ok('④reduce 完成并弹出避坑清单预览，条目解析正确');
  // 关掉弹层（点取消/遮罩关闭按钮）
  await page.evaluate(() => {
    const ta = document.querySelector('.textarea-dialog');
    ta?.closest('.mask')?.querySelector('.cancel')?.click();
  });
  await page.waitForTimeout(300);
  assertNoErrors('④reduce');

  // ⑤ 汇总跑完后，归档页出现「查看汇总会话」入口
  await page.evaluate(async (id) => {
    const mod = await import('/js/req-view.js');
    await mod.openRequirement(id);
  }, created.id);
  await page.waitForSelector('.req-archiving-page', { state: 'visible', timeout: 5000 });
  if (!(await page.isVisible('.req-retro-view-btn'))) fail('⑤汇总后归档页仍没有「查看汇总会话」入口');
  else ok('⑤归档页出现「查看汇总会话」入口');
  const doneProgress = await page.evaluate(() => document.getElementById('reqRetroProgress')?.textContent || '');
  if (!/汇总完成/.test(doneProgress)) fail(`⑤进度块未显示完成态：${JSON.stringify(doneProgress)}`);
  else ok('⑤进度块显示「汇总完成」');

  // ⑥ 入口可点且能回到 retro 会话，且汇总内容还在（实时期间已落库）
  await page.click('.req-retro-view-btn');
  await page.waitForTimeout(800);
  const backInConv = await page.evaluate(() => ({
    inChat: !document.querySelector('.panel-view')?.hidden === false,
    userSteps: [...document.querySelectorAll('#messages .msg.user .bubble')].filter((b) => /\[\d\/2\]|\[汇总\]/.test(b.innerText)).length,
    hasSummary: [...document.querySelectorAll('#messages .msg.assistant .bubble')].some((b) => /小结|复盘/.test(b.innerText)),
  }));
  if (backInConv.userSteps < 3) fail(`⑥回看时汇总步骤气泡不全（应有 2 个 map + 1 个 reduce，实际 ${backInConv.userSteps}）`);
  else ok(`⑥回看汇总会话：${backInConv.userSteps} 个步骤气泡在场`);
  if (!backInConv.hasSummary) fail('⑥回看时看不到助手的小结/复盘内容');
  else ok('⑥回看时助手小结内容在场');
  assertNoErrors('⑤⑥入口');
} catch (e) {
  fail('测试异常：' + (e && e.stack ? e.stack : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child) child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures) { console.error(`\n❌ E2E FAIL（${failures} 处）`); process.exit(1); }
console.log('\n✅ E2E PASS：优化汇总全程可见、字段 bug 已修、进度与回看入口就位');
