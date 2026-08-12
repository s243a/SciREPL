// Playwright test: DOCX export with math in markdown cells
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

        // Load docx library
        console.log('2. Loading docx library...');
        await page.evaluate(async () => {
            await window.exportManager._loadDocxLibrary();
        });

        // ── Test: _splitInlineMath basic ──

        console.log('3. Testing _splitInlineMath...');

        const splitTest = await page.evaluate(() => {
            const em = window.exportManager;
            const { TextRun, XmlComponent } = window.docx;
            class OmmlComponent extends XmlComponent {
                constructor(obj) { super('m:oMath'); this._obj = obj; }
                prepForXml() { return this._obj; }
            }

            // Line with inline math
            const parts = em._splitInlineMath('The formula $x^2$ is quadratic', TextRun, OmmlComponent);
            return {
                partCount: parts.length,
                hasTextBefore: parts.length > 0 && parts[0] instanceof TextRun,
                hasOmml: parts.some(p => p instanceof OmmlComponent),
                hasTextAfter: parts.length > 2 && parts[parts.length - 1] instanceof TextRun
            };
        });

        testLog('_splitInlineMath splits into parts', splitTest.partCount >= 3, `${splitTest.partCount} parts`);
        testLog('Has text before math', splitTest.hasTextBefore);
        testLog('Has OMML component for math', splitTest.hasOmml);
        testLog('Has text after math', splitTest.hasTextAfter);

        // ── Test: _splitInlineMath with no math ──

        console.log('4. Testing _splitInlineMath with no math...');

        const noMathTest = await page.evaluate(() => {
            const em = window.exportManager;
            const { TextRun, XmlComponent } = window.docx;
            class OmmlComponent extends XmlComponent {
                constructor(obj) { super('m:oMath'); this._obj = obj; }
                prepForXml() { return this._obj; }
            }

            const parts = em._splitInlineMath('No math here at all', TextRun, OmmlComponent);
            return {
                partCount: parts.length,
                allTextRuns: parts.every(p => p instanceof TextRun)
            };
        });

        testLog('No-math line returns text runs only', noMathTest.allTextRuns);

        // ── Test: _splitInlineMath with multiple inline math ──

        console.log('5. Testing multiple inline math in one line...');

        const multiTest = await page.evaluate(() => {
            const em = window.exportManager;
            const { TextRun, XmlComponent } = window.docx;
            class OmmlComponent extends XmlComponent {
                constructor(obj) { super('m:oMath'); this._obj = obj; }
                prepForXml() { return this._obj; }
            }

            const parts = em._splitInlineMath('Both $x^2$ and $y^2$ are squared', TextRun, OmmlComponent);
            const ommlCount = parts.filter(p => p instanceof OmmlComponent).length;
            return { partCount: parts.length, ommlCount };
        });

        testLog('Multiple inline math produces multiple OMML', multiTest.ommlCount === 2, `${multiTest.ommlCount} OMML`);

        // ── Test: Full DOCX export with display + inline math in markdown ──

        console.log('6. Testing DOCX export with math in markdown cells...');

        // Create all test cells at once (no delete/recreate loop)
        await page.evaluate(async () => {
            await window.importCells([
                { code: '# Physics\n\nEinstein showed $E = mc^2$.\n\nThe full equation:\n\n$$E^2 = (pc)^2 + (mc^2)^2$$\n\nThis is **important**.', type: 'markdown', language: 'python' },
                { code: 'The quadratic formula is $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$ and $p = mv$.', type: 'markdown', language: 'python' }
            ]);
        });

        const exportTest = await page.evaluate(async () => {
            const em = window.exportManager;

            let capturedBlob = null;
            const origDownload = em._downloadBlob.bind(em);
            em._downloadBlob = (name, blob) => { capturedBlob = { name, size: blob.size }; };

            await em.exportDOCX();

            em._downloadBlob = origDownload;

            return {
                captured: capturedBlob !== null,
                size: capturedBlob ? capturedBlob.size : 0,
                name: capturedBlob ? capturedBlob.name : null
            };
        });

        testLog('DOCX with math markdown exports successfully', exportTest.captured);
        testLog('DOCX has .docx extension', exportTest.name && exportTest.name.endsWith('.docx'));
        testLog('DOCX has content', exportTest.size > 1000, `${exportTest.size} bytes`);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All DOCX markdown math tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
