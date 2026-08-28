/**
 * 会话飞书通知（🔔 开关 + 补充内容收件箱轮询）e2e 回归门禁。
 *
 * 守的两条不变量 ——
 * ① **收件箱认领语义：认领即删**。/claim 一旦收到某个 id，服务端就把它从收件箱抹掉、
 *    此后不再下发。所以只有 applyInjectedItems 返回的「**真正上了屏**的 id」才允许拿去 claim；
 *    对空数组（或没上屏的 id）调 claim，等于把用户在飞书里敲进来的那句补充内容永久蒸发 ——
 *    既没进对话、也无处可查，且不可逆。本门禁因此专门断言「空 items 轮次不得调 /claim」。
 * ② **ok:false 不得点亮按钮**。/on 在「缺 myFeishuOpenId」「没有启用中的机器人」时回的是
 *    200 + {ok:false, error}（故意不用 4xx，好让前端弹出可执行的下一步）。这是配置缺失而非
 *    请求失败，此时若把按钮点亮，用户会以为通知已生效、实际一条也发不出去，任务跑完只剩沉默 ——
 *    这种「假成功」比直接报错更难被发现，所以断言必须同时覆盖「不加 .on」和「不写 meta」。
 *
 * 与 tests/e2e-req-review.mjs 同范式：自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR +
 * 内核分配的空闲端口），**绝不触碰 pm2 的 principal-web** —— 3000 端口与仓库根数据目录是用户
 * 正在服务的真实会话，既不可占用也不可污染。server.js 未做任何改动，PORT / APP_DATA_DIR
 * 是它本就支持的入口（见 src/shared/config.js、src/store/index.js）。
 * 端口默认走 listen(0) 由内核分配（拿号即放），比写死一个「不常用端口」更不可能与人撞；
 * 需要固定端口时用 E2E_PORT 覆盖。
 *
 * 三阶段共用一个服务端进程，各开独立 browser context 拿干净的 localStorage：
 *  ① 未配飞书 —— 结构断言（按钮在 composer 上方、排在 #modelFab 之前）+ 点击只弹 toast，
 *                不点亮、不写 meta
 *  ② 配好飞书 —— 点亮 + 写 meta + 服务端登记表收到完整快照；切走变灰、切回仍亮；
 *                桩掉 /inbox 投一条 → 用户气泡上屏 + /claim 被调用；空 items 轮次不调 claim
 *  ③ 真链路   —— 全程不打桩：直接往服务端 conv-notify.json 的收件箱塞一条，断言它上屏、
 *                且 /claim 真把服务端那条清空；再点一次按钮验证 /off 注销登记
 *
 * 阶段②③各需等一个 5s 轮询周期，整轮约 25s，属预期耗时。
 * 运行：node tests/e2e-conv-notify.mjs
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

const INJECT_TEXT_STUB = '来自飞书的补充内容XYZ';
const INJECT_TEXT_REAL = '真实收件箱补充内容ABC';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};
const step = (msg) => console.log('  ✔ ' + msg);

/** 找一个当前空闲端口：临时监听 0 号端口由内核分配后立即关闭，复用其号码给待起的子进程。 */
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-notify-e2e-'));
const settingsFile = path.join(dataDir, 'settings.json');
const notifyFile = path.join(dataDir, 'conv-notify.json');

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

  const ready = await waitForReady(BASE);
  if (!ready) throw new Error('自起的 web 服务器未在 20s 内就绪，输出：\n' + serverOutput);

  browser = await chromium.launch();

  // ---- 每阶段一个干净页面：addInitScript 先于页面脚本注入种子会话，免去 reload
  //      （reload 会中断在途 fetch，制造与被测代码无关的假 pageerror）----
  const seedInit = (preOn) => {
    const now = Date.now();
    const mk = (id, title, session, dt) => ({
      id,
      title,
      session,
      cwd: '', // 必须与 chat.js 的默认 cwd（localStorage.claude_cwd）一致，否则一窗一项目过滤会把它藏起来
      model: 'auto',
      effort: 'medium',
      mode: 'default',
      pinned: true, // 钉住 = 侧栏恒显，才点得到（否则 historyRange='used' 下新种子不入列表）
      provider: 'claude-agent',
      messages: [{ role: 'user', text: 'seed ' + id }],
      updatedAt: now - dt,
      meta: preOn && id === 'cA' ? { notifyFeishu: true } : undefined,
    });
    localStorage.setItem('claude_cwd', '');
    localStorage.setItem(
      'claude_convs',
      JSON.stringify([mk('cA', '会话A', 'sessA', 0), mk('cB', '会话B', 'sessB', 1000)]),
    );
    localStorage.setItem('claude_last_conv', 'cA');
  };

  /** 开一个带种子会话的新页面（独立 context = 独立 localStorage，阶段之间互不残留）。 */
  async function openPage({ preOn = false } = {}) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      // 只收真实运行错误；网络类 console.error（ping 探测等）不算
      if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) {
        pageErrors.push('[console] ' + m.text());
      }
    });
    page.assertNoErrors = (stage) => {
      if (pageErrors.length) {
        fail(`${stage} 阶段出现页面错误：\n  ` + pageErrors.join('\n  '));
        pageErrors.length = 0;
      } else {
        step(`${stage}：零 pageerror`);
      }
    };
    await page.addInitScript(seedInit, preOn);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#messages', { state: 'attached', timeout: 8000 });
    await page.waitForTimeout(1200); // 等启动闸门内的初始化 + openConv（setTimeout(0) 排在其后）
    return { ctx, page };
  }

  const isOn = (page) =>
    page.evaluate(() => document.querySelector('#notifyFabBtn')?.classList.contains('on'));
  const toastText = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('#toast-container .toast-msg')].map((e) => e.textContent).join(' | '),
    );
  const clearToasts = (page) =>
    page.evaluate(() => document.querySelectorAll('#toast-container .toast').forEach((e) => e.remove()));
  const convMeta = (page, id) =>
    page.evaluate(
      (cid) => JSON.parse(localStorage.getItem('claude_convs')).find((c) => c.id === cid)?.meta || null,
      id,
    );
  const clickConv = (page, id) => page.click(`#convList .conv-item[data-conv-id="${id}"]`);
  /** 轮询等待某段文字出现在**用户气泡**里（注入项必须是 user 角色，画进助手气泡即为 bug） */
  async function waitUserBubble(page, text, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const seen = await page.evaluate(
        (t) => [...document.querySelectorAll('#messages .msg.user .bubble')].some((b) => b.textContent.includes(t)),
        text,
      );
      if (seen) return Date.now() - t0;
      await page.waitForTimeout(250);
    }
    return -1;
  }

  // ==================== ① 未配飞书 ====================
  console.log('── ① 未配飞书：结构 + ok:false 语义 ──');
  {
    const { ctx, page } = await openPage();
    page.assertNoErrors('启动');

    if (!(await page.evaluate(() => !!document.querySelector('#fabRow #notifyFabBtn')))) {
      fail('#notifyFabBtn 不在 #fabRow 内');
    } else {
      step('#notifyFabBtn 位于 #fabRow 内');
    }
    if (!(await page.evaluate(() => !!window.__convNotify))) fail('window.__convNotify 桥未挂载');
    else step('window.__convNotify 桥已挂载');

    const geo = await page.evaluate(() => {
      const b = document.querySelector('#notifyFabBtn').getBoundingClientRect();
      const c = document.querySelector('footer.composer').getBoundingClientRect();
      const m = document.querySelector('#modelFab').getBoundingClientRect();
      return { btnBottom: b.bottom, composerTop: c.top, btnLeft: b.left, modelLeft: m.left, w: b.width, h: b.height };
    });
    if (!(geo.w > 0 && geo.h > 0)) fail('按钮不可见：' + JSON.stringify(geo));
    if (!(geo.btnBottom <= geo.composerTop + 1)) fail('按钮未位于输入框上方：' + JSON.stringify(geo));
    else step(`按钮在输入框上方（btnBottom=${geo.btnBottom.toFixed(1)} ≤ composerTop=${geo.composerTop.toFixed(1)}）`);
    if (!(geo.btnLeft < geo.modelLeft)) fail('按钮未排在 #modelFab 之前：' + JSON.stringify(geo));
    else step('按钮排在 #modelFab 之前');

    // 不变量②：缺 myFeishuOpenId → 200 + ok:false → 只弹 toast，不点亮、不写 meta
    await clearToasts(page);
    await page.click('#notifyFabBtn');
    await page.waitForTimeout(900);
    const t = await toastText(page);
    if (!t) fail('未配飞书时点按钮没有弹 toast');
    else if (!t.includes('open_id') && !t.includes('机器人')) fail('toast 未指出配置缺失原因：' + t);
    else step('弹出指路 toast：' + t);
    if (await isOn(page)) fail('【不变量②破坏】ok:false 时按钮被点亮');
    else step('按钮未点亮（无 .on）');
    const meta = await convMeta(page, 'cA');
    if (meta?.notifyFeishu) fail('【不变量②破坏】ok:false 时误写了 meta.notifyFeishu');
    else step('未写 meta.notifyFeishu：' + JSON.stringify(meta));
    page.assertNoErrors('未配飞书点击');
    await ctx.close(); // 关掉再写 settings，避免该页遗留的 ui-prefs 防抖写盘与下面的写入交错
  }

  // ==================== ② 配好飞书 ====================
  console.log('── ② 配好飞书：点亮 / 快照 / 切会话 / 轮询上屏 + claim ──');
  // 直写 settings.json：getSettings() 每次读盘无缓存，不必重启服务端
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      bots: [{ id: 'bot_t', name: 'T', platform: 'feishu', appId: 'a', appSecret: 's', enabled: true }],
      myFeishuOpenId: 'ou_test',
    }),
  );
  {
    const { ctx, page } = await openPage();
    page.assertNoErrors('启动');

    await clearToasts(page);
    await page.click('#notifyFabBtn');
    await page.waitForTimeout(900);
    if (!(await isOn(page))) fail('配好飞书后点击按钮未点亮');
    else step('按钮已点亮（.on），toast：' + (await toastText(page)));
    const metaA = await convMeta(page, 'cA');
    if (!metaA?.notifyFeishu) fail('meta.notifyFeishu 未写入：' + JSON.stringify(metaA));
    else step('meta 已写入：' + JSON.stringify(metaA));

    // 服务端登记表必须拿到完整快照：飞书侧靠 session/cwd/model/effort/mode 才能 resume 回原会话，
    // 缺一项就会在错误的目录/权限模式下起 run
    const entry = JSON.parse(fs.readFileSync(notifyFile, 'utf8')).cA;
    const wantSnap = { convId: 'cA', title: '会话A', session: 'sessA', cwd: '', model: 'auto', effort: 'medium', mode: 'default' };
    const badKeys = Object.keys(wantSnap).filter((k) => entry?.[k] !== wantSnap[k]);
    if (badKeys.length) fail('服务端登记表快照字段不符 ' + badKeys.join(',') + '：' + JSON.stringify(entry));
    else step('服务端登记表收到完整快照：' + JSON.stringify(wantSnap));

    await clickConv(page, 'cB');
    await page.waitForTimeout(600);
    if (await isOn(page)) fail('切到会话B 后按钮仍亮');
    else step('切到会话B → 按钮变灰');

    // 桩 /inbox：runId 留空以免触发 SSE 接流（本门禁不起真实 run）。三轮各打一个点 ——
    //  第 1 轮：一条正常项，验证上屏 + claim 走通；
    //  第 2 轮：一条 **text 为空** 的项 —— items 非空、但 applyInjectedItems 一条也上不了屏
    //          （它跳过无 text 的项），这正是 `!applied.length` 那道守卫唯一要拦的场景。
    //          注意不能用「空 items」来测这道守卫：空 items 在更早的 `!items.length` 就返回了，
    //          守卫删掉照样过 —— 这条曾在本门禁的初版里漏测（负向对照跑出来的）。
    //  第 3 轮起：空 items，顺带验证 5s 定时轮询确实还在跑。
    const claims = [];
    let inboxHits = 0;
    await page.route('**/api/conv-notify/inbox*', async (route) => {
      inboxHits++;
      const items =
        inboxHits === 1
          ? [{ id: 'inj_test1', text: INJECT_TEXT_STUB, runId: '', mode: 'run', at: Date.now() }]
          : inboxHits === 2
            ? [{ id: 'inj_blank', text: '', runId: '', mode: 'run', at: Date.now() }]
            : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ active: true, items }),
      });
    });
    await page.route('**/api/conv-notify/claim', async (route) => {
      claims.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await clickConv(page, 'cA');
    await page.waitForTimeout(600);
    if (!(await isOn(page))) fail('切回会话A 后按钮未复亮（会话级 meta 未还原）');
    else step('切回会话A → 按钮仍亮');

    const ms = await waitUserBubble(page, INJECT_TEXT_STUB, 5500);
    if (ms < 0) fail('5.5s 内注入内容未出现在用户气泡');
    else step(`注入内容 ${ms}ms 内出现在用户气泡（onConvOpened 的立即补拉）`);
    await page.waitForTimeout(600);
    if (!claims.length) fail('上屏后 /claim 未被调用');
    else if (claims[0].convId !== 'cA' || claims[0].ids?.[0] !== 'inj_test1') fail('claim 载荷不对：' + JSON.stringify(claims[0]));
    else step('/claim 被调用：' + JSON.stringify(claims));

    // 不变量①核心断言：第 2 轮的 items 非空但一条也没上屏 → 绝不能 claim
    const before = claims.length;
    const bubblesBefore = await page.evaluate(() => document.querySelectorAll('#messages .msg.user').length);
    await page.waitForTimeout(5600); // 跨过一个完整的 5s 轮询周期，吃到第 2 轮
    if (inboxHits < 2) {
      fail(`5s 定时轮询未触发（inbox 仅被请求 ${inboxHits} 次）`);
    } else if (claims.length !== before) {
      fail('【不变量①破坏】没上屏的注入项被 /claim 认领了（该内容将从服务端永久消失）：' + JSON.stringify(claims));
    } else {
      step(`未上屏的注入项未被 claim（5s 定时轮询已跑，inbox 共请求 ${inboxHits} 次）`);
    }
    const bubblesAfter = await page.evaluate(() => document.querySelectorAll('#messages .msg.user').length);
    if (bubblesAfter !== bubblesBefore) fail(`空 text 的注入项不该产生气泡（${bubblesBefore} → ${bubblesAfter}）`);
    else step('空 text 的注入项未产生气泡');

    // 空 items 轮次（第 3 轮起）同样不得 claim
    const before2 = claims.length;
    const hitsBefore2 = inboxHits;
    await page.waitForTimeout(5600);
    if (inboxHits <= hitsBefore2) fail(`轮询已停摆（inbox 仍停在 ${inboxHits} 次）`);
    else if (claims.length !== before2) fail('【不变量①破坏】空 items 轮次仍调用了 /claim：' + JSON.stringify(claims));
    else step(`空 items 轮次未调 /claim（inbox 共请求 ${inboxHits} 次）`);
    if (claims.some((c) => (c.ids || []).includes('inj_blank'))) fail('claim 载荷混入了未上屏的 inj_blank：' + JSON.stringify(claims));
    page.assertNoErrors('轮询');
    await ctx.close();
  }

  // ==================== ③ 真链路（不打任何桩）====================
  console.log('── ③ 真链路：服务端收件箱 → 上屏 → 真 claim 清空 → /off 注销 ──');
  // 直接往服务端登记表的收件箱塞一条（等价于飞书进程打过 /api/conv-notify/inject 后的落盘态，
  // 但不真的起 run —— 起 run 会烧额度且依赖 Claude 凭证）
  {
    const all = JSON.parse(fs.readFileSync(notifyFile, 'utf8'));
    all.cA.inbox = [{ id: 'inj_real1', text: INJECT_TEXT_REAL, runId: '', mode: 'run', at: Date.now() }];
    fs.writeFileSync(notifyFile, JSON.stringify(all, null, 2));
  }
  {
    const { ctx, page } = await openPage({ preOn: true });
    page.assertNoErrors('启动');
    if (!(await isOn(page))) fail('预置 meta.notifyFeishu 的会话开屏未点亮');
    else step('开屏按钮已亮（会话级 meta 还原）');

    const ms = await waitUserBubble(page, INJECT_TEXT_REAL, 5500);
    if (ms < 0) fail('5.5s 内真实收件箱内容未上屏');
    else step(`真实收件箱内容 ${ms}ms 内上屏`);

    await page.waitForTimeout(800);
    const after = await (await fetch(BASE + '/api/conv-notify/inbox?convId=cA')).json();
    if (after.items?.length) fail('/claim 后服务端收件箱未清空：' + JSON.stringify(after));
    else step('服务端收件箱已被真 /claim 清空：' + JSON.stringify(after));

    await clearToasts(page);
    await page.click('#notifyFabBtn');
    await page.waitForTimeout(900);
    if (await isOn(page)) fail('关闭后按钮仍亮');
    else step('再次点击 → 按钮变灰，toast：' + (await toastText(page)));
    const off = await (await fetch(BASE + '/api/conv-notify/inbox?convId=cA')).json();
    if (off.active) fail('/off 后服务端仍登记：' + JSON.stringify(off));
    else step('服务端登记已注销：' + JSON.stringify(off));
    page.assertNoErrors('真链路');
    await ctx.close();
  }

  console.log(
    failures
      ? `E2E FAIL（${failures} 处）`
      : 'E2E PASS：飞书通知开关 + 收件箱轮询全链路零页面错误（认领语义与 ok:false 语义均成立）',
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
