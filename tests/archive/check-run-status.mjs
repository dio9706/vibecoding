import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('加载页面...');
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 发送一条需要多工具调用的任务
  console.log('发送复杂任务（需要多工具调用）...');
  await page.focus('#prompt');
  await page.keyboard.type('列出项目中所有 js 文件的第一行');
  await page.click('#sendBtn');
  
  // 循环监听，看工具是否会出现
  console.log('\n等待工具调用出现...');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    
    const runStatusHtml = await page.evaluate(() => {
      const rs = document.querySelector('.run-status');
      if (!rs) return null;
      return {
        html: rs.outerHTML.substring(0, 300),
        toolLog: !!rs.querySelector('.tool-log'),
        toolBox: !!rs.querySelector('.tool-box'),
        children: rs.children.length,
        childClasses: Array.from(rs.children).map(c => c.className)
      };
    });
    
    if (runStatusHtml) {
      if (i === 0 || i % 5 === 0) {
        console.log(`\n--- 检查点 ${i} ---`);
        console.log('run-status HTML:', runStatusHtml.html);
        console.log('tool-log 存在:', runStatusHtml.toolLog);
        console.log('tool-box 存在:', runStatusHtml.toolBox);
        console.log('子元素个数:', runStatusHtml.children);
        console.log('子元素类名:', runStatusHtml.childClasses);
      }
    }
  }
  
  // 获取完整的 HTML
  console.log('\n\n========== 完整 run-status HTML ==========');
  const fullHtml = await page.evaluate(() => {
    const rs = document.querySelector('.run-status');
    return rs ? rs.outerHTML : '不存在';
  });
  console.log(fullHtml.substring(0, 1000));
  
  await browser.close();
}

main().catch(console.error);
