// Playwright test: Appearance → "Hide Android status bar" (Never / In landscape
// / Always), the swipe-reveal hold with its scrim, status-bar icon style, and
// the status-bar allowance kept by dialogs and the tour.
//
// Run the dev server first:  node server.js    (or PORT=8099 node server.js)
//   node tests/test_status_bar.mjs
//
// The native SystemBars bridge (Capacitor 8 core) is represented by a narrow
// mock, so this is a web-level contract test of appearance.js, not of the
// plugin. Ported from SciREPL Pro's tests/test_landscape_composer.mjs
// (sections 4, 4b, 5, 5b and 11).
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 120_000;

let failures = 0;
let checks = 0;
const check = (name, passed, detail = '') => {
    checks++;
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 300) : ''}`);
};

async function settle(page) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(resolve))));
}

function installPrelude() {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_auto_download', '1');
    addEventListener('DOMContentLoaded', () => {
        const version = window.KERNEL_CONFIG?.app?.version;
        if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
    }, { once: true });

    const record = (visible, method, options) => {
        window.__systemBars.visible = visible;
        // Opt-in: re-inject the top inset as Capacitor's SystemBars does
        // (24 px with the status bar shown, 0 hidden).
        if (window.__systemBars.injectInsets) {
            document.documentElement.style.setProperty('--safe-area-inset-top', visible ? '24px' : '0px');
        }
        window.__systemBars.calls.push({ method, visible, options: options || null, at: performance.now() });
        if (window.__systemBars.holdCount > 0) {
            window.__systemBars.holdCount -= 1;
            return new Promise((resolve, reject) => {
                window.__systemBars.pending.push({ method, resolve, reject });
            });
        }
        return Promise.resolve();
    };
    window.__systemBars = { visible: true, calls: [], styleCalls: [], holdCount: 0, pending: [], injectInsets: false };
    const plugin = {
        hide: (options) => record(false, 'hide', options),
        show: (options) => record(true, 'show', options),
        // Icon style is recorded apart from visibility calls.
        setStyle: (options) => {
            window.__systemBars.styleCalls.push(options || null);
            return Promise.resolve();
        },
    };
    Object.defineProperty(window, 'Capacitor', {
        configurable: true,
        value: {
            Plugins: { SystemBars: plugin },
            getPlatform: () => 'android',
            isNativePlatform: () => true,
        },
    });
}

async function openApp(context) {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.appearance && window.appearanceUI, null, { timeout: TIMEOUT });
    await settle(page);
    return page;
}

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
    await context.addInitScript(installPrelude);
    const page = await openApp(context);

    console.log('\n4. Status-bar hiding is an explicit Android-only preference');
    check('default-off startup makes no native visibility call',
        await page.evaluate(() => window.__systemBars.calls.length === 0),
        JSON.stringify(await page.evaluate(() => window.__systemBars.calls)));
    let appearance = await page.evaluate(() => {
        window.appearanceUI.open(document.getElementById('menu-btn'));
        const row = document.getElementById('appearance-landscape-status-row');
        const help = document.getElementById('appearance-landscape-status-help');
        const input = document.getElementById('appearance-status-bar-mode');
        return {
            mode: window.appearance.getStatusBarMode(),
            rowHidden: row.hidden || row.classList.contains('hidden'),
            helpHidden: help.hidden || help.classList.contains('hidden'),
            value: input.value,
            options: [...input.options].map((o) => o.value).join(','),
            label: document.querySelector('label[for="appearance-status-bar-mode"]')?.textContent.trim(),
            described: input.getAttribute('aria-describedby'),
        };
    });
    check('Android shows the setting (Never / In landscape / Always) and defaults it to Never',
        appearance.mode === 'never' && appearance.value === 'never'
        && appearance.options === 'never,landscape,always'
        && !appearance.rowHidden && !appearance.helpHidden, JSON.stringify(appearance));
    check('the select is labelled and described',
        /status bar/i.test(appearance.label || '')
        && appearance.described === 'appearance-landscape-status-help', JSON.stringify(appearance));
    check('Free does not ship the "Panels use the full screen" option',
        await page.evaluate(() => !document.getElementById('appearance-panels-full-screen')
            && !document.documentElement.hasAttribute('data-panels-full-screen')
            && typeof window.appearance.setPanelsFullScreen === 'undefined'));

    await page.selectOption('#appearance-status-bar-mode', 'landscape');
    await page.waitForFunction(() => window.appearance.getStatusBarMode() === 'landscape'
        && window.__systemBars.visible === false);
    check('enabling in landscape persists and hides the status bar',
        await page.evaluate(() => window.__systemBars.calls.some((call) => call.visible === false)
            && localStorage.getItem('scirepl_appearance_status_bar_mode') === 'landscape'));
    check('only the status bar is hidden, never the navigation bar',
        await page.evaluate(() => window.__systemBars.calls.every((call) => call.options?.bar === 'StatusBar')));

    await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true
        && window.appearance?.getStatusBarMode?.() === 'landscape'
        && window.__systemBars.visible === false, null, { timeout: TIMEOUT });
    appearance = await page.evaluate(() => {
        window.appearanceUI.open(document.getElementById('menu-btn'));
        return {
            mode: window.appearance.getStatusBarMode(),
            value: document.getElementById('appearance-status-bar-mode').value,
        };
    });
    check('the preference survives a real reload and the control reflects it',
        appearance.mode === 'landscape' && appearance.value === 'landscape', JSON.stringify(appearance));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.__systemBars.visible === true);
    check('portrait restores the status bar without changing the preference',
        await page.evaluate(() => window.appearance.getStatusBarMode() === 'landscape'));

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => window.__systemBars.visible === false);
    await page.evaluate(() => window.appearanceUI.open(document.getElementById('menu-btn')));
    await page.selectOption('#appearance-status-bar-mode', 'never');
    await page.waitForFunction(() => window.appearance.getStatusBarMode() === 'never'
        && window.__systemBars.visible === true);
    check('disabling in landscape restores the bar immediately', true);

    await page.evaluate(() => window.appearance.setStatusBarMode('landscape'));
    await page.waitForFunction(() => window.__systemBars.visible === false);
    await page.evaluate(() => window.appearance.reset());
    await page.waitForFunction(() => window.appearance.getStatusBarMode() === 'never'
        && window.__systemBars.visible === true);
    check('Reset Appearance restores the safe visible-bar default', true);
    await page.evaluate(() => window.appearanceUI.close());

    console.log('\n4b. Dialogs and the tour keep the status-bar allowance; the three hide modes');
    // A visible status bar reporting a 24 px safe area (as SystemBars injects
    // it), and a user top margin of 48 px. Each overlay is filled past its
    // height so its max-height, not its content, decides where it starts.
    const overlayTops = () => page.evaluate(async () => {
        const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
        const settled = () => Promise.all(document.getAnimations()
            .map((a) => { a.finish(); return a.finished.catch(() => null); }));
        const out = { header: top(document.getElementById('app-header').firstElementChild) };
        for (const id of ['appearance-modal', 'settings-modal', 'memory-modal',
            'package-catalog-modal', 'prolog-settings-modal', 'help-modal']) {
            const modal = document.getElementById(id);
            const content = modal?.querySelector('.modal-content');
            if (!content) { out[id] = null; continue; }
            const filler = document.createElement('div');
            filler.style.blockSize = '3000px';
            content.appendChild(filler);
            modal.classList.remove('hidden');
            await settled();
            out[id] = top(content);
            modal.classList.add('hidden');
            filler.remove();
        }
        return out;
    });
    const overlaysClear = (tops, min) => Object.entries(tops)
        .every(([, v]) => v !== null && v >= min);

    await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-top', '24px'));
    let tops = await overlayTops();
    check('Auto: every dialog starts below the 24 px status-bar allowance, like the header',
        overlaysClear(tops, 24), JSON.stringify(tops));
    await page.evaluate(() => window.appearance.setTopMargin(48));
    tops = await overlayTops();
    check('a 48 px top margin: every dialog (scrolling ones included) keeps it',
        overlaysClear(tops, 48), JSON.stringify(tops));

    // The tour card, centred in a short viewport, keeps the allowance too.
    await page.setViewportSize({ width: 844, height: 260 });
    const tour = await page.evaluate(async () => {
        window.onboarding.start();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const card = document.getElementById('tour-card');
        const r = card.getBoundingClientRect();
        const out = { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
        window.onboarding.finish();
        localStorage.setItem('scirepl_onboarding_seen', '1');
        return out;
    });
    check('the tour card starts below the top margin and stays on screen',
        tour.top >= 48 + 8 && tour.bottom <= tour.vh, JSON.stringify(tour));

    // The extreme: the largest top margin (96 px) on a 320x120 viewport. The
    // viewport wins over the allowance: the card fits inside it and scrolls.
    await page.evaluate(() => window.appearance.setTopMargin(96));
    await page.setViewportSize({ width: 320, height: 120 });
    const tinyTour = await page.evaluate(async () => {
        window.onboarding.start();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const card = document.getElementById('tour-card');
        const r = card.getBoundingClientRect();
        const out = { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
            right: Math.round(r.right), vw: innerWidth, vh: innerHeight,
            overflowY: getComputedStyle(card).overflowY,
            scrollable: card.scrollHeight > card.clientHeight };
        // Every part of the content is reachable: scrolling to the end
        // brings the last control fully inside the card.
        card.scrollTop = card.scrollHeight;
        const controls = [...card.querySelectorAll('button, select, input')]
            .filter((el) => el.offsetParent !== null);
        const last = controls.at(-1);
        const lr = last?.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        out.lastReachable = !!lr && lr.top >= cr.top - 1 && lr.bottom <= cr.bottom + 1;
        window.onboarding.finish();
        localStorage.setItem('scirepl_onboarding_seen', '1');
        return out;
    });
    check('320x120 with a 96 px top margin: the tour card is fully inside the viewport',
        tinyTour.top >= 0 && tinyTour.bottom <= tinyTour.vh
        && tinyTour.left >= 0 && tinyTour.right <= tinyTour.vw, JSON.stringify(tinyTour));
    check('…and its content scrolls inside it, so the last control is reachable',
        /auto|scroll/.test(tinyTour.overflowY) && tinyTour.lastReachable, JSON.stringify(tinyTour));
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => {
        window.appearance.setTopMargin(null);
        document.documentElement.style.removeProperty('--safe-area-inset-top');
    });

    // The three modes, in landscape (this page) and portrait.
    await page.evaluate(() => window.appearance.setStatusBarMode('always'));
    await page.waitForFunction(() => window.__systemBars.visible === false);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    check('Always hides the bar in portrait too', await page.evaluate(() => window.__systemBars.visible === false
        && window.appearance.getStatusBarMode() === 'always'));
    await page.evaluate(() => window.appearance.setStatusBarMode('landscape'));
    await page.waitForFunction(() => window.__systemBars.visible === true);
    check('In landscape shows the bar in portrait', true);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => window.__systemBars.visible === false);
    check('…and hides it in landscape', true);
    await page.evaluate(() => window.appearance.setStatusBarMode('never'));
    await page.waitForFunction(() => window.__systemBars.visible === true);
    check('Never restores the bar', await page.evaluate(() => window.appearance.getStatusBarMode() === 'never'));
    check('an unknown stored mode reads as Never',
        await page.evaluate(() => {
            localStorage.setItem('scirepl_appearance_status_bar_mode', 'sometimes');
            const mode = window.appearance.getStatusBarMode();
            localStorage.setItem('scirepl_appearance_status_bar_mode', 'never');
            return mode === 'never';
        }));

    // The Auto allowance collapses with the bar (SystemBars re-injects the
    // inset; the mock does too, opt-in), and a swipe-revealed bar is hidden
    // again under Always.
    await page.evaluate(() => {
        window.__systemBars.injectInsets = true;
        document.documentElement.style.setProperty('--safe-area-inset-top', '24px');
    });
    const headerTop = () => page.evaluate(() => Math.round(document.getElementById('app-header').firstElementChild.getBoundingClientRect().top));
    const shownTop = await headerTop();
    await page.evaluate(() => window.appearance.setStatusBarMode('always'));
    await page.waitForFunction(() => window.__systemBars.visible === false);
    await settle(page);
    const hiddenTop = await headerTop();
    check('Auto top allowance: 24 px with the bar shown, collapsed when Always hides it',
        shownTop >= 24 && hiddenTop < 24, JSON.stringify({ shownTop, hiddenTop }));
    const hidesBefore = await page.evaluate(() => window.__systemBars.calls.filter((c) => c.method === 'hide').length);
    await page.evaluate(() => {
        // A swipe from the top re-shows the bar for good; SystemBars re-injects its inset.
        window.__systemBars.visible = true;
        document.documentElement.style.setProperty('--safe-area-inset-top', '24px');
    });
    // The production hold (5 s, no override): the bar stays up to be read,
    // with a scrim the inset's height behind it, then hides once.
    const revealedAt = performance.now();
    const holdConst = await page.evaluate(() => window.appearance._statusBarRevealHoldMs);
    await page.waitForTimeout(400);
    const scrimDuring = await page.evaluate(() => {
        const el = document.querySelector('.status-bar-scrim');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width),
            vw: innerWidth, pe: cs.pointerEvents, hidden: el.getAttribute('aria-hidden'), position: cs.position,
            bg: cs.backgroundColor };
    });
    check('a swipe reveal on edge-to-edge shows a fixed scrim of the inset\'s height, inert and aria-hidden',
        scrimDuring && scrimDuring.top === 0 && scrimDuring.height === 24 && scrimDuring.width === scrimDuring.vw
        && scrimDuring.pe === 'none' && scrimDuring.hidden === 'true' && scrimDuring.position === 'fixed'
        && scrimDuring.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(scrimDuring));
    await page.waitForTimeout(Math.max(0, 4200 - (performance.now() - revealedAt)));
    const heldAt4s = await page.evaluate((n) => window.__systemBars.visible === true
        && window.__systemBars.calls.filter((c) => c.method === 'hide').length === n
        && !!document.querySelector('.status-bar-scrim'), hidesBefore);
    check('the production hold is 5000 ms and the revealed bar is still up after 4 s', holdConst === 5000 && heldAt4s,
        JSON.stringify({ holdConst, heldAt4s }));
    const rehidden = await page.waitForFunction((n) => window.__systemBars.visible === false
        && window.__systemBars.calls.filter((c) => c.method === 'hide').length > n, hidesBefore, { timeout: 4000 }).then(() => true, () => false);
    const heldFor = performance.now() - revealedAt;
    check('under Always a swipe-revealed status bar is hidden again after about 5 s', rehidden && heldFor >= 4900 && heldFor < 7000,
        String(heldFor));
    check('…and the scrim is gone with it (once the inset drops, after a short fade)',
        await page.waitForFunction(() => !document.querySelector('.status-bar-scrim'), null, { timeout: 1500 }).then(() => true, () => false));
    await page.waitForTimeout(600);
    const extra = await page.evaluate((n) => window.__systemBars.calls.filter((c) => c.method === 'hide').length - n, hidesBefore);
    check('…once, with no loop', extra === 1, String(extra));
    await page.evaluate(() => window.appearance.setStatusBarMode('never'));
    await page.waitForFunction(() => window.__systemBars.visible === true);
    await settle(page);
    check('Never shows the bar and the allowance returns', await headerTop() >= 24);
    await page.evaluate(() => {
        window.__systemBars.injectInsets = false;
        document.documentElement.style.removeProperty('--safe-area-inset-top');
    });
    await context.close();

    console.log('\n5. Status-bar reconciliation is latest-wins and bounded');
    const queueContext = await browser.newContext({ viewport: { width: 844, height: 390 } });
    await queueContext.addInitScript(installPrelude);
    const queuePage = await openApp(queueContext);
    await queuePage.setViewportSize({ width: 390, height: 844 });
    await settle(queuePage);
    check('default-off rotation still makes no native visibility call',
        await queuePage.evaluate(() => window.__systemBars.calls.length === 0),
        JSON.stringify(await queuePage.evaluate(() => window.__systemBars.calls)));

    await queuePage.evaluate(() => window.appearance.setStatusBarMode('landscape'));
    await queuePage.waitForFunction(() => window.__systemBars.calls.length === 1);
    check('enabling the preference in portrait repairs a possibly hidden bar',
        await queuePage.evaluate(() => window.__systemBars.calls[0]?.method === 'show'));

    await queuePage.setViewportSize({ width: 844, height: 390 });
    await queuePage.waitForFunction(() => window.__systemBars.calls.length === 2);
    await queuePage.evaluate(() => {
        window.__systemBars.holdCount = 1;
        window.appearance._syncLandscapeStatusBar(true);
    });
    await queuePage.waitForFunction(() => window.__systemBars.pending.length === 1);
    await queuePage.setViewportSize({ width: 390, height: 844 });
    await queuePage.setViewportSize({ width: 844, height: 390 });
    // Confirm the physical viewport is final, but deliberately do not wait for
    // the MediaQueryList listener. The production dispatch must not depend on
    // that event winning the race with the held native promise.
    await queuePage.waitForFunction(() => innerWidth > innerHeight);
    await queuePage.evaluate(() => window.__systemBars.pending.shift().resolve());
    await queuePage.waitForFunction(() => window.__systemBars.calls.length >= 4);
    const staleSequence = await queuePage.evaluate(() =>
        window.__systemBars.calls.map((call) => call.method));
    check('a queued portrait show is skipped after landscape becomes latest again',
        staleSequence.slice(-2).join(',') === 'hide,hide', staleSequence.join(','));

    await queuePage.setViewportSize({ width: 390, height: 844 });
    await queuePage.waitForFunction(() => window.__systemBars.visible === true);
    await queuePage.evaluate(() => window.appearance.setStatusBarMode('never'));
    await queuePage.setViewportSize({ width: 844, height: 390 });
    await settle(queuePage);
    const beforeHung = await queuePage.evaluate(() => window.__systemBars.calls.length);
    await queuePage.evaluate(() => {
        window.__systemBars.holdCount = 1;
        window.appearance.setStatusBarMode('landscape');
    });
    await queuePage.waitForFunction((count) => window.__systemBars.calls.length === count + 1,
        beforeHung);
    await queuePage.setViewportSize({ width: 390, height: 844 });
    await queuePage.waitForFunction((count) => window.__systemBars.calls.length >= count + 2,
        beforeHung, { timeout: 3_000 });
    const hungSequence = await queuePage.evaluate((count) =>
        window.__systemBars.calls.slice(count).map((call) => call.method), beforeHung);
    check('a hung hide cannot indefinitely block the newer portrait restoration',
        hungSequence[0] === 'hide' && hungSequence.includes('show'), hungSequence.join(','));
    await queueContext.close();

    console.log('\n5b. Re-hide fallback: signals other than the safe-area inset');
    // SystemBars injects --safe-area-inset-top only on API 35+ (and a cutout
    // can keep it unchanged), so a swipe-revealed bar must also be caught by
    // resize, focus, App resume and a touch near the top edge. Here the
    // stand-in re-shows the bar WITHOUT any inset change.
    const fbContext = await browser.newContext({ viewport: { width: 844, height: 390 } });
    await fbContext.addInitScript(installPrelude);
    await fbContext.addInitScript(() => {
        window.__appListeners = {};
        window.Capacitor.Plugins.App = {
            addListener(name, fn) {
                (window.__appListeners[name] ||= []).push(fn);
                return Promise.resolve({ remove() {} });
            },
        };
    });
    const fb = await openApp(fbContext);
    await fb.evaluate(() => {
        // Shorter waits for the test; the logic is the same.
        window.appearance._statusBarRevealHoldMs = 500;
        window.appearance._statusBarRehideCoverMs = 400;
    });
    const hides = () => fb.evaluate(() => window.__systemBars.calls.filter((c) => c.method === 'hide').length);
    const calls = () => fb.evaluate(() => window.__systemBars.calls.length);
    const reveal = () => fb.evaluate(() => { window.__systemBars.visible = true; });
    const quiet = () => fb.waitForTimeout(900);
    const signals = {
        focus: () => fb.evaluate(() => window.dispatchEvent(new Event('focus'))),
        resume: () => fb.evaluate(() => (window.__appListeners.resume || []).forEach((fn) => fn())),
        resize: () => fb.evaluate(() => window.dispatchEvent(new Event('resize'))),
        topTouch: () => fb.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 10 }))),
    };
    check('the App resume listener is registered on Android',
        await fb.evaluate(() => (window.__appListeners.resume || []).length === 1));

    await fb.evaluate(() => window.appearance.setStatusBarMode('always'));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await quiet();
    for (const [name, fire] of Object.entries(signals)) {
        const hb = await hides();
        await reveal();
        await fire();
        const ok = await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).then(() => true, () => false);
        await quiet();
        const n = (await hides()) - hb;
        check(`Always: ${name} re-hides a swipe-revealed bar with no inset signal, once`, ok && n === 1, String(n));
    }
    const lowTouch = await hides();
    await reveal();
    await fb.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 300 })));
    await fb.waitForTimeout(1200);
    check('a touch away from the top edge does not schedule a re-hide', (await hides()) === lowTouch);
    await fb.evaluate(() => window.appearance._syncLandscapeStatusBar(true));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await quiet();

    // Reveal hold vs prompt signals (hold shortened to 3000 ms here; the
    // production 5000 ms is checked in section 4b).
    await fb.evaluate(() => { window.appearance._statusBarRevealHoldMs = 3000; });
    const scrimNow = () => fb.evaluate(() => {
        const el = document.querySelector('.status-bar-scrim:not(.is-leaving)');
        return el ? Math.round(el.getBoundingClientRect().height) : null;
    });
    // A swipe that grows the inset (edge-to-edge): held, with a scrim.
    const insetReveal = () => fb.evaluate(() => {
        window.__systemBars.visible = true;
        document.documentElement.style.setProperty('--safe-area-inset-top', '24px');
    });
    const insetHidden = () => fb.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-top', '0px'));
    await insetHidden();
    await quiet();

    let hb = await hides();
    let t0 = performance.now();
    await reveal();
    await signals.topTouch();
    await fb.waitForTimeout(300);
    await signals.resume();
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).catch(() => null);
    let took = performance.now() - t0;
    await quiet();
    check('resume during a reveal hold hides promptly (well before the hold ends), once',
        took < 1500 && (await hides()) - hb === 1 && (await scrimNow()) === null, String(took));

    hb = await hides();
    t0 = performance.now();
    await reveal();
    await signals.resume();
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).catch(() => null);
    took = performance.now() - t0;
    await quiet();
    check('resume alone hides promptly, with no scrim', took < 1500 && (await hides()) - hb === 1, String(took));

    // App switcher: the resize that arrives with the return is not a reveal.
    t0 = performance.now();
    await reveal();
    await signals.resume();
    await signals.resize();
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).catch(() => null);
    took = performance.now() - t0;
    await quiet();
    check('resume with its resize stays prompt (no hold)', took < 1500 && (await scrimNow()) === null, String(took));

    // Scrim during the hold, at the inset's height; gone after the hide.
    hb = await hides();
    t0 = performance.now();
    await insetReveal();
    await fb.waitForTimeout(300);
    const scrimH = await scrimNow();
    const aria = await fb.evaluate(() => document.querySelector('.status-bar-scrim')?.getAttribute('aria-hidden'));
    const stillUp = await fb.evaluate(() => window.__systemBars.visible === true);
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 6000 }).catch(() => null);
    took = performance.now() - t0;
    // The stand-in does not lower the inset here: the scrim waits for it.
    const scrimAtHide = await scrimNow();
    await insetHidden();
    const scrimGone = await fb.waitForFunction(() => !document.querySelector('.status-bar-scrim'), null, { timeout: 1000 }).then(() => true, () => false);
    await quiet();
    check('an inset-growing reveal holds about the hold time with a scrim of the inset\'s height, then hides once; the scrim stays until the inset drops',
        scrimH === 24 && aria === 'true' && stillUp && took >= 2900 && took < 4500
        && (await hides()) - hb === 1 && scrimAtHide === 24 && scrimGone,
        JSON.stringify({ scrimH, aria, stillUp, took, scrimAtHide, scrimGone }));

    // No inset (the bar has its own background): held, but no scrim.
    t0 = performance.now();
    await reveal();
    await signals.resize();
    await fb.waitForTimeout(300);
    const noScrim = (await scrimNow()) === null;
    const upNoInset = await fb.evaluate(() => window.__systemBars.visible === true);
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 6000 }).catch(() => null);
    took = performance.now() - t0;
    await quiet();
    check('with a zero inset a resize reveal is held but draws no scrim', noScrim && upNoInset && took >= 2900,
        JSON.stringify({ noScrim, upNoInset, took }));

    // Never during a hold cancels the hide (and the scrim).
    hb = await hides();
    await insetReveal();
    await fb.waitForTimeout(300);
    const scrimBeforeNever = await scrimNow();
    await fb.evaluate(() => window.appearance.setStatusBarMode('never'));
    await fb.waitForTimeout(3500);
    check('changing the mode to Never during a hold cancels the hide and removes the scrim',
        scrimBeforeNever === 24 && (await hides()) === hb && (await scrimNow()) === null
        && await fb.evaluate(() => window.__systemBars.visible === true && window.__systemBars.calls.at(-1).method === 'show'),
        JSON.stringify({ scrimBeforeNever }));

    // In landscape: rotating to portrait during a hold cancels the hide.
    await fb.evaluate(() => window.appearance.setStatusBarMode('landscape'));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await insetHidden();
    await quiet();
    hb = await hides();
    await insetReveal();
    await fb.waitForTimeout(300);
    await fb.setViewportSize({ width: 390, height: 844 });
    await fb.waitForTimeout(3500);
    check('In landscape: leaving landscape during a hold cancels the hide and the scrim',
        (await hides()) === hb && (await scrimNow()) === null
        && await fb.evaluate(() => window.__systemBars.visible === true));
    await fb.setViewportSize({ width: 844, height: 390 });
    await fb.evaluate(() => window.appearance.setStatusBarMode('always'));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await insetHidden();
    await quiet();

    // A burst of reveals: one hold, one hide.
    let cb = await calls();
    await reveal();
    await fb.evaluate(() => {
        for (let i = 0; i < 40; i += 1) {
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 10 }));
        }
    });
    await fb.waitForTimeout(1000);
    const upMidBurst = await fb.evaluate(() => window.__systemBars.visible === true);
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 6000 }).catch(() => null);
    await fb.waitForTimeout(1500);
    const burstCalls = await fb.evaluate((n) => window.__systemBars.calls.slice(n).map((c) => c.method), cb);
    check('a burst of 80 reveal signals holds once and makes at most 2 hide calls, no loop',
        upMidBurst && burstCalls.length >= 1 && burstCalls.length <= 2 && burstCalls.every((m) => m === 'hide'),
        burstCalls.join(','));

    // Reveals that keep coming restart the hold a bounded number of times.
    cb = await calls();
    t0 = performance.now();
    await reveal();
    let firstHideAt = null;
    for (let i = 0; i < 34; i += 1) {
        await signals.resize();
        if (firstHideAt === null && await fb.evaluate(() => window.__systemBars.visible === false)) firstHideAt = performance.now() - t0;
        await fb.waitForTimeout(300);
    }
    if (firstHideAt === null) firstHideAt = Infinity;
    await fb.waitForTimeout(2000);
    const keptCalls = await fb.evaluate((n) => window.__systemBars.calls.slice(n).map((c) => c.method), cb);
    check('reveals every 300 ms restart the hold at most twice: the bar hides within 3 holds, bounded calls',
        firstHideAt >= 3500 && firstHideAt <= 3 * 3000 + 1500 && keptCalls.length <= 6 && keptCalls.every((m) => m === 'hide'),
        JSON.stringify({ firstHideAt, keptCalls }));
    await fb.evaluate(() => window.appearance._syncLandscapeStatusBar(true));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await insetHidden();
    await fb.waitForTimeout(1500);

    // Header taps (top-edge touches) use up the restart budget; a real
    // swipe (the inset grows) near the end of that hold still gets a full
    // hold of its own.
    t0 = performance.now();
    await reveal();
    for (let i = 0; i < 3; i += 1) {
        if (i) await fb.waitForTimeout(1100);
        await signals.topTouch();
    }
    // Last restart at ~2.2 s; that hold would end at ~5.2 s.
    await fb.waitForTimeout(Math.max(0, 4700 - (performance.now() - t0)));
    const swipeAt = performance.now();
    await insetReveal();
    await fb.waitForTimeout(Math.max(0, 2500 - (performance.now() - swipeAt)));
    const upAfterSwipe = await fb.evaluate(() => window.__systemBars.visible === true);
    const scrimAfterSwipe = await scrimNow();
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 6000 }).catch(() => null);
    const swipeHeld = performance.now() - swipeAt;
    await insetHidden();
    await quiet();
    check('after three header taps exhaust the restart budget, an inset-growing swipe still holds about a full hold',
        upAfterSwipe && scrimAfterSwipe === 24 && swipeHeld >= 2900 && swipeHeld < 4500,
        JSON.stringify({ upAfterSwipe, scrimAfterSwipe, swipeHeld: Math.round(swipeHeld) }));

    // The soft keyboard: a visualViewport resize with no inset change while
    // the bar is hidden. No scrim, no show, at most one no-op hide.
    await fb.waitForTimeout(1200);
    cb = await calls();
    await fb.evaluate(() => window.visualViewport.dispatchEvent(new Event('resize')));
    await fb.waitForTimeout(300);
    const kbScrim = await scrimNow();
    await fb.waitForTimeout(3500);
    const kbCalls = await fb.evaluate((n) => window.__systemBars.calls.slice(n).map((c) => c.method), cb);
    check('a keyboard visualViewport resize with the bar hidden draws no scrim, shows nothing, and makes at most one hide',
        kbScrim === null && kbCalls.length <= 1 && kbCalls.every((m) => m === 'hide'), kbCalls.join(','));
    await quiet();

    // focus and visibilitychange during a hold end it promptly.
    for (const [name, fire] of [
        ['focus', signals.focus],
        ['visibilitychange', () => fb.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))],
    ]) {
        await insetReveal();
        await fb.waitForTimeout(400);
        const scrimBefore = await scrimNow();
        t0 = performance.now();
        await fire();
        await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).catch(() => null);
        took = performance.now() - t0;
        await insetHidden();
        await quiet();
        check(`${name} during a hold ends it promptly`, scrimBefore === 24 && took < 1500
            && await fb.evaluate(() => !window.appearance._revealHoldTimer), String(Math.round(took)));
    }
    check('the page is visible, so the visibilitychange check exercised the prompt path',
        await fb.evaluate(() => document.visibilityState === 'visible'));

    // The scrim follows the theme: light theme, light band.
    const themeBefore = await fb.evaluate(() => window.appearance.getTheme());
    const scrimRgba = () => fb.evaluate(() => {
        const el = document.querySelector('.status-bar-scrim:not(.is-leaving)');
        if (!el) return null;
        const nums = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || []).map(Number);
        return { bg: getComputedStyle(el).backgroundColor, nums };
    });
    await fb.evaluate(() => window.appearance.setTheme('light'));
    await insetReveal();
    await fb.waitForTimeout(400);
    const lightScrim = await scrimRgba();
    await fb.evaluate(() => window.appearance._syncLandscapeStatusBar(true));
    await insetHidden();
    await quiet();
    // color(srgb r g b / a) or rgba(r, g, b, a): light channels, 0.92 alpha.
    const light = lightScrim && lightScrim.nums.slice(-4);
    const lightOk = !!light && light[3] > 0.9 && light[3] < 0.95
        && light.slice(0, 3).every((c) => (c > 1 ? c / 255 : c) > 0.9);
    check('under the light theme the scrim is the light header colour at high opacity', lightOk, JSON.stringify(lightScrim));

    // Icon style follows the app theme (dark app → light icons, 'DARK').
    const styles = () => fb.evaluate(() => window.__systemBars.styleCalls.map((c) => `${c.style}/${c.bar}`));
    const lastStyle = async () => (await styles()).at(-1);
    await fb.evaluate(() => window.appearance.setTheme('dark'));
    await fb.waitForTimeout(100);
    const sDark = await lastStyle();
    await fb.evaluate(() => window.appearance.setTheme('light'));
    await fb.waitForTimeout(100);
    const sLight = await lastStyle();
    const nBefore = (await styles()).length;
    await fb.evaluate(() => { window.appearance.apply(); window.appearance.setTheme('light'); });
    await fb.waitForTimeout(100);
    const nAfter = (await styles()).length;
    await fb.evaluate(() => {
        localStorage.setItem('scirepl_appearance_custom_theme', JSON.stringify({ name: 'Paper', base: 'dark', vars: { '--bg-secondary': '#eeeeee' } }));
        window.appearance.setTheme('custom');
    });
    await fb.waitForTimeout(100);
    const sCustomLight = await lastStyle();
    await fb.evaluate(() => {
        localStorage.setItem('scirepl_appearance_custom_theme', JSON.stringify({ name: 'Ink', base: 'light', vars: { '--bg-secondary': '#202020' } }));
        window.appearance.apply();
    });
    await fb.waitForTimeout(100);
    const sCustomDark = await lastStyle();
    // Any colour syntax the theme validator accepts is normalized before its
    // luminance is taken: white written as color() or oklch() must still get
    // dark icons (LIGHT), and a dark oklch() light icons (DARK).
    const styleFor = async (bg) => {
        await fb.evaluate((colour) => {
            localStorage.setItem('scirepl_appearance_custom_theme', JSON.stringify({ name: 'T', base: 'dark', vars: { '--bg-secondary': colour } }));
            // From a known opposite, so an unchanged style still records a call.
            window.appearance._systemBarStyle = null;
            window.appearance.setTheme('custom');
        }, bg);
        await fb.waitForTimeout(100);
        return lastStyle();
    };
    const syntaxes = {
        'color(srgb 1 1 1)': await styleFor('color(srgb 1 1 1)'),
        'oklch(100% 0 0)': await styleFor('oklch(100% 0 0)'),
        'oklch(20% 0 0)': await styleFor('oklch(20% 0 0)'),
        'lab(98% 0 0)': await styleFor('lab(98% 0 0)'),
        'hsl(0 0% 100%)': await styleFor('hsl(0 0% 100%)'),
        white: await styleFor('white'),
        '#111': await styleFor('#111'),
    };
    check('custom --bg-secondary in color()/oklch() white gives LIGHT (dark icons); oklch(20% 0 0) gives DARK',
        syntaxes['color(srgb 1 1 1)'] === 'LIGHT/StatusBar' && syntaxes['oklch(100% 0 0)'] === 'LIGHT/StatusBar'
        && syntaxes['oklch(20% 0 0)'] === 'DARK/StatusBar', JSON.stringify(syntaxes));
    check('…and lab(), hsl(), named and hex colours are normalized the same way',
        syntaxes['lab(98% 0 0)'] === 'LIGHT/StatusBar' && syntaxes['hsl(0 0% 100%)'] === 'LIGHT/StatusBar'
        && syntaxes.white === 'LIGHT/StatusBar' && syntaxes['#111'] === 'DARK/StatusBar', JSON.stringify(syntaxes));
    check('status-bar icon style follows the app theme: dark → DARK, light → LIGHT, custom by --bg-secondary luminance, no call when unchanged',
        sDark === 'DARK/StatusBar' && sLight === 'LIGHT/StatusBar' && nAfter === nBefore
        && sCustomLight === 'LIGHT/StatusBar' && sCustomDark === 'DARK/StatusBar',
        JSON.stringify({ sDark, sLight, nBefore, nAfter, sCustomLight, sCustomDark }));
    await fb.evaluate((t) => {
        localStorage.removeItem('scirepl_appearance_custom_theme');
        window.appearance.setTheme(t === 'custom' ? 'dark' : t);
    }, themeBefore);

    await fb.evaluate(() => { window.appearance._statusBarRevealHoldMs = 500; });
    await fb.evaluate(() => window.appearance._syncLandscapeStatusBar(true));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await quiet();

    // A genuine re-show inside the echo guard is not lost. SciREPL hides;
    // 100 ms later the bar is swiped back and a signal arrives. The guard
    // drops it, and one deferred re-check after the window hides the bar
    // with no further events.
    let fbBefore = await calls();
    await fb.evaluate(() => window.appearance._syncLandscapeStatusBar(true));
    await fb.waitForFunction(() => window.__systemBars.visible === false);
    await fb.waitForTimeout(100);
    await reveal();
    await signals.focus();
    const deferredOk = await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).then(() => true, () => false);
    await fb.waitForTimeout(1200);
    const seq = await fb.evaluate((n) => window.__systemBars.calls.slice(n), fbBefore);
    const gap = seq.length === 2 ? Math.round(seq[1].at - seq[0].at) : -1;
    check('a re-show inside the echo guard is hidden after the window with no further events (one deferred hide, no chain)',
        deferredOk && seq.map((c) => c.method).join(',') === 'hide,hide' && gap >= 400
        && await fb.evaluate(() => window.__systemBars.visible === false),
        JSON.stringify({ seq: seq.map((c) => c.method), gap }));

    // Burst: many signals at once, the echo of the hide, and the echo of the
    // deferred hide: at most two native calls, and nothing chains.
    fbBefore = await calls();
    await reveal();
    await fb.evaluate(() => {
        for (let i = 0; i < 20; i += 1) {
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('resize'));
            (window.__appListeners.resume || []).forEach((fn) => fn());
            window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 10 }));
        }
    });
    await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 });
    await fb.evaluate(() => window.dispatchEvent(new Event('resize')));
    await fb.waitForFunction((n) => window.__systemBars.calls.length >= n + 2, fbBefore, { timeout: 3000 }).catch(() => null);
    await fb.evaluate(() => window.dispatchEvent(new Event('resize')));
    await fb.waitForTimeout(1500);
    const burst = await fb.evaluate((n) => window.__systemBars.calls.slice(n).map((c) => c.method), fbBefore);
    check('a burst of 80 signals plus the echoes of its hides makes at most 2 hide calls, no loop',
        burst.length >= 1 && burst.length <= 2 && burst.every((m) => m === 'hide'), burst.join(','));

    // In landscape: landscape re-hides; portrait does not.
    await fb.evaluate(() => window.appearance.setStatusBarMode('landscape'));
    await quiet();
    fbBefore = await hides();
    await reveal();
    await signals.focus();
    const lsOk = await fb.waitForFunction(() => window.__systemBars.visible === false, null, { timeout: 3000 }).then(() => true, () => false);
    await quiet();
    check('In landscape, while in landscape: focus re-hides the bar, once', lsOk && (await hides()) - fbBefore === 1);
    await fb.setViewportSize({ width: 390, height: 844 });
    await fb.waitForFunction(() => window.__systemBars.visible === true);
    await quiet();
    fbBefore = await calls();
    for (const fire of Object.values(signals)) await fire();
    await fb.waitForTimeout(1200);
    check('In landscape, while in portrait: no signal hides the bar',
        (await calls()) === fbBefore && await fb.evaluate(() => window.__systemBars.visible === true));

    // Never: no signal makes any native call.
    await fb.evaluate(() => window.appearance.setStatusBarMode('never'));
    await fb.setViewportSize({ width: 844, height: 390 });
    await quiet();
    fbBefore = await calls();
    for (const fire of Object.values(signals)) await fire();
    await fb.waitForTimeout(1200);
    check('Never: focus, resume, resize and a top touch make no native call',
        (await calls()) === fbBefore && await fb.evaluate(() => window.__systemBars.visible === true));
    await fbContext.close();

    console.log('\n11. Web builds do not expose an Android-only control');
    const webContext = await browser.newContext({ viewport: { width: 844, height: 390 } });
    await webContext.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        addEventListener('DOMContentLoaded', () => {
            const version = window.KERNEL_CONFIG?.app?.version;
            if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
        }, { once: true });
    });
    const webPage = await openApp(webContext);
    const webSetting = await webPage.evaluate(() => {
        window.appearanceUI.open(document.getElementById('menu-btn'));
        const row = document.getElementById('appearance-landscape-status-row');
        const help = document.getElementById('appearance-landscape-status-help');
        return (row.hidden || row.classList.contains('hidden') || getComputedStyle(row).display === 'none')
            && (help.classList.contains('hidden') || getComputedStyle(help).display === 'none');
    });
    check('ordinary browser hides the Android status-bar preference', webSetting);
    check('…and setting a mode there makes no native call and draws no scrim',
        await webPage.evaluate(() => {
            window.appearance.setStatusBarMode('always');
            window.dispatchEvent(new Event('resize'));
            const ok = !window.appearance.supportsLandscapeStatusBar()
                && !document.querySelector('.status-bar-scrim');
            window.appearance.setStatusBarMode('never');
            return ok;
        }));
    await webContext.close();
} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.stack ? err.stack : err}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? `PASS: ${checks} status-bar checks passed` : `FAIL: ${failures} of ${checks} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
