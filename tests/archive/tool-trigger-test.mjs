import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setViewportSize({ width: 1400, height: 900 });
  
  console.log('打开应用...');
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 直接在浏览器控制台执行，模拟发送一条会立即触发工具的请求
  console.log('\n========== 发送任务 ==========');
  
  await page.focus('#prompt');
  // 输入一个明确会触发Read工具的请求
  await page.keyboard.type('请告诉我 package.json 的版本号');
  await page.click('#sendBtn');
  console.log('✓ 任务已发送');
  
  console.log('\n========== 监控活动（30秒）==========\n');
  
  let activities = [];
  let lastCheck = '';
  
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    
    const state = await page.evaluate(() => {
      // 查找 SSE 连接状态
      const runStatus = document.querySelector('.run-status');
      const runText = runStatus?.querySelector('.run-text')?.textContent || '';
      
      // 查找所有消息容器
      const lastMsg = document.querySelector('.msg.assistant');
      const mdBody = lastMsg?.querySelector('.md-body');
      const textContent = mdBody?.textContent || '';
      
      // 查找工具日志
      const toolLog = document.querySelector('.tool-log-single');
      const allToolTexts = Array.from(document.querySelectorAll('.tool-text-anim')).map(t => t.textContent);
      
      return {
        runText: runText.trim(),
        hasResponse: textContent.length > 0,
        responsePreview: textContent.substring(0, 80),
        hasToolLog: !!toolLog,
        toolTexts: allToolTexts,
        timestamp: new Date().toLocaleTimeString()
      };
    });
    
    const checkStr = JSON.stringify(state);
    if (checkStr !== lastCheck) {
      lastCheck = checkStr;
      
      if (state.toolTexts.length > 0) {
        console.log(`[${i * 0.5}s] 工具: ${state.toolTexts.join(', ')}`);
      } else if (state.hasToolLog) {
        console.log(`[${i * 0.5}s] ✓ 发现工具日志!`);
      } else if (state.hasResponse) {
        console.log(`[${i * 0.5}s] 有响应: ${state.responsePreview}`);
      } else if (state.runText) {
        console.log(`[${i * 0.5}s] 状态: ${state.runText}`);
      }
    }
  }
  
  // 最终检查
  console.log('\n========== 最终检查 ==========\n');
  const final = await page.evaluate(() => {
    const toolTexts = Array.from(document.querySelectorAll('.tool-text-anim'));
    const toolLogs = document.querySelectorAll('.tool-log-single');
    
    return {
      toolTextCount: toolTexts.length,
      toolLogCount: toolLogs.length,
      toolContents: Array.from(toolTexts).map(t => t.textContent),
    };
  });
  
  console.log(`工具文本动画元素: ${final.toolTextCount}`);
  console.log(`工具日志数: ${final.toolLogCount}`);
  if (final.toolContents.length > 0) {
    console.log('工具调用列表:');
    final.toolContents.forEach(c => console.log(`  • ${c}`));
  }
  
  if (final.toolTextCount > 0) {
    console.log('\n✓ 工具动画正常工作!');
  }
  
  await browser.close();
}

main().catch(console.error);
