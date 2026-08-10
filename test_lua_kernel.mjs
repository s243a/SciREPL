/**
 * Playwright test: Lua kernel + Language settings GUI
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const logs = [];
    page.on('console', msg => {
        logs.push(`[${msg.type()}] ${msg.text()}`);
    });

    console.log('1. Loading SciREPL...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Clear service worker caches and set prefs
    await page.evaluate(async () => {
        // Unregister service workers to get fresh code
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        // Clear all caches
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
    });

    // Reload to get fresh code without service worker
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    // Test 1: Lua option exists in main language selector
    console.log('2. Checking Lua in language selector...');
    const luaOption = await page.$('#lang-selector option[value="lua"]');
    if (!luaOption) throw new Error('FAIL: Lua option not found in lang-selector');
    console.log('   PASS: Lua option found');

    // Test 2: Select Lua and verify styling
    console.log('3. Selecting Lua language...');
    await page.selectOption('#lang-selector', 'lua');
    const selectorClass = await page.$eval('#lang-selector', el => el.className);
    if (!selectorClass.includes('lua-active')) throw new Error('FAIL: lua-active class not applied');
    console.log('   PASS: lua-active class applied');

    // Test 3: Execute Lua code via kernel directly (to verify kernel works)
    console.log('4. Testing Lua kernel execution...');
    const execResult = await page.evaluate(async () => {
        const km = window.kernelManager;
        await km.ensureReady('lua');
        return await km.execute('print("Hello from Lua!")', 'lua');
    });
    if (!execResult.stdout.includes('Hello from Lua!')) {
        throw new Error('FAIL: Expected "Hello from Lua!" in stdout, got: ' + execResult.stdout);
    }
    if (execResult.error) throw new Error('FAIL: Lua execution error: ' + execResult.error);
    console.log('   PASS: Lua print output correct');

    // Test 4: Lua expression auto-return
    console.log('5. Testing Lua auto-return...');
    const exprResult = await page.evaluate(async () => {
        return await window.kernelManager.execute('2 + 3', 'lua');
    });
    if (!exprResult.result || !exprResult.result.content.includes('5')) {
        throw new Error('FAIL: Expected result "5", got: ' + JSON.stringify(exprResult));
    }
    console.log('   PASS: Lua expression auto-return works');

    // Test 5: Lua state persistence
    console.log('6. Testing Lua state persistence...');
    await page.evaluate(async () => window.kernelManager.execute('x = 42', 'lua'));
    const persistResult = await page.evaluate(async () => {
        return await window.kernelManager.execute('print(x)', 'lua');
    });
    if (!persistResult.stdout.includes('42')) {
        throw new Error('FAIL: Expected "42" in output, got: ' + persistResult.stdout);
    }
    console.log('   PASS: Lua state persists between cells');

    // Test 6: Lua error handling
    console.log('7. Testing Lua error handling...');
    const errResult = await page.evaluate(async () => {
        return await window.kernelManager.execute('undefined_var()', 'lua');
    });
    if (!errResult.error) throw new Error('FAIL: Expected error for undefined function call');
    console.log('   PASS: Lua error handling works');

    // Test 7: Lua table output
    console.log('8. Testing Lua table print...');
    const tableResult = await page.evaluate(async () => {
        return await window.kernelManager.execute('t = {1, 2, 3}; print(#t)', 'lua');
    });
    if (!tableResult.stdout.includes('3')) {
        throw new Error('FAIL: Expected "3" in table length output, got: ' + tableResult.stdout);
    }
    console.log('   PASS: Lua table operations work');

    // Test 8: Languages modal
    console.log('10. Testing Languages modal...');
    await page.click('#menu-btn');
    await page.waitForSelector('#menu-modal:not(.hidden)', { timeout: 5000 });
    const langBtn = await page.$('#btn-languages');
    if (!langBtn) throw new Error('FAIL: Languages button not in menu');
    await langBtn.click();
    await page.waitForSelector('#languages-modal:not(.hidden)', { timeout: 5000 });

    // Check that all language checkboxes are present and checked
    const checkboxes = await page.$$('#languages-list .lang-toggle');
    if (checkboxes.length < 6) {
        throw new Error('FAIL: Expected at least 6 language checkboxes, got ' + checkboxes.length);
    }
    const allChecked = await page.$$eval('#languages-list .lang-toggle', cbs => cbs.every(cb => cb.checked));
    if (!allChecked) throw new Error('FAIL: Not all language checkboxes are checked by default');
    console.log('   PASS: Languages modal shows all languages checked');

    // Test 10: Disable a language and verify dropdown updates
    console.log('11. Testing language disable...');
    await page.click('.lang-toggle[data-lang="r"]');
    await page.waitForTimeout(500);
    const rOption = await page.$('#lang-selector option[value="r"]');
    if (rOption) throw new Error('FAIL: R option should be removed from lang-selector after disable');
    console.log('   PASS: Disabling R removes it from dropdown');

    // Re-enable R
    await page.click('.lang-toggle[data-lang="r"]');
    await page.waitForTimeout(500);
    const rOptionBack = await page.$('#lang-selector option[value="r"]');
    if (!rOptionBack) throw new Error('FAIL: R option should be back after re-enable');
    console.log('   PASS: Re-enabling R adds it back');

    // Close modal
    await page.click('#languages-modal .modal-close');
    await page.waitForSelector('#languages-modal.hidden', { timeout: 3000 });
    console.log('   PASS: Languages modal closes');

    // Test 11: Lua kernel can be destroyed and re-initialized
    console.log('12. Testing kernel destroy and re-init...');
    await page.evaluate(async () => {
        await window.kernelManager.destroyKernel('lua');
    });
    const afterDestroy = await page.evaluate(() => window.kernelManager.isReady('lua'));
    if (afterDestroy) throw new Error('FAIL: Lua should not be ready after destroy');
    const reinitResult = await page.evaluate(async () => {
        await window.kernelManager.ensureReady('lua');
        const r1 = await window.kernelManager.execute('print("after reinit")', 'lua');
        const r2 = await window.kernelManager.execute('return 99', 'lua');
        return { r1, r2 };
    });
    console.log('   Reinit results:', JSON.stringify(reinitResult));
    if (!reinitResult.r1.stdout.includes('after reinit')) {
        throw new Error('FAIL: Print after reinit failed');
    }
    console.log('   PASS: Kernel destroy and re-init works');

    console.log('\n=== ALL TESTS PASSED ===');
    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
