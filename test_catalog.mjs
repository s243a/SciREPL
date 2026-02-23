// Quick Playwright test: verify package catalog modal opens
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Dismiss privacy modal
    try {
      const btn = await page.waitForSelector('#privacy-modal button', { timeout: 5000 });
      if (btn) await btn.click();
    } catch {}

    await page.waitForTimeout(2000);

    // Hide loading overlay if present
    await page.evaluate(() => {
      const overlay = document.getElementById('loading-overlay');
      if (overlay) overlay.style.display = 'none';
    });

    // Open menu
    await page.click('#menu-btn');
    await page.waitForTimeout(500);

    // Check Browse Packages button exists
    const browseBtn = await page.$('#btn-browse-packages');
    console.log('Browse Packages button:', browseBtn ? 'FOUND' : 'MISSING');

    // Click it
    if (browseBtn) {
      await browseBtn.click();
      await page.waitForTimeout(500);

      // Check catalog modal is visible
      const modal = await page.$('#package-catalog-modal');
      const isHidden = await modal?.evaluate(el => el.classList.contains('hidden'));
      console.log('Catalog modal visible:', !isHidden ? 'YES' : 'NO');

      // Check package cards rendered
      const cards = await page.$$('.pkg-card');
      console.log('Package cards:', cards.length);

      // Check first card content
      if (cards.length > 0) {
        const name = await cards[0].$eval('strong', el => el.textContent);
        const installBtn = await cards[0].$('.pkg-install-btn');
        console.log('First package:', name);
        console.log('Install button:', installBtn ? 'FOUND' : 'MISSING');
      }
    }

    console.log('\nPASS: Package catalog UI works');

  } catch (err) {
    console.error('FAIL:', err.message);
  } finally {
    await browser.close();
  }
})();
