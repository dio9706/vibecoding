import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setViewportSize({ width: 1280, height: 720 });
  
  console.log('\n========== 打开应用 ==========');
  await page.goto('http://127.0.0.1:3000');
  console.log('✓ 页面已加载');
  
  // 等待页面稳定
  await page.waitForTimeout(2000);
  
  console.log('\n========== 检查 Anime.js CDN 加载 ==========');
  const animeLoaded = await page.evaluate(() => {
    return typeof window.anime !== 'undefined';
  });
  console.log(animeLoaded ? '✓ Anime.js 已加载' : '✗ Anime.js 未加载');
  
  // 检查 CDN 资源请求
  console.log('\n========== 检查网络资源 ==========');
  const networkRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('anime') || req.url().includes('cdn')) {
      networkRequests.push(req.url());
    }
  });
  
  console.log('✓ 已设置网络监听');
  
  // 检查 HTML 中的动画元素
  console.log('\n========== 检查 DOM 结构 ==========');
  const hasStatusLine = await page.$('.status-line');
  const hasToolBox = await page.$('.tool-box');
  const hasToolText = await page.$('.tool-text-anim');
  
  console.log(`状态行 (.status-line): ${hasStatusLine ? '✓ 存在' : '✗ 不存在'}`);
  console.log(`工具框 (.tool-box): ${hasToolBox ? '✓ 存在' : '✗ 不存在'}`);
  console.log(`工具文字 (.tool-text-anim): ${hasToolText ? '✓ 存在' : '✗ 不存在'}`);
  
  // 屏幕截图
  console.log('\n========== 保存初始页面截图 ==========');
  await page.screenshot({ path: '/tmp/anim-init.png' });
  console.log('✓ 已保存: /tmp/anim-init.png');
  
  console.log('\n========== 测试完成 ==========');
  
  await browser.close();
}

main().catch(console.error);
