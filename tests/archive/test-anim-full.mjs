import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setViewportSize({ width: 1280, height: 720 });
  
  console.log('\n========== 阶段 1: 页面加载 ==========');
  await page.goto('http://127.0.0.1:3000');
  console.log('✓ 页面已加载');
  
  await page.waitForTimeout(2000);
  
  // 检查 Anime.js
  const animeLoaded = await page.evaluate(() => typeof window.anime !== 'undefined');
  console.log(`✓ Anime.js 已加载: ${animeLoaded}`);
  
  // 检查 CDN 链接
  console.log('\n========== 阶段 2: 检查 CDN 链接 ==========');
  const cdnUrl = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    return scripts
      .filter(s => s.src && s.src.includes('anime'))
      .map(s => s.src);
  });
  console.log(`CDN 链接: ${cdnUrl.join(', ') || '未找到'}`);
  
  // 准备发送任务
  console.log('\n========== 阶段 3: 发送测试任务 ==========');
  
  // 点击输入框
  await page.focus('#prompt');
  await page.keyboard.type('列出当前目录文件');
  console.log('✓ 已输入测试命令');
  
  // 点击发送
  await page.click('#sendBtn');
  console.log('✓ 已点击发送');
  
  // 监控动画
  console.log('\n========== 阶段 4: 监控动画效果 ==========');
  
  let animFound = false;
  let statusTexts = [];
  let toolTexts = [];
  
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(500);
    
    // 检查是否有状态行
    const statusEl = await page.$('.status-line');
    if (statusEl && !animFound) {
      animFound = true;
      console.log('✓ 发现状态行元素');
    }
    
    // 检查工具文本动画元素
    const toolText = await page.$('.tool-text-anim');
    if (toolText) {
      const text = await toolText.textContent();
      if (text && !toolTexts.includes(text)) {
        toolTexts.push(text);
        console.log(`  工具文本: "${text.trim()}"`);
      }
    }
    
    // 检查状态行文本
    if (statusEl) {
      const text = await statusEl.textContent();
      if (text && !statusTexts.includes(text)) {
        statusTexts.push(text);
        console.log(`  状态文本: "${text.trim()}"`);
      }
    }
  }
  
  // 屏幕截图
  console.log('\n========== 阶段 5: 保存截图 ==========');
  await page.screenshot({ path: '/tmp/anim-running.png' });
  console.log('✓ 已保存运行中的截图: /tmp/anim-running.png');
  
  // 测试降级
  console.log('\n========== 阶段 6: 降级测试 ==========');
  await page.evaluate(() => {
    window.anime = undefined;
  });
  console.log('✓ 已禁用 Anime.js');
  
  // 再发送一条消息
  await page.focus('#prompt');
  await page.keyboard.type('测试降级');
  await page.click('#sendBtn');
  console.log('✓ 已发送降级测试消息');
  
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/anim-degraded.png' });
  console.log('✓ 已保存降级测试截图: /tmp/anim-degraded.png');
  
  console.log('\n========== 测试结果摘要 ==========');
  console.log(`状态文本变化次数: ${statusTexts.length}`);
  console.log(`工具文本变化次数: ${toolTexts.length}`);
  console.log(`动画元素发现: ${animFound ? '✓' : '✗'}`);
  
  console.log('\n========== 测试完成 ==========');
  
  // 保持浏览器打开以便观察
  console.log('浏览器保持打开，按 Ctrl+C 退出...');
  
  // 不关闭浏览器，让用户有时间观察
  await new Promise(() => {});
}

main().catch(console.error);
