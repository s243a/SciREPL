// Playwright test: SharedVFS sync — full workbook flow
// Python downloads 2 CSVs → SharedVFS sync → R reads them
import { chromium } from 'playwright';

const TIMEOUT = 180_000;

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
    });
    const page = await context.newPage();

    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

    let allPassed = true;
    const results = [];
    const testLog = (name, passed, detail) => {
        const mark = passed ? 'PASS' : 'FAIL';
        if (!passed) allPassed = false;
        results.push({ name, passed, detail });
        console.log(`  [${mark}] ${name}${detail ? ': ' + detail : ''}`);
    };

    try {
        // ── Phase 1: Load page, init Python ──
        console.log('1. Loading SciREPL and waiting for Pyodide...');
        await page.goto('http://localhost:8085/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        // ── Phase 2: Run workbook cell-2 (download both CSVs) ──
        console.log('2. Running workbook download cell (both CSVs)...');
        const dlResult = await page.evaluate(async () => {
            const code = `
import micropip
await micropip.install(['pandas'])

import pyodide.http, os
os.makedirs("/shared/data", exist_ok=True)

datasets = {
    "gapminder.csv": "https://raw.githubusercontent.com/resbaz/r-novice-gapminder-files/master/data/gapminder-FiveYearData.csv",
    "who_life_expectancy.csv": "https://raw.githubusercontent.com/Sid-149/Life-Expectancy-Predictor-Comparative-Analysis/main/Notebooks/Life%20Expectancy%20Data.csv"
}

for name, url in datasets.items():
    path = f"/shared/data/{name}"
    if os.path.exists(path):
        print(f"Already exists: {path}")
    else:
        resp = await pyodide.http.pyfetch(url)
        text = await resp.string()
        with open(path, "w") as f:
            f.write(text)
        lines = text.count("\\n")
        print(f"Downloaded {name}: {lines} lines")
`;
            return window.kernelManager.execute(code, 'python');
        }, { timeout: TIMEOUT });
        testLog('Python download succeeded', !dlResult.error, dlResult.stdout?.trim() || dlResult.error);

        // Check both files in SharedVFS
        const sharedFiles = await page.evaluate(() => {
            const vfs = window.sharedVFS;
            const files = [];
            for (const [path, entry] of vfs._files) {
                files.push({ path, size: entry.size, origin: entry.origin });
            }
            return files;
        });
        const gapInShared = sharedFiles.find(f => f.path.includes('gapminder'));
        const whoInShared = sharedFiles.find(f => f.path.includes('who_life'));
        testLog('gapminder.csv in SharedVFS', !!gapInShared, gapInShared ? `${gapInShared.size} bytes` : 'NOT FOUND');
        testLog('who_life_expectancy.csv in SharedVFS', !!whoInShared, whoInShared ? `${whoInShared.size} bytes` : 'NOT FOUND');

        // ── Phase 3: Run Python analysis cells ──
        console.log('3. Running Python analysis cells...');
        const pyAnalysis = await page.evaluate(async () => {
            const code = `
import pandas as pd
gap = pd.read_csv("/shared/data/gapminder.csv")
who = pd.read_csv("/shared/data/who_life_expectancy.csv")
print(f"Gapminder: {gap.shape[0]} rows, {gap.shape[1]} cols")
print(f"WHO: {who.shape[0]} rows, {who.shape[1]} cols")
`;
            return window.kernelManager.execute(code, 'python');
        }, { timeout: TIMEOUT });
        testLog('Python reads both CSVs', !pyAnalysis.error && pyAnalysis.stdout?.includes('Gapminder'),
            pyAnalysis.stdout?.trim() || pyAnalysis.error);

        // ── Phase 4: Init R and test access ──
        console.log('4. Initializing R kernel...');
        await page.evaluate(async () => {
            window.confirm = () => true;
            await window.kernelManager.ensureReady('r');
        }, { timeout: TIMEOUT });
        console.log('   R kernel ready.');

        // Test: R reads gapminder.csv
        console.log('5. Testing R reads both CSVs...');
        const rGap = await page.evaluate(async () => {
            const res = await window.kernelManager.execute(
                'gap <- read.csv("/shared/data/gapminder.csv"); cat("rows:", nrow(gap), "cols:", ncol(gap))',
                'r'
            );
            return { stdout: res.stdout, error: res.error };
        }, { timeout: TIMEOUT });
        testLog('R reads gapminder.csv', !rGap.error && rGap.stdout?.includes('rows:'),
            rGap.stdout?.trim() || rGap.error);

        // Test: R reads who_life_expectancy.csv
        const rWho = await page.evaluate(async () => {
            const res = await window.kernelManager.execute(
                'who <- read.csv("/shared/data/who_life_expectancy.csv"); cat("rows:", nrow(who), "cols:", ncol(who))',
                'r'
            );
            return { stdout: res.stdout, error: res.error };
        }, { timeout: TIMEOUT });
        testLog('R reads who_life_expectancy.csv', !rWho.error && rWho.stdout?.includes('rows:'),
            rWho.stdout?.trim() || rWho.error);

        // ── Phase 5: Save and reload — test persistence ──
        console.log('6. Saving to IndexedDB and reloading...');
        await page.evaluate(async () => {
            await window.sharedVFS.saveToIndexedDB();
        });

        consoleLogs.length = 0;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() => {
            const km = window.kernelManager;
            return km && km._instances && km._instances.python && km._instances.python.isReady();
        }, { timeout: TIMEOUT });

        const restoredFiles = await page.evaluate(() => window.sharedVFS._files.size);
        testLog('Files persist across reload', restoredFiles >= 2, `${restoredFiles} files`);

        const restoreLog = consoleLogs.find(l => l.includes('Restored') && l.includes('files'));
        testLog('IndexedDB restore message', !!restoreLog, restoreLog || 'not found');

        // ── Phase 6: Files & Storage display ──
        console.log('7. Checking Files & Storage tree...');
        const treeFiles = await page.evaluate(() => {
            return window.sharedVFS.getTree('/shared')
                .filter(e => !e.isDir)
                .map(e => ({ path: e.path, size: e.size }));
        });
        testLog('getTree shows both CSVs', treeFiles.length >= 2,
            treeFiles.map(e => `${e.path} (${e.size}b)`).join(', '));

        // ── Console sync logs ──
        console.log('\n   Sync-related console logs:');
        for (const log of consoleLogs) {
            if (log.includes('PythonKernel') || log.includes('SharedVFS') || log.includes('Restored')) {
                console.log('   ', log);
            }
        }

        // ── Results ──
        console.log('\n==================================================');
        console.log(`Results: ${results.filter(r => r.passed).length}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All SharedVFS sync tests passed!' : '\nFAIL: Some tests failed.');

    } catch (err) {
        console.error('Test error:', err.message);
        console.log('\nRecent console logs:');
        for (const log of consoleLogs.slice(-15)) {
            console.log('  ', log);
        }
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
