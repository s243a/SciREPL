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

    // Start initialization, then use SciREPL's custom download modal.
    const cancelPromise = page.evaluate(async () => {
      const km = window.kernelManager;
      try {
        await km.ensureReady('r');
        return { error: null, ready: km.isReady('r') };
      } catch (e) {
        return { error: e.message, ready: km.isReady('r') };
      }
    });
    await page.waitForSelector('#runtime-download-modal:not(.hidden)');
    await page.click('#runtime-cancel-btn');
    const cancelResult = await cancelPromise;
    testLog('Cancel stops R init',
      cancelResult.error && cancelResult.error.includes('cancelled'),
      cancelResult.error || 'no error');
    testLog('R kernel stays not-ready after cancel',
      cancelResult.ready === false,
      String(cancelResult.ready));

    // --- Test: Accept download and actually load webR ---

    console.log('4. Testing webR download + init (this may take a while)...');

    let rReady = false;
    try {
      const readyPromise = page.evaluate(async () => {
        const km = window.kernelManager;
        await km.ensureReady('r');
      });
      await page.waitForSelector('#runtime-download-modal:not(.hidden)');
      await page.click('#runtime-download-btn');
      await readyPromise;
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
      testLog('R arithmetic (1+1) autoprints exactly once',
        arithTest.stdout.trim() === '[1] 2' && arithTest.result === null,
        arithOutput.trim() || arithTest.error);

      // --- Test: Vector operations ---

      const vecTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('c(1, 2, 3, 4, 5)', 'r');
      });
      const vecOutput = (vecTest.stdout || '') + ' ' + (vecTest.result ? vecTest.result.content : '');
      testLog('R vector autoprints exactly once',
        vecTest.stdout.trim() === '[1] 1 2 3 4 5' && vecTest.result === null,
        vecOutput.trim() || vecTest.error);

      const dataFrameTest = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('data.frame(x = 1:2, y = c("a", "b"))', 'r');
      });
      const dataFrameOutput = (dataFrameTest.stdout || '') +
        ' ' + (dataFrameTest.result ? dataFrameTest.result.content : '');
      testLog('R structured values use canonical output',
        dataFrameOutput.includes('x y') &&
          !dataFrameOutput.includes('[object Object]') &&
          dataFrameTest.result === null,
        dataFrameOutput.trim() || dataFrameTest.error);

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
        'R arithmetic (1+1)', 'R vector (c(1,2,3,4,5))',
        'R structured values use canonical output', 'R cat() output',
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
