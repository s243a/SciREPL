import { chromium } from 'playwright';

const BASE = 'http://localhost:8085';

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox']
    });
    const page = await browser.newPage();

    page.on('console', msg => {
        const t = msg.text();
        if (t.includes('ython') || t.includes('yodide') || t.includes('ownload') ||
            t.includes('rror') || t.includes('crash') || t.includes('Helper') ||
            t.includes('ready') || t.includes('init'))
            console.log('  [page]', t.substring(0, 200));
    });

    page.on('pageerror', err => console.log('  [PAGE ERROR]', err.message));

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
    });
    await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });

    console.log('Triggering Python ensureReady — waiting up to 5 minutes...');
    const start = Date.now();

    // Use addScriptTag to trigger ensureReady without page.evaluate(),
    // which causes ERR_STRING_TOO_LONG when Pyodide WASM loads.
    // Signal readiness via a DOM attribute instead.
    await page.addScriptTag({ content: `
        window.kernelManager.ensureReady('python')
            .then(() => document.body.setAttribute('data-python-ready', 'true'))
            .catch(e => document.body.setAttribute('data-python-error', e.message));
    `});

    try {
        // waitForFunction uses polling that doesn't serialize the full WASM state
        await page.waitForFunction(
            () => document.body.hasAttribute('data-python-ready') || document.body.hasAttribute('data-python-error'),
            { timeout: 300000, polling: 2000 }
        );

        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const error = await page.getAttribute('body', 'data-python-error');
        if (error) {
            console.log(`FAILED after ${elapsed}s:`, error);
        } else {
            console.log(`SUCCESS: Python ready in ${elapsed}s`);

            // Test execution via addScriptTag too
            await page.addScriptTag({ content: `
                window.kernelManager.execute('python', 'print(2+2)')
                    .then(r => document.body.setAttribute('data-exec-result', JSON.stringify(r)))
                    .catch(e => document.body.setAttribute('data-exec-error', e.message));
            `});
            await page.waitForFunction(
                () => document.body.hasAttribute('data-exec-result') || document.body.hasAttribute('data-exec-error'),
                { timeout: 30000 }
            );
            const result = await page.getAttribute('body', 'data-exec-result');
            const execErr = await page.getAttribute('body', 'data-exec-error');
            console.log('Execution:', result || execErr);
        }
    } catch (e) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`TIMEOUT/ERROR after ${elapsed}s:`, e.message.substring(0, 200));
    }

    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
});
