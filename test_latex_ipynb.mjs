// Playwright test: LaTeX export + .ipynb output preservation
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
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        // ── Test: LaTeX export method exists ──

        console.log('2. Testing LaTeX export availability...');

        const hasLatex = await page.evaluate(() =>
            typeof window.exportManager.exportLatex === 'function' &&
            typeof window.exportManager._buildLatexString === 'function' &&
            typeof window.exportManager._escapeLatex === 'function' &&
            typeof window.exportManager._htmlTableToLatex === 'function' &&
            typeof window.exportManager._markdownToLatex === 'function'
        );
        testLog('LaTeX export methods exist', hasLatex);

        const latexBtnExists = await page.evaluate(() => !!document.getElementById('btn-export-latex'));
        testLog('LaTeX export button exists in menu', latexBtnExists);

        // ── Test: ipynb output helper exists ──

        console.log('3. Testing .ipynb output helper...');

        const hasIpynbHelper = await page.evaluate(() =>
            typeof window.exportManager.scrapedOutputsToJupyter === 'function'
        );
        testLog('scrapedOutputsToJupyter() method exists', hasIpynbHelper);

        // ── Populate test cells ──

        console.log('4. Creating test cells...');

        await page.evaluate(async () => {
            await window.importCells([
                { code: 'print("hello latex")', type: 'code', language: 'python' },
                { code: 'from sympy import symbols, sin; x = symbols("x"); sin(x)**2', type: 'code', language: 'python' },
                { code: '"JS test value"', type: 'code', language: 'javascript' },
                { code: '# Markdown Cell\n\nThis is **bold** and *italic*.', type: 'markdown', language: 'python' }
            ]);
        });

        const cellCount = await page.evaluate(() => (window._cells || []).length);
        testLog('Test cells created', cellCount >= 4, `${cellCount} cells`);

        // ── Test: LaTeX helpers ──

        console.log('5. Testing LaTeX helper methods...');

        const helperResults = await page.evaluate(() => {
            const em = window.exportManager;

            // _escapeLatex
            const escaped = em._escapeLatex('a & b # c $ d % e _ f { g }');
            const escapeOk = escaped.includes('\\&') && escaped.includes('\\#') &&
                escaped.includes('\\$') && escaped.includes('\\%') && escaped.includes('\\_');

            // _latexLanguageName
            const pyName = em._latexLanguageName('python');
            const nameOk = pyName === 'Python';

            // _htmlTableToLatex
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th>X</th><th>Y</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>';
            const tableTex = em._htmlTableToLatex(table);
            const tableOk = tableTex.includes('\\begin{tabular}') && tableTex.includes('\\toprule') &&
                tableTex.includes('\\midrule') && tableTex.includes('X') && tableTex.includes('1');

            // _markdownToLatex
            const mdTex = em._markdownToLatex('# Title\n\nSome **bold** text.');
            const mdOk = mdTex.includes('\\section{') && mdTex.includes('\\textbf{');

            return { escapeOk, nameOk, tableOk, mdOk };
        });

        testLog('_escapeLatex escapes special chars', helperResults.escapeOk);
        testLog('_latexLanguageName maps correctly', helperResults.nameOk);
        testLog('_htmlTableToLatex generates tabular', helperResults.tableOk);
        testLog('_markdownToLatex converts headings/bold', helperResults.mdOk);

        // ── Test: Build LaTeX string ──

        console.log('6. Testing LaTeX document generation...');

        const texResult = await page.evaluate(async () => {
            const result = await window.exportManager._buildLatexString();
            return {
                length: result.tex.length,
                hasDocumentclass: result.tex.includes('\\documentclass'),
                hasListings: result.tex.includes('\\usepackage{listings}'),
                hasAmsmath: result.tex.includes('amsmath'),
                hasBooktabs: result.tex.includes('booktabs'),
                hasGraphicx: result.tex.includes('graphicx'),
                hasBeginDocument: result.tex.includes('\\begin{document}'),
                hasEndDocument: result.tex.includes('\\end{document}'),
                hasLstlisting: result.tex.includes('\\begin{lstlisting}'),
                hasCode: result.tex.includes('hello latex'),
                hasMath: result.tex.includes('\\['),
                hasMarkdown: result.tex.includes('\\section{'),
                imageCount: result.images.length
            };
        });

        testLog('LaTeX has \\documentclass', texResult.hasDocumentclass);
        testLog('LaTeX has listings package', texResult.hasListings);
        testLog('LaTeX has amsmath package', texResult.hasAmsmath);
        testLog('LaTeX has booktabs package', texResult.hasBooktabs);
        testLog('LaTeX has graphicx package', texResult.hasGraphicx);
        testLog('LaTeX has \\begin{document}', texResult.hasBeginDocument);
        testLog('LaTeX has \\end{document}', texResult.hasEndDocument);
        testLog('LaTeX has lstlisting code blocks', texResult.hasLstlisting);
        testLog('LaTeX includes cell code', texResult.hasCode);
        testLog('LaTeX includes display math', texResult.hasMath);
        testLog('LaTeX includes markdown conversion', texResult.hasMarkdown);

        // ── Test: .ipynb with outputs ──

        console.log('7. Testing .ipynb output preservation...');

        const ipynbResult = await page.evaluate(async () => {
            // Intercept downloadFile to capture the notebook JSON
            let capturedContent = null;
            const origDownload = window.fileIO.downloadFile.bind(window.fileIO);
            window.fileIO.downloadFile = async (name, content, mime) => {
                capturedContent = { name, content };
            };

            await window.fileIO.exportNotebook();

            window.fileIO.downloadFile = origDownload;

            if (!capturedContent) return { error: 'no content captured' };

            const nb = JSON.parse(capturedContent.content);
            const codeCells = nb.cells.filter(c => c.cell_type === 'code');
            const cellsWithOutputs = codeCells.filter(c => c.outputs && c.outputs.length > 0);

            // Check specific output types
            let hasStream = false;
            let hasLatexOutput = false;
            let hasTextPlain = false;

            for (const cell of codeCells) {
                for (const out of cell.outputs || []) {
                    if (out.output_type === 'stream') hasStream = true;
                    if (out.output_type === 'execute_result' && out.data && out.data['text/latex']) hasLatexOutput = true;
                    if (out.output_type === 'execute_result' && out.data && out.data['text/plain']) hasTextPlain = true;
                }
            }

            return {
                totalCells: nb.cells.length,
                codeCells: codeCells.length,
                cellsWithOutputs: cellsWithOutputs.length,
                hasStream,
                hasLatexOutput,
                hasTextPlain,
                format: nb.nbformat,
                hasMetadata: !!nb.metadata
            };
        });

        testLog('.ipynb has correct cell count', ipynbResult.totalCells >= 4, `${ipynbResult.totalCells} cells`);
        testLog('.ipynb code cells have outputs', ipynbResult.cellsWithOutputs >= 2,
            `${ipynbResult.cellsWithOutputs}/${ipynbResult.codeCells} cells with outputs`);
        testLog('.ipynb has stream output (print)', ipynbResult.hasStream);
        testLog('.ipynb has text/latex output (SymPy)', ipynbResult.hasLatexOutput);
        testLog('.ipynb has text/plain output', ipynbResult.hasTextPlain);
        testLog('.ipynb has nbformat 4', ipynbResult.format === 4);

        // ── Test: scrapedOutputsToJupyter directly ──

        console.log('8. Testing output format conversion...');

        const conversionResult = await page.evaluate(async () => {
            const em = window.exportManager;

            // Create a mock scraped cell with various output types
            const mockScraped = {
                id: 99,
                type: 'code',
                language: 'python',
                code: 'test',
                outputs: [
                    { kind: 'text', content: 'hello\nworld' },
                    { kind: 'error', content: 'ValueError: bad' }
                ]
            };

            const jupyterOutputs = await em.scrapedOutputsToJupyter(mockScraped);

            return {
                count: jupyterOutputs.length,
                firstType: jupyterOutputs[0] ? jupyterOutputs[0].output_type : null,
                firstName: jupyterOutputs[0] ? jupyterOutputs[0].name : null,
                firstText: jupyterOutputs[0] ? jupyterOutputs[0].text : null,
                secondType: jupyterOutputs[1] ? jupyterOutputs[1].output_type : null,
                secondEvalue: jupyterOutputs[1] ? jupyterOutputs[1].evalue : null
            };
        });

        testLog('Conversion produces correct output count', conversionResult.count === 2);
        testLog('Text output maps to stream type', conversionResult.firstType === 'stream');
        testLog('Stream output has name=stdout', conversionResult.firstName === 'stdout');
        testLog('Stream text is line-split array',
            Array.isArray(conversionResult.firstText) && conversionResult.firstText[0] === 'hello\n');
        testLog('Error output maps to error type', conversionResult.secondType === 'error');
        testLog('Error has evalue field', conversionResult.secondEvalue === 'ValueError: bad');

        // ── Test: Empty notebook ──

        console.log('9. Testing empty notebook handling...');

        const emptyResult = await page.evaluate(async () => {
            const origCells = window._cells;
            window._cells = [];

            let alertCalled = false;
            const origAlert = window.alert;
            window.alert = (msg) => { alertCalled = msg; };

            await window.exportManager.exportLatex();

            window.alert = origAlert;
            window._cells = origCells;

            return { alertCalled: alertCalled !== false };
        });

        testLog('LaTeX export shows alert for empty notebook', emptyResult.alertCalled);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All LaTeX + .ipynb output tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
