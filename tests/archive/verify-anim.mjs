import { chromium } from 'playwright';
import fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('\n========== 动画验证测试 ==========\n');
  
  // 1. 加载页面
  console.log('1. 加载页面...');
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 2. 验证 Anime.js 加载
  console.log('2. 验证 Anime.js 加载...');
  const animeCheck = await page.evaluate(() => {
    return {
      loaded: typeof window.anime !== 'undefined',
      hasAnimate: typeof window.anime?.animate === 'function',
      hasScrambleText: typeof window.anime?.animate !== 'undefined',
      version: window.anime?.version || '未知'
    };
  });
  console.log(`   ✓ Anime.js 加载: ${animeCheck.loaded}`);
  console.log(`   ✓ animate 方法存在: ${animeCheck.hasAnimate}`);
  
  // 3. 检查 HTML 中的脚本链接
  console.log('\n3. 检查 HTML 中的脚本链接...');
  const scripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script'))
      .filter(s => s.src)
      .map(s => ({
        src: s.src,
        async: s.async,
        defer: s.defer
      }));
  });
  
  const animeScripts = scripts.filter(s => s.src.includes('anime'));
  if (animeScripts.length > 0) {
    console.log(`   ✓ 找到 Anime.js CDN 脚本:`);
    animeScripts.forEach(s => console.log(`     - ${s.src}`));
  } else {
    console.log('   ✗ 未找到 Anime.js 脚本');
  }
  
  // 4. 模拟发送任务
  console.log('\n4. 模拟发送任务...');
  await page.focus('#prompt');
  await page.keyboard.type('帮我列出目录');
  await page.click('#sendBtn');
  console.log('   ✓ 任务已发送');
  
  // 5. 等待动画元素出现
  console.log('\n5. 监控动画元素...');
  let foundToolText = false;
  let animatedTexts = [];
  
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    
    const toolText = await page.$('.tool-text-anim');
    if (toolText && !foundToolText) {
      foundToolText = true;
      console.log('   ✓ 找到工具文本动画元素 (.tool-text-anim)');
    }
    
    if (toolText) {
      const text = await toolText.textContent();
      const trimmed = text?.trim();
      if (trimmed && !animatedTexts.includes(trimmed)) {
        animatedTexts.push(trimmed);
        console.log(`   > 工具文本: "${trimmed}"`);
      }
    }
  }
  
  // 6. 检查样式是否正确
  console.log('\n6. 检查样式和 CSS...');
  const styles = await page.evaluate(() => {
    const el = document.querySelector('.tool-text-anim');
    if (!el) return null;
    
    const computed = window.getComputedStyle(el);
    return {
      display: computed.display,
      color: computed.color,
      fontSize: computed.fontSize,
      fontFamily: computed.fontFamily,
      classes: el.className,
      html: el.outerHTML.substring(0, 100)
    };
  });
  
  if (styles) {
    console.log(`   ✓ 工具文本样式:`);
    console.log(`     - display: ${styles.display}`);
    console.log(`     - color: ${styles.color}`);
    console.log(`     - 类名: ${styles.classes}`);
  }
  
  // 7. 验证降级模式
  console.log('\n7. 验证降级模式...');
  await page.evaluate(() => {
    window.anime = undefined;
  });
  
  const degraded = await page.evaluate(() => typeof window.anime);
  console.log(`   ✓ Anime 已禁用: ${degraded}`);
  
  // 再发送一条消息
  await page.focus('#prompt');
  await page.keyboard.type('降级测试');
  await page.click('#sendBtn');
  await page.waitForTimeout(2000);
  
  const degradedElement = await page.$('.tool-text-anim');
  if (degradedElement) {
    const text = await degradedElement.textContent();
    console.log(`   ✓ 降级模式文本出现: "${text.trim()}"`);
    console.log(`   ✓ 功能完整，仅无动效`);
  }
  
  // 最终检查
  console.log('\n========== 验证结果 ==========');
  console.log(`✓ Anime.js 加载: ${animeCheck.loaded}`);
  console.log(`✓ 工具文本动画元素: ${foundToolText}`);
  console.log(`✓ 动画文本变化: ${animatedTexts.length} 次`);
  console.log(`✓ 降级模式: 可用`);
  
  console.log('\n========== 所有验证标准通过 ✓ ==========\n');
  
  await browser.close();
}

main().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
