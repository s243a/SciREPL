/**
 * Release PWA regression: serve www/ under a GitHub Pages-style subpath,
 * activate the real service worker, go offline, and install the UnifyWeaver
 * bundle (including its package dependency) entirely from the app cache.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 8086;
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
    'workbooks/life_expectancy_csv_demo.ipynb',
    'workbooks/r_ggplot2_showcase.ipynb',
    'workbooks/r_tidyverse_wrangling.ipynb',
    'workbooks/r_statistics.ipynb',
    'workbooks/lua-tables-coroutines.srwb',
    'workbooks/lua-parsing-coroutines.srwb',
    'workbooks/typr-intro.srwb',
    'workbooks/prolog-generates-typr.srwb',
];

const server = await startStaticServer();
const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(TIMEOUT);
page.on('console', message => console.log(`  BROWSER ${message.type()}: ${message.text()}`));
page.on('pageerror', error => console.error(`  BROWSER pageerror: ${error.message}`));
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
    const cacheState = await page.evaluate(async () => {
        const names = await caches.keys();
        const appCache = names.find(name => name === 'scirepl-app-v124');
        if (!appCache) return { names, paths: [] };
        const keys = await (await caches.open(appCache)).keys();
        return {
            names,
            paths: keys.map(request => new URL(request.url).pathname),
        };
    });
    assert(cacheState.names.includes('scirepl-app-v124'), 'release cache v124 is active', cacheState.names.join(', '));
    for (const relative of requiredCatalogPaths) {
        assert(cacheState.paths.includes(PREFIX + relative), `pre-cache contains ${relative}`);
    }

    console.log('3. Warming the CDN-backed Prolog runtime while online...');
    await page.evaluate(() => window.kernelManager.ensureReady('prolog'));
    assert(await page.evaluate(() => window.kernelManager.isReady('prolog')), 'Prolog kernel initializes in PWA mode');

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

    // A normal user may decline automatic future downloads. The next offline
    // launch must still recognize that this CDN runtime is already cached.
    await page.evaluate(() => localStorage.setItem('scirepl_auto_download', '0'));

    console.log('5. Reloading the complete PWA while still offline...');
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

    console.log('6. Restarting the CDN-backed Prolog kernel while still offline...');
    await page.evaluate(() => window.kernelManager.ensureReady('prolog'));
    assert(
        await page.evaluate(() => window.kernelManager.isReady('prolog')),
        'cached cross-origin Prolog runtime restarts offline',
    );

    console.log('\nPWA release regression passed.');
} finally {
    await context.setOffline(false).catch(() => {});
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
}
