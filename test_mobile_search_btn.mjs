// Playwright test: Mobile search button opens search bar
import { chromium } from 'playwright';

const TIMEOUT = 180_000;

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
        console.log(`  [${mark}] ${name}${detail ? ': ' + detail : ''}`);
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

        console.log('   Waiting for Pyodide...');
        await page.evaluate(async () => {
            // Returning the kernel would make Playwright serialise the whole
            // Pyodide object graph over CDP, which blows Node's string limit.
            await window.kernelManager.ensureReady('python');
        });
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        // ── Test: Search button exists in header ──
        console.log('2. Testing search button in header...');

        const btnResult = await page.evaluate(() => {
            const btn = document.getElementById('search-btn');
            return {
                exists: !!btn,
                isIconBtn: btn ? btn.classList.contains('icon-btn') : false,
                title: btn ? btn.title : '',
                visible: btn ? btn.offsetParent !== null : false,
                inHeader: btn ? !!btn.closest('.header-right') : false
            };
        });

        testLog('Search button exists', btnResult.exists);
        testLog('Search button has icon-btn class', btnResult.isIconBtn);
        testLog('Search button has correct title', btnResult.title === 'Find in notebook');
        testLog('Search button is visible', btnResult.visible);
        testLog('Search button is in header-right', btnResult.inHeader);

        // ── Test: Search bar is hidden initially ──
        console.log('3. Testing initial state...');

        const initialState = await page.evaluate(() => {
            return document.getElementById('search-bar').classList.contains('hidden');
        });
        testLog('Search bar is initially hidden', initialState);

        // ── Test: Clicking search button opens search bar ──
        console.log('4. Testing click opens search bar...');

        await page.click('#search-btn');
        await page.waitForTimeout(300);

        const afterClick = await page.evaluate(() => {
            const bar = document.getElementById('search-bar');
            const input = document.getElementById('search-input');
            return {
                barVisible: !bar.classList.contains('hidden'),
                inputFocused: document.activeElement === input
            };
        });

        testLog('Click opens search bar', afterClick.barVisible);
        testLog('Search input is focused after click', afterClick.inputFocused);

        // ── Test: Can search after opening via button ──
        console.log('5. Testing search works after button open...');

        // Add some cells first
        await page.evaluate(async () => {
            await window.importCells([
                { code: 'import numpy as np', type: 'code', language: 'python' },
                { code: 'x = np.array([1,2,3])', type: 'code', language: 'python' }
            ]);
        });
        await page.waitForTimeout(1500);

        // Close search bar first (it overlays the header button), then reopen
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        await page.click('#search-btn');
        await page.waitForTimeout(200);

        await page.fill('#search-input', 'np');
        await page.waitForTimeout(300);

        const searchResult = await page.evaluate(() => {
            const count = document.getElementById('search-count').textContent;
            return {
                count,
                hasMatches: !count.startsWith('0/')
            };
        });

        testLog('Search finds matches via button-opened bar', searchResult.hasMatches, searchResult.count);

        // ── Test: Close and reopen ──
        console.log('6. Testing close and reopen...');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        const closed = await page.evaluate(() =>
            document.getElementById('search-bar').classList.contains('hidden')
        );
        testLog('Escape closes search bar', closed);

        await page.click('#search-btn');
        await page.waitForTimeout(200);

        const reopened = await page.evaluate(() =>
            !document.getElementById('search-bar').classList.contains('hidden')
        );
        testLog('Button reopens search bar', reopened);

        // ── Test: Close button also works ──
        console.log('7. Testing close button...');

        await page.click('#search-close-btn');
        await page.waitForTimeout(200);

        const closedViaBtn = await page.evaluate(() =>
            document.getElementById('search-bar').classList.contains('hidden')
        );
        testLog('Close button hides search bar', closedViaBtn);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All mobile search button tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
