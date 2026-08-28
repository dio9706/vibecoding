/**
 * 需求视图（Task 8：侧栏「新需求」+ 评审设计期文档模式）e2e 回归。
 * 与其余 e2e-*.mjs 不同：本测试自起独立 web 服务器（临时 APP_DATA_DIR + 随机空闲端口），
 * 不触碰 pm2 的 principal-web —— 那是用户正在服务的真实会话，端口(3000)与数据目录都不可占用/污染。
 * server.js 本身已支持 PORT/APP_DATA_DIR 环境变量（见 src/shared/config.js、src/store/index.js），
 * 未对其做任何改动。
 *
 * 覆盖：
 *  ① 开页 + 侧栏「＋ 新需求」按钮存在，零 pageerror
 *  ② 点＋新需求 → 输入标题 → 创建 → 列表出现该需求 → 自动进入 req 视图
 *  ③ 配置弹层开 / 关
 *  ④ 空态「生成开发文档」按钮存在（不真跑 docgen，避免烧额度）
 *  ⑤ 补充说明框存在
 *  ⑥ 草稿保留回归：补充说明框输入文字后，触发一次非用户主动发起的整页重渲染（点历史折叠），
 *     断言草稿仍在（曾因 renderReqPage 整页重建清空 supplementDraftText 被判阻塞项）
 *  ⑦（Task 10）开发期聊天模式：直改数据文件把需求推到 dev 期 → 横幅工程芯片/「完成开发」按钮、
 *     右栏 API 文档区与设计准则输入框均正确渲染
 *  ⑧ 挂卸载往返：切普通对话卸载横幅/右栏，重开需求再现
 *  ⑧b 阶段流转确认弹窗正文非空回归（confirmDialog 传参形状），取消不流转
 *  ⑨ conv 回填：开发期首次打开自动创建并回填 convId
 *  ⑩（Task 12）测试期右栏 BUG 面板：直改数据文件推到 test 期并塞 3 条不同状态的 bug，断言面板
 *     计数/状态徽标/确认修复/忽略/重试按钮渲染正确、卡片顺序按 at 倒序排列；点 failed 卡的
 *     ［忽略］（唯一安全操作）验证状态流转生效
 *  ⑪ 测试期轮询跟进回归：直改数据文件把 doubt 卡置 fixing（不经真实巡检/修复），断言 ≤4.5s 内
 *     徽标随轮询自动变为「修复中」——验证测试期轮询条件已扩到"存在未终态 bug"而不仅是 busy
 *  ⑫（Task 13）归档期：直改数据文件把需求推到 archiving 期 → 重开 → 断言归档表单（备注框/确认按钮/
 *     「对话已禁用」提示）渲染正确 → 填备注确认归档（confirmDialog 确认）→ 断言视图变只读档案页
 *     （含备注文本）、GET get 回读 phase=archived、侧栏「已归档」折叠组展开后可见该需求标题。
 *     归档流程零 Claude 调用（archiveRequirement 只做 git log + 落盘），e2e 安全可全程真跑。
 *
 * 运行：node tests/e2e-req-review.mjs
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
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};

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

const port = await findFreePort();
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-review-e2e-'));
const reqFile = path.join(dataDir, 'requirements.json');
/** 原子写：先写临时文件再 rename，消除与服务端 30s 轮询期间读取发生"撕裂读"的理论窗口 */
function writeReqFileAtomic(data) {
  const tmp = reqFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, reqFile);
}
/** 直改磁盘：按 id 找到需求，用 mutate(req) 就地改，原子写回，再触发前端刷新（server 每请求实时读盘） */
function patchReqOnDisk(id, mutate) {
  const data = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  mutate(data.find((r) => r.id === id));
  writeReqFileAtomic(data);
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

  const ready = await waitForReady(BASE);
  if (!ready) throw new Error('自起的 web 服务器未在 20s 内就绪，输出：\n' + serverOutput);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
  });
  const assertNoErrors = (stage) => {
    if (pageErrors.length) {
      fail(`${stage} 阶段出现页面错误：\n  ` + pageErrors.join('\n  '));
      pageErrors.length = 0;
    }
  };

  // ① 开页 + 侧栏「＋ 新需求」按钮存在
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600); // 等启动闸门内的初始化（含 initReqView 首次 refreshReqList）
  if (!(await page.isVisible('#sidebarNewReq'))) fail('侧栏「＋ 新需求」按钮未显示');
  assertNoErrors('启动');

  // ② 新建需求 → 列表出现 → 自动进入 req 视图
  const reqTitle = 'E2E 测试需求 ' + Date.now();
  await page.click('#sidebarNewReq');
  await page.waitForSelector('.mask .prompt-input', { state: 'visible', timeout: 3000 });
  await page.fill('.mask .prompt-input', reqTitle);
  await page.click('.mask .ok');
  await page.waitForSelector('.panel-page[data-view="req"]', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  const reqListText = await page.textContent('#reqList');
  if (!reqListText.includes(reqTitle)) fail('新建需求未出现在侧栏列表: ' + reqListText.slice(0, 160));
  if (!(await page.isVisible('.req-chips'))) fail('新建需求未自动进入评审期文档视图（芯片条未显示）');
  // 未生成开发文档前底部只应有空态的 [生成开发文档] 按钮，不得出现补充说明框（首次流程单入口）
  if (await page.isVisible('.req-supplement-box')) fail('未生成开发文档时不应显示补充说明框');
  if (!(await page.isVisible('.req-doc-empty button'))) fail('未生成开发文档时应显示 [生成开发文档] 按钮');
  assertNoErrors('新建需求');

  // ③ 配置弹层开 / 关
  await page.click('.req-edit-config-btn');
  await page.waitForSelector('.req-config-modal', { state: 'visible', timeout: 3000 });
  await page.click('.req-config-modal .close');
  await page.waitForTimeout(150);
  if (await page.isVisible('.req-config-modal')) fail('配置弹层未关闭');
  assertNoErrors('配置弹层');

  // ④ 空态「生成开发文档」按钮存在（不点击，避免真的触发 docgen 烧额度）
  if (!(await page.isVisible('.req-doc-empty button'))) {
    fail('空态「生成开发文档」按钮未显示');
  } else {
    const emptyBtnText = await page.textContent('.req-doc-empty button');
    if (!emptyBtnText.includes('生成开发文档')) fail('空态按钮文案不符: ' + emptyBtnText);
  }

  // ⑤ 生成出 v1 后才出现补充说明框：直改磁盘给该需求注入一个开发文档版本 + 配置，重开验证
  //（不真跑 docgen，避免烧额度；server 每请求实时读盘，直改即生效）
  const reviewList = await (await fetch(BASE + '/api/req/list')).json();
  const reviewReq = reviewList.requirements.find((r) => r.title === reqTitle);
  if (!reviewReq) throw new Error('步骤⑤：未在列表中找到刚建的评审期需求');
  const docPath = path.join(dataDir, 'requirements', reviewReq.id, 'dev-doc-v1.md');
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, '## 一、说人话总结\ne2e 注入文档\n\n## 二、详细设计\n略');
  patchReqOnDisk(reviewReq.id, (r) => {
    r.projects = { frontend: { dir: 'D:/e2e-fake/ui', dev: true }, backend: null };
    r.reqDoc = { name: '需求文档.md', path: docPath };
    r.devDoc = { versions: [{ v: 1, path: docPath, summary: 'e2e 注入文档', at: new Date().toISOString() }] };
  });
  await page.evaluate(async (id) => {
    const mod = await import('/js/req-view.js');
    await mod.refreshReqList();
    await mod.openRequirement(id);
  }, reviewReq.id);
  await page.waitForSelector('.req-supplement-textarea', { state: 'visible', timeout: 5000 });
  if (!(await page.isVisible('.req-supplement-footer button.primary'))) fail('提交补充说明按钮未显示');
  if (!(await page.isVisible('.req-doc-vtab'))) fail('v1 版本页签未显示');
  assertNoErrors('文档区/补充框');

  // ⑥ 回归：输入草稿文字 → 触发一次非用户主动发起的整页重渲染（点「补充说明历史」折叠）
  //    → 断言草稿仍在（阻塞项修复：renderReqPage 整页重建不得清空未提交的补充说明草稿）
  const draftText = '这是一段未提交的补充说明草稿 ' + Date.now();
  await page.fill('.req-supplement-textarea', draftText);
  await page.click('.req-supplement-history-toggle'); // 折叠态切换 → renderReqPage(currentReq) 整页重建
  await page.waitForTimeout(150);
  const draftAfterToggle = await page.inputValue('.req-supplement-textarea');
  if (draftAfterToggle !== draftText) fail('补充说明草稿在历史折叠重渲染后丢失: ' + draftAfterToggle);
  assertNoErrors('草稿保留回归');

  // ⑦（Task 10）开发期聊天模式：直改数据文件把一个需求推到 dev 期（不真跑 docgen/finalize——
  //    finalize 需要真实 git 仓库，e2e 不具备；server 每次请求实时读盘，直改 json 即可生效）
  const devTitle = 'E2E 开发期需求 ' + Date.now();
  const createResp = await fetch(BASE + '/api/req/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: devTitle }),
  });
  const devReq = await createResp.json();
  patchReqOnDisk(devReq.id, (target) => {
    target.phase = 'dev';
    target.projects = { frontend: { dir: 'D:/e2e-fake/ui', dev: true }, backend: { dir: 'D:/e2e-fake/server', dev: false } };
  });

  // refreshReqList 是 30s 轮询，直改数据后主动触发一次刷新（页面模块可动态 import）
  await page.evaluate(async () => {
    const mod = await import('/js/req-view.js');
    await mod.refreshReqList();
  });
  await page.waitForTimeout(200);
  await page.click(`.req-item:has-text("${devTitle}")`);
  await page.waitForSelector('#reqBanner', { state: 'visible', timeout: 5000 });
  const bannerText = await page.textContent('#reqBanner');
  if (!bannerText.includes('ui · 开发')) fail('横幅缺前端工程芯片: ' + bannerText.slice(0, 120));
  if (!bannerText.includes('server · 只读')) fail('横幅缺后端工程芯片: ' + bannerText.slice(0, 120));
  if (!bannerText.includes('完成开发')) fail('横幅缺「完成开发」按钮: ' + bannerText.slice(0, 120));
  if (!(await page.isVisible('#reqRail'))) fail('开发期右栏未显示');
  const railText = await page.textContent('#reqRail');
  if (!railText.includes('API 文档')) fail('右栏缺 API 文档区: ' + railText.slice(0, 120));
  if (!(await page.isVisible('.req-guidelines'))) fail('右栏缺设计准则输入框');
  assertNoErrors('开发期横幅/右栏');

  // ⑧ 切到普通新对话 → 横幅/右栏卸载；重开需求 → 再现
  await page.click('#sidebarNew');
  await page.waitForTimeout(200);
  if (await page.isVisible('#reqBanner')) fail('切普通对话后横幅未卸载');
  if (await page.isVisible('#reqRail')) fail('切普通对话后右栏未卸载');
  await page.click(`.req-item:has-text("${devTitle}")`);
  await page.waitForSelector('#reqBanner', { state: 'visible', timeout: 5000 });
  assertNoErrors('挂卸载往返');

  // ⑧b 阶段按钮确认弹窗正文非空（曾因 confirmDialog 误传字符串导致正文空白被判阻塞）→ 取消不流转
  await page.click('.req-phase-btn');
  await page.waitForSelector('.mask .confirm-msg', { state: 'visible', timeout: 3000 });
  const confirmMsg = (await page.textContent('.mask .confirm-msg')).trim();
  if (!confirmMsg) fail('阶段流转确认弹窗正文为空（confirmDialog 传参形状回归）');
  if (!confirmMsg.includes('测试期')) fail('确认弹窗文案不符: ' + confirmMsg);
  await page.click('.mask .cancel');
  await page.waitForTimeout(150);
  const stillDev = await (await fetch(BASE + '/api/req/get?id=' + devReq.id)).json();
  if (stillDev.phase !== 'dev') fail('取消确认后 phase 不应流转: ' + stillDev.phase);
  assertNoErrors('阶段按钮确认弹窗');

  // ⑨ conv 回填：后端记录应已绑定 convId（openRequirementChat 首次进入时创建并回填）
  const bound = await (await fetch(BASE + '/api/req/get?id=' + devReq.id)).json();
  if (!bound.convId) fail('开发期首次打开未回填 convId');

  // ⑩（Task 12）测试期右栏 BUG 面板：直改数据文件把该需求推到 test 期并塞 3 条不同状态的 bug
  //     （一条 sure/fixed、一条 doubt/pending 带 reason、一条 failed）→ 重开需求 → 断言面板/卡片/
  //     按钮渲染正确。重新从磁盘读取（而非复用步骤⑦的旧内存副本）以保留期间服务端已回填的 convId。
  //     e2e 红线：绝不点确认修复/重试/开始巡检（会真入队 bug-fix，泵会真派发 Claude 调用）——
  //     全程只点「忽略」，这是纯状态流转、无副作用的唯一安全操作。
  const reqData2 = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  const target2 = reqData2.find((r) => r.id === devReq.id);
  target2.phase = 'test';
  target2.busy = null;
  target2.bugs = [
    {
      id: 'b_e2e_fixed', recordId: 'rec_fixed', title: 'BUG-已修复项',
      detail: '这是已修复 BUG 的详情文本', verdict: 'sure', reason: '', status: 'fixed',
      at: new Date(Date.now() - 3000).toISOString(),
    },
    {
      id: 'b_e2e_doubt', recordId: 'rec_doubt', title: 'BUG-待确认项',
      detail: '这是疑问态 BUG 的详情文本', verdict: 'doubt', reason: '怀疑是产品预期行为，需人工确认', status: 'pending',
      at: new Date(Date.now() - 2000).toISOString(),
    },
    {
      id: 'b_e2e_failed', recordId: 'rec_failed', title: 'BUG-修复失败项',
      detail: '这是修复失败 BUG 的详情文本', verdict: 'sure', reason: '', status: 'failed',
      at: new Date(Date.now() - 1000).toISOString(),
    },
  ];
  writeReqFileAtomic(reqData2);

  await page.click('#sidebarNew');
  await page.waitForTimeout(150);
  await page.click(`.req-item:has-text("${devTitle}")`);
  await page.waitForSelector('#reqBanner', { state: 'visible', timeout: 5000 });
  const testBannerText = await page.textContent('#reqBanner');
  if (!testBannerText.includes('测试通过')) fail('测试期横幅缺「✅ 测试通过」按钮: ' + testBannerText.slice(0, 120));

  const railText2 = await page.textContent('#reqRail');
  if (!railText2.includes('BUG 面板（3）')) fail('右栏缺「BUG 面板（3）」计数: ' + railText2.slice(0, 160));
  if (!(await page.isVisible('.req-bitable-form input'))) fail('贴表格链接输入框未显示');
  if (!(await page.isVisible('.req-bitable-form button'))) fail('开始巡检按钮未显示');

  const cardCount = await page.locator('.req-bug-card').count();
  if (cardCount !== 3) fail('BUG 卡片数量不为 3: ' + cardCount);

  // 倒序断言：renderTestRail 按 at 降序排列（req-chat.js sorted = [...bugs].sort((a,b)=>new Date(b.at)-new Date(a.at))）。
  // 种子三条 bug 的 at 依次为 now-3000ms（已修复）/ now-2000ms（待确认）/ now-1000ms（修复失败），
  // 即修复失败最新、已修复最旧，渲染顺序应为：修复失败 → 待确认 → 已修复
  const bugTitleOrder = await page.$$eval('.req-bug-card .req-bug-title', (els) => els.map((el) => el.textContent));
  const expectedBugOrder = ['BUG-修复失败项', 'BUG-待确认项', 'BUG-已修复项'];
  if (JSON.stringify(bugTitleOrder) !== JSON.stringify(expectedBugOrder)) {
    fail('BUG 卡片未按 at 倒序排列: ' + bugTitleOrder.join(','));
  }

  const badgeTexts = await page.locator('.req-bug-badge').allTextContents();
  if (!badgeTexts.includes('已修复')) fail('缺「已修复」状态徽标: ' + badgeTexts.join(','));
  if (!badgeTexts.includes('待确认')) fail('缺「待确认」状态徽标: ' + badgeTexts.join(','));
  if (!badgeTexts.includes('修复失败')) fail('缺「修复失败」状态徽标: ' + badgeTexts.join(','));

  const doubtCard = page.locator('.req-bug-card', { hasText: 'BUG-待确认项' });
  if (!(await doubtCard.locator('button:has-text("确认修复")').isVisible())) fail('doubt 卡缺「确认修复」按钮');
  if (!(await doubtCard.locator('button:has-text("忽略")').isVisible())) fail('doubt 卡缺「忽略」按钮');
  const failedCard = page.locator('.req-bug-card', { hasText: 'BUG-修复失败项' });
  if (!(await failedCard.locator('button:has-text("重试")').isVisible())) fail('failed 卡缺「重试」按钮');
  if (!(await failedCard.locator('button:has-text("忽略")').isVisible())) fail('failed 卡缺「忽略」按钮');
  assertNoErrors('测试期 BUG 面板渲染');

  // 点 failed 卡的［忽略］（唯一安全可点操作——不点 doubt 卡是特意的：doubt 卡留着 pending
  // 给下面⑪的轮询回归当活体，忽略/确认/重试都会改它的状态，谁先动它谁就把⑪的前提条件破坏了）
  await failedCard.locator('button:has-text("忽略")').click();
  await page.waitForTimeout(300);
  const failedCardAfter = page.locator('.req-bug-card', { hasText: 'BUG-修复失败项' });
  const failedBadgeAfter = (await failedCardAfter.locator('.req-bug-badge').textContent()).trim();
  if (failedBadgeAfter !== '已忽略') fail('忽略后徽标未变为「已忽略」: ' + failedBadgeAfter);
  if (await failedCardAfter.locator('button').count() !== 0) fail('忽略后按钮未消失');
  assertNoErrors('忽略 BUG 操作');

  // ⑪ 测试期轮询跟进回归：doubt 卡此刻仍是 verdict=doubt/status=pending（未被上一步动过），
  // 直改数据文件把它置 fixing——模拟"确认修复后泵已接手"这一真实会发生、但 e2e 红线不能真触发
  // 的中间态。测试期轮询条件已从"仅 busy"扩到"busy 或存在 pending/fixing 的 bug"（req-chat.js
  // shouldPoll），此刻 busy 仍是 null，若轮询没跟上，4.5s 内徽标不会变。
  const reqData3 = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  const target3 = reqData3.find((r) => r.id === devReq.id);
  const doubtBug = target3.bugs.find((b) => b.id === 'b_e2e_doubt');
  doubtBug.status = 'fixing';
  writeReqFileAtomic(reqData3);

  try {
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('.req-bug-card')];
        const c = cards.find((el) => el.textContent.includes('BUG-待确认项'));
        return !!c && c.querySelector('.req-bug-badge')?.textContent === '修复中';
      },
      { timeout: 4500 },
    );
  } catch {
    fail('测试期轮询未在 4.5s 内把 doubt 卡刷新为「修复中」（轮询条件扩展回归）');
  }
  assertNoErrors('测试期轮询跟进回归');

  // ⑫（Task 13）归档期：直改数据文件把该需求从测试期推到归档中期（branches 留空数组，
  //     archiveRequirement 零 git 依赖）→ 重开 → 断言归档表单渲染 → 提交 → 断言只读档案页/回读/侧栏分组
  const reqData4 = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  const target4 = reqData4.find((r) => r.id === devReq.id);
  target4.phase = 'archiving';
  target4.busy = null;
  writeReqFileAtomic(reqData4);

  await page.click('#sidebarNew');
  await page.waitForTimeout(150);
  await page.click(`.req-item:has-text("${devTitle}")`);
  await page.waitForSelector('.req-archive-note-textarea', { state: 'visible', timeout: 5000 });
  if (!(await page.isVisible('.req-archive-confirm-btn'))) fail('归档表单缺「确认归档」按钮');
  const archiveHintText = await page.textContent('.req-archive-hint');
  if (!archiveHintText.includes('对话已禁用')) fail('归档表单缺「对话已禁用」提示: ' + archiveHintText);
  assertNoErrors('归档表单渲染');

  const archiveNote = 'E2E 归档备注 ' + Date.now();
  await page.fill('.req-archive-note-textarea', archiveNote);
  await page.click('.req-archive-confirm-btn');
  await page.waitForSelector('.mask .confirm-msg', { state: 'visible', timeout: 3000 });
  await page.click('.mask .ok');
  await page.waitForSelector('.req-archived-page', { state: 'visible', timeout: 5000 });

  const archivedPageText = await page.textContent('.req-archived-page');
  if (!archivedPageText.includes(archiveNote)) fail('归档只读页未显示提交的备注文本: ' + archivedPageText.slice(0, 200));

  const archivedRecord = await (await fetch(BASE + '/api/req/get?id=' + devReq.id)).json();
  if (archivedRecord.phase !== 'archived') fail('归档后 GET get 回读 phase 不为 archived: ' + archivedRecord.phase);

  // 侧栏「已归档」折叠组：默认收起，点开后应出现该需求标题
  await page.click('.req-archived-toggle');
  await page.waitForTimeout(150);
  const archivedGroupText = await page.textContent('#reqList');
  if (!archivedGroupText.includes(devTitle)) fail('侧栏「已归档」折叠组展开后未见该需求标题: ' + archivedGroupText.slice(0, 200));
  assertNoErrors('归档流程');

  console.log(failures ? `E2E FAIL（${failures} 处）` : 'E2E PASS：需求视图（评审期文档模式 + 开发期聊天模式 + 归档期）全流程零页面错误');
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + (e && e.message ? e.message : e));
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
