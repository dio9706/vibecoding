import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
    console.log('✓ Page loaded');
    
    await page.waitForTimeout(1000);
    
    // Click Markdown tool button
    const mdButton = await page.$('#toolMarkdown');
    if (mdButton) {
      await mdButton.click();
      console.log('✓ Clicked Markdown tool button');
    }
    
    await page.waitForTimeout(500);
    
    // Verify CSS is loaded
    const cssLoaded = await page.evaluate(() => {
      const link = document.querySelector('link[href="/css/markdown-tool.css"]');
      return link !== null;
    });
    console.log('✓ CSS file linked:', cssLoaded);
    
    // Verify key elements exist
    const elements = await page.evaluate(() => {
      return {
        mdEmpty: !!document.getElementById('mdEmpty'),
        mdOpenFileBtn: !!document.getElementById('mdOpenFileBtn'),
        mdContainer: !!document.getElementById('mdContainer'),
        mdTocPanel: !!document.querySelector('.md-toc-panel'),
        mdContentPanel: !!document.querySelector('.md-content-panel')
      };
    });
    console.log('✓ Elements exist:', elements);
    
    // Check computed styles
    const styles = await page.evaluate(() => {
      const empty = document.getElementById('mdEmpty');
      const toc = document.querySelector('.md-toc-panel');
      const content = document.querySelector('.md-content-panel');
      
      if (!empty || !toc || !content) return null;
      
      return {
        emptyDisplay: window.getComputedStyle(empty).display,
        tocWidth: window.getComputedStyle(toc).width,
        contentFlex: window.getComputedStyle(content).flex
      };
    });
    console.log('✓ Computed styles:', styles);
    
    // Take screenshot
    await page.screenshot({ path: './markdown-tool-test.png' });
    console.log('✓ Screenshot saved');
    
  } catch (error) {
    console.error('✗ Test failed:', error.message);
  } finally {
    await browser.close();
  }
})();
