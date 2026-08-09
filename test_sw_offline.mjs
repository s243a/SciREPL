// Playwright test: service worker precaching, including every shipped locale.
//
// Two things are being protected here.
//
// A catalogue missing from APP_SHELL is fetched on demand, and offline that
// fetch fails and i18n falls back to English — an Arabic user with no
// connection silently loses their translation, in an app whose premise is that
// it works without a network.
//
// And cache.addAll() is atomic, so one bad path used to mean no offline support
// at all, silently. With every locale listed the entry count roughly doubled,
// which made that a real risk rather than a theoretical one.
//
//   node server.js            (or PORT=8099 node server.js)
//   node test_sw_offline.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const PORT = process.env.PORT || 8085;
const ORIGIN = `http://localhost:${PORT}`;
const TIMEOUT = 60_000;

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 180) : ''}`);
};

const browser = await chromium.launch({ headless: true });

/** Load the app, wait for the worker to take control, report what it cached. */
async function installWorker(routeOverride, opts = {}) {
    const context = await browser.newContext();
    // Serve sw.js with a bumped CACHE_VERSION so the browser sees a new worker,
    // optionally with one shell entry 404ing to force a partial install.
    if (opts.bumpVersion) {
        await context.route('**/sw.js', async (route) => {
            const res = await route.fetch();
            const body = (await res.text()).replace(/const CACHE_VERSION = '([^']+)'/,
                (m, v) => `const CACHE_VERSION = '${v}-next'`);
            await route.fulfill({ status: 200, contentType: 'application/javascript', body });
        });
    }
    if (opts.break404) {
        await context.route(opts.break404, (route) => route.fulfill({ status: 404, body: 'gone' }));
    }
    await context.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
    });
    const page = await context.newPage();
    const swLogs = [];
    page.on('console', (m) => swLogs.push(m.text()));
    if (routeOverride) await context.route(...routeOverride);

    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const activated = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration()
            || await navigator.serviceWorker.register('./sw.js');
        // Wait for a worker to reach 'activated' rather than assuming timing.
        for (let i = 0; i < 100; i++) {
            const w = reg.active || reg.waiting || reg.installing;
            if (w && w.state === 'activated') return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    }).catch(() => false);

    const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const app = names.find((n) => n.startsWith('scirepl-app-'));
        if (!app) return null;
        const keys = await (await caches.open(app)).keys();
        return keys.map((r) => new URL(r.url).pathname);
    });
    const extra = await page.evaluate(async () => {
        const names = await caches.keys();
        const appCaches = names.filter((n) => n.startsWith('scirepl-app-'));
        let marker = null, koServed = false;
        for (const n of appCaches) {
            const c = await caches.open(n);
            const m = await c.match('./__app-shell-complete');
            if (m && n === appCaches[appCaches.length - 1]) marker = await m.text();
        }
        const hit = await caches.match(new URL('i18n/ko.json', location.href).href);
        koServed = Boolean(hit);
        return { appCaches, marker, koServed };
    });
    await context.close();
    return { activated, cached, swLogs, ...extra };
}

try {
    console.log('\n1. The worker installs and precaches every locale');

    const { activated, cached } = await installWorker();
    check('the service worker reaches activated', activated === true);
    check('an app cache exists', Array.isArray(cached), cached === null ? 'no cache' : `${cached.length} entries`);

    const locales = ['en', 'es', 'ar', 'bn', 'de', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh'];
    const missing = locales.filter((c) => !(cached || []).some((p) => p.endsWith(`/i18n/${c}.json`)));
    check('every shipped catalogue is precached, so it survives offline',
        missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${locales.length} locales`);

    const missingPrivacy = locales.filter(
        (c) => !(cached || []).some((p) => p.endsWith(`/i18n/privacy.${c}.json`)));
    check('every privacy catalogue is precached — the unofficial-translation notice '
        + 'must render offline too', missingPrivacy.length === 0,
        missingPrivacy.length ? `missing: ${missingPrivacy.join(', ')}` : 'all present');

    check('the manifest is precached', (cached || []).some((p) => p.endsWith('/i18n/manifest.json')));

    console.log('\n2. One bad entry does not cost the whole offline experience');

    // Serve a 404 for a single app-shell file. Under the old atomic addAll this
    // took out the entire install; the worker should now still activate and
    // cache everything else.
    const victim = '**/i18n/ko.json';
    const { activated: stillUp, cached: partial } = await installWorker([
        victim, (route) => route.fulfill({ status: 404, body: 'gone' }),
    ]);
    check('the worker still activates when one shell entry 404s', stillUp === true);
    check('the surviving locales are still cached',
        (partial || []).some((p) => p.endsWith('/i18n/ar.json')),
        `${(partial || []).length} entries cached`);
    // The worker logs which entries it could not cache, but that console output
    // belongs to the worker context and is not observable from the page, so the
    // assertion here is on the outcome: exactly the broken file is absent, and
    // nothing else was collateral damage.
    check('only the broken entry is missing, not a whole class of files',
        (partial || []).length === (cached || []).length - 1,
        `${(cached || []).length} -> ${(partial || []).length}`);
    check('the broken entry is genuinely absent from the cache',
        !(partial || []).some((p) => p.endsWith('/i18n/ko.json')));
    console.log('\n3. A partial install does not destroy the previous cache');

    /**
     * Upgrades have to happen inside one browsing context: a fresh context has
     * no previous cache, so "the old one survives" would pass for the wrong
     * reason. Install the shipped worker, then serve a bumped CACHE_VERSION and
     * reload, optionally breaking one shell entry on the way.
     */
    async function upgradeInPlace({ breakUrl } = {}) {
        writeFileSync('www/sw-next.js', readFileSync('www/sw.js', 'utf8').replace(
            /const CACHE_VERSION = '([^']+)'/, (m, v) => `const CACHE_VERSION = '${v}-next'`));
        const context = await browser.newContext();
        await context.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            localStorage.setItem('scirepl_auto_download', '1');
        });
        const page = await context.newPage();
        const settle = async () => {
            await page.evaluate(async () => {
                const reg = await navigator.serviceWorker.getRegistration()
                    || await navigator.serviceWorker.register('./sw.js');
                for (let i = 0; i < 120; i++) {
                    await reg.update().catch(() => {});
                    const w = reg.active;
                    if (w && w.state === 'activated') return;
                    await new Promise((r) => setTimeout(r, 100));
                }
            }).catch(() => {});
            await page.waitForTimeout(1200);
        };

        await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await settle();
        const before = await page.evaluate(async () =>
            (await caches.keys()).filter((n) => n.startsWith('scirepl-app-')));

        // Chromium fetches the worker script outside page routing, so
        // context.route cannot swap it. Put a real bumped worker on disk and
        // register it at the same scope, which replaces the current one.
        if (breakUrl) await context.route(breakUrl, (r) => r.fulfill({ status: 404, body: 'gone' }));

        // index.html registers sw.js on every load, which would immediately undo
        // a swap done from the page. Redirect the registration itself, from the
        // next navigation onwards, so the app installs the bumped worker as if
        // it had shipped that way.
        await context.addInitScript(() => {
            const sw = navigator.serviceWorker;
            const real = sw.register.bind(sw);
            sw.register = (url, opts) => real(
                String(url).includes('sw-next') ? url : './sw-next.js', opts);
        });

        await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
        // The app reloads itself on controllerchange, so allow for that landing
        // mid-wait rather than assuming a single stable load.
        await page.waitForTimeout(7000);
        await page.waitForLoadState('load').catch(() => {});

        const readCaches = async () => await page.evaluate(async () => {
            const names = (await caches.keys()).filter((n) => n.startsWith('scirepl-app-'));
            const newest = names.find((n) => n.endsWith('-next'));
            let marker = null;
            if (newest) {
                const m = await (await caches.open(newest)).match('./__app-shell-complete');
                if (m) marker = await m.text();
            }
            const ko = await caches.match(new URL('i18n/ko.json', location.href).href);
            return { names, marker, koServed: Boolean(ko) };
        });
        let after;
        for (let i = 0; i < 5; i++) {
            try { after = await readCaches(); break; }
            catch { await page.waitForTimeout(1000); }
        }
        if (!after) after = { names: [], marker: null, koServed: false };
        await context.close();
        rmSync('www/sw-next.js', { force: true });
        return { before, ...after };
    }

    const partialUpgrade = await upgradeInPlace({ breakUrl: '**/i18n/ko.json' });
    check('a first install produces one app cache', partialUpgrade.before.length === 1, partialUpgrade.before.join(','));
    check('the previous version\'s cache is kept when the upgrade is partial',
        partialUpgrade.names.length >= 2, partialUpgrade.names.join(', '));
    check('the entry the new version could not cache is still served from the old one',
        partialUpgrade.koServed === true);
    check('the incomplete install is recorded, not assumed good',
        partialUpgrade.marker === 'partial', String(partialUpgrade.marker));

    const cleanUpgrade = await upgradeInPlace();
    check('a complete upgrade evicts the previous cache',
        cleanUpgrade.names.length === 1, cleanUpgrade.names.join(', '));
    check('a complete install is marked complete',
        cleanUpgrade.marker === 'complete', String(cleanUpgrade.marker));

} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: service worker offline tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
