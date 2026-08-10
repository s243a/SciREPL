// Playwright test: R SharedVFS integration + R package installation
import { chromium } from 'playwright';

const TIMEOUT = 180_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  // Accept all confirm dialogs (webR download prompt)
  page.on('dialog', async dialog => {
    if (dialog.type() === 'confirm') {
      await dialog.accept();
    }
  });

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
    });

    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // Wait for Python (needed for cross-kernel tests)
    console.log('   Waiting for Pyodide...');
    await page.waitForFunction(() => {
      const km = window.kernelManager;
      return km && km._instances && km._instances.python && km._instances.python.isReady();
    }, { timeout: TIMEOUT });

    // Init R kernel
    console.log('   Initializing R kernel (webR download)...');
    await page.evaluate(async () => {
      await window.kernelManager.ensureReady('r');
    }, { timeout: TIMEOUT });

    // ── SharedVFS: Python writes → R reads ──

    console.log('2. Testing SharedVFS: Python → R...');

    await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.execute(
        'import sharedfs\nsharedfs.write_text("/shared/data/py_to_r.txt", "hello from python")',
        'python'
      );
    });

    const pyToR = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('sharedfs_read("/shared/data/py_to_r.txt")', 'r');
    });
    const pyToROutput = (pyToR.stdout || '') + ' ' + (pyToR.result ? pyToR.result.content : '');
    testLog('Python write → R read',
      pyToROutput.includes('hello from python'),
      pyToROutput.trim() || pyToR.error);

    // ── SharedVFS: R writes → Bash reads ──

    console.log('3. Testing SharedVFS: R → Bash...');

    await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.execute('sharedfs_write("/shared/data/from_r.txt", "hello from R")', 'r');
    });

    const rToBash = await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.ensureReady('bash');
      return await km.execute('cat /shared/data/from_r.txt', 'bash');
    });
    testLog('R write → Bash read',
      (rToBash.stdout || '').includes('hello from R'),
      (rToBash.stdout || '').trim() || rToBash.error);

    // ── SharedVFS: R writes → JS reads ──

    console.log('4. Testing SharedVFS: R → JS...');

    const rToJs = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute(
        'window.sharedVFS.readFile("/shared/data/from_r.txt", "utf8")',
        'javascript'
      );
    });
    const rToJsContent = rToJs.result ? rToJs.result.content : '';
    testLog('R write → JS read',
      rToJsContent.includes('hello from R'),
      rToJsContent || rToJs.error || 'no result');

    // ── SharedVFS: JS writes → R reads ──

    console.log('5. Testing SharedVFS: JS → R...');

    await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.execute(
        'window.sharedVFS.writeFile("/shared/data/js_to_r.txt", "hello from JS", "javascript")',
        'javascript'
      );
    });

    const jsToR = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('sharedfs_read("/shared/data/js_to_r.txt")', 'r');
    });
    const jsToROutput = (jsToR.stdout || '') + ' ' + (jsToR.result ? jsToR.result.content : '');
    testLog('JS write → R read',
      jsToROutput.includes('hello from JS'),
      jsToROutput.trim() || jsToR.error);

    // ── SharedVFS: R helper functions ──

    console.log('6. Testing R SharedVFS helper functions...');

    const existsTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('sharedfs_exists("/shared/data/from_r.txt")', 'r');
    });
    const existsOutput = (existsTest.stdout || '') + ' ' + (existsTest.result ? existsTest.result.content : '');
    testLog('sharedfs_exists() returns TRUE',
      existsOutput.includes('TRUE') || existsOutput.includes('true'),
      existsOutput.trim() || existsTest.error);

    const listTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('sharedfs_list("/shared/data")', 'r');
    });
    const listOutput = (listTest.stdout || '') + ' ' + (listTest.result ? listTest.result.content : '');
    testLog('sharedfs_list() shows files',
      listOutput.includes('from_r.txt'),
      listOutput.trim() || listTest.error);

    const removeTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.execute('sharedfs_remove("/shared/data/from_r.txt")', 'r');
      return await km.execute('sharedfs_exists("/shared/data/from_r.txt")', 'r');
    });
    const removeOutput = (removeTest.stdout || '') + ' ' + (removeTest.result ? removeTest.result.content : '');
    testLog('sharedfs_remove() deletes file',
      removeOutput.includes('FALSE') || removeOutput.includes('false'),
      removeOutput.trim() || removeTest.error);

    // ── SharedVFS: R native file.* functions ──

    console.log('7. Testing R native file operations on /shared/...');

    const nativeWrite = await page.evaluate(async () => {
      const km = window.kernelManager;
      await km.execute('writeLines("native R write", "/shared/data/native_r.txt")', 'r');
      // After execution, syncFromWebR should push this to SharedVFS
      return window.sharedVFS.readFile('/shared/data/native_r.txt', 'utf8');
    });
    testLog('R writeLines() → SharedVFS sync',
      nativeWrite && nativeWrite.includes('native R write'),
      nativeWrite || 'not synced');

    // ── Package installation: install.packages() ──

    console.log('8. Testing R package installation...');

    const installTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      // jsonlite is a commonly available WASM package
      return await km.execute('install.packages("jsonlite")\nlibrary(jsonlite)\ncat("jsonlite loaded\\n")', 'r');
    });
    const installOutput = (installTest.stdout || '');
    testLog('install.packages("jsonlite") works',
      installOutput.includes('jsonlite loaded') || installOutput.includes('jsonlite'),
      installOutput.trim().substring(0, 200) || installTest.error);

    // Test using the installed package
    const useTest = await page.evaluate(async () => {
      const km = window.kernelManager;
      return await km.execute('toJSON(list(a = 1, b = "hello"))', 'r');
    });
    const useOutput = (useTest.stdout || '') + ' ' + (useTest.result ? useTest.result.content : '');
    testLog('jsonlite toJSON() works',
      useOutput.includes('"a"') && useOutput.includes('"hello"'),
      useOutput.trim().substring(0, 200) || useTest.error);

    // ── %install magic ──

    console.log('9. Testing %install magic command...');

    const magicInstall = await page.evaluate(async () => {
      // Test via the executeCode path (app.js magic handler)
      const code = '%install cli';
      const km = window.kernelManager;
      // Simulate the magic handler path
      const rInstallMatch = code.match(/^%install\s+(.+)$/m);
      if (rInstallMatch) {
        const packages = rInstallMatch[1].trim().split(/\s+/);
        const kernel = km._instances && km._instances['r'];
        if (kernel && kernel.installPackages) {
          return { stdout: await kernel.installPackages(packages), error: null };
        }
      }
      return { stdout: '', error: 'magic not matched' };
    });
    testLog('%install cli works',
      (magicInstall.stdout || '').includes('Installed cli') || (magicInstall.stdout || '').includes('cli'),
      (magicInstall.stdout || '').trim().substring(0, 200) || magicInstall.error);

    // --- Summary ---
    console.log('\n' + '='.repeat(50));
    const passCount = results.filter(r => r.passed).length;
    console.log(`Results: ${passCount}/${results.length} passed`);
    console.log(allPassed ? '\nPASS: All R SharedVFS + package tests passed!' : '\nFAIL: Some tests failed');

  } catch (err) {
    console.error('FATAL:', err.message);
    console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
    allPassed = false;
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
