// Playwright test: Parse life_expectancy workbook, run all cells in order, verify R reads CSVs
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const TIMEOUT = 180_000;

function detectLanguage(code) {
    // R indicators: <- assignment, par(), read.csv with <-, str(), nrow, ncol, barplot, boxplot, lm(
    if (code.match(/\s*<-\s/) || code.match(/^par\(/m) || code.match(/^(barplot|boxplot|legend|plot)\(/m) ||
        code.match(/^(str|summary|cat)\(/m) || code.match(/^model\s*<-/m)) {
        return 'r';
    }
    return 'python';
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
    });
    const page = await context.newPage();

    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

    // Auto-accept R download dialog
    page.on('dialog', async dialog => { await dialog.accept(); });

    let allPassed = true;
    const results = [];
    const testLog = (name, passed, detail) => {
        const mark = passed ? 'PASS' : 'FAIL';
        if (!passed) allPassed = false;
        results.push({ name, passed, detail });
        console.log(`  [${mark}] ${name}${detail ? ': ' + detail : ''}`);
    };

    try {
        // Parse the workbook
        const nb = JSON.parse(readFileSync('www/workbooks/life_expectancy_csv_demo.ipynb', 'utf8'));
        const cells = nb.cells.map((c, i) => {
            const code = Array.isArray(c.source) ? c.source.join('') : c.source;
            return {
                index: i,
                type: c.cell_type,
                language: c.metadata?.language || detectLanguage(code),
                code
            };
        });

        const codeCells = cells.filter(c => c.type === 'code');
        console.log(`Workbook: ${cells.length} cells total, ${codeCells.length} code cells`);
        for (const c of codeCells) {
            console.log(`  [${c.index}] ${c.language}: ${c.code.substring(0, 60).replace(/\n/g, ' ')}`);
        }

        // 1. Load page, wait for Pyodide
        console.log('\n1. Loading SciREPL and waiting for Pyodide...');
        await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });
        console.log('   Pyodide ready.');

        // 2. Run each code cell in order
        console.log('\n2. Running workbook cells in order...');
        for (const cell of codeCells) {
            const lang = cell.language;
            const preview = cell.code.substring(0, 50).replace(/\n/g, ' ');
            process.stdout.write(`   Cell ${cell.index} (${lang}): ${preview}... `);

            const result = await page.evaluate(async (args) => {
                const { code, language } = args;
                try {
                    const res = await window.kernelManager.execute(code, language);
                    return {
                        stdout: (res.stdout || '').substring(0, 300),
                        error: res.error ? res.error.substring(0, 300) : null
                    };
                } catch (e) {
                    return { error: e.message.substring(0, 300) };
                }
            }, { code: cell.code, language: lang });

            if (result.error) {
                console.log('ERROR');
                console.log(`      ${result.error.substring(0, 150)}`);
                testLog(`Cell ${cell.index} (${lang})`, false, result.error.substring(0, 100));
            } else {
                console.log('OK');
                if (result.stdout) {
                    console.log(`      ${result.stdout.split('\n')[0].substring(0, 100)}`);
                }
                testLog(`Cell ${cell.index} (${lang})`, true,
                    result.stdout?.split('\n')[0]?.substring(0, 80) || 'ok');
            }

            // After the download cell, check SharedVFS
            if (cell.index === 2) {
                const files = await page.evaluate(() => [...window.sharedVFS._files.keys()]);
                console.log(`      SharedVFS files: ${JSON.stringify(files)}`);
            }
        }

        // 3. Final state
        console.log('\n3. Final SharedVFS:');
        const finalFiles = await page.evaluate(() => {
            const files = [];
            for (const [path, entry] of window.sharedVFS._files) {
                files.push(`${path} (${entry.size}b, ${entry.origin})`);
            }
            return files;
        });
        for (const f of finalFiles) console.log(`   ${f}`);

        // Results
        console.log('\n==================================================');
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;
        console.log(`Results: ${passed}/${results.length} passed, ${failed} failed`);
        if (failed > 0) {
            console.log('\nFailed:');
            for (const r of results.filter(r => !r.passed)) {
                console.log(`  - ${r.name}: ${r.detail}`);
            }
        }
        console.log(allPassed ? '\nPASS' : '\nFAIL');

    } catch (err) {
        console.error('Test error:', err.message);
        console.log('\nRecent console logs:');
        for (const log of consoleLogs.slice(-20)) {
            console.log('  ', log);
        }
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
