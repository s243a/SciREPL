// Playwright test: verify micropip / %pip install support
import { chromium } from 'playwright';

const TIMEOUT = 120_000;

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

    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      localStorage.setItem('scirepl_privacy_accepted', '1');
      localStorage.setItem('scirepl_onboarding_seen', '1');
      addEventListener('DOMContentLoaded', () => localStorage.setItem(
          'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for Python kernel to be fully ready (including micropip)
    console.log('   Waiting for Pyodide + micropip...');
    await page.waitForFunction(() => {
      const km = window.kernelManager;
      return km && km.getKernel('python') && km.getKernel('python').isReady();
    }, { timeout: TIMEOUT });

    // --- Test 1: micropip is available ---
    console.log('2. Testing micropip availability...');

    const micropipAvail = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('import micropip; print(type(micropip).__name__)', 'python');
    });
    testLog('micropip is importable',
      (micropipAvail.stdout || '').trim() === 'module',
      (micropipAvail.stdout || '').trim() || micropipAvail.error);

    // --- Test 2: pip_install() helper available ---
    console.log('3. Testing pip_install() helper...');

    const helperAvail = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('print(callable(pip_install))', 'python');
    });
    testLog('pip_install() is callable',
      (helperAvail.stdout || '').trim() === 'True',
      (helperAvail.stdout || '').trim() || helperAvail.error);

    // --- Test 3: %pip install a pure-Python package ---
    console.log('4. Testing %pip install...');

    const pipInstall = await page.evaluate(async () => {
      const km = window.kernelManager;
      // Use runFromInputBar to test the %pip magic path through app.js
      // But we need to use executeCode directly since runFromInputBar goes through UI
      // Let's test via the Python kernel directly first
      return await km.execute('await pip_install("six")', 'python');
    });
    testLog('%pip install six (pure Python)',
      (pipInstall.stdout || '').includes('Installed six'),
      (pipInstall.stdout || '').trim() || pipInstall.error);

    // --- Test 4: Installed package is importable ---
    const importSix = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('import six; print(six.__version__)', 'python');
    });
    testLog('six is importable after install',
      (importSix.stdout || '').trim().length > 0,
      (importSix.stdout || '').trim() || importSix.error);

    // --- Test 5: Multiple packages ---
    console.log('5. Testing multiple package install...');

    const multiInstall = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('await pip_install("pure-eval", "executing")', 'python');
    });
    testLog('Multiple packages install',
      (multiInstall.stdout || '').includes('Installed pure-eval') &&
      (multiInstall.stdout || '').includes('Installed executing'),
      (multiInstall.stdout || '').trim() || multiInstall.error);

    // --- Test 6: Failed install (nonexistent package) ---
    console.log('6. Testing error handling...');

    const failInstall = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('await pip_install("nonexistent_fake_pkg_12345")', 'python');
    });
    testLog('Nonexistent package shows error (no crash)',
      (failInstall.stdout || '').includes('Failed to install'),
      (failInstall.stdout || '').trim() || failInstall.error);

    // --- Test 7: %pip magic via executeCode ---
    console.log('7. Testing %pip magic command path...');

    const magicTest = await page.evaluate(async () => {
      // Test the magic command via the app's executeCode function
      if (typeof window.executeCode === 'function') {
        return { skip: false, result: 'executeCode available' };
      }
      // executeCode is module-scoped, test via runFromInputBar instead
      return { skip: true };
    });

    if (magicTest.skip) {
      // Test %pip magic via the input bar
      const magicResult = await page.evaluate(async () => {
        const input = document.getElementById('code-input');
        const runBtn = document.getElementById('run-btn');
        const langSel = document.getElementById('lang-selector');

        // Ensure Python is selected
        langSel.value = 'python';
        langSel.dispatchEvent(new Event('change'));

        const cellsBefore = window._cells.length;

        // Type and run %pip install
        input.value = '%pip install chardet';
        input.dispatchEvent(new Event('input'));
        runBtn.click();

        // Wait for new cell to appear
        await new Promise(resolve => {
          const check = () => {
            if (window._cells.length > cellsBefore) resolve();
            else setTimeout(check, 200);
          };
          check();
        });

        // Wait for output
        await new Promise(r => setTimeout(r, 5000));

        // Check the last output card
        const lastCell = window._cells[window._cells.length - 1];
        const outputText = lastCell.outputCard ? lastCell.outputCard.textContent : '';
        return outputText;
      });

      testLog('%pip magic via input bar installs chardet',
        magicResult.includes('Installed chardet'),
        magicResult.trim().substring(0, 100));

      // Verify chardet is importable
      const importChardet = await page.evaluate(async () => {
        const km = window.kernelManager;
        return await km.execute('import chardet; print(chardet.__version__)', 'python');
      });
      testLog('chardet importable after %pip magic',
        (importChardet.stdout || '').trim().length > 0,
        (importChardet.stdout || '').trim() || importChardet.error);
    }

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All micropip tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
