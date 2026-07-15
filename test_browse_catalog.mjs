// Playwright test: Browse Packages, Bundles & Workbooks catalog
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
            if (!sessionStorage.getItem('catalog_test_seeded')) {
                sessionStorage.setItem('catalog_test_seeded', '1');
                localStorage.setItem('scirepl_privacy_accepted', '1');
                localStorage.setItem('scirepl_installed_packages', JSON.stringify([{
                    name: 'UnifyWeaver SciREPL',
                    pages_url: 'packages/unifyweaver_scirepl.zip'
                }]));
            }
        });

        await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });


        // ── Test: Menu button text ──

        console.log('2. Testing menu button text...');

        const btnText = await page.evaluate(() => {
            return document.getElementById('btn-browse-packages')?.textContent?.trim();
        });
        testLog('Menu button includes Packages, Bundles & Workbooks',
            btnText && btnText.includes('Packages, Bundles & Workbooks'), btnText);

        // ── Test: Modal title ──

        console.log('3. Testing modal title...');

        const modalTitle = await page.evaluate(() => {
            const modal = document.getElementById('package-catalog-modal');
            return modal?.querySelector('h2')?.textContent?.trim();
        });
        testLog('Modal title includes Packages, Bundles & Workbooks',
            modalTitle === 'Browse Packages, Bundles & Workbooks', modalTitle);

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
        testLog('Has "Bundles" section', sections.includes('Bundles'), sections.join(', '));
        testLog('Has "Workbooks" section', sections.includes('Workbooks'), sections.join(', '));
        testLog('Sections are ordered Packages, Bundles, Workbooks',
            sections.join('|') === 'Packages|Bundles|Workbooks', sections.join(', '));

        // ── Test: Catalog entries ──

        console.log('6. Testing catalog entries...');

        const cards = await page.evaluate(() => {
            const items = document.querySelectorAll('#package-catalog-list .pkg-card');
            return Array.from(items).map(card => {
                return {
                    name: card.querySelector('strong')?.textContent?.trim(),
                    kernels: card.querySelector('.pkg-kernels')?.textContent?.trim(),
                    contents: card.querySelector('.pkg-contents')?.textContent?.trim(),
                    requires: card.querySelector('.pkg-requires')?.textContent?.trim(),
                    buttonText: card.querySelector('.pkg-install-btn')?.textContent?.trim(),
                    buttonDisabled: !!card.querySelector('.pkg-install-btn')?.disabled,
                    hasInstallBtn: !!card.querySelector('.pkg-install-btn')
                };
            });
        });

        testLog('Has at least 15 catalog entries', cards.length >= 15, `${cards.length} entries`);

        const packageEntry = cards.find(c => c.name === 'UnifyWeaver SciREPL');
        const bundleEntry = cards.find(c => c.name === 'UnifyWeaver Tutorials & Compiler Demos');
        const workbookEntry = cards.find(c => c.name === 'Life Expectancy Analysis');
        const typrIntroEntry = cards.find(c => c.name === 'TypR Introduction');
        const generatedTyprEntry = cards.find(c => c.name === 'Prolog Generates TypR');

        testLog('Package entry exists', !!packageEntry);
        testLog('Previously installed package is labelled Installed',
            packageEntry?.buttonText === 'Installed' && packageEntry?.buttonDisabled,
            `${packageEntry?.buttonText}, disabled=${packageEntry?.buttonDisabled}`);
        testLog('UnifyWeaver bundle entry exists', !!bundleEntry);
        testLog('UnifyWeaver bundle advertises four workbooks', bundleEntry?.contents === '4 workbooks', bundleEntry?.contents);
        testLog('UnifyWeaver bundle displays its package dependency',
            bundleEntry?.requires === 'Requires: UnifyWeaver SciREPL', bundleEntry?.requires);
        testLog('Workbook entry exists', !!workbookEntry);
        testLog('Workbook shows python, r kernels', workbookEntry?.kernels === 'python, r', workbookEntry?.kernels);
        testLog('TypR introduction entry exists', !!typrIntroEntry);
        testLog('TypR introduction shows typr, r kernels', typrIntroEntry?.kernels === 'typr, r', typrIntroEntry?.kernels);
        testLog('Generated TypR entry exists', !!generatedTyprEntry);
        testLog('Generated TypR shows prolog, typr, r kernels', generatedTyprEntry?.kernels === 'prolog, typr, r', generatedTyprEntry?.kernels);

        const bundleDefinition = await page.evaluate(() => {
            const bundle = window.packageCatalog.packages.find(p => p.id === 'unifyweaver-workbooks');
            return { items: bundle?.items || [], requires: bundle?.requires || [] };
        });
        testLog('Bundle matches package-builder workbook list',
            bundleDefinition.items.join('|') === [
                'unifyweaver-family-tree',
                'unifyweaver-recursion-patterns',
                'unifyweaver-call-graph',
                'prolog-generates-r'
            ].join('|'), bundleDefinition.items.join(', '));
        testLog('Bundle declares UnifyWeaver package dependency',
            bundleDefinition.requires.includes('unifyweaver-scirepl'), bundleDefinition.requires.join(', '));

        const bundleInstall = await page.evaluate(async () => {
            const catalog = window.packageCatalog;
            const bundle = catalog.packages.find(p => p.id === 'unifyweaver-workbooks');
            await catalog._ensureDependencies(bundle);
            await catalog._doImport(bundle, null);
            catalog._syncInstallButtons();
            const names = window.notebookManager.getNotebooks().map(nb => nb.name);
            return { names, installed: catalog._isInstalled(bundle) };
        });
        for (const name of [
            'Family Tree Tutorial with UnifyWeaver',
            'Advanced Recursion Patterns in UnifyWeaver',
            'Call Graph Analysis and SCC Detection',
            'Prolog Generates R: Compiler Demo'
        ]) {
            testLog(`Bundle installs ${name}`, bundleInstall.names.includes(name));
        }
        testLog('Bundle reports Installed after all members are present', bundleInstall.installed);

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
                    readsNamedPrologCell: code.includes("nb_read('family_tree', '.code', PrologSrc)"),
                    usesDirectVariadicCat: code.includes('cat("Descendants of alice:", paste(results'),
                    hasLegacyCatPaste: code.includes('cat(paste(')
                };
            } catch (e) {
                return { fetched: false, error: e.message };
            }
        });

        testLog('Generated TypR workbook fetches from pages_url', typrWorkbookResult.fetched, typrWorkbookResult.error || '');
        if (typrWorkbookResult.fetched) {
            testLog('Generated TypR compiler reads the named Prolog source cell', typrWorkbookResult.readsNamedPrologCell);
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

        // ── Test: Clear History resets catalog installation state ──

        console.log('10. Testing Clear History package-state reset...');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT }),
            page.evaluate(() => {
                const button = document.getElementById('btn-clear-session');
                button.click();
                button.click();
            })
        ]);
        await page.waitForSelector('#run-btn:not([disabled])');
        await page.evaluate(() => document.getElementById('btn-browse-packages').click());
        const clearedPackageState = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('#package-catalog-list .pkg-card')];
            const card = cards.find(item => item.querySelector('strong')?.textContent?.trim() === 'UnifyWeaver SciREPL');
            const button = card?.querySelector('.pkg-install-btn');
            return {
                stored: localStorage.getItem('scirepl_installed_packages'),
                buttonText: button?.textContent?.trim(),
                disabled: !!button?.disabled
            };
        });
        testLog('Clear History removes remembered package installations',
            clearedPackageState.stored === null, clearedPackageState.stored || 'not stored');
        testLog('Catalog shows Install after Clear History and reload',
            clearedPackageState.buttonText === 'Install' && !clearedPackageState.disabled,
            `${clearedPackageState.buttonText}, disabled=${clearedPackageState.disabled}`);

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
