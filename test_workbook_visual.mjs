// Visual test: Opens browser, imports workbook via UI, watches cells execute
import { chromium } from 'playwright';

const TIMEOUT = 180_000;

(async () => {
    const browser = await chromium.launch({ headless: false, slowMo: 150 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
    });
    const page = await context.newPage();

    // Auto-accept R download dialog
    page.on('dialog', async dialog => { await dialog.accept(); });

    console.log('Loading SciREPL...');
    await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Wait for Pyodide to be ready
    await page.waitForFunction(() => {
        const km = window.kernelManager;
        return km && km._instances && km._instances.python && km._instances.python.isReady();
    }, { timeout: TIMEOUT });
    console.log('Pyodide ready.');

    // 1. Open menu
    console.log('Opening menu...');
    await page.click('#menu-btn');
    await page.waitForTimeout(500);

    // 2. Click "Browse Packages, Bundles & Workbooks"
    console.log('Opening package catalog...');
    await page.click('#btn-browse-packages');
    await page.waitForSelector('#package-catalog-list', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // 3. Find and install the Life Expectancy workbook
    console.log('Installing Life Expectancy workbook...');
    const installBtn = page.locator('.pkg-card:has-text("Life Expectancy") .pkg-install-btn');
    const count = await installBtn.count();
    if (count === 0) {
        console.log('  (workbook not found by name, clicking first install button)');
        await page.locator('.pkg-install-btn').first().click();
    } else {
        await installBtn.click();
    }

    // 4. Wait for importCells to finish — it auto-executes all cells
    //    The status badge changes to 'ready' when importCells completes
    console.log('Waiting for workbook to import and execute all cells...');
    console.log('  (importCells auto-executes each cell — this includes downloading webR for R cells)');

    // First, wait for at least one cell to appear
    await page.waitForSelector('.card.card-input', { timeout: 60000 });

    // Then wait for the status badge to return to 'ready' (importCells sets it to 'importing...')
    // Also periodically log progress
    let lastCellCount = 0;
    for (let i = 0; i < 180; i++) { // up to 6 minutes
        await page.waitForTimeout(2000);

        const state = await page.evaluate(() => {
            const badge = document.getElementById('status-badge');
            return {
                badgeText: badge ? badge.textContent : 'unknown',
                cellCount: window._cells ? window._cells.length : 0,
                outputCount: document.querySelectorAll('.card.card-output').length,
            };
        });

        if (state.cellCount > lastCellCount) {
            console.log(`  ${state.cellCount} cells loaded, ${state.outputCount} outputs, status: ${state.badgeText}`);
            lastCellCount = state.cellCount;
        }

        // importCells sets badge to 'importing…' and back to 'ready' when done
        if (state.badgeText === 'ready' && state.cellCount >= 15) {
            console.log(`  Import complete: ${state.cellCount} cells, ${state.outputCount} outputs`);
            break;
        }
    }

    // 5. Check for errors in R cells
    const errors = await page.evaluate(() => {
        const errs = [];
        document.querySelectorAll('.card.card-output .card-body').forEach((body, i) => {
            const text = body.textContent || '';
            if (text.includes('Error') || text.includes('cannot open file')) {
                errs.push({ cell: i, text: text.substring(0, 200) });
            }
        });
        return errs;
    });

    if (errors.length > 0) {
        console.log('\nErrors found in output cells:');
        for (const e of errors) {
            console.log(`  Cell output ${e.cell}: ${e.text}`);
        }
    } else {
        console.log('\nNo errors found in output cells.');
    }

    // 6. Check SharedVFS
    const files = await page.evaluate(() => {
        if (!window.sharedVFS) return [];
        return [...window.sharedVFS._files.entries()].map(([p, e]) => `${p} (${e.size}b)`);
    });
    console.log('SharedVFS files:', files);

    console.log('\nDone! Browser will stay open — press Ctrl+C to close.');
    await new Promise(() => {});
})();
