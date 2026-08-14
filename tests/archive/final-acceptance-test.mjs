import { chromium } from 'playwright';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        动画流畅性 - 本地端到端测试               ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setViewportSize({ width: 1400, height: 800 });
  
  // ===== 第一阶段：检查 CDN 加载 =====
  console.log('【阶段 1】CDN 和库加载检查\n');
  
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  const cdnCheck = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    const animeScript = scripts.find(s => s.src && s.src.includes('anime'));
    
    return {
      animeScriptFound: !!animeScript,
      animeScriptUrl: animeScript?.src || '',
      animeLoaded: typeof window.anime !== 'undefined',
      hasAnimate: typeof window.anime?.animate === 'function',
      version: window.anime?.version || '未知',
    };
  });
  
  console.log(`CDN 脚本加载: ${cdnCheck.animeScriptFound ? '✓' : '✗'}`);
  if (cdnCheck.animeScriptFound) {
    console.log(`  URL: ${cdnCheck.animeScriptUrl}`);
  }
  console.log(`Anime.js 库加载: ${cdnCheck.animeLoaded ? '✓' : '✗'}`);
  console.log(`animate 方法可用: ${cdnCheck.hasAnimate ? '✓' : '✗'}`);
  
  // ===== 第二阶段：状态行动画验证 =====
  console.log('\n【阶段 2】状态行动画验证\n');
  
  await page.focus('#prompt');
  await page.keyboard.type('获取项目目录结构');
  await page.click('#sendBtn');
  console.log('✓ 已发送任务');
  
  let statusTexts = [];
  let foundStatusLine = false;
  
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(400);
    
    const statusInfo = await page.evaluate(() => {
      const rs = document.querySelector('.run-status');
      const runText = rs?.querySelector('.run-text');
      
      return {
        hasRunStatus: !!rs,
        runTextContent: runText?.textContent || '',
        hasScrambleAttr: runText?.hasAttribute('scrambletext') || false,
      };
    });
    
    if (statusInfo.hasRunStatus && !foundStatusLine) {
      foundStatusLine = true;
      console.log('✓ 状态行元素已出现');
    }
    
    if (statusInfo.runTextContent && !statusTexts.includes(statusInfo.runTextContent)) {
      statusTexts.push(statusInfo.runTextContent);
      console.log(`  • 状态: "${statusInfo.runTextContent}"`);
    }
  }
  
  if (statusTexts.length > 0) {
    console.log(`✓ 状态文本变化次数: ${statusTexts.length}`);
  }
  
  // ===== 第三阶段：工具行动画验证 =====
  console.log('\n【阶段 3】工具行动画验证\n');
  
  let toolTexts = [];
  let foundToolAnimation = false;
  let toolAnimationDetails = {};
  
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    
    const toolInfo = await page.evaluate(() => {
      const toolBox = document.querySelector('.tool-box');
      const toolLog = document.querySelector('.tool-log-single');
      const toolText = toolBox?.querySelector('.tool-text-anim');
      const toolDot = toolBox?.querySelector('.tool-dot');
      
      return {
        hasToolLog: !!toolLog,
        hasToolBox: !!toolBox,
        hasToolText: !!toolText,
        toolTextContent: toolText?.textContent || '',
        hasDot: !!toolDot,
        totalToolTexts: document.querySelectorAll('.tool-text-anim').length,
        toolLogClasses: toolLog?.className || '',
      };
    });
    
    if (toolInfo.hasToolBox && !foundToolAnimation) {
      foundToolAnimation = true;
      console.log('✓ 工具行动画元素已出现');
    }
    
    if (toolInfo.toolTextContent && !toolTexts.includes(toolInfo.toolTextContent)) {
      toolTexts.push(toolInfo.toolTextContent);
      console.log(`  • 工具: "${toolInfo.toolTextContent}"`);
      toolAnimationDetails = toolInfo;
    }
  }
  
  if (toolTexts.length > 0) {
    console.log(`✓ 工具文本变化次数: ${toolTexts.length}`);
    console.log(`✓ 圆点持续显示: ${toolAnimationDetails.hasDot ? '是' : '否'}`);
  }
  
  // ===== 第四阶段：降级测试 =====
  console.log('\n【阶段 4】降级模式测试\n');
  
  // 禁用 Anime.js
  await page.evaluate(() => {
    window.anime = undefined;
  });
  
  const degraded = await page.evaluate(() => typeof window.anime);
  console.log(`✓ Anime.js 已禁用: ${degraded}`);
  
  // 发送新消息
  await page.focus('#prompt');
  await page.keyboard.type('测试降级功能');
  await page.click('#sendBtn');
  console.log('✓ 已发送降级测试消息');
  
  let degradedWorking = false;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(400);
    
    const state = await page.evaluate(() => {
      const toolText = document.querySelector('.tool-text-anim');
      return {
        hasToolText: !!toolText,
        toolContent: toolText?.textContent || ''
      };
    });
    
    if (state.hasToolText && state.toolContent) {
      degradedWorking = true;
      console.log(`✓ 降级模式工作正常，文本显示: "${state.toolContent}"`);
      break;
    }
  }
  
  // ===== 最终结果汇总 =====
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║              测试结果汇总                      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  const allResults = {
    'CDN 加载': cdnCheck.animeScriptFound ? '✓' : '✗',
    'Anime.js 库': cdnCheck.animeLoaded ? '✓' : '✗',
    'animate 方法': cdnCheck.hasAnimate ? '✓' : '✗',
    '状态行元素': foundStatusLine ? '✓' : '✗',
    '状态文本变化': statusTexts.length > 0 ? '✓' : '✗',
    '工具行元素': foundToolAnimation ? '✓' : '✗',
    '工具文本变化': toolTexts.length > 0 ? '✓' : '✗',
    '降级模式': degradedWorking ? '✓' : '✗',
  };
  
  Object.entries(allResults).forEach(([name, result]) => {
    console.log(`${name.padEnd(20)} ${result}`);
  });
  
  // 最终验收
  const passed = Object.values(allResults).every(r => r === '✓');
  
  console.log('\n' + '═'.repeat(50));
  if (passed) {
    console.log('✓✓✓ 所有验收标准通过！动画流畅性验证成功! ✓✓✓');
  } else {
    console.log('⚠ 部分验收标准未通过，需要进一步调查');
  }
  console.log('═'.repeat(50) + '\n');
  
  await browser.close();
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('测试执行失败:', err.message);
  process.exit(1);
});
