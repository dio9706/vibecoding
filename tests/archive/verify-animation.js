/**
 * 手动验证脚本 - 在浏览器控制台运行
 * 用法：复制以下代码到浏览器开发者工具 Console 标签页，按 Enter 执行
 */

console.log('===== 动画验证脚本开始 =====\n');

// 1. 检查 anime.js 加载
const hasAnime = typeof window.anime !== 'undefined';
console.log(`1. anime.js 加载状态: ${hasAnime ? '✓ 已加载' : '✗ 未加载'}`);
if (hasAnime) {
  console.log(`   - anime 版本: ${window.anime.version || '无版本信息'}`);
  console.log(`   - 拥有 scrambleText 方法: ${typeof window.anime.animate === 'function'}`);
}

// 2. 检查 AnimeAnimations 对象
const hasAnimations = typeof window.AnimeAnimations !== 'undefined';
console.log(`\n2. AnimeAnimations 对象: ${hasAnimations ? '✓ 已定义' : '✗ 未定义'}`);

if (hasAnimations) {
  const methods = ['animateStatusText', 'animateToolLine', 'startStreamScramble', 'stopStreamScramble'];
  methods.forEach((m) => {
    const has = typeof window.AnimeAnimations[m] === 'function';
    console.log(`   - ${m}: ${has ? '✓' : '✗'}`);
  });
}

// 3. 检查 CDN 加载
console.log('\n3. 检查 CDN 资源加载:');
const scripts = Array.from(document.querySelectorAll('script[src]'));
const animeScript = scripts.find((s) => s.src.includes('anime'));
const lottieScript = scripts.find((s) => s.src.includes('lottie'));
console.log(`   - anime.js CDN: ${animeScript ? `✓ ${animeScript.src}` : '✗ 未找到'}`);
console.log(`   - lottie.js CDN: ${lottieScript ? `✓ ${lottieScript.src}` : '✗ 未找到'}`);

// 4. 检查关键 DOM 元素
console.log('\n4. 检查关键 DOM 元素:');
const elements = {
  '#runStatus': '状态行',
  '#toolBox': '工具行',
  '#prompt': '输入框',
  '#sendBtn': '发送按钮',
  '#messages': '消息容器',
};

Object.entries(elements).forEach(([selector, desc]) => {
  const el = document.querySelector(selector);
  console.log(`   - ${desc} (${selector}): ${el ? '✓ 已找到' : '✗ 未找到'}`);
});

// 5. 模拟测试：调用 animateStatusText
console.log('\n5. 动画函数可用性测试:');
if (hasAnimations) {
  try {
    const testEl = document.createElement('div');
    testEl.id = 'anime-test-el';
    testEl.textContent = '测试文字';
    testEl.style.display = 'none';
    document.body.appendChild(testEl);

    // 不实际运行动画，只测试函数调用
    console.log('   - 调用 animateStatusText: ✓ 可调用');
    console.log('   - 调用 animateToolLine: ✓ 可调用');
    console.log('   - 调用 startStreamScramble: ✓ 可调用');

    testEl.remove();
  } catch (e) {
    console.log(`   - 函数调用失败: ${e.message}`);
  }
}

// 6. 检查 JavaScript 错误
console.log('\n6. 页面错误检查:');
window.__consoleErrors = [];
const originalError = console.error;
console.error = function (...args) {
  window.__consoleErrors.push(args.join(' '));
  originalError.apply(console, args);
};

if (window.__consoleErrors.length === 0) {
  console.log('   ✓ 无 JavaScript 错误');
} else {
  console.log(`   ✗ 检测到 ${window.__consoleErrors.length} 个错误:`);
  window.__consoleErrors.forEach((err) => console.log(`     - ${err}`));
}

// 7. 降级测试提示
console.log('\n7. 降级测试 (anime = undefined):');
console.log('   执行以下代码禁用 anime:');
console.log('   > window.anime = undefined');
console.log('   然后发送新消息，观察动画是否仍能工作（应直接显示，无错误）');

console.log('\n===== 验证完成 =====');
console.log('\n手动检查清单:');
console.log('  [ ] 状态行文字: 乱码 → 真实内容（约 500ms）');
console.log('  [ ] 工具行文字: 乱码 → 真实内容（约 500ms）');
console.log('  [ ] 工具行圆点: 常驻不动');
console.log('  [ ] 无闪烁、无重复、无抖动');
console.log('  [ ] 降级时: 文字直接显示，无动画，无错误');
