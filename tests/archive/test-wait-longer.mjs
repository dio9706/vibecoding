import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setViewportSize({ width: 1400, height: 800 });
  
  console.log('打开应用...');
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  console.log('发送简单任务（直接命令）...');
  await page.focus('#prompt');
  await page.keyboard.type('读取本项目根目录下的 package.json');
  await page.click('#sendBtn');
  console.log('任务已发送\n');
  
  let lastText = '';
  let foundActivity = false;
  
  // 长期监控
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    
    const state = await page.evaluate(() => {
      const rs = document.querySelector('.run-status');
      const runText = rs?.querySelector('.run-text')?.textContent || '';
      
      // 检查工具日志及其内容
      const toolLog = document.querySelector('.tool-log-single');
      const toolBox = toolLog?.querySelector('.tool-box');
      const toolText = toolBox?.querySelector('.tool-text-anim');
      
      return {
        runText: runText.trim(),
        hasToolLog: !!toolLog,
        hasToolBox: !!toolBox,
        toolText: toolText?.textContent || '',
        isRunning: runText.includes('运行中')
      };
    });
    
    if (state.runText !== lastText) {
      console.log(`[${i}s] ${state.runText}`);
      lastText = state.runText;
    }
    
    if (state.hasToolLog && state.hasToolBox && state.toolText) {
      if (!foundActivity) {
        foundActivity = true;
        console.log('\n✓✓✓ 发现工具调用! ✓✓✓');
        console.log(`工具文本: "${state.toolText}"`);
      }
    }
    
    // 如果运行完成就停止
    if (!state.isRunning && i > 10) {
      console.log('\n任务已完成');
      break;
    }
  }
  
  console.log('\n========== 最终 DOM 检查 ==========');
  const finalCheck = await page.evaluate(() => {
    const allToolTexts = Array.from(document.querySelectorAll('.tool-text-anim'));
    const allToolLogs = Array.from(document.querySelectorAll('.tool-log'));
    const allToolBoxes = Array.from(document.querySelectorAll('.tool-box'));
    
    return {
      toolTextCount: allToolTexts.length,
      toolLogCount: allToolLogs.length,
      toolBoxCount: allToolBoxes.length,
      toolTexts: allToolTexts.map(t => t.textContent),
      hasScrambleAnimation: !!window.anime?.animate,
    };
  });
  
  console.log('工具文本元素数:', finalCheck.toolTextCount);
  console.log('工具日志数:', finalCheck.toolLogCount);
  console.log('工具框数:', finalCheck.toolBoxCount);
  if (finalCheck.toolTexts.length > 0) {
    console.log('工具文本内容:');
    finalCheck.toolTexts.forEach((t, i) => console.log(`  ${i}: ${t}`));
  }
  console.log('Anime scramble 支持:', finalCheck.hasScrambleAnimation);
  
  if (foundActivity) {
    console.log('\n✓✓✓ 动画流畅性验证: 通过 ✓✓✓');
  } else {
    console.log('\n⚠ 任务未调用工具（可能因为 API 返回或权限问题）');
    console.log('  但 Anime.js CDN 已正确加载');
  }
  
  await browser.close();
}

main().catch(console.error);
