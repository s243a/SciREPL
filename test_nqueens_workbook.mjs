import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.SCIREPL_BASE_URL || 'http://localhost:8085/';
const workbook = JSON.parse(readFileSync(
    new URL('./www/workbooks/nqueens-transpile.ipynb', import.meta.url),
    'utf8'));

function source(cell) {
    return Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
}

function assert(condition, message, detail = '') {
    if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
    console.log(`  ok - ${message}`);
}

assert(workbook.nbformat === 4, 'N-Queens workbook uses Jupyter notebook format 4');
const codeCells = workbook.cells.filter(cell => cell.cell_type === 'code');
assert(codeCells.length === 5, 'N-Queens workbook has five executable cells');
assert(codeCells.filter(cell => cell.metadata?.scirepl_language === 'prolog').length === 3,
    'N-Queens workbook has three Prolog cells');
assert(codeCells.filter(cell => cell.metadata?.scirepl_language === 'clojurescript').length === 2,
    'N-Queens workbook has two ClojureScript cells');

const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
});

try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_enabled_languages');
        localStorage.removeItem('scirepl_installed_packages');
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 30_000 });

    const dependency = await page.evaluate(async () => {
        try {
            const item = window.packageCatalog.packages.find(
                entry => entry.id === 'nqueens-prolog-to-clojurescript');
            await window.packageCatalog._ensureDependencies(item);
            return {
                found: !!item,
                installed: window.packageCatalog._isInstalled(
                    window.packageCatalog.packages.find(entry => entry.id === 'unifyweaver-scirepl')),
            };
        } catch (error) {
            return { found: false, installed: false, error: error?.message || String(error) };
        }
    });
    assert(dependency.found, 'N-Queens catalogue entry is available', dependency.error);
    assert(dependency.installed, 'UnifyWeaver dependency installs automatically', dependency.error);

    const outputs = [];
    for (const cell of codeCells) {
        const language = cell.metadata.scirepl_language;
        const result = await page.evaluate(async ({ code, language }) => {
            await window.kernelManager.ensureReady(language);
            return await window.kernelManager.execute(code, language);
        }, { code: source(cell), language });
        assert(!result.error, `${language} workbook cell executes without error`, result.error);
        outputs.push(result.stdout || '');
    }

    assert(outputs[2].includes('Wrote /shared/runtime.cljs + /shared/core.cljs'),
        'Transpiler reports the generated SharedVFS files', outputs[2]);
    assert(outputs[2].length < 500,
        'Transpiler does not dump generated code into cell output', `${outputs[2].length} characters`);
    const generated = await page.evaluate(() => ({
        runtime: window.sharedVFS.readFile('/shared/runtime.cljs', 'utf8'),
        core: window.sharedVFS.readFile('/shared/core.cljs', 'utf8'),
    }));
    assert(generated.runtime.length > 50_000, 'Transpiler writes its runtime to SharedVFS');
    assert(generated.core.length > 1_000, 'Transpiler writes the N-Queens predicates to SharedVFS');

    const results = outputs[4];
    assert(/queens_q\(4,\s*\[2 4 1 3\]\s*\)\s*=>\s*true/.test(results), 'First valid board is accepted');
    assert(/queens_q\(4,\s*\[3 1 4 2\]\s*\)\s*=>\s*true/.test(results), 'Second valid board is accepted');
    assert(/queens_q\(4,\s*\[1 2 3 4\]\s*\)\s*=>\s*false/.test(results), 'First invalid board is rejected');
    assert(/queens_q\(4,\s*\[1 3 2 4\]\s*\)\s*=>\s*false/.test(results), 'Second invalid board is rejected');
    assert(pageErrors.length === 0, 'N-Queens run produces no page errors', pageErrors.join('; '));
    console.log('N-Queens workbook execution passed');
} finally {
    await browser.close();
}
