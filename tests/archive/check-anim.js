const { chromium } = require('playwright');

(async () => {
  // 使用系统已装的 Chrome
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    slowMo: 50,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('[PAGE] ' + err.message));

  await page.addInitScript(() => {
    window._animeCheck = () => {
      if (typeof anime === 'undefined') return { loaded: false };
      return {
        loaded: true, type: typeof anime,
        callable: typeof anime === 'function',
        keys: Object.keys(anime),
        hasSvg: !!(anime.svg), svgKeys: anime.svg ? Object.keys(anime.svg) : [],
        hasScramble: typeof anime.scrambleText === 'function',
        hasSplitText: typeof anime.splitText === 'function',
        hasCreateDrawable: typeof anime.createDrawable === 'function',
        hasSvgCreateDrawable: !!(anime.svg && typeof anime.svg.createDrawable === 'function'),
        hasAnimate: typeof anime.animate === 'function',
        hasCreateTimeline: typeof anime.createTimeline === 'function',
        hasStagger: typeof anime.stagger === 'function',
      };
    };
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => window._animeCheck());
  console.log('\n=== anime.js API ===\n' + JSON.stringify(info, null, 2));

  await page.screenshot({ path: 'C:/Users/DELL/Desktop/ss1.png' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'C:/Users/DELL/Desktop/ss2.png' });

  // SVG 路径实际状态
  const svg = await page.evaluate(() => {
    const t = document.getElementById('vibeTitle');
    return {
      titleOpacity: t ? getComputedStyle(t).opacity : '?',
      paths: [...document.querySelectorAll('#vibeSvg path')].map(p => ({
        id: p.id,
        da: getComputedStyle(p).strokeDasharray,
        do: getComputedStyle(p).strokeDashoffset,
      }))
    };
  });
  console.log('\n=== SVG 状态 ===\n' + JSON.stringify(svg, null, 2));

  if (errors.length) console.log('\n=== JS 错误 ===\n' + errors.join('\n'));
  else console.log('\n无 JS 错误');

  await browser.close();
})();
