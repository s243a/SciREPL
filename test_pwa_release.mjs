/**
 * Release PWA regression: serve www/ under a GitHub Pages-style subpath,
 * activate the real service worker, go offline, and install the UnifyWeaver
 * bundle (including its package dependency) entirely from the app cache.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Derived from sw.js, not hardcoded — the cache version bumps whenever an
// app-shell asset changes (enforced by scripts/check-sw-shell.mjs), and this
// test must track it rather than pinning a number that goes stale each release.
const CACHE_VERSION = (readFileSync(new URL('./www/sw.js', import.meta.url), 'utf8')
    .match(/const CACHE_VERSION = '([^']+)'/) || [])[1];
const APP_CACHE_NAME = `scirepl-app-${CACHE_VERSION}`;

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8086);
const PREFIX = '/SciREPL/';
const BASE_URL = `http://${HOST}:${PORT}${PREFIX}`;
const WWW = resolve('www');
const TIMEOUT = 120_000;

const MIME = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.ipynb': 'application/json',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.mjs': 'text/javascript',
    '.png': 'image/png',
    '.srwb': 'application/json',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
};

function assert(condition, message, detail = '') {
    if (!condition) throw new Error(message + (detail ? `: ${detail}` : ''));
    console.log(`  PASS: ${message}`);
}

async function withTimeout(promise, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function startStaticServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', BASE_URL);
            if (url.pathname === PREFIX.slice(0, -1)) {
                res.writeHead(302, { Location: PREFIX });
                res.end();
                return;
            }
            if (!url.pathname.startsWith(PREFIX)) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            let relative = decodeURIComponent(url.pathname.slice(PREFIX.length));
            if (!relative || relative.endsWith('/')) relative += 'index.html';
            let filePath = resolve(WWW, relative);
            if (filePath !== WWW && !filePath.startsWith(WWW + sep)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html');

            const body = await readFile(filePath);
            const headers = {
                'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
                'Cache-Control': filePath.endsWith('sw.js') ? 'no-cache' : 'public, max-age=0',
            };
            res.writeHead(200, headers);
            res.end(body);
        } catch (_) {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    return new Promise((resolveReady, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => resolveReady(server));
    });
}

const requiredCatalogPaths = [
    'packages/unifyweaver_scirepl.zip',
    'workbooks/01_family_tree_tutorial.ipynb',
    'workbooks/02_recursion_patterns.ipynb',
    'workbooks/03_call_graph_analysis.ipynb',
    'workbooks/prolog-generates-r.srwb',
    'workbooks/prolog-generates-lua.srwb',
    'workbooks/prolog-generates-clojurescript.srwb',
    'workbooks/compute-pi-workbook.srwb',
    'workbooks/life_expectancy_csv_demo.ipynb',
    'workbooks/r_ggplot2_showcase.ipynb',
    'workbooks/r_tidyverse_wrangling.ipynb',
    'workbooks/r_statistics.ipynb',
    'workbooks/lua-tables-coroutines.srwb',
    'workbooks/lua-parsing-coroutines.srwb',
    'workbooks/typr-intro.srwb',
    'workbooks/prolog-generates-typr.srwb',
];

function inspectCallGraphStructure(workbook) {
    const codeCells = (workbook.cells || [])
        .filter(cell => cell.cell_type === 'code')
        .map(cell => (cell.source || []).join(''));
    const scc = codeCells.find(code => code.includes("% Find SCCs using Tarjan's algorithm")) || '';
    const classification = codeCells.find(code => code.includes('% Check each SCC')) || '';
    const saveDot = codeCells.find(code => code.includes('even_odd_graph.dot') && code.includes('open(')) || '';
    const ordered = (code, snippets) => {
        let position = -1;
        return snippets.every(snippet => {
            position = code.indexOf(snippet, position + 1);
            return position >= 0;
        });
    };
    return {
        sccSelfContained: ordered(scc, ['build_call_graph(', 'find_sccs(']),
        classificationSelfContained: ordered(classification,
            ['build_call_graph(', 'find_sccs(', 'forall(member(']),
        dotSaveSelfContained: ordered(saveDot, ['build_call_graph(', 'generate_dot(', 'open(']),
    };
}

console.log('0. Checking Call Graph cells before starting Chromium...');
const callGraphSource = JSON.parse(await readFile(
    resolve(WWW, 'workbooks/03_call_graph_analysis.ipynb'),
    'utf8',
));
const callGraphStructure = inspectCallGraphStructure(callGraphSource);
assert(callGraphStructure.sccSelfContained, 'SCC display cell reconstructs its graph');
assert(callGraphStructure.classificationSelfContained,
    'SCC classification cell reconstructs graph and components');
assert(callGraphStructure.dotSaveSelfContained, 'DOT save cell reconstructs its source');

const server = await startStaticServer();
const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const context = await browser.newContext();
const page = await context.newPage();
const prologRuntimeRequests = [];
let prologCdnAttempts = 0;
const pageErrors = [];
page.setDefaultTimeout(TIMEOUT);
page.on('request', request => {
    if (request.url().includes('dynamic-import.js')) {
        prologRuntimeRequests.push(request.url());
    }
});
await page.route('https://swi-prolog.github.io/**', async route => {
    prologCdnAttempts++;
    await route.abort('blockedbyclient');
});
page.on('console', message => console.log(`  BROWSER ${message.type()}: ${message.text()}`));
page.on('pageerror', error => {
    pageErrors.push(error.message);
    console.error(`  BROWSER pageerror: ${error.message}`);
});
page.on('requestfailed', request => console.error(
    `  BROWSER requestfailed: ${request.url()} (${request.failure()?.errorText || 'unknown error'})`,
));
page.on('dialog', async dialog => {
    console.log(`  BROWSER dialog: ${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
});

try {
    console.log('1. Installing the service worker from a GitHub Pages-style subpath...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version);
        localStorage.setItem('scirepl_auto_switch_workbook', '0');
        localStorage.setItem('scirepl_auto_download', '1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const scope = await page.evaluate(async () => {
        const registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('service worker did not become ready within 30 seconds')),
                30_000,
            )),
        ]);
        return registration.scope;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert(scope.endsWith(PREFIX), 'service worker scope preserves the repository subpath', scope);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#run-btn:not([disabled])');
    assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'reload is service-worker controlled');

    console.log('2. Verifying every local catalog payload is pre-cached...');
    const cacheState = await page.evaluate(async (appCacheName) => {
        const names = await caches.keys();
        const appCache = names.find(name => name === appCacheName);
        if (!appCache) return { names, paths: [] };
        const keys = await (await caches.open(appCache)).keys();
        return {
            names,
            paths: keys.map(request => new URL(request.url).pathname),
        };
    }, APP_CACHE_NAME);
    assert(cacheState.names.includes(APP_CACHE_NAME), `release cache ${APP_CACHE_NAME} is active`, cacheState.names.join(', '));
    for (const relative of requiredCatalogPaths) {
        assert(cacheState.paths.includes(PREFIX + relative), `pre-cache contains ${relative}`);
    }

    console.log('3. Loading the bundled Prolog runtime while its CDN fallback is blocked...');
    await withTimeout(
        page.evaluate(() => window.kernelManager.ensureReady('prolog')),
        TIMEOUT,
        'initial bundled Prolog startup',
    );
    assert(await page.evaluate(() => window.kernelManager.isReady('prolog')), 'Prolog kernel initializes in PWA mode');
    assert(
        prologRuntimeRequests.length > 0 &&
            prologRuntimeRequests.every(url => url === BASE_URL + 'vendor/swipl/dynamic-import.js'),
        'Prolog loads only the bundled same-origin runtime',
        prologRuntimeRequests.join(', '),
    );
    assert(prologCdnAttempts === 0, 'Prolog does not attempt its CDN fallback', String(prologCdnAttempts));

    console.log('4. Going offline before installing the dependency-aware bundle...');
    await context.setOffline(true);
    const offlineInstall = await page.evaluate(async () => {
        document.getElementById('btn-browse-packages').click();
        const catalog = window.packageCatalog;
        const all = catalog.packages;
        const bundleIndex = all.findIndex(item => item.id === 'unifyweaver-workbooks');
        const button = document.querySelector(`.pkg-install-btn[data-idx="${bundleIndex}"]`);
        await catalog._install(button);
        return {
            packageInstalled: catalog._isInstalled(all.find(item => item.id === 'unifyweaver-scirepl')),
            bundleInstalled: catalog._isInstalled(all[bundleIndex]),
            notebooks: window.notebookManager.getNotebooks().map(notebook => notebook.name),
        };
    });
    assert(offlineInstall.packageInstalled, 'offline bundle install adds the UnifyWeaver package dependency');
    assert(offlineInstall.bundleInstalled, 'offline bundle install adds all four workbooks');
    for (const name of [
        'Family Tree Tutorial with UnifyWeaver',
        'Advanced Recursion Patterns in UnifyWeaver',
        'Call Graph Analysis and SCC Detection',
        'Prolog Generates R: Compiler Demo',
    ]) {
        assert(offlineInstall.notebooks.includes(name), `offline bundle contains ${name}`);
    }

    console.log('5. Running the Call Graph workbook while offline...');
    const callGraphRun = await withTimeout(page.evaluate(async () => {
        const notebook = window.notebookManager.getNotebooks()
            .find(item => item.name === 'Call Graph Analysis and SCC Detection');
        if (!notebook) return { found: false };
        window.notebookManager.switchTo(notebook.id);
        await window.runAllCells();

        const cells = (window._cells || []).map(cell => ({
            code: cell.code || '',
            output: cell.outputCard?.querySelector('.card-body')?.textContent || '',
            error: !!cell.outputCard?.classList.contains('card-error'),
        }));
        const outputFor = marker => cells.find(cell => cell.code.includes(marker))?.output || '';
        let savedDot = '';
        try {
            savedDot = window.sharedVFS.readFile('/shared/data/even_odd_graph.dot', 'utf8');
        } catch (_) {
            // The assertions below report a missing file with the other run details.
        }
        return {
            found: true,
            errors: cells.filter(cell => cell.error).map(cell => cell.output),
            allOutput: cells.map(cell => cell.output).join('\n'),
            scc: outputFor("% Find SCCs using Tarjan's algorithm"),
            classification: outputFor('% Check each SCC'),
            dot: outputFor('% Helper to generate DOT format'),
            savedDot,
        };
    }), TIMEOUT, 'Call Graph Run All');
    assert(callGraphRun.found, 'Call Graph workbook is selectable');
    assert(callGraphRun.errors.length === 0, 'Call Graph Run All has no error cards',
        callGraphRun.errors.join(' | '));
    const bindingNoise = /\[object Object\]|\b(?:AccInfo|BashCode|BashLines|Count|Deps|DotCode|Edge|FibBody|FibHead|Graph|Group|LibraryCode|LibraryLines|SCC|SCCs|Stream)\s*=/;
    assert(!bindingNoise.test(callGraphRun.allOutput),
        'Call Graph output hides internal Prolog bindings', callGraphRun.allOutput);
    assert(callGraphRun.scc.includes('Strongly Connected Components:') &&
        callGraphRun.scc.includes('is_even/1') && callGraphRun.scc.includes('is_odd/1'),
        'Call Graph Run All reports the even/odd SCC', callGraphRun.scc);
    assert(callGraphRun.classification.includes('NON-TRIVIAL (mutual recursion!)'),
        'Call Graph Run All classifies mutual recursion', callGraphRun.classification);
    for (const edge of ['"is_even/1" -> "is_odd/1";', '"is_odd/1" -> "is_even/1";']) {
        assert(callGraphRun.dot.includes(edge), `DOT output contains ${edge}`, callGraphRun.dot);
        assert(callGraphRun.savedDot.includes(edge), `saved DOT contains ${edge}`, callGraphRun.savedDot);
    }

    // A normal user may decline automatic future downloads. The next offline
    // launch must still restart from the same-origin runtime cached on demand.
    await page.evaluate(() => localStorage.setItem('scirepl_auto_download', '0'));

    console.log('6. Reloading the complete PWA while still offline...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#run-btn:not([disabled])');
    const offlineReload = await page.evaluate(() => ({
        controlled: !!navigator.serviceWorker.controller,
        online: navigator.onLine,
        title: document.title,
    }));
    assert(offlineReload.controlled, 'offline reload remains service-worker controlled');
    assert(!offlineReload.online, 'browser remained offline during reload');
    assert(offlineReload.title === 'Sci REPL', 'offline app shell rendered', offlineReload.title);
    assert(pageErrors.length === 0, 'offline app reload raises no uncaught page errors', pageErrors.join(' | '));

    console.log('7. Restarting the bundled Prolog kernel while still offline...');
    await withTimeout(
        page.evaluate(() => window.kernelManager.ensureReady('prolog')),
        TIMEOUT,
        'offline bundled Prolog restart',
    );
    assert(
        await page.evaluate(() => window.kernelManager.isReady('prolog')),
        'cached same-origin Prolog runtime restarts offline',
    );

    // Run the Bash-heavy tutorials after the offline Prolog restart. Starting
    // a second SWI-Prolog WASM instance while Brush is still at peak memory can
    // stall resource-constrained CI browsers.
    console.log('8. Running the other cleaned UnifyWeaver tutorials while offline...');
    const tutorialRuns = await withTimeout(page.evaluate(async () => {
        const names = [
            'Family Tree Tutorial with UnifyWeaver',
            'Advanced Recursion Patterns in UnifyWeaver',
        ];
        const runs = {};
        for (const name of names) {
            const notebook = window.notebookManager.getNotebooks().find(item => item.name === name);
            if (!notebook) {
                runs[name] = { found: false };
                continue;
            }
            window.notebookManager.switchTo(notebook.id);
            await window.runAllCells();
            const cells = (window._cells || []).map(cell => ({
                code: cell.code || '',
                output: cell.outputCard?.querySelector('.card-body')?.textContent || '',
                error: !!cell.outputCard?.classList.contains('card-error'),
            }));
            runs[name] = {
                found: true,
                errors: cells.filter(cell => cell.error).map(cell => cell.output),
                allOutput: cells.map(cell => cell.output).join('\n'),
                ancestorCheck: cells.find(cell => cell.code.includes('Is Abraham an ancestor'))?.output || '',
            };
        }
        return runs;
    }), TIMEOUT * 2, 'UnifyWeaver tutorial Run All');

    for (const [name, run] of Object.entries(tutorialRuns)) {
        assert(run.found, `${name} is selectable`);
        assert(run.errors.length === 0, `${name} Run All has no error cards`, run.errors.join(' | '));
        assert(!bindingNoise.test(run.allOutput), `${name} hides internal Prolog bindings`, run.allOutput);
    }
    assert(
        tutorialRuns['Family Tree Tutorial with UnifyWeaver'].ancestorCheck.includes(
            'Yes: Abraham is an ancestor of Jacob'),
        'Family Tree prints the ground-query result explicitly',
        tutorialRuns['Family Tree Tutorial with UnifyWeaver'].ancestorCheck,
    );

    console.log('\nPWA release regression passed.');
} finally {
    await context.setOffline(false).catch(() => {});
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
}
