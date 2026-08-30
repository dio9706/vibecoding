/**
 * 「不许自动切会话/切视图」回归。
 *
 * 用户实测反馈：任务完成或其他场景下经常被自动切走会话。其中一条根因在 req 文档页的 3s busy 轮询：
 * 自杀判定 `!isReqViewActive()` 在 fetch **之前**，渲染发生在 fetch **之后**，中间只补查 reqEpoch——
 * 而 reqEpoch 只由 openRequirement 自增，用户点侧栏切走根本不改它。于是一次 phase 推进
 * （review→dev）就会把正在别处干活的用户拽进需求会话。
 *
 * 本测试自起独立 web 服务器（临时 APP_DATA_DIR + 随机空闲端口），范式同 e2e-req-review.mjs，
 * 不触碰 pm2 的 principal-web（真实会话数据不可污染）。全程零 Claude 调用（不跑 docgen/finalize，
 * phase 与 busy 都靠直改磁盘注入）。
 *
 * 覆盖：
 *  ① 后台轮询不许拽人：用户离开 req 文档页（切到设置面板）后，phase 推进到 dev 不得改变当前视图
 *  ② 手势仍须导航：用户主动点开该 dev 期需求，必须进入聊天视图并挂上需求横幅
 *  ③ 守卫不得过度：用户**留在** req 文档页时，phase 推进应当照常把他带进聊天视图
 *
 * 运行：node tests/e2e-no-auto-switch.mjs
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

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL: ' + msg); };
const ok = (msg) => console.log('  ✔ ' + msg);

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
    try { if ((await fetch(baseUrl + '/api/ping')).ok) return true; } catch { /* 还没监听上 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const port = await findFreePort();
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-auto-switch-e2e-'));
// 预置「已配置用户」settings：空数据目录会被 onboarding 判为新用户，
// 引导罩覆盖全屏后所有点击都被拦截（详见 helpers.mjs 的说明）。
seedConfiguredSettings(dataDir);
const reqFile = path.join(dataDir, 'requirements.json');

function writeReqFileAtomic(data) {
  const tmp = reqFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, reqFile);
}
function patchReqOnDisk(id, mutate) {
  const data = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  mutate(data.find((r) => r.id === id));
  writeReqFileAtomic(data);
}

const FAKE_PROJECTS = {
  frontend: { dir: 'D:/e2e-fake/ui', dev: true },
  backend: null,
};

async function createReq(title) {
  const r = await fetch(BASE + '/api/req/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return r.json();
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

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
  });
  const assertNoErrors = (stage) => {
    if (pageErrors.length) { fail(`${stage} 阶段页面错误：\n  ` + pageErrors.join('\n  ')); pageErrors.length = 0; }
  };
  const activeView = () => page.evaluate(() => {
    const p = [...document.querySelectorAll('.panel-page')].find((el) => !el.hidden);
    if (p) return p.dataset.view;
    return document.querySelector('.app.in-panel') ? 'panel?' : 'chat';
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600);
  assertNoErrors('启动');

  // ── ① 后台轮询不许把离开的人拽回来 ──────────────────────────────
  // 造一个 busy 的评审期需求：busy 非空 → 点开后前端启动 3s 轮询（这是 bug 的载体）
  const bgTitle = 'E2E 后台推进需求 ' + Date.now();
  const bgReq = await createReq(bgTitle);
  patchReqOnDisk(bgReq.id, (r) => {
    r.projects = FAKE_PROJECTS;
    r.busy = { kind: 'docgen', startedAt: new Date().toISOString() };
  });
  await page.evaluate(async (id) => {
    const mod = await import('/js/req-view.js');
    await mod.refreshReqList();
    await mod.openRequirement(id); // 用户手势：进 req 文档页并启动 busy 轮询
  }, bgReq.id);
  await page.waitForSelector('.panel-page[data-view="req"]', { state: 'visible', timeout: 5000 });
  if ((await activeView()) !== 'req') fail('①前置：未进入 req 文档页');

  // ★ 精确复现危险窗口。
  // 光是「切走后等一个 tick」测不出问题：老代码 tick 头部的 !isReqViewActive() 自杀检查会拦住。
  // 真正的盲区是 **fetch 已发出、响应还没回来** 的那一瞬间用户切走 —— 那时头部检查早已过去，
  // 而 await 之后只补查了 reqEpoch（用户点侧栏/切面板都不改它）。于是把 /api/req/get 挂住，
  // 在挂住期间切视图，再放行响应，就把这个窄窗口拉成了确定性场景。
  let releaseFetch = null;
  let onFetchStarted = null;
  const fetchStarted = new Promise((r) => { onFetchStarted = r; });
  let intercepted = false;
  await page.route('**/api/req/get*', async (route) => {
    if (intercepted) return route.continue(); // 只挂住第一次，后续轮询正常放行
    intercepted = true;
    onFetchStarted();
    await new Promise((r) => { releaseFetch = r; });
    return route.continue();
  });

  // 后台推进：phase → dev（响应放行后，老代码会 openRequirementChat → openConv → _goChat）
  patchReqOnDisk(bgReq.id, (r) => { r.phase = 'dev'; r.busy = null; });
  await fetchStarted; // 轮询 tick 的 fetch 已在飞行中（头部自杀检查已通过）
  // 就在此刻用户切走：切到设置面板
  await page.evaluate(() => window.__showView?.('settings'));
  await page.evaluate(() => document.querySelector('#settingsBtn, [data-view-btn="settings"]')?.click());
  await page.waitForTimeout(150);
  const viewBefore = await activeView();
  if (viewBefore === 'req') {
    fail('①前置：无法离开 req 文档页，本用例无效');
    if (releaseFetch) releaseFetch();
  } else {
    ok(`①前置：fetch 在飞行中时用户已切走，当前视图=${viewBefore}`);
    if (releaseFetch) releaseFetch(); // 放行响应 → applyFetchedReq 落地
    await page.waitForTimeout(1200);
    const viewAfter = await activeView();
    if (viewAfter !== viewBefore) fail(`①迟到响应把视图从 ${viewBefore} 拽到了 ${viewAfter}（不该发生）`);
    else ok(`①迟到响应落地后视图未变（仍为 ${viewAfter}）`);
    const convAfter = await page.evaluate(() => document.querySelector('#convList .conv-item.active')?.dataset.convId || null);
    if (convAfter) fail(`①迟到响应顺带切了会话：${convAfter}`);
    else ok('①迟到响应没有切换会话');
  }
  await page.unroute('**/api/req/get*');
  assertNoErrors('①后台轮询迟到响应');

  // ── ② 手势仍须导航（守卫不能把正常功能挡掉）──────────────────────
  await page.evaluate(async () => {
    const mod = await import('/js/req-view.js');
    await mod.refreshReqList();
  });
  await page.waitForTimeout(200);
  // 侧栏是「对话/需求」双模式（2026-08-25 改版）：默认停在对话态，此时 #reqList 是 hidden 的，
  // 直接点 .req-item 会一直等到超时（元素在 DOM 里但不可见）。先切到需求态。
  await page.click('.switch-btn[data-target="req"]');
  await page.waitForSelector('.req-item', { state: 'visible', timeout: 5000 });
  await page.click(`.req-item:has-text("${bgTitle}")`);
  await page.waitForSelector('#reqBanner', { state: 'visible', timeout: 5000 });
  const viewGesture = await activeView();
  if (viewGesture !== 'chat') fail(`②手势点开 dev 期需求应进聊天视图，实际=${viewGesture}`);
  else ok('②手势点开 dev 期需求 → 进入聊天视图 + 需求横幅已挂');
  assertNoErrors('②手势导航');

  // ── ③ 守卫不得过度：用户留在文档页时，phase 推进应当照常带他走 ─────
  const stayTitle = 'E2E 在场推进需求 ' + Date.now();
  const stayReq = await createReq(stayTitle);
  patchReqOnDisk(stayReq.id, (r) => {
    r.projects = FAKE_PROJECTS;
    r.busy = { kind: 'docgen', startedAt: new Date().toISOString() };
  });
  await page.evaluate(async (id) => {
    const mod = await import('/js/req-view.js');
    await mod.refreshReqList();
    await mod.openRequirement(id);
  }, stayReq.id);
  await page.waitForSelector('.panel-page[data-view="req"]', { state: 'visible', timeout: 5000 });
  if ((await activeView()) !== 'req') fail('③前置：未进入 req 文档页');
  patchReqOnDisk(stayReq.id, (r) => { r.phase = 'dev'; r.busy = null; });
  await page.waitForTimeout(4200);
  const viewStay = await activeView();
  if (viewStay !== 'chat') fail(`③用户在场时 phase 推进应带他进聊天视图，实际=${viewStay}（守卫过严）`);
  else ok('③用户留在文档页 → phase 推进照常带入聊天视图');
  assertNoErrors('③在场跟随');
} catch (e) {
  fail('测试异常：' + (e && e.stack ? e.stack : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child) child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures) {
  console.error(`\n❌ E2E FAIL（${failures} 处）`);
  process.exit(1);
}
console.log('\n✅ E2E PASS：后台刷新不再自动切会话/切视图，用户手势与在场跟随均正常');
