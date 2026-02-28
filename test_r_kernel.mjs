// Playwright test: verify R kernel — registration, download prompt, execution via webR
import { chromium } from 'playwright';

const TIMEOUT = 180_000; // 3 min — webR is ~50 MB download

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  let allPassed = true;
  const results = [];
  const testLog = (name, passed, detail) => {
    const mark = passed ? 'PASS' : 'FAIL';
    if (!passed) allPassed = false;
    results.push({ name, passed, detail });
    console.log(`  [${mark}] ${name}${detail ? ': ' + detail.trim() : ''}`);
  };

  try {
    console.log('1. Navigating to SciREPL...');

    // Pre-accept privacy policy
    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // --- Test: R kernel is registered ---

    console.log('2. Testing R kernel registration...');

    const rRegistered = await page.evaluate(() => {
      const km = window.kernelManager;
      return km && km._registry && !!km._registry['r'];
    });
    testLog('R kernel is registered', rRegistered === true);

    // --- Test: R option in language selector ---

    const rInDropdown = await page.evaluate(() => {
      const sel = document.getElementById('lang-selector');
      if (!sel) return false;
      for (const opt of sel.options) {
        if (opt.value === 'r') return true;
      }
      return false;
    });
    testLog('R option in language dropdown', rInDropdown === true);

    // --- Test: R kernel metadata ---

    const kernelMeta = await page.evaluate(() => {
      const km = window.kernelManager;
      const RKernel = km._registry['r'];
      if (!RKernel) return null;
      const inst = new RKernel();
      return {
        name: inst.getName(),
        language: inst.getLanguage(),
        ready: inst.isReady(),
        displayName: RKernel.displayName
      };
    });
    testLog('R kernel getName()',
      kernelMeta && kernelMeta.name === 'R (webR)',
      kernelMeta ? kernelMeta.name : 'null');
    testLog('R kernel getLanguage()',
      kernelMeta && kernelMeta.language === 'r',
      kernelMeta ? kernelMeta.language : 'null');
    testLog('R kernel not ready before init',
      kernelMeta && kernelMeta.ready === false,
      kernelMeta ? String(kernelMeta.ready) : 'null');
    testLog('R kernel displayName',
      kernelMeta && kernelMeta.displayName === 'R',
      kernelMeta ? kernelMeta.displayName : 'null');

    // --- Test: Download confirmation prompt ---

    console.log('3. Testing download confirmation prompt...');

    // Test that cancelling the confirm dialog prevents initialization
    page.on('dialog', async dialog => {
      if (dialog.type() === 'confirm' && dialog.message().includes('50 MB')) {
        await dialog.dismiss(); // cancel
      }
    });

    const cancelResult = await page.evaluate(async () => {
      const km = window.kernelManager;
      const RKernel = km._registry['r'];
      const inst = new RKernel();
      try {
        await inst.init();
        return { error: null, ready: inst.isReady() };
      } catch (e) {
        return { error: e.message, ready: inst.isReady() };
      }
    });
    testLog('Cancel stops R init',
      cancelResult.error && cancelResult.error.includes('cancelled'),
      cancelResult.error || 'no error');
    testLog('R kernel stays not-ready after cancel',
      cancelResult.ready === false,
      String(cancelResult.ready));

    // Remove the cancel handler
    page.removeAllListeners('dialog');

    // --- Test: Accept download and actually load webR ---

    console.log('4. Testing webR download + init (this may take a while)...');

    // Accept the confirm dialog
    page.on('dialog', async dialog => {
      if (dialog.type() === 'confirm') {
        console.log('   [dialog] Accepting webR download prompt');
        await dialog.accept();
      }
    });

    let rReady = false;
    try {
      await page.evaluate(async () => {
        const km = window.kernelManager;
        await km.ensureReady('r');
      }, { timeout: TIMEOUT });
      rReady = true;
    } catch (e) {
      console.log('   webR init failed or timed out:', e.message);
      rReady = false;
    }

    testLog('webR runtime loaded',
      rReady === true,
      rReady ? 'ready' : 'failed/timeout');

    if (rReady) {
      // --- Test: Basic arithmetic ---

      console.log('5. Testing R execution...');

      const arithTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('1 + 1', 'r');
      });
      const arithOutput = (arithTest.stdout || '') + ' ' + (arithTest.result ? arithTest.result.content : '');
      testLog('R arithmetic (1+1)',
        arithOutput.includes('2'),
        arithOutput.trim() || arithTest.error);

      // --- Test: Vector operations ---

      const vecTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('c(1, 2, 3, 4, 5)', 'r');
      });
      const vecOutput = (vecTest.stdout || '') + ' ' + (vecTest.result ? vecTest.result.content : '');
      testLog('R vector (c(1,2,3,4,5))',
        vecOutput.includes('1') && vecOutput.includes('5'),
        vecOutput.trim() || vecTest.error);

      // --- Test: cat() output ---

      const catTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('cat("hello from R\\n")', 'r');
      });
      testLog('R cat() output',
        (catTest.stdout || '').includes('hello from R'),
        catTest.stdout || catTest.error);

      // --- Test: Variable assignment and recall ---

      const varTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        await km.execute('myvar <- 42', 'r');
        return await km.execute('myvar', 'r');
      });
      const varOutput = (varTest.stdout || '') + ' ' + (varTest.result ? varTest.result.content : '');
      testLog('R variable persistence',
        varOutput.includes('42'),
        varOutput.trim() || varTest.error);

      // --- Test: String operations ---

      const strTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('paste("hello", "world")', 'r');
      });
      const strOutput = (strTest.stdout || '') + ' ' + (strTest.result ? strTest.result.content : '');
      testLog('R string paste()',
        strOutput.includes('hello world'),
        strOutput.trim() || strTest.error);

      // --- Test: Statistical functions ---

      const statsTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('mean(c(10, 20, 30))', 'r');
      });
      const statsOutput = (statsTest.stdout || '') + ' ' + (statsTest.result ? statsTest.result.content : '');
      testLog('R mean()',
        statsOutput.includes('20'),
        statsOutput.trim() || statsTest.error);

      // --- Test: Error handling ---

      const errTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('stop("test error message")', 'r');
      });
      // R stop() errors appear in stdout via captureR, not in the error field
      const errOutput = (errTest.error || '') + (errTest.stdout || '');
      testLog('R error handling',
        errOutput.includes('test error message'),
        errOutput || 'no error output');

      // --- Test: Empty code ---

      const emptyTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('', 'r');
      });
      testLog('R empty code returns no error',
        emptyTest.error === null || emptyTest.error === undefined,
        emptyTest.error || 'ok');

      // --- Test: Multi-line code ---

      const multiTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('x <- 10\ny <- 20\nx + y', 'r');
      });
      const multiOutput = (multiTest.stdout || '') + ' ' + (multiTest.result ? multiTest.result.content : '');
      testLog('R multi-line code',
        multiOutput.includes('30'),
        multiOutput.trim() || multiTest.error);

      // --- Test: Plot generates images ---

      console.log('6. Testing R plotting...');

      const plotTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('plot(1:10, (1:10)^2)', 'r');
      });
      testLog('R plot() generates images',
        plotTest.images && plotTest.images.length > 0,
        plotTest.images ? `${plotTest.images.length} image(s)` : (plotTest.error || 'no images'));

    } else {
      // Skip execution tests if webR didn't load
      console.log('   Skipping R execution tests (webR not available)');
      const skipTests = [
        'R arithmetic (1+1)', 'R vector (c(1,2,3,4,5))', 'R cat() output',
        'R variable persistence', 'R string paste()', 'R mean()',
        'R error handling', 'R empty code returns no error',
        'R multi-line code', 'R plot() generates images'
      ];
      for (const name of skipTests) {
        testLog(name + ' [SKIPPED]', true, 'webR not available — skipped');
      }
    }

    // --- Test: R styling ---

    console.log('7. Testing R UI styling...');

    const rActiveClass = await page.evaluate(() => {
      const sel = document.getElementById('lang-selector');
      if (!sel) return false;
      sel.value = 'r';
      sel.dispatchEvent(new Event('change'));
      return sel.classList.contains('r-active');
    });
    testLog('R active class applied',
      rActiveClass === true,
      String(rActiveClass));

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All R kernel tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
