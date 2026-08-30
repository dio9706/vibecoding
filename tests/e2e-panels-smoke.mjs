/**
 * 面板级冒烟回归：遍历全部视图/设置 tab/模型弹层/侧栏开关，全程零 pageerror。
 * 作为 app.js 拆分重构的安全网：module 化 + 严格模式的运行时破坏（隐式全局赋值等）
 * 在任何一步交互中抛错都会被捕获。须先起 localhost:3000（pm2 principal-web）。
 * 运行：node tests/e2e-panels-smoke.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3000';
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  // 仅收集真实运行错误；网络类 console.error（ping 探测等）不算
  if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
});
const assertNoErrors = (stage) => {
  if (pageErrors.length) {
    fail(`${stage} 阶段出现页面错误：\n  ` + pageErrors.join('\n  '));
    pageErrors.length = 0;
  }
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); // 不等 CDN 资源（animejs）：module 脚本在 DCL 前已执行
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600); // 等启动初始化（设置拉取/轮询首轮）
  assertNoErrors('启动');

  // 设置页全部 tab
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsTabs', { state: 'visible', timeout: 3000 });
  // tab 列表**从 DOM 动态读取**，不写死。
  // 教训（2026-08-28）：这里原先硬编码 ['basic','lark','messages','tokens',...]，
  // 而 lark / messages / tokens 三个 tab 早已在重构中消失、又新增了 claude / custom / desktop。
  // 结果本门禁长期卡在 `waiting for button[data-tab="lark"]` 超时失败，
  // 而它不在 `npm test` 里、只能手动跑，于是**没人发现安全网已经锈掉**。
  // 必须按可见性过滤：`desktop` tab 带 hidden 属性，只在 Tauri 桌面版才显出来，
  // 浏览器里点它会一直等到超时。offsetParent 判可见比查 hidden 属性可靠 ——
  // 隐藏也可能是 CSS 控制的。
  const tabs = await page.$$eval('#settingsTabs button[data-tab]', (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => e.dataset.tab),
  );
  // 下限断言不可省：选择器一旦失效会返回空数组，for 循环直接跳过 → 假绿通过。
  if (tabs.length < 3) fail(`设置 tab 只读到 ${tabs.length} 个（${tabs.join(',')}），选择器可能已失效`);
  for (const tab of tabs) {
    await page.click(`#settingsTabs button[data-tab="${tab}"]`);
    const visible = await page.isVisible(`.set-tab[data-tab="${tab}"]`);
    if (!visible) fail(`设置 tab ${tab} 未显示`);
  }
  console.log(`  设置 tab 已遍历 ${tabs.length} 个: ${tabs.join(', ')}`);
  assertNoErrors('设置页');

  // 需求/故障、访问日志、JSON 工具视图
  await page.click('#taskBtn');
  if (!(await page.isVisible('.panel-page[data-view="tasks"]'))) fail('tasks 视图未显示');
  await page.click('#logBtn');
  await page.waitForTimeout(300); // 日志拉取
  if (!(await page.isVisible('.panel-page[data-view="logs"]'))) fail('logs 视图未显示');
  assertNoErrors('面板视图');

  // JSON 工具：切侧栏工具态 → 打开 → 贴 JSON → 格式化 → 出树
  await page.evaluate(() => window._setSidebarToolsMode?.(true));
  await page.click('#toolJson');
  await page.waitForSelector('.panel-page[data-view="json-tool"]', { state: 'visible', timeout: 3000 });
  await page.fill('#jsonInput', '{"a":[1,2,{"b":"中文"}],"ok":true}');
  await page.waitForTimeout(400); // input 解析有 250ms 防抖，须先等它落定
  await page.click('#jsonFormatBtn');
  await page.waitForTimeout(200);
  const treeText = await page.textContent('#jsonOutput');
  if (!treeText.includes('中文') || !treeText.includes('ok')) fail('JSON 树渲染异常: ' + treeText.slice(0, 80));
  await page.evaluate(() => window._setSidebarToolsMode?.(false));
  await page.click('.panel-page[data-view="json-tool"] .panel-close'); // 回对话，否则 fab/输入区隐藏
  await page.waitForTimeout(200);
  assertNoErrors('JSON 工具');

  // 模型 fab 弹层
  await page.click('#modelFabBtn');
  if (!(await page.isVisible('#modelPop'))) fail('模型弹层未打开');
  const pills = await page.$$('#modelPills button');
  if (pills.length < 4) fail('模型 pills 数量异常: ' + pills.length);
  await page.click('#modelFabBtn'); // 收起
  assertNoErrors('模型弹层');

  // 工作目录弹层：开 → 等目录列表 → 关
  await page.click('#dirBtn');
  await page.waitForSelector('#dirMask', { state: 'visible', timeout: 3000 });
  await page.waitForTimeout(400); // 目录浏览接口往返
  await page.click('#dirClose');
  await page.waitForTimeout(150);
  if (await page.isVisible('#dirMask')) fail('目录弹层未关闭');
  assertNoErrors('目录弹层');

  // 侧栏开关往返
  await page.click('#sidebarToggleBtn');
  await page.waitForTimeout(200);
  await page.click('#sidebarToggleBtn');
  assertNoErrors('侧栏开关');

  // 输入框可交互（contenteditable 富输入；不真发送，避免烧额度）
  await page.click('#prompt');
  await page.keyboard.type('smoke 输入不发送');
  const v = await page.textContent('#prompt');
  if (!v.includes('smoke 输入不发送')) fail('输入框写入异常: ' + v);

  // 富文本粘贴降级纯文本：合成带 HTML 的粘贴事件，断言样式标签没进输入框
  const pasted = await page.evaluate(() => {
    const el = document.querySelector('#prompt');
    el.innerHTML = '';
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/html', '<b style="color:red">红字</b><h1>大标题</h1>');
    dt.setData('text/plain', '红字大标题');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { html: el.innerHTML, text: el.textContent };
  });
  if (/<(b|h1|span|style)\b/i.test(pasted.html)) fail('粘贴带入了样式标签: ' + pasted.html.slice(0, 80));
  if (!pasted.text.includes('红字大标题')) fail('纯文本粘贴内容丢失: ' + pasted.text);
  await page.evaluate(() => (document.querySelector('#prompt').innerHTML = ''));
  assertNoErrors('输入框');

  console.log(failures ? `E2E FAIL（${failures} 处）` : 'E2E PASS：全部面板遍历零页面错误');
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
