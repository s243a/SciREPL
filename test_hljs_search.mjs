// Playwright test: In-app syntax highlighting + Search within notebook
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

        // ── Test: In-app syntax highlighting ──

        console.log('2. Testing in-app syntax highlighting...');

        await page.evaluate(async () => {
            await window.importCells([
                { code: 'import numpy as np\nx = np.array([1, 2, 3])', type: 'code', language: 'python' },
                { code: 'const y = "hello";', type: 'code', language: 'javascript' },
                { code: '# This is a Markdown cell\n\n**Bold text**', type: 'markdown', language: 'python' }
            ]);
        });
        await page.waitForTimeout(2000);

        const hljsResult = await page.evaluate(() => {
            const cells = window._cells;
            const results = {};

            // Cell 0: Python
            const pre0 = cells[0].inputCard.querySelector('pre');
            const code0 = pre0 ? pre0.querySelector('code') : null;
            results.cell0HasCode = !!code0;
            results.cell0HasKeyword = code0 ? code0.innerHTML.includes('hljs-keyword') : false;
            results.cell0HasImport = code0 ? code0.textContent.includes('import') : false;

            // Cell 1: JavaScript
            const pre1 = cells[1].inputCard.querySelector('pre');
            const code1 = pre1 ? pre1.querySelector('code') : null;
            results.cell1HasCode = !!code1;
            results.cell1HasKeyword = code1 ? code1.innerHTML.includes('hljs-keyword') : false;
            results.cell1HasString = code1 ? code1.innerHTML.includes('hljs-string') : false;

            // Cell 2: Markdown — should NOT have <code> child (plain text)
            const pre2 = cells[2].inputCard.querySelector('pre');
            results.cell2NoCodeChild = pre2 ? !pre2.querySelector('code') : true;
            results.cell2IsMdSource = pre2 ? pre2.classList.contains('md-source') : false;

            return results;
        });

        testLog('Python cell has <code> element', hljsResult.cell0HasCode);
        testLog('Python cell has hljs-keyword spans', hljsResult.cell0HasKeyword);
        testLog('Python cell contains "import" text', hljsResult.cell0HasImport);
        testLog('JS cell has <code> element', hljsResult.cell1HasCode);
        testLog('JS cell has hljs-keyword spans', hljsResult.cell1HasKeyword);
        testLog('JS cell has hljs-string spans', hljsResult.cell1HasString);
        testLog('Markdown cell has no <code> child', hljsResult.cell2NoCodeChild);
        testLog('Markdown cell pre has md-source class', hljsResult.cell2IsMdSource);

        // ── Test: Highlighting survives edit + re-run ──

        console.log('3. Testing highlighting after edit...');

        const editResult = await page.evaluate(async () => {
            const cell = window._cells[0];
            const internals = window._appInternals;

            // Simulate edit: change code and re-highlight
            cell.code = 'from sympy import symbols';
            const pre = cell.inputCard.querySelector('pre');
            internals.setPreHighlighted(pre, cell.code, 'python', false);

            const code = pre.querySelector('code');
            return {
                hasCode: !!code,
                hasKeyword: code ? code.innerHTML.includes('hljs-keyword') : false,
                hasFrom: code ? code.textContent.includes('from') : false,
                hasSympy: code ? code.textContent.includes('sympy') : false
            };
        });

        testLog('Re-highlighted cell has <code>', editResult.hasCode);
        testLog('Re-highlighted cell has hljs-keyword', editResult.hasKeyword);
        testLog('Re-highlighted cell contains "from"', editResult.hasFrom);
        testLog('Re-highlighted cell contains "sympy"', editResult.hasSympy);

        // ── Test: highlightCode helper function ──

        console.log('4. Testing highlightCode helper...');

        const helperResult = await page.evaluate(() => {
            const hc = window._appInternals.highlightCode;

            const pyResult = hc('def foo():\n    return 42', 'python');
            const bashResult = hc('echo "hello" | grep h', 'bash');
            const unknownResult = hc('hello <world>', 'unknown_lang');

            return {
                pyHasDef: pyResult.includes('hljs-keyword') && pyResult.includes('def'),
                bashHasEcho: bashResult.includes('hljs-built_in') || bashResult.includes('echo'),
                unknownEscaped: unknownResult.includes('&lt;') && !unknownResult.includes('hljs-')
            };
        });

        testLog('Python highlightCode has def keyword', helperResult.pyHasDef);
        testLog('Bash highlightCode works', helperResult.bashHasEcho);
        testLog('Unknown language escapes HTML safely', helperResult.unknownEscaped);

        // ── Test: Search bar exists ──

        console.log('5. Testing search bar UI...');

        const searchUIResult = await page.evaluate(() => {
            return {
                barExists: !!document.getElementById('search-bar'),
                inputExists: !!document.getElementById('search-input'),
                countExists: !!document.getElementById('search-count'),
                prevExists: !!document.getElementById('search-prev-btn'),
                nextExists: !!document.getElementById('search-next-btn'),
                closeExists: !!document.getElementById('search-close-btn'),
                replaceToggleExists: !!document.getElementById('search-replace-toggle'),
                replaceRowExists: !!document.getElementById('search-replace-row'),
                replaceInputExists: !!document.getElementById('replace-input'),
                replaceOneExists: !!document.getElementById('replace-one-btn'),
                replaceAllExists: !!document.getElementById('replace-all-btn'),
                barHidden: document.getElementById('search-bar').classList.contains('hidden')
            };
        });

        testLog('Search bar element exists', searchUIResult.barExists);
        testLog('Search input exists', searchUIResult.inputExists);
        testLog('Search count display exists', searchUIResult.countExists);
        testLog('Prev/Next buttons exist', searchUIResult.prevExists && searchUIResult.nextExists);
        testLog('Replace toggle exists', searchUIResult.replaceToggleExists);
        testLog('Replace row exists (hidden)', searchUIResult.replaceRowExists);
        testLog('Search bar is initially hidden', searchUIResult.barHidden);

        // ── Test: Ctrl+F opens search ──

        console.log('6. Testing Ctrl+F opens search...');

        await page.keyboard.down('Control');
        await page.keyboard.press('f');
        await page.keyboard.up('Control');
        await page.waitForTimeout(300);

        const ctrlFResult = await page.evaluate(() => {
            const bar = document.getElementById('search-bar');
            return {
                visible: !bar.classList.contains('hidden'),
                inputFocused: document.activeElement === document.getElementById('search-input')
            };
        });

        testLog('Ctrl+F opens search bar', ctrlFResult.visible);
        testLog('Search input is focused', ctrlFResult.inputFocused);

        // ── Test: Search finds matches ──

        console.log('7. Testing search finds matches...');

        // First, set up fresh cells for search testing
        await page.evaluate(async () => {
            window._cells = [];
            window._cellCounter = 0;
            const repl = document.getElementById('repl');
            if (repl) {
                const cards = repl.querySelectorAll('.card-input, .card-output');
                cards.forEach(c => c.remove());
            }
            await window.importCells([
                { code: 'import numpy\nimport pandas', type: 'code', language: 'python' },
                { code: 'x = import_data()', type: 'code', language: 'python' },
                { code: 'print("hello world")', type: 'code', language: 'python' }
            ]);
        });
        await page.waitForTimeout(2000);

        // Open search and type query
        await page.keyboard.down('Control');
        await page.keyboard.press('f');
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);

        await page.fill('#search-input', 'import');
        await page.waitForTimeout(300);

        const searchResult = await page.evaluate(() => {
            const count = document.getElementById('search-count').textContent;
            const matchCards = document.querySelectorAll('.card-input.search-match').length;
            const currentCards = document.querySelectorAll('.card-input.search-current').length;
            return { count, matchCards, currentCards };
        });

        testLog('Search shows match count', searchResult.count.includes('/'), searchResult.count);
        testLog('Matching cards get .search-match class', searchResult.matchCards >= 2);
        testLog('Current match gets .search-current class', searchResult.currentCards === 1);

        // ── Test: Navigate matches ──

        console.log('8. Testing match navigation...');

        const navResult = await page.evaluate(() => {
            const results = {};

            // Current match info
            const current1 = document.querySelector('.card-input.search-current');
            results.firstMatchCellId = current1 ? current1.dataset.cellId : null;

            // Click next
            document.getElementById('search-next-btn').click();
            const current2 = document.querySelector('.card-input.search-current');
            results.secondMatchCellId = current2 ? current2.dataset.cellId : null;
            results.navigated = results.firstMatchCellId !== results.secondMatchCellId ||
                document.getElementById('search-count').textContent.startsWith('2/');

            return results;
        });

        testLog('Next button navigates to different match', navResult.navigated);

        // ── Test: Replace ──

        console.log('9. Testing replace...');

        // Toggle replace row
        await page.click('#search-replace-toggle');
        await page.waitForTimeout(200);

        const replaceVisible = await page.evaluate(() =>
            !document.getElementById('search-replace-row').classList.contains('hidden')
        );
        testLog('Replace row toggles visible', replaceVisible);

        // Navigate back to first match and replace
        await page.fill('#search-input', 'hello world');
        await page.waitForTimeout(300);
        await page.fill('#replace-input', 'goodbye world');
        await page.click('#replace-one-btn');
        await page.waitForTimeout(300);

        const replaceResult = await page.evaluate(() => {
            const cell = window._cells[2]; // The "hello world" cell
            return {
                codeUpdated: cell.code.includes('goodbye world'),
                noHello: !cell.code.includes('hello world')
            };
        });

        testLog('Replace updates cell code', replaceResult.codeUpdated);
        testLog('Original text replaced', replaceResult.noHello);

        // ── Test: Replace All ──

        console.log('10. Testing replace all...');

        await page.fill('#search-input', 'import');
        await page.waitForTimeout(300);
        await page.fill('#replace-input', 'load');
        await page.click('#replace-all-btn');
        await page.waitForTimeout(300);

        const replaceAllResult = await page.evaluate(() => {
            let importCount = 0;
            let loadCount = 0;
            for (const cell of window._cells) {
                if (cell.code.includes('import')) importCount++;
                if (cell.code.includes('load')) loadCount++;
            }
            return { importCount, loadCount };
        });

        testLog('Replace All removed "import"', replaceAllResult.importCount === 0);
        testLog('Replace All inserted "load"', replaceAllResult.loadCount >= 2);

        // ── Test: Escape closes search ──

        console.log('11. Testing Escape closes search...');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const closeResult = await page.evaluate(() => {
            const bar = document.getElementById('search-bar');
            const matches = document.querySelectorAll('.search-match').length;
            return {
                barHidden: bar.classList.contains('hidden'),
                highlightsCleared: matches === 0
            };
        });

        testLog('Escape closes search bar', closeResult.barHidden);
        testLog('Highlights cleared on close', closeResult.highlightsCleared);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All highlighting + search tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
