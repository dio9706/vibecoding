import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 开启日志
  page.on('console', msg => {
    if (msg.type() === 'log') console.log('[PAGE LOG]', msg.text());
  });
  
  console.log('========== 打开应用 ==========');
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 验证 Anime.js
  const hasAnime = await page.evaluate(() => typeof window.anime !== 'undefined');
  console.log('✓ Anime.js 已加载:', hasAnime);
  
  console.log('\n========== 发送工具调用任务 ==========');
  // 发送一条会引发工具调用的消息
  await page.focus('#prompt');
  await page.keyboard.type('帮我读取这个项目的 package.json 文件');
  await page.click('#sendBtn');
  console.log('✓ 任务已发送');
  
  console.log('\n========== 监控 SSE 事件 ==========');
  let eventLog = [];
  
  page.on('response', response => {
    if (response.url().includes('/api/run?')) {
      console.log(`SSE 连接: ${response.status()}`);
    }
  });
  
  // 监听网络事件
  await page.context().on('request', request => {
    if (request.url().includes('api/run')) {
      console.log(`请求: ${request.method()} ${request.url()}`);
    }
  });
  
  // 轮询查看 DOM 变化
  console.log('\n========== 等待工具调用事件 ==========');
  let lastActivity = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    
    const current = await page.evaluate(() => {
      const rs = document.querySelector('.run-status');
      const runText = rs?.querySelector('.run-text')?.textContent || '';
      const toolLog = document.querySelector('.tool-log-single');
      const toolTexts = toolLog 
        ? Array.from(toolLog.querySelectorAll('.tool-text-anim')).map(t => t.textContent)
        : [];
      
      return {
        runText,
        hasToolLog: !!toolLog,
        toolTexts,
        toolLogHTML: toolLog?.outerHTML.substring(0, 150) || ''
      };
    });
    
    if (current.runText !== lastActivity) {
      lastActivity = current.runText;
      if (i % 3 === 0) {
        console.log(`[${i}s] 状态: ${current.runText}`);
      }
    }
    
    if (current.hasToolLog) {
      console.log('\n✓ 工具日志出现!');
      console.log('  工具文本:', current.toolTexts);
      console.log('  HTML:', current.toolLogHTML);
      break;
    }
  }
  
  // 最后检查一次
  console.log('\n========== 最终检查 ==========');
  const finalState = await page.evaluate(() => {
    const toolLog = document.querySelector('.tool-log-single');
    const toolBoxes = document.querySelectorAll('.tool-box');
    const toolTexts = document.querySelectorAll('.tool-text-anim');
    
    return {
      toolLogExists: !!toolLog,
      toolBoxCount: toolBoxes.length,
      toolTextCount: toolTexts.length,
      toolTextContents: Array.from(toolTexts).map(t => t.textContent)
    };
  });
  
  console.log('工具日志元素:', finalState.toolLogExists);
  console.log('工具框元素:', finalState.toolBoxCount);
  console.log('工具文本动画元素:', finalState.toolTextCount);
  console.log('工具文本内容:', finalState.toolTextContents);
  
  console.log('\n========== 验证结论 ==========');
  if (finalState.toolTextCount > 0) {
    console.log('✓ 工具动画元素正确渲染');
  } else {
    console.log('⚠ 任务可能未调用工具，或工具调用尚未开始');
  }
  
  await browser.close();
}

main().catch(console.error);
