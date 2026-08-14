/**
 * 一窗一项目回归：种子多项目会话 → 断言侧栏仅显示本窗项目会话（无「其他项目」分组）、
 * 全程零 pageerror。跨项目开新窗（win_new / window.open）为真机/契约路径，此处不覆盖。
 * 须先起 localhost:3000。运行：node tests/e2e-one-window-per-project.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3000';
const CUR = 'E:\\test-cur';
const ENTRY = BASE + '/?cwd=' + encodeURIComponent(CUR); // 本窗定向到 test-cur，隔离本机 defaultCwd
let failures = 0;
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.addInitScript(() => {
  const now = Date.now();
  localStorage.setItem('claude_convs', JSON.stringify([
    { id: 'c_cur', title: '本窗项目会话', session: null, cwd: 'E:\\test-cur', messages: [], updatedAt: now - 1000 },
    { id: 'c_x1', title: 'projX 任务一', session: null, cwd: 'C:\\proj-x', messages: [], updatedAt: now - 2000 },
    { id: 'c_y1', title: 'projY 任务', session: null, cwd: 'D:\\proj-y', messages: [], updatedAt: now - 3000 },
  ]));
  localStorage.removeItem('claude_last_conv');
});

try {
  await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#convList', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.click('#convList .conv-load-more'); // 展开今日历史（本窗项目）
  await page.waitForTimeout(300);

  const listText = await page.textContent('#convList');
  if (!listText.includes('本窗项目会话')) fail('本窗项目会话未显示');
  if (listText.includes('projX') || listText.includes('projY')) fail('其他项目会话泄漏到侧栏: ' + listText);
  if (listText.includes('其他项目')) fail('「其他项目」分组应已移除');
  if (await page.$('.conv-group-head')) fail('分组头元素残留');
  if (await page.$('.conv-item.foreign')) fail('foreign 行残留');

  if (errs.length) fail('页面错误：' + errs.join(' | '));
  console.log(failures ? `E2E FAIL（${failures} 处）` : 'E2E PASS：一窗一项目隔离（仅本窗项目会话、无其他项目分组）OK');
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
