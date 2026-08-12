// Playwright test: HTML, Markdown, PDF, DOCX export
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

        // ── Test: ExportManager exists ──

        console.log('2. Testing ExportManager...');

        const exportManagerExists = await page.evaluate(() => {
            return typeof window.exportManager === 'object' &&
                typeof window.exportManager.exportHTML === 'function' &&
                typeof window.exportManager.exportMarkdown === 'function' &&
                typeof window.exportManager.exportPDF === 'function' &&
                typeof window.exportManager.exportDOCX === 'function';
        });
        testLog('ExportManager has all export methods', exportManagerExists === true);

        // ── Test: Menu buttons exist ──

        console.log('3. Testing menu buttons...');

        const buttonsExist = await page.evaluate(() => {
            return {
                html: !!document.getElementById('btn-export-html'),
                md: !!document.getElementById('btn-export-md'),
                pdf: !!document.getElementById('btn-export-pdf'),
                docx: !!document.getElementById('btn-export-docx'),
                checkbox: !!document.getElementById('chk-embed-images')
            };
        });
        testLog('HTML export button exists', buttonsExist.html);
        testLog('Markdown export button exists', buttonsExist.md);
        testLog('PDF export button exists', buttonsExist.pdf);
        testLog('DOCX export button exists', buttonsExist.docx);
        testLog('Embed images checkbox exists', buttonsExist.checkbox);

        // ── Populate cells for export testing ──

        console.log('4. Creating test cells...');

        await page.evaluate(async () => {
            await window.importCells([
                { code: 'print("hello world")', type: 'code', language: 'python' },
                { code: 'from sympy import symbols, cos; x = symbols("x"); cos(x)', type: 'code', language: 'python' },
                { code: '"JavaScript result: " + (2 + 3)', type: 'code', language: 'javascript' }
            ]);
        });

        const cellCount = await page.evaluate(() => (window._cells || []).length);
        testLog('Cells created for export', cellCount >= 3, `${cellCount} cells`);

        // ── Test: DOM scraping ──

        console.log('5. Testing DOM scraping...');

        const scrapeResult = await page.evaluate(() => {
            const cells = window.exportManager._scrapeCells();
            return {
                count: cells.length,
                hasCode: cells.some(c => c.code && c.code.length > 0),
                hasOutputs: cells.some(c => c.outputs.length > 0),
                languages: [...new Set(cells.map(c => c.language))],
                outputKinds: cells.flatMap(c => c.outputs.map(o => o.kind))
            };
        });

        testLog('Scraping captures all cells', scrapeResult.count >= 3, `${scrapeResult.count} cells`);
        testLog('Scraped cells have code', scrapeResult.hasCode);
        testLog('Scraped cells have outputs', scrapeResult.hasOutputs, scrapeResult.outputKinds.join(', '));
        testLog('Scraped cells have multiple languages', scrapeResult.languages.length >= 2,
            scrapeResult.languages.join(', '));

        // ── Test: HTML export (embedded mode) ──

        console.log('6. Testing HTML export (embedded)...');

        const htmlResult = await page.evaluate(async () => {
            const result = await window.exportManager._buildHTMLString({ embedImages: true });
            return {
                length: result.html.length,
                hasDoctype: result.html.startsWith('<!DOCTYPE html>'),
                hasTitle: result.html.includes('SciREPL'),
                hasCode: result.html.includes('hello world'),
                hasDarkTheme: result.html.includes('--bg-primary: #0d1117'),
                hasPrintMedia: result.html.includes('@media print'),
                hasLangBadge: result.html.includes('lang-badge'),
                imageCount: result.images.length
            };
        });

        testLog('HTML has doctype', htmlResult.hasDoctype);
        testLog('HTML has title', htmlResult.hasTitle);
        testLog('HTML has cell code', htmlResult.hasCode);
        testLog('HTML has dark theme CSS', htmlResult.hasDarkTheme);
        testLog('HTML has print media query', htmlResult.hasPrintMedia);
        testLog('HTML has language badges', htmlResult.hasLangBadge);
        testLog('HTML embedded has no separate images', htmlResult.imageCount === 0);

        // ── Test: HTML export (zip mode) ──

        console.log('7. Testing HTML export (zip mode)...');

        const zipResult = await page.evaluate(async () => {
            const result = await window.exportManager._buildHTMLString({ embedImages: false });
            return {
                length: result.html.length,
                imageCount: result.images.length
            };
        });

        testLog('HTML zip mode generates HTML', zipResult.length > 100, `${zipResult.length} chars`);
        // No images expected since we only have text/latex output (no matplotlib or plots in test cells)

        // ── Test: Markdown export ──

        console.log('8. Testing Markdown export...');

        const mdResult = await page.evaluate(() => {
            // Capture the markdown content by intercepting the download
            let capturedContent = null;
            const origDownload = window.exportManager._downloadFile.bind(window.exportManager);
            window.exportManager._downloadFile = async (name, content, mime) => {
                capturedContent = { name, content, mime };
            };

            window.exportManager.exportMarkdown();

            window.exportManager._downloadFile = origDownload;
            return capturedContent;
        });

        testLog('Markdown file has .md extension', mdResult && mdResult.name.endsWith('.md'));
        testLog('Markdown has fenced code blocks',
            mdResult && mdResult.content.includes('```python'));
        testLog('Markdown has cell code',
            mdResult && mdResult.content.includes('hello world'));
        testLog('Markdown has cell labels',
            mdResult && mdResult.content.includes('In ['));
        testLog('Markdown has header',
            mdResult && mdResult.content.startsWith('# '));

        // ── Test: Empty notebook handling ──

        console.log('9. Testing empty notebook handling...');

        const emptyResult = await page.evaluate(() => {
            // Temporarily clear cells
            const origCells = window._cells;
            window._cells = [];

            let alertCalled = false;
            const origAlert = window.alert;
            window.alert = (msg) => { alertCalled = msg; };

            const scraped = window.exportManager._scrapeCells();
            window.exportManager.exportMarkdown();

            window.alert = origAlert;
            window._cells = origCells;

            return {
                scrapedEmpty: scraped.length === 0,
                alertCalled: alertCalled !== false
            };
        });

        testLog('Empty notebook returns no cells', emptyResult.scrapedEmpty);
        testLog('Empty notebook shows alert', emptyResult.alertCalled);

        // ── Test: Helper methods ──

        console.log('10. Testing helper methods...');

        const helperResults = await page.evaluate(() => {
            const em = window.exportManager;

            // _escapeHtml
            const escaped = em._escapeHtml('<script>alert("xss")</script>');
            const escapeOk = escaped === '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';

            // _getNotebookName
            const name = em._getNotebookName();
            const nameOk = typeof name === 'string' && name.length > 0;

            // _htmlTableToMarkdown
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>';
            const tableMd = em._htmlTableToMarkdown(table);
            const tableOk = tableMd.includes('| A | B |') && tableMd.includes('| 1 | 2 |') && tableMd.includes('---');

            // _extractTexFromKaTeX — create a mock
            const div = document.createElement('div');
            div.innerHTML = '<span class="katex"><span class="katex-mathml"><math><annotation encoding="application/x-tex">\\cos(x)</annotation></math></span></span>';
            const tex = em._extractTexFromKaTeX(div);
            const texOk = tex === '\\cos(x)';

            return { escapeOk, nameOk, tableOk, texOk };
        });

        testLog('_escapeHtml works correctly', helperResults.escapeOk);
        testLog('_getNotebookName returns string', helperResults.nameOk);
        testLog('_htmlTableToMarkdown converts correctly', helperResults.tableOk);
        testLog('_extractTexFromKaTeX extracts TeX', helperResults.texOk);

        // ── Test: Embed checkbox state ──

        console.log('11. Testing embed checkbox...');

        const checkboxState = await page.evaluate(() => {
            const chk = document.getElementById('chk-embed-images');
            const defaultChecked = chk.checked;
            chk.checked = false;
            const unchecked = !chk.checked;
            chk.checked = true; // restore
            return { defaultChecked, unchecked };
        });

        testLog('Embed checkbox default is checked', checkboxState.defaultChecked);
        testLog('Embed checkbox can be unchecked', checkboxState.unchecked);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All export tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
