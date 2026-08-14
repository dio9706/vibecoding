import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 发送任务
  await page.focus('#prompt');
  await page.keyboard.type('读取 package.json');
  await page.click('#sendBtn');
  
  // 等待工具出现
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    
    const hasToolLog = await page.$('.tool-log-single');
    if (hasToolLog) {
      console.log(`\n✓ 工具日志在 ${i * 0.4}s 出现\n`);
      break;
    }
  }
  
  // 详细检查结构
  const structure = await page.evaluate(() => {
    const toolLog = document.querySelector('.tool-log-single');
    if (!toolLog) return 'tool-log-single 不存在';
    
    return {
      className: toolLog.className,
      innerHTML: toolLog.innerHTML,
      outerHTML: toolLog.outerHTML,
      children: Array.from(toolLog.children).map((c, i) => ({
        index: i,
        tag: c.tagName,
        className: c.className,
        text: c.textContent?.substring(0, 50)
      })),
      toolDot: !!toolLog.querySelector('.tool-dot'),
      toolText: !!toolLog.querySelector('.tool-text-anim'),
      toolTextContent: toolLog.querySelector('.tool-text-anim')?.textContent || ''
    };
  });
  
  console.log('========== 工具日志完整结构 ==========\n');
  console.log(JSON.stringify(structure, null, 2));
  
  await browser.close();
}

main().catch(console.error);
