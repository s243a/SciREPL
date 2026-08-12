// Playwright test: DOCX export with OOXML Math (OMML) for LaTeX formulas
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
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        // ── Test: _texToOmml basic conversion ──

        console.log('2. Testing _texToOmml with simple formulas...');

        const basicTests = await page.evaluate(() => {
            const em = window.exportManager;
            const results = {};

            // Simple variable
            const xResult = em._texToOmml('x');
            results.simpleVar = xResult !== null &&
                JSON.stringify(xResult).includes('m:oMath') &&
                JSON.stringify(xResult).includes('m:r') &&
                JSON.stringify(xResult).includes('m:t');

            // Fraction
            const fracResult = em._texToOmml('\\frac{a}{b}');
            results.fraction = fracResult !== null &&
                JSON.stringify(fracResult).includes('m:f') &&
                JSON.stringify(fracResult).includes('m:num') &&
                JSON.stringify(fracResult).includes('m:den');

            // Superscript
            const supResult = em._texToOmml('x^2');
            results.superscript = supResult !== null &&
                JSON.stringify(supResult).includes('m:sSup') &&
                JSON.stringify(supResult).includes('m:sup');

            // Subscript
            const subResult = em._texToOmml('x_i');
            results.subscript = subResult !== null &&
                JSON.stringify(subResult).includes('m:sSub') &&
                JSON.stringify(subResult).includes('m:sub');

            // Square root
            const sqrtResult = em._texToOmml('\\sqrt{x}');
            results.sqrt = sqrtResult !== null &&
                JSON.stringify(sqrtResult).includes('m:rad') &&
                JSON.stringify(sqrtResult).includes('m:degHide');

            // cos(x) — trig function
            const cosResult = em._texToOmml('\\cos(x)');
            results.trig = cosResult !== null &&
                JSON.stringify(cosResult).includes('m:oMath');

            return results;
        });

        testLog('Simple variable → OMML', basicTests.simpleVar);
        testLog('Fraction \\frac{a}{b} → m:f', basicTests.fraction);
        testLog('Superscript x^2 → m:sSup', basicTests.superscript);
        testLog('Subscript x_i → m:sSub', basicTests.subscript);
        testLog('Square root → m:rad with degHide', basicTests.sqrt);
        testLog('Trig \\cos(x) → OMML', basicTests.trig);

        // ── Test: Complex formulas ──

        console.log('3. Testing complex formulas...');

        const complexTests = await page.evaluate(() => {
            const em = window.exportManager;
            const results = {};

            // Sub+superscript
            const subSupResult = em._texToOmml('x_i^2');
            results.subsup = subSupResult !== null &&
                JSON.stringify(subSupResult).includes('m:sSubSup');

            // Nth root
            const nrootResult = em._texToOmml('\\sqrt[3]{x}');
            results.nthRoot = nrootResult !== null &&
                JSON.stringify(nrootResult).includes('m:rad') &&
                JSON.stringify(nrootResult).includes('m:deg');

            // Nested: fraction with superscript
            const nestedResult = em._texToOmml('\\frac{x^2 + 1}{y^2 - 1}');
            const nestedStr = JSON.stringify(nestedResult);
            results.nested = nestedResult !== null &&
                nestedStr.includes('m:f') &&
                nestedStr.includes('m:sSup');

            // Sum with limits
            const sumResult = em._texToOmml('\\sum_{i=0}^{n} x_i');
            results.sum = sumResult !== null &&
                JSON.stringify(sumResult).includes('m:nary');

            // Integral
            const intResult = em._texToOmml('\\int_0^\\infty e^{-x^2} dx');
            results.integral = intResult !== null &&
                JSON.stringify(intResult).includes('m:nary');

            // Matrix
            const matrixResult = em._texToOmml('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
            results.matrix = matrixResult !== null &&
                JSON.stringify(matrixResult).includes('m:oMath');

            return results;
        });

        testLog('Sub+superscript x_i^2 → m:sSubSup', complexTests.subsup);
        testLog('Nth root \\sqrt[3]{x} → m:rad with m:deg', complexTests.nthRoot);
        testLog('Nested fraction+sup → m:f + m:sSup', complexTests.nested);
        testLog('Sum with limits → m:nary', complexTests.sum);
        testLog('Integral → m:nary', complexTests.integral);
        testLog('Matrix → OMML', complexTests.matrix);

        // ── Test: Fallback for invalid TeX ──

        console.log('4. Testing fallback behavior...');

        const fallbackTests = await page.evaluate(() => {
            const em = window.exportManager;
            const results = {};

            // Empty string
            results.emptyReturnsNull = em._texToOmml('') === null;

            // Whitespace-only
            results.whitespaceNull = em._texToOmml('   ') === null;

            return results;
        });

        testLog('Empty string returns null (fallback)', fallbackTests.emptyReturnsNull);
        testLog('Whitespace returns null (fallback)', fallbackTests.whitespaceNull);

        // ── Test: OMML namespace declaration ──

        console.log('5. Testing namespace declaration...');

        const nsTest = await page.evaluate(() => {
            const em = window.exportManager;
            const result = em._texToOmml('x');
            const str = JSON.stringify(result);
            return {
                hasOmmlNs: str.includes('xmlns:m') &&
                    str.includes('http://schemas.openxmlformats.org/officeDocument/2006/math'),
                hasOMathPara: str.includes('m:oMathPara'),
                hasOmath: str.includes('m:oMath')
            };
        });

        testLog('OMML has xmlns:m namespace', nsTest.hasOmmlNs);
        testLog('OMML wrapped in m:oMathPara', nsTest.hasOMathPara);
        testLog('OMML contains m:oMath', nsTest.hasOmath);

        // ── Test: _walkMathML handles various elements ──

        console.log('6. Testing MathML walker edge cases...');

        const walkerTests = await page.evaluate(() => {
            const em = window.exportManager;
            const results = {};

            // Accent (hat)
            const hatResult = em._texToOmml('\\hat{x}');
            results.accent = hatResult !== null &&
                JSON.stringify(hatResult).includes('m:acc');

            // Multiple terms in expression
            const exprResult = em._texToOmml('x^2 + y^2 = z^2');
            const exprStr = JSON.stringify(exprResult);
            results.multiTerm = exprResult !== null &&
                exprStr.includes('m:sSup') &&
                (exprStr.match(/m:sSup/g) || []).length >= 2;

            // mtext
            const textResult = em._texToOmml('\\text{if } x > 0');
            results.mtext = textResult !== null &&
                JSON.stringify(textResult).includes('m:nor');

            return results;
        });

        testLog('Accent \\hat{x} → m:acc', walkerTests.accent);
        testLog('Multi-term expression has multiple m:sSup', walkerTests.multiTerm);
        testLog('\\text{} → m:r with m:nor', walkerTests.mtext);

        // ── Test: Full DOCX export with LaTeX cell ──

        console.log('7. Creating SymPy cell for DOCX export...');

        await page.evaluate(async () => {
            // Clear existing cells
            while (window._cells.length > 0) {
                window.deleteCell(0);
            }
            await window.importCells([
                { code: 'from sympy import symbols, cos, sqrt; x = symbols("x"); sqrt(cos(x))', type: 'code', language: 'python' }
            ]);
        });

        // Wait for execution to complete
        await page.waitForFunction(() => {
            const cells = window._cells;
            if (!cells || cells.length === 0) return false;
            const card = cells[0].outputCard;
            return card && card.querySelector('.katex');
        }, { timeout: TIMEOUT });

        console.log('   SymPy output rendered. Testing DOCX export...');

        // Load docx library and test OMML in export
        const docxTest = await page.evaluate(async () => {
            const em = window.exportManager;

            // Load docx library
            await em._loadDocxLibrary();
            const { Document, Paragraph, TextRun, Packer, HeadingLevel, AlignmentType,
                    ShadingType, XmlComponent } = window.docx;

            // Scrape cells to check for latex output
            const cells = em._scrapeCells();
            const latexOutputs = cells.flatMap(c => c.outputs.filter(o => o.kind === 'latex'));

            if (latexOutputs.length === 0) {
                return { error: 'No LaTeX outputs found in scraped cells' };
            }

            // Extract TeX and convert to OMML
            const tex = latexOutputs[0].element
                ? em._extractTexFromKaTeX(latexOutputs[0].element)
                : em._extractTexFromKaTeX(em._parseHtmlFragment(latexOutputs[0].html));

            const ommlObj = em._texToOmml(tex);

            // Build a minimal docx document with the OMML
            class OmmlComponent extends XmlComponent {
                constructor(obj) { super('m:oMathPara'); this._obj = obj; }
                prepForXml() { return this._obj; }
            }

            let docxBlob = null;
            let docxSize = 0;
            try {
                const para = new Paragraph({ spacing: { before: 100, after: 100 } });
                if (ommlObj) {
                    para.addChildElement(new OmmlComponent(ommlObj));
                }

                const doc = new Document({
                    sections: [{
                        children: [
                            new Paragraph({
                                children: [new TextRun({ text: 'Math Test', bold: true, size: 36 })],
                                heading: HeadingLevel.HEADING_1
                            }),
                            para
                        ]
                    }]
                });

                docxBlob = await Packer.toBlob(doc);
                docxSize = docxBlob.size;
            } catch (e) {
                return { error: 'Packer.toBlob failed: ' + e.message };
            }

            return {
                tex,
                hasOmml: ommlObj !== null,
                ommlHasFraction: ommlObj ? JSON.stringify(ommlObj).includes('m:f') : false,
                ommlHasRad: ommlObj ? JSON.stringify(ommlObj).includes('m:rad') : false,
                docxSize,
                docxGenerated: docxSize > 0
            };
        });

        if (docxTest.error) {
            testLog('DOCX math export', false, docxTest.error);
        } else {
            testLog('SymPy LaTeX extracted', !!docxTest.tex, docxTest.tex);
            testLog('_texToOmml returns OMML object', docxTest.hasOmml);
            testLog('DOCX generated successfully', docxTest.docxGenerated, `${docxTest.docxSize} bytes`);
        }

        // ── Test: Full DOCX export via exportDOCX (intercept blob) ──

        console.log('8. Testing full exportDOCX pipeline...');

        const fullExportTest = await page.evaluate(async () => {
            const em = window.exportManager;

            // Intercept _downloadBlob to capture the blob (DOCX uses _downloadBlob)
            let capturedBlob = null;
            const origDownload = em._downloadBlob.bind(em);
            em._downloadBlob = (name, blob) => {
                capturedBlob = { name, size: blob.size || 0 };
            };

            await em.exportDOCX();

            em._downloadBlob = origDownload;

            return {
                captured: capturedBlob !== null,
                name: capturedBlob ? capturedBlob.name : null,
                size: capturedBlob ? capturedBlob.size : 0
            };
        });

        testLog('exportDOCX completes without error', fullExportTest.captured);
        testLog('DOCX file has .docx extension', fullExportTest.name && fullExportTest.name.endsWith('.docx'));
        testLog('DOCX file has content', fullExportTest.size > 1000, `${fullExportTest.size} bytes`);

        // ── Test: OMML structure detail ──

        console.log('9. Testing OMML structure for sqrt(cos(x))...');

        const structureTest = await page.evaluate(() => {
            const em = window.exportManager;
            // sqrt(cos(x)) should produce: m:rad containing m:r elements for cos(x)
            const result = em._texToOmml('\\sqrt{\\cos(x)}');
            if (!result) return { error: 'null result' };
            const str = JSON.stringify(result);
            return {
                hasRad: str.includes('m:rad'),
                hasDegHide: str.includes('m:degHide'),
                hasText: str.includes('m:t'),
                totalRuns: (str.match(/"m:r"/g) || []).length
            };
        });

        if (structureTest.error) {
            testLog('OMML structure for sqrt(cos(x))', false, structureTest.error);
        } else {
            testLog('sqrt(cos(x)) has m:rad', structureTest.hasRad);
            testLog('sqrt(cos(x)) has m:degHide (square root)', structureTest.hasDegHide);
            testLog('sqrt(cos(x)) has m:t text runs', structureTest.hasText);
            testLog('sqrt(cos(x)) has multiple m:r runs', structureTest.totalRuns >= 2,
                `${structureTest.totalRuns} runs`);
        }

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All DOCX math tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
