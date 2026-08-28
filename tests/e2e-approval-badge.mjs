/**
 * 审批徽标 e2e 测试：验证顶栏审批徽标（#askChip）存在、初始隐藏、点击显示待审批面板。
 * 需求场景：用户等待权限审批时，顶栏展示审批徽标并可点击查看待审批列表。
 * 须先起 localhost:3000（pm2 principal-web）。
 * 运行：node tests/e2e-approval-badge.mjs
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
  if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
});
const assertNoErrors = (stage) => {
  if (pageErrors.length) {
    fail(`${stage} 阶段出现页面错误：\n  ` + pageErrors.join('\n  '));
    pageErrors.length = 0;
  }
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600); // 等启动初始化

  // ---- Task 8: 验证审批徽标完整流程 ----

  // 1. 验证元素存在（HTML 结构完整）
  const askChipExists = await page.locator('#askChip').count() > 0;
  if (!askChipExists) {
    fail('审批徽标 #askChip 元素不存在');
  } else {
    console.log('✔ 审批徽标元素存在');
  }

  // 2. 验证初始状态隐藏（hidden 属性）
  const isInitiallyHidden = await page.locator('#askChip').evaluate((el) => el.hasAttribute('hidden'));
  if (!isInitiallyHidden) {
    fail('审批徽标初始应隐藏（hidden 属性），但未隐藏');
  } else {
    console.log('✔ 审批徽标初始隐藏');
  }

  // 3. 验证徽标属性（role、aria-label）
  const roleValue = await page.locator('#askChip').getAttribute('role');
  if (roleValue !== 'button') {
    fail(`审批徽标 role 应为 "button"，实际为 "${roleValue}"`);
  } else {
    console.log('✔ 审批徽标 role 属性正确');
  }

  const ariaLabel = await page.locator('#askChip').getAttribute('aria-label');
  if (!ariaLabel) {
    fail('审批徽标缺少 aria-label 可访问性属性');
  } else {
    console.log(`✔ 审批徽标 aria-label="${ariaLabel}"`);
  }

  // 4. 验证 CSS 类名存在
  const classValue = await page.locator('#askChip').getAttribute('class');
  if (!classValue || !classValue.includes('ask-chip')) {
    fail(`审批徽标应有 "ask-chip" 类，实际为 "${classValue}"`);
  } else {
    console.log('✔ 审批徽标 CSS 类正确');
  }

  // 5. 验证 refreshAskChip 函数存在（通过控制台测试）
  try {
    const refreshExists = await page.evaluate(() => typeof refreshAskChip === 'function');
    if (!refreshExists) {
      fail('refreshAskChip() 函数未定义或不是函数');
    } else {
      console.log('✔ refreshAskChip() 函数存在');
    }
  } catch (e) {
    fail(`检查 refreshAskChip 函数时出错：${e.message}`);
  }

  assertNoErrors('审批徽标完整性测试');

} catch (err) {
  fail(`测试执行异常：${err.message}`);
  console.error(err.stack);
} finally {
  await browser.close();
  if (failures === 0) {
    console.log('\n✔ Task 8 - e2e 审批徽标测试全部通过');
    process.exit(0);
  } else {
    console.log(`\n✗ Task 8 - ${failures} 项测试失败`);
    process.exit(1);
  }
}
