// Playwright test: Browse Packages & Workbooks catalog
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
        });

        await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });


        // ── Test: Menu button text ──

        console.log('2. Testing menu button text...');

        const btnText = await page.evaluate(() => {
            return document.getElementById('btn-browse-packages')?.textContent?.trim();
        });
        testLog('Menu button contains "Browse Packages & Workbooks"', btnText && btnText.includes('Browse Packages & Workbooks'), btnText);

        // ── Test: Modal title ──

        console.log('3. Testing modal title...');

        const modalTitle = await page.evaluate(() => {
            const modal = document.getElementById('package-catalog-modal');
            return modal?.querySelector('h2')?.textContent?.trim();
        });
        testLog('Modal title says "Browse Packages & Workbooks"', modalTitle === 'Browse Packages & Workbooks', modalTitle);

        // ── Test: Open catalog modal ──

        console.log('4. Opening catalog modal...');

        await page.evaluate(() => {
            document.getElementById('btn-browse-packages').click();
        });

        await page.waitForSelector('#package-catalog-modal:not(.hidden)', { timeout: 5000 });
        testLog('Catalog modal opens', true);

        // ── Test: Section headers ──

        console.log('5. Testing section headers...');

        const sections = await page.evaluate(() => {
            const headers = document.querySelectorAll('#package-catalog-list .catalog-section-header');
            return Array.from(headers).map(h => h.textContent.trim());
        });

        testLog('Has "Packages" section', sections.includes('Packages'), sections.join(', '));
        testLog('Has "Workbooks" section', sections.includes('Workbooks'), sections.join(', '));

        // ── Test: Catalog entries ──

        console.log('6. Testing catalog entries...');

        const cards = await page.evaluate(() => {
            const items = document.querySelectorAll('#package-catalog-list .pkg-card');
            return Array.from(items).map(card => {
                return {
                    name: card.querySelector('strong')?.textContent?.trim(),
                    kernels: card.querySelector('.pkg-kernels')?.textContent?.trim(),
                    hasInstallBtn: !!card.querySelector('.pkg-install-btn')
                };
            });
        });

        testLog('Has at least 9 catalog entries', cards.length >= 9, `${cards.length} entries`);

        const packageEntry = cards.find(c => c.name === 'UnifyWeaver SciREPL');
        const workbookEntry = cards.find(c => c.name === 'Life Expectancy Analysis');
        const typrIntroEntry = cards.find(c => c.name === 'TypR Introduction');
        const generatedTyprEntry = cards.find(c => c.name === 'Prolog Generates TypR');

        testLog('Package entry exists', !!packageEntry);
        testLog('Workbook entry exists', !!workbookEntry);
        testLog('Workbook shows python, r kernels', workbookEntry?.kernels === 'python, r', workbookEntry?.kernels);
        testLog('TypR introduction entry exists', !!typrIntroEntry);
        testLog('TypR introduction shows typr, r kernels', typrIntroEntry?.kernels === 'typr, r', typrIntroEntry?.kernels);
        testLog('Generated TypR entry exists', !!generatedTyprEntry);
        testLog('Generated TypR shows prolog, typr, r kernels', generatedTyprEntry?.kernels === 'prolog, typr, r', generatedTyprEntry?.kernels);

        // ── Test: Workbook fetch via pages_url ──

        console.log('7. Testing workbook fetch...');

        const installResult = await page.evaluate(async () => {
            try {
                const resp = await fetch('workbooks/life_expectancy_csv_demo.ipynb');
                if (!resp.ok) return { fetched: false, error: `HTTP ${resp.status}` };
                const text = await resp.text();
                const parsed = JSON.parse(text);
                return {
                    fetched: true,
                    hasNbformat: parsed.nbformat === 4,
                    cellCount: parsed.cells?.length || 0
                };
            } catch (e) {
                return { fetched: false, error: e.message };
            }
        });

        testLog('Workbook fetches from pages_url', installResult.fetched, installResult.error || '');
        if (installResult.fetched) {
            testLog('Workbook is valid ipynb (nbformat 4)', installResult.hasNbformat);
            testLog('Workbook has cells', installResult.cellCount > 5, `${installResult.cellCount} cells`);
        }

        // ── Test: Generated TypR workbook ──

        console.log('8. Testing generated TypR workbook...');

        const typrWorkbookResult = await page.evaluate(async () => {
            try {
                const resp = await fetch('workbooks/prolog-generates-typr.srwb');
                if (!resp.ok) return { fetched: false, error: 'HTTP ' + resp.status };
                const workbook = await resp.json();
                const compileCell = workbook.notebook?.cells?.find(cell => cell.name === 'compile_to_typr');
                const code = compileCell?.code || '';
                return {
                    fetched: true,
                    usesDirectVariadicCat: code.includes('cat("Descendants of alice:", paste(results'),
                    hasLegacyCatPaste: code.includes('cat(paste(')
                };
            } catch (e) {
                return { fetched: false, error: e.message };
            }
        });

        testLog('Generated TypR workbook fetches from pages_url', typrWorkbookResult.fetched, typrWorkbookResult.error || '');
        if (typrWorkbookResult.fetched) {
            testLog('Generated TypR queries use direct variadic cat', typrWorkbookResult.usesDirectVariadicCat);
            testLog('Generated TypR queries omit legacy cat(paste(...))', !typrWorkbookResult.hasLegacyCatPaste);
        }

        // ── Test: importIpynb integration ──

        console.log('9. Testing importIpynb integration...');

        const importResult = await page.evaluate(async () => {
            const resp = await fetch('workbooks/life_expectancy_csv_demo.ipynb');
            const text = await resp.text();

            window.fileIO.importIpynb(text);
            const cellsAfter = window._cells ? window._cells.length : 0;

            // Check that cells include content from the workbook
            const hasLifeExp = (window._cells || []).some(c =>
                c.code && c.code.includes('Life Expectancy')
            );

            return { cellsAfter, hasLifeExp };
        });

        testLog('importIpynb loads workbook content', importResult.hasLifeExp,
            `${importResult.cellsAfter} cells, hasLifeExp=${importResult.hasLifeExp}`);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All browse catalog tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
