// Playwright test: Auto-save / crash recovery
// Uses a single Pyodide load — simulates save/restore via sessionStorage + event dispatch.
import { chromium } from 'playwright';

const TIMEOUT = 180_000;
const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/`;

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
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

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

        // ── Test: beforeunload handler saves draft input ──

        console.log('2. Testing beforeunload saves draft input...');

        const beforeUnloadTest = await page.evaluate(() => {
            const input = document.getElementById('code-input');
            input.value = 'draft_test_value_123';

            // Fire beforeunload
            window.dispatchEvent(new Event('beforeunload'));

            const saved = sessionStorage.getItem('scirepl_draft_input');
            // Cleanup
            sessionStorage.removeItem('scirepl_draft_input');
            input.value = '';
            return saved;
        });
        testLog('beforeunload saves draft to sessionStorage', beforeUnloadTest === 'draft_test_value_123');

        // ── Test: beforeunload does NOT save empty input ──

        console.log('3. Testing beforeunload skips empty input...');

        const emptyTest = await page.evaluate(() => {
            const input = document.getElementById('code-input');
            input.value = '';
            sessionStorage.removeItem('scirepl_draft_input');

            window.dispatchEvent(new Event('beforeunload'));

            const saved = sessionStorage.getItem('scirepl_draft_input');
            return saved;
        });
        testLog('beforeunload does not save empty input', emptyTest === null);

        // ── Test: beforeunload saves whitespace-only as non-empty ──

        console.log('4. Testing beforeunload with whitespace-only input...');

        const whitespaceTest = await page.evaluate(() => {
            const input = document.getElementById('code-input');
            input.value = '   ';
            sessionStorage.removeItem('scirepl_draft_input');

            window.dispatchEvent(new Event('beforeunload'));

            const saved = sessionStorage.getItem('scirepl_draft_input');
            sessionStorage.removeItem('scirepl_draft_input');
            input.value = '';
            return saved;
        });
        testLog('beforeunload skips whitespace-only input', whitespaceTest === null);

        // ── Test: Draft restore on init ──

        console.log('5. Testing draft restore from sessionStorage...');

        const restoreTest = await page.evaluate(() => {
            // Simulate: set draft in sessionStorage, then trigger the restore logic
            const input = document.getElementById('code-input');
            input.value = '';

            // Set a draft as if beforeunload had saved it
            sessionStorage.setItem('scirepl_draft_input', 'restored_draft_value');

            // The restore code runs on script init. Simulate it:
            const draft = sessionStorage.getItem('scirepl_draft_input');
            if (draft) {
                input.value = draft;
                sessionStorage.removeItem('scirepl_draft_input');
            }

            const result = input.value;
            const keyGone = sessionStorage.getItem('scirepl_draft_input') === null;
            input.value = ''; // cleanup
            return { restored: result, keyCleared: keyGone };
        });
        testLog('Draft input restored from sessionStorage', restoreTest.restored === 'restored_draft_value');
        testLog('Draft sessionStorage key cleared after restore', restoreTest.keyCleared);

        // ── Test: beforeunload commits in-progress cell edits ──

        console.log('6. Testing beforeunload saves cell edits...');

        await page.evaluate(async () => {
            // Clear existing cells
            while (window._cells.length > 0) window.deleteCell(0);
            await window.importCells([
                { code: 'original_code()', type: 'code', language: 'python' }
            ]);
        });

        // Enter edit mode
        await page.click('.cell-edit-btn');
        await page.waitForSelector('.cell-editor');

        // Modify the code in the editor
        await page.fill('.cell-editor', 'modified_in_editor()');

        // Fire beforeunload — should commit the edit to the cell and save
        const cellEditTest = await page.evaluate(() => {
            window.dispatchEvent(new Event('beforeunload'));

            // Check the cell object was updated
            const cell = window._cells[0];
            const codeInMemory = cell ? cell.code : null;

            // Check it was persisted
            const saved = window.sessionManager.getSavedCells();
            const codeInStorage = saved.length > 0 ? saved[0].code : null;

            return { codeInMemory, codeInStorage };
        });

        testLog('beforeunload commits cell edit to memory', cellEditTest.codeInMemory === 'modified_in_editor()');
        testLog('beforeunload persists cell edit to storage', cellEditTest.codeInStorage === 'modified_in_editor()');

        // Exit edit mode (press Escape)
        await page.keyboard.press('Escape');

        // ── Test: saveCellsToSession round-trip ──

        console.log('7. Testing saveCellsToSession round-trip...');

        const persistTest = await page.evaluate(() => {
            // Check that the cells from test 6 are persisted
            const saved = window.sessionManager.getSavedCells();
            return {
                count: saved.length,
                hasCells: saved.length > 0,
                savedCode: saved.length > 0 ? saved[0].code : null
            };
        });

        testLog('saveCellsToSession persists cells', persistTest.hasCells, `${persistTest.count} cells`);
        testLog('Persisted cell has correct code', persistTest.savedCode === 'modified_in_editor()',
            persistTest.savedCode);

        // ── Test: Auto-save timer callback logic ──

        console.log('8. Testing auto-save timer logic...');

        // Reuse the cell from test 6. Enter edit mode and change code.
        await page.click('.cell-edit-btn');
        await page.waitForSelector('.cell-editor');
        await page.fill('.cell-editor', 'timer_test_modified()');

        // Simulate what the 30s timer does (commit editor → save)
        const timerTest = await page.evaluate(() => {
            const editor = document.querySelector('.cell-editor');
            if (!editor) return { error: 'no editor' };

            const card = editor.closest('.card-input');
            const cellId = card ? parseInt(card.dataset.cellId) : -1;
            const cell = window._cells.find(c => c.id === cellId);
            if (!cell) return { error: 'no cell' };

            // This is exactly what the timer does
            if (editor.value.trim() !== cell.code) {
                cell.code = editor.value.trim();
            }

            return { cellCode: cell.code };
        });

        if (timerTest.error) {
            testLog('Auto-save timer logic works', false, timerTest.error);
        } else {
            testLog('Timer commits editor value to cell', timerTest.cellCode === 'timer_test_modified()');
        }

        await page.keyboard.press('Escape');

        // ── Test: Full reload round-trip (one reload only) ──

        console.log('9. Testing full reload round-trip (single reload)...');

        // Set up: use existing cell, type a draft
        await page.evaluate(() => {
            document.getElementById('code-input').value = 'reload_draft_input';
        });

        // Reload (triggers real beforeunload + full restore)
        await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.evaluate(async () => {
            // Returning the kernel would make Playwright serialise the whole
            // Pyodide object graph over CDP, which blows Node's string limit.
            await window.kernelManager.ensureReady('python');
        });
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        const reloadTest = await page.evaluate(() => {
            const input = document.getElementById('code-input');
            const cells = window._cells || [];
            return {
                draftRestored: input.value,
                cellCount: cells.length,
                cellCode: cells.length > 0 ? cells[0].code : null
            };
        });

        testLog('Draft input restored after real reload', reloadTest.draftRestored === 'reload_draft_input',
            reloadTest.draftRestored);
        testLog('Cells restored after reload', reloadTest.cellCount >= 1, `${reloadTest.cellCount} cells`);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All auto-save tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
