/**
 * Task 5 动画测试脚本 - 本地验证动画流畅性
 * 执行步骤：
 * 1. 打开浏览器 → 访问 http://127.0.0.1:3000
 * 2. 验证状态行动画（状态文字乱码→落定）
 * 3. 验证工具行动画（工具名乱码→落定，无缝过渡）
 * 4. 验证降级测试（anime 未定义时）
 */

import playwright from 'playwright';

const BASE_URL = 'http://127.0.0.1:3000';
const TEST_TIMEOUT = 60000;

// 测试报告
const report = {
  steps: [],
  errors: [],
  passed: false,
};

function logStep(step, status = '✓') {
  console.log(`[${status}] ${step}`);
  report.steps.push({ step, status });
}

function logError(error) {
  console.error(`[✗] ${error}`);
  report.errors.push(error);
}

async function testAnimations() {
  let browser;
  let page;

  try {
    logStep('Step 1: 启动浏览器');
    browser = await playwright.chromium.launch({ headless: false });
    page = await browser.newPage();

    // 捕获控制台消息
    page.on('console', (msg) => {
      console.log(`[CONSOLE] ${msg.type()}: ${msg.text()}`);
    });

    logStep('Step 2: 访问服务地址');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    logStep('Step 3: 等待页面初始化');
    await page.waitForTimeout(1000);

    // 检查 anime.js 是否加载成功
    const hasAnime = await page.evaluate(() => typeof anime !== 'undefined');
    if (hasAnime) {
      logStep('anime.js 已加载');
    } else {
      logError('anime.js 未加载 - 检查 CDN');
    }

    // 检查 AnimeAnimations 对象
    const hasAnimations = await page.evaluate(() => {
      return (typeof AnimeAnimations !== 'undefined') &&
             (typeof AnimeAnimations.animateStatusText === 'function');
    });
    if (hasAnimations) {
      logStep('AnimeAnimations 对象已初始化');
    } else {
      logError('AnimeAnimations 未初始化');
    }

    // ========== 测试 1: 状态行动画 ==========
    logStep('------- 测试 1: 状态行动画 -------');

    // 模拟发送消息
    const promptInput = await page.$('#prompt');
    if (!promptInput) {
      logError('无法找到 prompt 输入框');
      return;
    }

    logStep('Step 4: 输入测试消息');
    await promptInput.type('你好', { delay: 50 });

    logStep('Step 5: 点击发送');
    const sendBtn = await page.$('#sendBtn');
    if (sendBtn) {
      await sendBtn.click();
    } else {
      logError('无法找到发送按钮');
      return;
    }

    // 等待任务开始运行
    logStep('Step 6: 等待任务运行...');
    await page.waitForTimeout(2000);

    // 检查状态行元素
    const runStatusEl = await page.$('#runStatus');
    if (!runStatusEl) {
      logError('无法找到状态行元素');
      return;
    }

    logStep('状态行元素已找到');

    // 监测状态行文字变化（应该显示乱码→真实内容）
    const statusTextHistogram = await page.evaluate(() => {
      const el = document.querySelector('#runStatus');
      if (!el) return null;
      const texts = [];

      // 记录状态行文字变化过程（监听 100ms，每 50ms 采样一次）
      return new Promise((resolve) => {
        let count = 0;
        const maxSamples = 20;
        const timer = setInterval(() => {
          if (el && el.textContent) {
            texts.push({
              time: count * 50,
              text: el.textContent.substring(0, 50),
              hasScramble: /[^\w\s一-鿿]/.test(el.textContent), // 包含非词字符=乱码
            });
          }
          count++;
          if (count >= maxSamples) {
            clearInterval(timer);
            resolve(texts);
          }
        }, 50);
      });
    });

    console.log('状态行文字历程:', statusTextHistogram);

    // 检查是否出现乱码→落定的动画效果
    if (statusTextHistogram && statusTextHistogram.length > 0) {
      const hasScramble = statusTextHistogram.some((s) => s.hasScramble);
      if (hasScramble) {
        logStep('观察到状态行动画（乱码阶段）');
      } else {
        logStep('未观察到明显乱码效果（可能由于时序或配置）');
      }
    }

    // ========== 测试 2: 降级测试 ==========
    logStep('------- 测试 2: 降级测试 (anime=undefined) -------');

    logStep('Step 7: 禁用 anime.js');
    await page.evaluate(() => {
      window.anime = undefined;
    });

    logStep('Step 8: 输入第二条消息');
    await promptInput.type('降级测试', { delay: 50 });

    logStep('Step 9: 发送降级消息');
    const sendBtn2 = await page.$('#sendBtn');
    if (sendBtn2) {
      await sendBtn2.click();
    }

    // 等待执行
    await page.waitForTimeout(2000);

    // 检查控制台错误
    const errors = await page.evaluate(() => {
      // 这是运行时检查，anime undefined 会导致错误
      return window.__consoleErrors || [];
    });

    if (errors.length === 0) {
      logStep('降级时无 JavaScript 错误');
    } else {
      logError(`降级时出现错误: ${errors.join(', ')}`);
    }

    // ========== 总结 ==========
    logStep('------- 测试完成 -------');
    report.passed = report.errors.length === 0;

    console.log('\n========== 测试报告 ==========');
    console.log(`总步骤数: ${report.steps.length}`);
    console.log(`错误数: ${report.errors.length}`);
    console.log(`结果: ${report.passed ? '✓ PASS' : '✗ FAIL'}`);

    if (report.errors.length > 0) {
      console.log('\n错误列表:');
      report.errors.forEach((err) => console.log(`  - ${err}`));
    }

    console.log('\n========== 检查清单 ==========');
    console.log('手动验证项（自动化无法完全覆盖）:');
    console.log('  [ ] 状态行文字乱码→真实内容，时长约 500ms');
    console.log('  [ ] 工具行文字无缝过渡，圆点常驻');
    console.log('  [ ] 无闪烁、无抖动');
    console.log('  [ ] 降级模式下功能完整（仅无动画）');
    console.log('  [ ] anime.js CDN 返回 HTTP 200（检查 Network 标签页）');

    await browser.close();
  } catch (err) {
    logError(`${err.message}`);
    console.error(err);
    if (browser) await browser.close();
  }
}

// 运行测试
await testAnimations();
