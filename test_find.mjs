// Playwright test: verify `find` command works in brush-wasm SciREPL
import { chromium } from 'playwright';

const TIMEOUT = 90_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  let allPassed = true;
  const testLog = (name, passed, detail) => {
    const mark = passed ? 'PASS' : 'FAIL';
    if (!passed) allPassed = false;
    console.log(`  [${mark}] ${name}${detail ? ': ' + detail.trim() : ''}`);
  };

  try {
    console.log('1. Navigating to SciREPL...');
    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Dismiss privacy modal
    try {
      const acceptBtn = await page.waitForSelector('#privacy-modal button, #privacy-modal .btn', { timeout: 5000 });
      if (acceptBtn) await acceptBtn.click();
    } catch {}

    // Wait for page scripts to load
    console.log('2. Waiting for page scripts (3s)...');
    await page.waitForTimeout(3000);

    // Initialize bash kernel via ensureReady
    console.log('3. Initializing bash kernel...');
    const initResult = await page.evaluate(async () => {
      const km = window.kernelManager;
      if (!km) return { error: 'no kernelManager' };
      try {
        await km.ensureReady('bash');
        const kernel = km.getKernel('bash');
        return { ready: kernel.isReady(), name: kernel.getName?.() || 'bash' };
      } catch (e) {
        return { error: e.message + '\n' + e.stack };
      }
    });
    console.log('   Kernel status:', JSON.stringify(initResult));

    if (initResult.error) throw new Error('Kernel init failed: ' + initResult.error);

    // Helper: execute with timeout
    const exec = async (cmd, timeoutMs = 10000) => {
      const result = await page.evaluate(async ({command, timeout}) => {
        const km = window.kernelManager;
        try {
          const p = km.execute(command, 'bash');
          const timer = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT: ' + command)), timeout)
          );
          const r = await Promise.race([p, timer]);
          if (r.error) return 'ERROR: ' + r.error;
          return (r.stdout || '') + (r.result || '');
        } catch (e) {
          return 'EXCEPTION: ' + e.message;
        }
      }, { command: cmd, timeout: timeoutMs });
      return result;
    };

    // Quick test: echo works?
    console.log('4. Testing basic echo...');
    const echoTest = await exec('echo hello');
    console.log('   echo hello:', JSON.stringify(echoTest));

    if (echoTest.includes('TIMEOUT') || echoTest.includes('EXCEPTION')) {
      throw new Error('Basic echo failed: ' + echoTest);
    }

    // Setup test files
    console.log('5. Setting up test files...');
    const setup = await exec('mkdir -p /tmp/findtest/sub && touch /tmp/findtest/a.txt /tmp/findtest/b.log /tmp/findtest/sub/c.txt /tmp/findtest/sub/d.md /tmp/findtest/FOO.TXT && echo SETUP_OK');
    console.log('   Setup result:', JSON.stringify(setup));

    const lsOut = await exec('ls /tmp/findtest');
    console.log('   ls /tmp/findtest:', JSON.stringify(lsOut));

    // Run find tests
    console.log('\n6. Running find tests:\n');

    // Test 1: find --version
    const version = await exec('find --version 2>&1');
    testLog('find --version', version && version.includes('find'), version);

    // Test 2: find default print
    const defaultFind = await exec('find /tmp/findtest -sorted 2>&1');
    testLog('find (default print)', defaultFind && defaultFind.includes('/tmp/findtest'), defaultFind);

    // Test 3: find -name "*.txt"
    const nameResult = await exec('find /tmp/findtest -name "*.txt" -sorted 2>&1');
    testLog('find -name "*.txt"',
      nameResult && nameResult.includes('a.txt') && nameResult.includes('c.txt') && !nameResult.includes('b.log'),
      nameResult);

    // Test 4: find -type d
    const typeDResult = await exec('find /tmp/findtest -type d -sorted 2>&1');
    testLog('find -type d',
      typeDResult && typeDResult.includes('/tmp/findtest') && typeDResult.includes('sub') && !typeDResult.includes('.txt'),
      typeDResult);

    // Test 5: find -type f
    const typeFResult = await exec('find /tmp/findtest -type f -sorted 2>&1');
    testLog('find -type f',
      typeFResult && typeFResult.includes('a.txt') && typeFResult.includes('b.log'),
      typeFResult);

    // Test 6: find -maxdepth 1
    const maxdepthResult = await exec('find /tmp/findtest -maxdepth 1 -sorted 2>&1');
    testLog('find -maxdepth 1',
      maxdepthResult && !maxdepthResult.includes('c.txt') && maxdepthResult.includes('a.txt'),
      maxdepthResult);

    // Test 7: find -not
    const notResult = await exec('find /tmp/findtest -type f -not -name "*.log" -sorted 2>&1');
    testLog('find -not -name "*.log"',
      notResult && !notResult.includes('b.log') && notResult.includes('a.txt'),
      notResult);

    // Test 8: find -iname
    const inameResult = await exec('find /tmp/findtest -maxdepth 1 -iname "foo*" -sorted 2>&1');
    testLog('find -iname "foo*"',
      inameResult && inameResult.includes('FOO.TXT'),
      inameResult);

    // Test 9: find -or
    const orResult = await exec('find /tmp/findtest -name "*.txt" -or -name "*.md" -sorted 2>&1');
    testLog('find -or',
      orResult && orResult.includes('.txt') && orResult.includes('.md'),
      orResult);

    // Test 10: find -print0
    const print0Result = await exec('find /tmp/findtest -maxdepth 1 -name "*.txt" -print0 2>&1');
    testLog('find -print0',
      print0Result !== undefined && print0Result !== null && print0Result.includes('a.txt'),
      print0Result ? print0Result.replace(/\0/g, '\\0') : '(null)');

    console.log(`\n=== ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===\n`);

    if (!allPassed) {
      console.log('--- Last 15 Console Logs ---');
      for (const log of consoleLogs.slice(-15)) console.log(log);
    }

  } catch (err) {
    console.error('Test error:', err.message);
    console.log('\n--- Console Logs ---');
    for (const log of consoleLogs.slice(-20)) console.log(log);
  } finally {
    await browser.close();
    process.exit(allPassed ? 0 : 1);
  }
})();
