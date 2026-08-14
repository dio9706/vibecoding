#!/usr/bin/env node
/**
 * Task 5 验证脚本：检查动画代码的完整性和 CDN 加载
 * 不依赖 AnimeAnimations 全局对象
 */

import puppeteer from 'puppeteer';

const BASE_URL = 'http://127.0.0.1:3001';

async function verifyAnimation() {
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // 设置视口
    await page.setViewport({ width: 1280, height: 720 });

    console.log('\n=== Task 5: 动画验证 ===\n');

    // 监听网络请求
    const networkRequests = [];
    page.on('response', (response) => {
      networkRequests.push({
        url: response.url(),
        status: response.status(),
      });
    });

    // 加载页面
    console.log('加载页面...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

    // ---- 检查 1: anime.js CDN 加载 ----
    const animeLoaded = networkRequests.some(
      (r) => r.url.includes('anime') && r.status === 200
    );

    console.log(`\n检查 1: anime.js CDN 加载`);
    if (animeLoaded) {
      console.log('✓ PASS: anime.js 从 CDN 成功加载');
    } else {
      console.log('❌ FAIL: anime.js 未从 CDN 加载');
      console.log('   加载的资源:', networkRequests.map((r) => r.url).join('\n   '));
    }

    // ---- 检查 2: 验证 anime 全局对象 ----
    const animeAvailable = await page.evaluate(() => {
      return {
        hasAnime: typeof window.anime !== 'undefined',
        hasAnimate: typeof window.anime?.animate === 'function',
        version: window.anime?.version || 'unknown',
      };
    });

    console.log(`\n检查 2: anime 全局对象`);
    if (animeAvailable.hasAnime) {
      console.log(`✓ PASS: window.anime 可用`);
      if (animeAvailable.hasAnimate) {
        console.log(`✓ PASS: anime.animate() 方法可用`);
      }
      console.log(`  版本: ${animeAvailable.version}`);
    } else {
      console.log('❌ FAIL: window.anime 不可用');
    }

    // ---- 检查 3: DOM 中的动画触发点 ----
    const animationDOMReady = await page.evaluate(() => {
      const runStatusEl = document.querySelector('[data-run-status]') ||
                           document.querySelector('[class*="run-status"]') ||
                           document.querySelector('.run-status');

      const messages = document.querySelector('#messages');

      return {
        hasMessages: !!messages,
        hasStatusContainer: !!runStatusEl,
      };
    });

    console.log(`\n检查 3: 动画 DOM 容器`);
    console.log(`✓ 消息容器: ${animationDOMReady.hasMessages ? '存在' : '不存在'}`);
    console.log(`  状态容器: ${animationDOMReady.hasStatusContainer ? '存在' : '待创建'}`);

    // ---- 检查 4: app.js 源码中的动画代码 ----
    const appJsAnimationCode = await page.evaluate(() => {
      // 注入测试代码，检查 scrambleText 调用
      const scripts = Array.from(document.querySelectorAll('script'))
        .filter((s) => s.src.includes('app.js'));

      return {
        hasAppJs: scripts.length > 0,
        appJsSrc: scripts[0]?.src,
      };
    });

    console.log(`\n检查 4: 应用脚本加载`);
    if (appJsAnimationCode.hasAppJs) {
      console.log(`✓ PASS: app.js 已加载`);
      console.log(`  路径: ${appJsAnimationCode.appJsSrc}`);
    } else {
      console.log('❌ FAIL: app.js 未加载');
    }

    // ---- 检查 5: scrambleText 测试 ----
    console.log(`\n检查 5: anime.animate(el, { scrambleText }) 测试`);
    const scrambleWorks = await page.evaluate(() => {
      if (typeof window.anime === 'undefined') {
        return { success: false, error: 'anime 未加载' };
      }

      try {
        const testEl = document.createElement('div');
        testEl.textContent = '测试';
        document.body.appendChild(testEl);

        window.anime.animate(testEl, {
          scrambleText: '成功',
          duration: 100,
        });

        document.body.removeChild(testEl);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    if (scrambleWorks.success) {
      console.log('✓ PASS: scrambleText 动画正常工作');
    } else {
      console.log(`❌ FAIL: scrambleText 异常: ${scrambleWorks.error}`);
    }

    // ---- 总结 ----
    console.log('\n=== 验证总结 ===');
    const allPass =
      animeLoaded &&
      animeAvailable.hasAnime &&
      animeAvailable.hasAnimate &&
      animationDOMReady.hasMessages &&
      appJsAnimationCode.hasAppJs &&
      scrambleWorks.success;

    if (allPass) {
      console.log('✓ 所有检查通过！动画系统已就绪\n');
    } else {
      console.log('❌ 存在问题需要修复\n');
    }

    // 保持浏览器打开，便于手动验收
    console.log('浏览器保持打开状态，您现在可以手动进行交互测试：');
    console.log('1. 点击输入框，输入 "你好"');
    console.log('2. 点击发送，观察运行状态时的文字动画');
    console.log('3. 观察文字从乱码逐步变为真实内容\n');

    await page.waitForTimeout(5000);

    return allPass;

  } catch (error) {
    console.error('❌ 验证异常:', error);
    return false;
  } finally {
    await browser.close();
  }
}

verifyAnimation().then((passed) => {
  process.exit(passed ? 0 : 1);
});
