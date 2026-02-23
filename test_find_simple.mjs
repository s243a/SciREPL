// Minimal Playwright test: debug mutex recursion on ls/find
import { chromium } from 'playwright';

const TIMEOUT = 90_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

  try {
    console.log('1. Navigating to SciREPL...');
    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Dismiss privacy modal
    try {
      const acceptBtn = await page.waitForSelector('#privacy-modal button, #privacy-modal .btn', { timeout: 5000 });
      if (acceptBtn) await acceptBtn.click();
    } catch {}

    await page.waitForTimeout(3000);

    console.log('2. Initializing bash kernel...');
    const initResult = await page.evaluate(async () => {
      const km = window.kernelManager;
      if (!km) return { error: 'no kernelManager' };
      try {
        await km.ensureReady('bash');
        const kernel = km.getKernel('bash');
        return { ready: kernel.isReady(), name: kernel.getName?.() || 'bash' };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('   Kernel status:', JSON.stringify(initResult));
    if (initResult.error) throw new Error('Kernel init failed: ' + initResult.error);

    // Helper: execute with longer timeout
    const exec = async (cmd, timeoutMs = 15000) => {
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

    // Test 1: echo (should work)
    console.log('\n3. Testing echo...');
    const r1 = await exec('echo hello_world');
    console.log('   echo:', JSON.stringify(r1));

    // Test 2: pwd
    console.log('4. Testing pwd...');
    const r2 = await exec('pwd');
    console.log('   pwd:', JSON.stringify(r2));

    // Test 3: ls (root or cwd)
    console.log('5. Testing ls (no args)...');
    const r3 = await exec('ls');
    console.log('   ls:', JSON.stringify(r3));

    // Test 4: mkdir + ls
    console.log('6. Testing mkdir /tmp/test1...');
    const r4 = await exec('mkdir -p /tmp/test1 && echo DONE');
    console.log('   mkdir:', JSON.stringify(r4));

    console.log('7. Testing ls /tmp...');
    const r5 = await exec('ls /tmp');
    console.log('   ls /tmp:', JSON.stringify(r5));

    // Test 5: find --version
    console.log('8. Testing find --version...');
    const r6 = await exec('find --version 2>&1');
    console.log('   find --version:', JSON.stringify(r6));

    // Test 6: Simple find
    console.log('9. Testing find /tmp...');
    const r7 = await exec('find /tmp 2>&1');
    console.log('   find /tmp:', JSON.stringify(r7));

    console.log('\n--- Console Logs (last 10) ---');
    for (const log of consoleLogs.slice(-10)) console.log(log);

  } catch (err) {
    console.error('Test error:', err.message);
    console.log('\n--- Console Logs (last 20) ---');
    for (const log of consoleLogs.slice(-20)) console.log(log);
  } finally {
    await browser.close();
  }
})();
