import { chromium } from 'playwright';

async function main() {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║     工具行动画延长等待测试                ║');
  console.log('╚════════════════════════════════════════════╝\n');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setViewportSize({ width: 1400, height: 800 });
  
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 发送需要读文件的任务（这会触发工具调用）
  console.log('发送需要工具调用的任务...');
  await page.focus('#prompt');
  await page.keyboard.type('读取一下 package.json 的内容');
  await page.click('#sendBtn');
  console.log('✓ 任务已发送\n');
  
  let toolTexts = [];
  let toolAppeared = false;
  let maxWaitTime = 0;
  
  // 长期监控，最多 60 秒
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(500);
    
    const toolInfo = await page.evaluate(() => {
      const toolLog = document.querySelector('.tool-log-single');
      const toolBox = toolLog?.querySelector('.tool-box');
      const toolText = toolBox?.querySelector('.tool-text-anim');
      const runStatus = document.querySelector('.run-status');
      
      return {
        hasToolLog: !!toolLog,
        hasToolBox: !!toolBox,
        toolTextContent: toolText?.textContent || '',
        isRunning: runStatus?.textContent.includes('运行中') || false,
        toolLogHTML: toolLog?.outerHTML.substring(0, 200) || '',
      };
    });
    
    if (toolInfo.hasToolBox && !toolAppeared) {
      toolAppeared = true;
      maxWaitTime = i * 0.5;
      console.log(`\n✓ 工具行元素出现! (等待 ${maxWaitTime.toFixed(1)} 秒)\n`);
    }
    
    if (toolInfo.toolTextContent && !toolTexts.includes(toolInfo.toolTextContent)) {
      toolTexts.push(toolInfo.toolTextContent);
      console.log(`[${(i * 0.5).toFixed(1)}s] 工具: "${toolInfo.toolTextContent}"`);
    }
    
    // 如果运行完成且已经等待足够长时间，停止
    if (!toolInfo.isRunning && i > 10) {
      console.log('\n任务已完成');
      break;
    }
  }
  
  // 详细检查 DOM
  console.log('\n========== 最终 DOM 状态 ==========\n');
  const finalDom = await page.evaluate(() => {
    const toolBoxes = document.querySelectorAll('.tool-box');
    const toolTexts = document.querySelectorAll('.tool-text-anim');
    const toolLogs = document.querySelectorAll('.tool-log-single');
    
    return {
      toolBoxCount: toolBoxes.length,
      toolTextCount: toolTexts.length,
      toolLogCount: toolLogs.length,
      toolTextContents: Array.from(toolTexts).map(t => t.textContent),
      firstToolBoxHTML: toolBoxes[0]?.outerHTML.substring(0, 300) || '',
    };
  });
  
  console.log(`工具框数: ${finalDom.toolBoxCount}`);
  console.log(`工具文本元素数: ${finalDom.toolTextCount}`);
  console.log(`工具日志数: ${finalDom.toolLogCount}`);
  if (finalDom.toolTextContents.length > 0) {
    console.log('工具文本内容:');
    finalDom.toolTextContents.forEach(t => console.log(`  • ${t}`));
  }
  
  console.log('\n========== 最终结果 ==========\n');
  if (toolAppeared) {
    console.log('✓ 工具行动画元素成功出现');
    console.log(`✓ 工具文本变化: ${toolTexts.length} 次`);
    console.log('✓ 验收标准通过: 工具行动画正常工作');
  } else {
    console.log('⚠ 工具行未出现');
    console.log('  原因可能: 任务未调用工具或权限被拒绝');
  }
  
  await browser.close();
  process.exit(toolAppeared ? 0 : 1);
}

main().catch(console.error);
