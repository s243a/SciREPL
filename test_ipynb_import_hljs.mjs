// Playwright test: .ipynb import with outputs + syntax highlighting in exports
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

        console.log('   Waiting for Pyodide...');
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        // ── Test: highlight.js loaded ──

        console.log('2. Testing highlight.js availability...');

        const hljsResult = await page.evaluate(() => {
            const hljs = window.hljs;
            if (!hljs) return { loaded: false };
            return {
                loaded: true,
                languages: hljs.listLanguages(),
                hasPython: !!hljs.getLanguage('python'),
                hasJS: !!hljs.getLanguage('javascript'),
                hasR: !!hljs.getLanguage('r'),
                hasBash: !!hljs.getLanguage('bash'),
                hasProlog: !!hljs.getLanguage('prolog')
            };
        });

        testLog('highlight.js loaded', hljsResult.loaded);
        testLog('hljs has Python language', hljsResult.hasPython);
        testLog('hljs has JavaScript language', hljsResult.hasJS);
        testLog('hljs has R language', hljsResult.hasR);
        testLog('hljs has Bash language', hljsResult.hasBash);
        testLog('hljs has Prolog language', hljsResult.hasProlog);

        // ── Test: _highlightCode helper ──

        console.log('3. Testing _highlightCode helper...');

        const highlightResult = await page.evaluate(() => {
            const em = window.exportManager;

            const pyResult = em._highlightCode('import numpy as np', 'python');
            const jsResult = em._highlightCode('const x = 42;', 'javascript');
            const plainResult = em._highlightCode('hello world', 'unknown_lang');

            return {
                pyHasSpans: pyResult.includes('<span class="hljs-keyword">'),
                pyHasImport: pyResult.includes('import'),
                jsHasSpans: jsResult.includes('<span class="hljs-keyword">'),
                plainNoSpans: !plainResult.includes('<span class="hljs-'),
                plainEscaped: plainResult === 'hello world'
            };
        });

        testLog('Python highlighting produces hljs spans', highlightResult.pyHasSpans);
        testLog('Python highlighting includes import keyword', highlightResult.pyHasImport);
        testLog('JavaScript highlighting produces hljs spans', highlightResult.jsHasSpans);
        testLog('Unknown language falls back to escaped HTML', highlightResult.plainNoSpans);

        // ── Test: _parseHljsTokens helper ──

        console.log('4. Testing _parseHljsTokens helper...');

        const tokenResult = await page.evaluate(() => {
            const em = window.exportManager;
            const highlighted = window.hljs.highlight('x = 42', { language: 'python' }).value;
            const tokens = em._parseHljsTokens(highlighted);

            return {
                hasTokens: tokens.length > 0,
                hasColors: tokens.some(t => t.color !== '000000'),
                allHaveText: tokens.every(t => typeof t.text === 'string'),
                allHaveColor: tokens.every(t => typeof t.color === 'string' && t.color.length === 6)
            };
        });

        testLog('_parseHljsTokens produces tokens', tokenResult.hasTokens);
        testLog('Tokens include colored segments', tokenResult.hasColors);
        testLog('All tokens have text', tokenResult.allHaveText);
        testLog('All tokens have 6-char color', tokenResult.allHaveColor);

        // ── Test: renderJupyterOutputs function ──

        console.log('5. Testing renderJupyterOutputs...');

        const renderResult = await page.evaluate(() => {
            return typeof window.renderJupyterOutputs === 'function';
        });
        testLog('renderJupyterOutputs function exists', renderResult);

        // ── Test: .ipynb import with outputs ──

        console.log('6. Testing .ipynb import with outputs...');

        const importResult = await page.evaluate(async () => {
            // Create a mock .ipynb with pre-existing outputs
            const mockNotebook = {
                nbformat: 4,
                nbformat_minor: 5,
                metadata: {
                    kernelspec: { name: 'python3', language: 'python' }
                },
                cells: [
                    {
                        cell_type: 'code',
                        source: ['print("hello from import")'],
                        metadata: {},
                        outputs: [
                            {
                                output_type: 'stream',
                                name: 'stdout',
                                text: ['hello from import\n']
                            }
                        ],
                        execution_count: 1
                    },
                    {
                        cell_type: 'code',
                        source: ['x = 42\n', 'x'],
                        metadata: {},
                        outputs: [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': ['42'] },
                                metadata: {},
                                execution_count: 2
                            }
                        ],
                        execution_count: 2
                    },
                    {
                        cell_type: 'code',
                        source: ['from sympy import symbols, sin\n', 'x = symbols("x")\n', 'sin(x)'],
                        metadata: {},
                        outputs: [
                            {
                                output_type: 'execute_result',
                                data: {
                                    'text/plain': ['sin(x)'],
                                    'text/latex': ['$\\displaystyle \\sin{\\left(x \\right)}$']
                                },
                                metadata: {},
                                execution_count: 3
                            }
                        ],
                        execution_count: 3
                    },
                    {
                        cell_type: 'code',
                        source: ['1/0'],
                        metadata: {},
                        outputs: [
                            {
                                output_type: 'error',
                                ename: 'ZeroDivisionError',
                                evalue: 'division by zero',
                                traceback: ['ZeroDivisionError: division by zero']
                            }
                        ],
                        execution_count: 4
                    },
                    {
                        cell_type: 'code',
                        source: ['# image test'],
                        metadata: {},
                        outputs: [
                            {
                                output_type: 'display_data',
                                data: {
                                    'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                                },
                                metadata: {}
                            }
                        ],
                        execution_count: 5
                    },
                    {
                        cell_type: 'markdown',
                        source: ['# Test Heading\n', '\n', 'Some **bold** text.'],
                        metadata: {}
                    }
                ]
            };

            // Clear existing cells
            window._cells = [];
            window._cellCounter = 0;
            const repl = document.getElementById('repl');
            if (repl) {
                const cards = repl.querySelectorAll('.input-card, .output-card');
                cards.forEach(c => c.remove());
            }

            // Import the notebook
            window.fileIO.importIpynb(JSON.stringify(mockNotebook));

            // Wait a moment for rendering
            await new Promise(r => setTimeout(r, 500));

            const cells = window._cells;
            const results = {
                cellCount: cells.length,
                outputs: []
            };

            for (const cell of cells) {
                const card = cell.outputCard;
                if (!card) {
                    results.outputs.push({ type: cell.type, hasCard: false });
                    continue;
                }
                const body = card.querySelector('.card-body');
                if (!body) {
                    results.outputs.push({ type: cell.type, hasCard: true, hasBody: false });
                    continue;
                }

                const info = {
                    type: cell.type,
                    hasCard: true,
                    hasBody: true,
                    html: body.innerHTML.substring(0, 200),
                    hasTextResult: !!body.querySelector('.text-result'),
                    hasErrorResult: !!body.querySelector('.error-result'),
                    hasLatexResult: !!body.querySelector('.latex-result'),
                    hasImage: !!body.querySelector('img'),
                    textContent: body.textContent.substring(0, 100)
                };
                results.outputs.push(info);
            }

            return results;
        });

        testLog('.ipynb import created correct cell count', importResult.cellCount === 6, `${importResult.cellCount} cells`);

        // Cell 0: stream output (print)
        const cell0 = importResult.outputs[0];
        testLog('Cell 0 has stream output (text-result)', cell0 && cell0.hasTextResult);
        testLog('Cell 0 text contains "hello from import"', cell0 && cell0.textContent.includes('hello from import'));

        // Cell 1: execute_result text/plain
        const cell1 = importResult.outputs[1];
        testLog('Cell 1 has text/plain output', cell1 && cell1.hasTextResult);
        testLog('Cell 1 text contains "42"', cell1 && cell1.textContent.includes('42'));

        // Cell 2: execute_result with text/latex
        const cell2 = importResult.outputs[2];
        testLog('Cell 2 has LaTeX output', cell2 && cell2.hasLatexResult);

        // Cell 3: error output
        const cell3 = importResult.outputs[3];
        testLog('Cell 3 has error output', cell3 && cell3.hasErrorResult);
        testLog('Cell 3 error text contains "division by zero"', cell3 && cell3.textContent.includes('division by zero'));

        // Cell 4: image output
        const cell4 = importResult.outputs[4];
        testLog('Cell 4 has image output', cell4 && cell4.hasImage);

        // ── Test: HTML export with syntax highlighting ──

        console.log('7. Testing HTML export with syntax highlighting...');

        const htmlResult = await page.evaluate(async () => {
            // Clear existing cells for a fresh export test
            window._cells = [];
            window._cellCounter = 0;
            const repl = document.getElementById('repl');
            if (repl) {
                const cards = repl.querySelectorAll('.input-card, .output-card');
                cards.forEach(c => c.remove());
            }

            await window.importCells([
                { code: 'import numpy as np\nx = np.array([1, 2, 3])', type: 'code', language: 'python' },
                { code: 'const y = "hello";', type: 'code', language: 'javascript' }
            ]);

            // Wait for execution
            await new Promise(r => setTimeout(r, 2000));

            const em = window.exportManager;
            const result = await em._buildHTMLString({ embedImages: true });

            return {
                hasHljsKeyword: result.html.includes('hljs-keyword'),
                hasHljsString: result.html.includes('hljs-string'),
                hasHljsCSS: result.html.includes('.hljs-keyword'),
                codeSnippet: result.html.match(/<pre class="cell-code"><code>(.*?)<\/code><\/pre>/s)?.[1]?.substring(0, 100) || ''
            };
        });

        testLog('HTML export has hljs-keyword spans', htmlResult.hasHljsKeyword);
        testLog('HTML export has hljs-string spans', htmlResult.hasHljsString);
        testLog('HTML export includes hljs CSS styles', htmlResult.hasHljsCSS);

        // ── Test: .ipynb import without outputs (regression) ──

        console.log('8. Testing .ipynb import without outputs (regression)...');

        const regressionResult = await page.evaluate(async () => {
            // Clear cells
            window._cells = [];
            window._cellCounter = 0;
            const repl = document.getElementById('repl');
            if (repl) {
                const cards = repl.querySelectorAll('.input-card, .output-card');
                cards.forEach(c => c.remove());
            }

            // Import a notebook WITHOUT outputs — should execute normally
            const bareNotebook = {
                nbformat: 4,
                nbformat_minor: 5,
                metadata: { kernelspec: { name: 'python3', language: 'python' } },
                cells: [
                    {
                        cell_type: 'code',
                        source: ['2 + 2'],
                        metadata: {},
                        outputs: []
                    }
                ]
            };

            window.fileIO.importIpynb(JSON.stringify(bareNotebook));

            // Wait for execution
            await new Promise(r => setTimeout(r, 3000));

            const cells = window._cells;
            if (cells.length === 0) return { executed: false };

            const card = cells[0].outputCard;
            if (!card) return { executed: false, noCard: true };

            const body = card.querySelector('.card-body');
            const text = body ? body.textContent : '';

            return {
                executed: true,
                cellCount: cells.length,
                hasOutput: text.length > 0,
                outputText: text.trim()
            };
        });

        testLog('Bare .ipynb import executes code', regressionResult.executed, regressionResult.outputText);
        testLog('Bare .ipynb output has result', regressionResult.hasOutput);

        // ── Test: Round-trip (export then import with outputs) ──

        console.log('9. Testing round-trip export → import...');

        const roundtripResult = await page.evaluate(async () => {
            // Clear and create a test cell
            window._cells = [];
            window._cellCounter = 0;
            const repl = document.getElementById('repl');
            if (repl) {
                const cards = repl.querySelectorAll('.input-card, .output-card');
                cards.forEach(c => c.remove());
            }

            await window.importCells([
                { code: 'print("roundtrip test")', type: 'code', language: 'python' }
            ]);
            await new Promise(r => setTimeout(r, 2000));

            // Export to .ipynb (capture content)
            let capturedContent = null;
            const origDownload = window.fileIO.downloadFile.bind(window.fileIO);
            window.fileIO.downloadFile = async (name, content, mime) => {
                capturedContent = content;
            };
            await window.fileIO.exportNotebook();
            window.fileIO.downloadFile = origDownload;

            if (!capturedContent) return { error: 'no content captured' };

            const nb = JSON.parse(capturedContent);
            const codeCell = nb.cells.find(c => c.cell_type === 'code');
            const hasOutputs = codeCell && codeCell.outputs && codeCell.outputs.length > 0;

            // Now re-import and check outputs render
            window._cells = [];
            window._cellCounter = 0;
            if (repl) {
                const cards2 = repl.querySelectorAll('.input-card, .output-card');
                cards2.forEach(c => c.remove());
            }

            window.fileIO.importIpynb(capturedContent);
            await new Promise(r => setTimeout(r, 500));

            const importedCell = window._cells[0];
            const card = importedCell ? importedCell.outputCard : null;
            const body = card ? card.querySelector('.card-body') : null;
            const text = body ? body.textContent.trim() : '';

            return {
                exportedWithOutputs: hasOutputs,
                importedCells: window._cells.length,
                importedText: text,
                roundtripMatch: text.includes('roundtrip test')
            };
        });

        testLog('Export includes outputs', roundtripResult.exportedWithOutputs);
        testLog('Round-trip import shows outputs', roundtripResult.roundtripMatch, roundtripResult.importedText);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All .ipynb import + highlighting tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
