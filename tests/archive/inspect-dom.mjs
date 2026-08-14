import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('加载页面...');
  await page.goto('http://127.0.0.1:3000');
  await page.waitForTimeout(2000);
  
  // 发送任务
  console.log('发送测试任务...');
  await page.focus('#prompt');
  await page.keyboard.type('列出文件');
  await page.click('#sendBtn');
  
  // 等待一段时间让动画出现
  await page.waitForTimeout(3000);
  
  // 检查 DOM 结构
  const dom = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    
    // 查找所有可能相关的元素
    const toolBoxes = Array.from(document.querySelectorAll('[class*="tool"]'));
    const animations = Array.from(document.querySelectorAll('[class*="anim"]'));
    const status = Array.from(document.querySelectorAll('[class*="status"]'));
    
    return {
      totalElements: document.querySelectorAll('*').length,
      toolBoxCount: toolBoxes.length,
      animationCount: animations.length,
      statusCount: status.length,
      toolBoxClasses: toolBoxes.slice(0, 10).map(e => e.className),
      animationClasses: animations.slice(0, 10).map(e => e.className),
      statusClasses: status.slice(0, 10).map(e => e.className),
      messageElements: Array.from(document.querySelectorAll('.message')).length,
      bubbleElements: Array.from(document.querySelectorAll('.bubble')).length,
    };
  });
  
  console.log('\n========== DOM 检查结果 ==========');
  console.log('总元素数:', dom.totalElements);
  console.log('工具相关元素:', dom.toolBoxCount);
  console.log('动画相关元素:', dom.animationCount);
  console.log('状态相关元素:', dom.statusCount);
  console.log('消息元素:', dom.messageElements);
  console.log('气泡元素:', dom.bubbleElements);
  
  console.log('\n工具相关类名:');
  dom.toolBoxClasses.forEach((c, i) => console.log(`  ${i}: ${c}`));
  
  console.log('\n动画相关类名:');
  dom.animationClasses.forEach((c, i) => console.log(`  ${i}: ${c}`));
  
  // 查找具体的元素结构
  const structure = await page.evaluate(() => {
    // 查找消息容器
    const messages = document.getElementById('messages');
    if (!messages) return 'messages 容器不存在';
    
    // 列出最后几个子元素
    const lastChildren = Array.from(messages.children).slice(-3);
    return {
      messagesChildCount: messages.children.length,
      lastChildren: lastChildren.map(el => ({
        tag: el.tagName,
        className: el.className,
        children: el.children.length,
        html: el.outerHTML.substring(0, 200)
      }))
    };
  });
  
  console.log('\n========== 消息结构 ==========');
  console.log(JSON.stringify(structure, null, 2));
  
  // 查找是否有运行状态指示
  const runStatus = await page.evaluate(() => {
    return {
      hasRunStatus: !!document.querySelector('.run-status'),
      hasToolLog: !!document.querySelector('.tool-log'),
      hasToolBox: !!document.querySelector('.tool-box'),
      hasToolTextAnim: !!document.querySelector('.tool-text-anim'),
      runStatuses: Array.from(document.querySelectorAll('[class*="run"]')).map(e => e.className)
    };
  });
  
  console.log('\n========== 运行状态检查 ==========');
  console.log('run-status 存在:', runStatus.hasRunStatus);
  console.log('tool-log 存在:', runStatus.hasToolLog);
  console.log('tool-box 存在:', runStatus.hasToolBox);
  console.log('tool-text-anim 存在:', runStatus.hasToolTextAnim);
  console.log('所有 run* 类名:');
  runStatus.runStatuses.forEach(cn => console.log('  -', cn));
  
  await browser.close();
}

main().catch(console.error);
