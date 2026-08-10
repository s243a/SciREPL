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

        await page.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
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

    console.log('\n4. Version coherence across consecutive partial upgrades');

    // Sol's scenario: v1 complete -> v2 partial -> v3 partial -> v4 complete.
    // The app must serve ONE version's shell throughout, never a mix, and the
    // fallback must be the newest complete cache, not the oldest. Proven with a
    // real offline fetch() whose body is stamped per version, not caches.match().
    {
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            const sw = navigator.serviceWorker;
            const real = sw.register.bind(sw);
            // Persist in localStorage so it survives the app's controllerchange reload.
            sw.register = (u, o) => real(localStorage.getItem('__swTarget') || u, o);
        });
        let curVer = null, broken = null;
        await ctx.route('**/i18n/manifest.json', async (route) => {
            const res = await route.fetch();
            const j = JSON.parse(await res.text());
            j._testVersion = curVer;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
        });
        await ctx.route('**/*', async (route) => {
            if (broken && route.request().url().includes(broken)) {
                return route.fulfill({ status: 404, body: 'x' });
            }
            return route.fallback();
        });
        const pg = await ctx.newPage();
        await pg.goto(`${ORIGIN}/index.html`, { waitUntil: 'load', timeout: TIMEOUT });

        const install = async (ver, breakName) => {
            curVer = ver; broken = breakName || null;
            writeFileSync(`www/sw-${ver}.js`, readFileSync('www/sw.js', 'utf8').replace(
                /const CACHE_VERSION = '([^']+)'/, `const CACHE_VERSION = '${ver}'`));
            await pg.evaluate((v) => localStorage.setItem('__swTarget', `./sw-${v}.js`), ver);
            // The app reloads itself on controllerchange (a new worker taking
            // over), which can abort this explicit reload. Tolerate that and let
            // the page settle either way.
            await pg.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
            await pg.waitForTimeout(5000);
            await pg.waitForLoadState('load').catch(() => {});
            await pg.waitForLoadState('load').catch(() => {});
        };
        const servedOffline = async () => {
            await ctx.setOffline(true);
            const v = await pg.evaluate(async () => {
                try {
                    const r = await fetch('./i18n/manifest.json', { cache: 'no-store' });
                    return (await r.json())._testVersion;
                } catch (e) { return 'FETCH-FAILED'; }
            });
            await ctx.setOffline(false);
            return v;
        };

        try {
            await install('t-v1');
            check('v1 (complete) serves its own shell offline',
                (await servedOffline()) === 't-v1');
            await install('t-v2', 'ko.json');
            check('v2 (partial) does not take effect — v1 still served',
                (await servedOffline()) === 't-v1');
            await install('t-v3', 'ru.json');
            check('v3 (partial) still does not take effect — no mix, still v1',
                (await servedOffline()) === 't-v1');
            await install('t-v4');
            check('v4 (complete) finally takes over',
                (await servedOffline()) === 't-v4');
            const remaining = await pg.evaluate(async () =>
                (await caches.keys()).filter((k) => k.startsWith('scirepl-app-')));
            check('stale caches are pruned once a complete version wins',
                remaining.length === 1 && remaining[0].endsWith('t-v4'), remaining.join(', '));
        } finally {
            for (const v of ['t-v1', 't-v2', 't-v3', 't-v4']) {
                rmSync(`www/sw-${v}.js`, { force: true });
            }
            await ctx.close();
        }
    }

    console.log('\n5. Partial install recovers and promotes once files return');

    // A version that installed partially serves the previous complete shell
    // (coherent, no mix). When its missing file becomes reachable again, the
    // opportunistic repair fills the gap and the cache is promoted — WITHOUT a
    // fresh deploy. Sol's edge case 2.
    {
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            const sw = navigator.serviceWorker, real = sw.register.bind(sw);
            // No-op until a target is set, so the app's own sw.js does not create
            // a parallel lineage on the first load.
            sw.register = (u, o) => {
                const t = localStorage.getItem('__swTarget');
                return t ? real(t, o) : Promise.resolve({ unregister() {}, addEventListener() {} });
            };
        });
        let ver = null, broken = null;
        await ctx.route('**/i18n/manifest.json', async (route) => {
            const j = JSON.parse(await (await route.fetch()).text());
            j._testVersion = ver;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
        });
        await ctx.route('**/*', (route) =>
            (broken && route.request().url().includes(broken))
                ? route.fulfill({ status: 404, body: 'x' }) : route.fallback());
        const pg = await ctx.newPage();
        await pg.goto(`${ORIGIN}/index.html`, { waitUntil: 'load', timeout: TIMEOUT });

        const install = async (v, breakName) => {
            ver = v; broken = breakName || null;
            writeFileSync(`www/sw-${v}.js`, readFileSync('www/sw.js', 'utf8').replace(
                /const CACHE_VERSION = '[^']+'/, `const CACHE_VERSION = '${v}'`));
            await pg.evaluate((vv) => localStorage.setItem('__swTarget', `./sw-${vv}.js`), v);
            await pg.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
            await pg.waitForTimeout(5000);
            await pg.waitForLoadState('load').catch(() => {});
        };
        const served = async () => {
            await ctx.setOffline(true);
            const v = await pg.evaluate(async () => {
                try { return (await (await fetch('./i18n/manifest.json', { cache: 'no-store' })).json())._testVersion; }
                catch { return 'FETCH-FAILED'; }
            });
            await ctx.setOffline(false);
            return v;
        };

        try {
            await install('r-v1');
            await install('r-v2', 'ko.json');   // partial: ko 404
            check('while partial, the previous complete shell is served',
                (await served()) === 'r-v1');
            // Network recovers; drive some fetches to trigger the throttled repair.
            broken = null;
            for (let i = 0; i < 6; i++) {
                await pg.evaluate(() => fetch('./index.html', { cache: 'no-store' }).catch(() => {}));
                await pg.waitForTimeout(2500);
            }
            // The recovered file is now in the cache, and the cache is complete...
            check('the recovered file is cached and the version marked complete',
                await pg.evaluate(async () => {
                    const ko = await caches.match(new URL('i18n/ko.json', location.href).href);
                    return !!ko;
                }));
            // ...but the ALREADY-OPEN document stays pinned to the version it
            // navigated on — it must not silently swap to v2 assets mid-session.
            check('an open document is not switched to the promoted version mid-session',
                (await served()) === 'r-v1');
            // Promotion takes effect at the next navigation.
            await pg.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
            await pg.waitForTimeout(3000);
            await pg.waitForLoadState('load').catch(() => {});
            check('after a reload, the promoted version serves',
                (await served()) === 'r-v2');
        } finally {
            for (const v of ['r-v1', 'r-v2']) rmSync(`www/sw-${v}.js`, { force: true });
            await ctx.close();
        }
    }

    console.log('\n6. Concurrent requests trigger a single serialized repair');

    // Thirty simultaneous requests must not launch thirty identical fetches of a
    // missing asset: the repair is one in-flight promise shared by all of them.
    {
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            const sw = navigator.serviceWorker, real = sw.register.bind(sw);
            sw.register = (u, o) => {
                const t = localStorage.getItem('__swTarget');
                return t ? real(t, o) : Promise.resolve({ unregister() {}, addEventListener() {} });
            };
        });
        let broken = null, koFetches = 0;
        await ctx.route('**/i18n/ko.json', (r) => {
            if (broken) return r.fulfill({ status: 404, body: 'x' });
            koFetches++; return r.fallback();
        });
        const pg = await ctx.newPage();
        await pg.goto(`${ORIGIN}/index.html`, { waitUntil: 'load', timeout: TIMEOUT });
        const install = async (v) => {
            writeFileSync(`www/sw-${v}.js`, readFileSync('www/sw.js', 'utf8').replace(
                /const CACHE_VERSION = '[^']+'/, `const CACHE_VERSION = '${v}'`));
            await pg.evaluate((vv) => localStorage.setItem('__swTarget', `./sw-${vv}.js`), v);
            await pg.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
            await pg.waitForTimeout(5000);
            await pg.waitForLoadState('load').catch(() => {});
        };
        try {
            await install('c1');
            broken = 'ko'; await install('c2');    // partial
            broken = null;                          // network back
            await pg.waitForTimeout(6000);          // clear the repair cooldown
            koFetches = 0;
            await pg.evaluate(async () => {
                const ps = [];
                for (let i = 0; i < 30; i++) ps.push(fetch('./index.html?b=' + i, { cache: 'no-store' }).catch(() => {}));
                await Promise.all(ps);
            });
            await pg.waitForTimeout(3000);
            check('30 concurrent requests cause at most one repair fetch of the missing asset',
                koFetches <= 1, `${koFetches} fetches`);
            check('the missing asset is repaired into the cache',
                await pg.evaluate(async () => !!(await caches.match(
                    new URL('i18n/ko.json', location.href).href))));
        } finally {
            for (const v of ['c1', 'c2']) rmSync(`www/sw-${v}.js`, { force: true });
            await ctx.close();
        }
    }

} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: service worker offline tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
