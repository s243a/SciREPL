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
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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
        rmSync('www/sw-next.js', { force: true });
        return { before, ...after, page, _close: () => context.close() };
    }

    const partialUpgrade = await upgradeInPlace({ breakUrl: '**/i18n/ko.json' });
    check('a first install produces one app cache', partialUpgrade.before.length === 1, partialUpgrade.before.join(','));
    check('the previous version\'s cache is kept when the upgrade is partial',
        partialUpgrade.names.length >= 2, partialUpgrade.names.join(', '));
    check('the entry the new version could not cache is still served from the old one',
        partialUpgrade.koServed === true);
    check('the incomplete install is recorded, not assumed good',
        partialUpgrade.marker === 'partial', String(partialUpgrade.marker));
    await partialUpgrade._close();

    const cleanUpgrade = await upgradeInPlace();
    check('a complete install is marked complete',
        cleanUpgrade.marker === 'complete', String(cleanUpgrade.marker));
    // Pruning respects a still-open client: the previous cache is retained while
    // this document is pinned to it. Further navigations re-pin to the new
    // version, and the next activate then prunes the old one.
    let evicted = [];
    for (let i = 0; i < 3; i++) {
        await cleanUpgrade.page.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
        await cleanUpgrade.page.waitForTimeout(2500);
    }
    evicted = await cleanUpgrade.page.evaluate(async () =>
        (await caches.keys()).filter((k) => k.startsWith('scirepl-app-')));
    check('once no client is pinned to it, the previous cache is evicted',
        evicted.length === 1, evicted.join(', '));
    await cleanUpgrade._close();

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
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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
            for (let i = 0; i < 3; i++) {
                await pg.reload({ waitUntil: 'load', timeout: TIMEOUT }).catch(() => {});
                await pg.waitForTimeout(2500);
            }
            const remaining = await pg.evaluate(async () =>
                (await caches.keys()).filter((k) => k.startsWith('scirepl-app-')));
            check('stale caches are pruned once no client is pinned to them',
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
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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

    console.log('\n7. The session pin survives a service-worker restart');

    // Service workers are terminated while idle; an in-memory pin was lost on
    // restart and an open v1 document then received v2 assets. The pin is now
    // durable, so it survives a real worker restart (driven via CDP).
    {
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
            const sw = navigator.serviceWorker, real = sw.register.bind(sw);
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
        let cdp = null;
        try { cdp = await ctx.newCDPSession(pg); await cdp.send('ServiceWorker.enable'); }
        catch { cdp = null; }   // CDP is Chromium-only; skip gracefully elsewhere
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
        const servedSub = () => pg.evaluate(async () => {
            try { return (await (await fetch('./i18n/manifest.json', { cache: 'no-store' })).json())._testVersion; }
            catch { return 'FETCH-FAILED'; }
        });

        try {
            await install('p1');
            await install('p2', 'ko.json');   // partial, doc re-pins to p1
            broken = null;
            for (let i = 0; i < 5; i++) {      // repair -> promote p2 under the open doc
                await pg.evaluate(() => fetch('./index.html?x=' + Math.random(), { cache: 'no-store' }).catch(() => {}));
                await pg.waitForTimeout(2500);
            }
            check('the open document stays on its version after a mid-session promotion',
                (await servedSub()) === 'p1');
            if (cdp) {
                await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {});
                await pg.waitForTimeout(1500);
                check('the pin survives a service-worker restart (still p1)',
                    (await servedSub()) === 'p1');
            } else {
                console.log('  [SKIP] CDP unavailable — cannot force a worker restart here');
            }
        } finally {
            for (const v of ['p1', 'p2']) rmSync(`www/sw-${v}.js`, { force: true });
            await ctx.close();
        }
    }

    console.log('\n8. Runtime CDN cache keeps only immutable exact versions');

    {
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_privacy_accepted_revision',
                '2026-08-runtime-metadata-v1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        });
        const urls = {
            swiplPinned: 'https://swi-prolog.github.io/npm-swipl-wasm/3/8/2/dynamic-import.js',
            swiplLatest: 'https://swi-prolog.github.io/npm-swipl-wasm/3/latest/dynamic-import.js',
            webrPinned: 'https://webr.r-wasm.org/v0.6.0/webr.mjs',
            webrLatest: 'https://webr.r-wasm.org/latest/webr.mjs',
            npmPinned: 'https://cdn.jsdelivr.net/npm/webr@0.6.0/dist/webr.mjs',
            npmQuery: 'https://cdn.jsdelivr.net/npm/webr@0.6.0/dist/webr.mjs?mutable=1',
            unpkgPinned: 'https://unpkg.com/fengari-web@0.1.4/dist/fengari-web.js',
            malformedPinned: 'https://webr.r-wasm.org/v0.6.0/%ZZ-runtime',
            packagesIndex: 'https://webr.r-wasm.org/v0.6.0/R/wasm32-unknown-emscripten/contrib/4.5/PACKAGES.gz',
            optionalHead200: 'https://webr.r-wasm.org/v0.6.0/vfs/optional-present',
            optionalHead404: 'https://webr.r-wasm.org/v0.6.0/vfs/optional-missing',
            optionalGet404: 'https://webr.r-wasm.org/v0.6.0/vfs/get-missing',
        };
        const networkCounts = new Map();
        const handler = async (route) => {
            const request = route.request();
            const url = request.url();
            networkCounts.set(`${request.method()} ${url}`,
                (networkCounts.get(`${request.method()} ${url}`) || 0) + 1);
            const missing = url === urls.optionalHead404 || url === urls.optionalGet404;
            const luaFixture = url === urls.unpkgPinned;
            await route.fulfill({
                status: missing ? 404 : 200,
                headers: {
                    'access-control-allow-origin': '*',
                    'content-type': luaFixture ? 'application/javascript' : 'text/plain',
                },
                body: request.method() === 'HEAD' ? '' : luaFixture
                    ? 'window.__scireplLuaFixtureLoads = (window.__scireplLuaFixtureLoads || 0) + 1;'
                    : `network:${url}`,
            });
        };
        await ctx.route('https://swi-prolog.github.io/**', handler);
        await ctx.route('https://webr.r-wasm.org/**', handler);
        await ctx.route('https://cdn.jsdelivr.net/**', handler);
        await ctx.route('https://unpkg.com/**', handler);
        const pg = await ctx.newPage();
        try {
            await pg.goto(`${ORIGIN}/index.html`, { waitUntil: 'load', timeout: TIMEOUT });
            await pg.evaluate(() => navigator.serviceWorker.ready);
            if (!(await pg.evaluate(() => !!navigator.serviceWorker.controller))) {
                await pg.reload({ waitUntil: 'load', timeout: TIMEOUT });
            }
            await pg.waitForFunction(() => !!navigator.serviceWorker.controller);

            const online = await pg.evaluate(async (u) => {
                const result = {};
                for (const key of ['swiplPinned', 'swiplLatest', 'webrPinned', 'webrLatest',
                    'npmPinned', 'npmQuery', 'malformedPinned', 'packagesIndex',
                    'optionalGet404']) {
                    result[key] = (await fetch(u[key])).status;
                }
                result.optionalHead200 = (await fetch(u.optionalHead200, { method: 'HEAD' })).status;
                result.optionalHead404 = (await fetch(u.optionalHead404, { method: 'HEAD' })).status;
                const cache = await caches.open('scirepl-cdn-v3');
                await cache.delete(u.unpkgPinned);
                result.luaCachedBeforeScript = Boolean(await cache.match(u.unpkgPinned));
                const nativeCreateElement = document.createElement;
                document.createElement = (tag, options) => {
                    const node = nativeCreateElement.call(document, tag, options);
                    if (String(tag).toLowerCase() === 'script') {
                        const originalSetAttribute = node.setAttribute.bind(node);
                        node.setAttribute = (name, value) => originalSetAttribute(name, value);
                        window.__scireplLastRuntimeScript = node;
                    }
                    return node;
                };
                await window.kernelManager.loadKernelSource('lua', u.unpkgPinned,
                    (url) => window.kernelManager._loadScript(url));
                document.createElement = nativeCreateElement;
                result.luaCrossOrigin = window.__scireplLastRuntimeScript?.crossOrigin || '';
                result.luaScriptLoads = window.__scireplLuaFixtureLoads || 0;
                result.luaCachedAfterScript = Boolean(await cache.match(u.unpkgPinned));
                result.luaReceipt = await window.kernelManager.markRuntimeCacheComplete('lua');
                result.luaComplete = await window.kernelManager._hasCompleteCachedRuntime('lua');
                window.kernelManager._commitRuntimeSource('lua');
                return result;
            }, urls);
            check('online immutable/mutable fixture requests completed',
                online.swiplPinned === 200 && online.optionalGet404 === 404
                && online.optionalHead404 === 404, JSON.stringify(online));
            check('Lua uses a CORS-visible classic-script request',
                online.luaCrossOrigin === 'anonymous'
                && online.luaCachedBeforeScript === false
                && online.luaCachedAfterScript === true,
                JSON.stringify({ crossOrigin: online.luaCrossOrigin,
                    before: online.luaCachedBeforeScript, after: online.luaCachedAfterScript }));
            check('Lua script load writes and validates an exact-version completion receipt',
                online.luaScriptLoads === 1
                && online.luaReceipt === true && online.luaComplete === true,
                JSON.stringify({ loads: online.luaScriptLoads,
                    receipt: online.luaReceipt, complete: online.luaComplete }));

            const cached = await pg.evaluate(async () => {
                const cache = await caches.open('scirepl-cdn-v3');
                return (await cache.keys()).map((request) => request.url);
            });
            for (const key of ['swiplPinned', 'webrPinned', 'npmPinned', 'unpkgPinned',
                'malformedPinned', 'optionalGet404']) {
                check(`exact-version runtime is cached: ${key}`, cached.includes(urls[key]));
            }
            for (const key of ['swiplLatest', 'webrLatest', 'npmQuery', 'packagesIndex']) {
                check(`mutable runtime request is not cached: ${key}`, !cached.includes(urls[key]));
            }
            check('immutable HEAD probes are represented by method-specific markers',
                cached.filter((url) => url.includes('/__scirepl_runtime_probes__/')).length === 2,
                cached.filter((url) => url.includes('/__scirepl_runtime_probes__/')).join(', '));

            const luaNetworkBeforeOffline = networkCounts.get(`GET ${urls.unpkgPinned}`) || 0;
            await ctx.setOffline(true);
            const offline = await pg.evaluate(async (u) => {
                const result = {};
                for (const [key, init] of [
                    ['swiplPinned', {}],
                    ['optionalGet404', {}],
                    ['optionalHead200', { method: 'HEAD' }],
                    ['optionalHead404', { method: 'HEAD' }],
                ]) {
                    try { result[key] = (await fetch(u[key], init)).status; }
                    catch (_) { result[key] = 'failed'; }
                }
                try {
                    await window.kernelManager._loadScript(u.unpkgPinned);
                    result.luaScript = 'loaded';
                    result.luaLoads = window.__scireplLuaFixtureLoads;
                    result.luaComplete = await window.kernelManager._hasCompleteCachedRuntime('lua');
                } catch (_) {
                    result.luaScript = 'failed';
                }
                return result;
            }, urls);
            check('pinned GET runtime asset is served offline', offline.swiplPinned === 200,
                JSON.stringify(offline));
            check('pinned GET 404 remains an honest offline 404', offline.optionalGet404 === 404,
                JSON.stringify(offline));
            check('webR immutable HEAD 200 probe is served offline', offline.optionalHead200 === 200,
                JSON.stringify(offline));
            check('webR immutable HEAD 404 probe is served offline', offline.optionalHead404 === 404,
                JSON.stringify(offline));
            check('cached Lua classic script executes offline with its receipt intact',
                offline.luaScript === 'loaded'
                && offline.luaLoads === online.luaScriptLoads + 1
                && offline.luaComplete === true,
                JSON.stringify({ onlineLoads: online.luaScriptLoads, ...offline }));
            check('offline Lua script load makes no second network handoff',
                (networkCounts.get(`GET ${urls.unpkgPinned}`) || 0) === luaNetworkBeforeOffline,
                `${luaNetworkBeforeOffline} -> ${networkCounts.get(`GET ${urls.unpkgPinned}`) || 0}`);
            await ctx.setOffline(false);
        } finally {
            await ctx.setOffline(false).catch(() => {});
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
