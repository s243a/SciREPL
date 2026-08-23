// Playwright test: the three-state header shortcuts and their priority order.
//
// "always" and "never" are settings. "auto" is a MEASUREMENT: the same stored
// preferences must produce different headers on a narrow phone and a wide one,
// because whether a button fits is a property of the viewport, not of the
// user's taste. Priority decides which button gives up its place first.
import { chromium } from 'playwright';

const TIMEOUT = 180_000;
const APP_URL = process.env.SCIREPL_TEST_BASE || 'http://localhost:8085/';

(async () => {
    const browser = await chromium.launch({ headless: true });
    let allPassed = true, count = 0;
    const check = (name, passed, detail) => {
        count++;
        if (!passed) allPassed = false;
        console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
    };

    const open = async (width, height, init) => {
        const ctx = await browser.newContext({ viewport: { width, height } });
        await ctx.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => {
                const v = window.KERNEL_CONFIG?.app?.version;
                if (v) localStorage.setItem('scirepl_whats_new_seen_version', v);
            }, { once: true });
        });
        if (init) await ctx.addInitScript(init);
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() => window.__SCIREPL_APP_READY === true, null, { timeout: TIMEOUT });
        await settle(page);
        return { ctx, page };
    };

    // The header keeps moving after a viewport change: the fitter runs on the
    // next frame, the status badge swaps "loading …" for "ready", and i18n may
    // relabel. A fixed sleep either flakes or wastes time, so wait until two
    // consecutive frames produce the same header signature.
    const settle = (page) => page.waitForFunction(() => new Promise((resolve) => {
        const signature = () => {
            const bar = document.querySelector('.header-right');
            if (!bar) return 'none';
            return [...bar.children].map((el) => [
                el.id || el.className,
                el.classList.contains('header-shortcut-hidden') ? 0 : 1,
                Math.round(el.getBoundingClientRect().width),
            ].join(':')).join('|') + '#' + Math.round(bar.getBoundingClientRect().height);
        };
        const before = signature();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(signature() === before)));
    }), null, { timeout: 30_000 });

    const state = (page) => page.evaluate(() => {
        const vis = (id) => {
            const e = document.getElementById(id);
            return !!e && !e.classList.contains('header-shortcut-hidden');
        };
        const bar = document.querySelector('.header-right');
        let tallest = 0;
        for (const el of bar.children) {
            if (el.offsetParent === null) continue;
            tallest = Math.max(tallest, el.getBoundingClientRect().height);
        }
        return {
            browse: vis('browse-shortcut-btn'),
            formula: vis('math-mode-btn'),
            tour: vis('tour-shortcut-btn'),
            rows: bar.getBoundingClientRect().height > tallest + 2 ? 2 : 1,
            badge: (document.getElementById('status-badge') || {}).textContent,
            barW: Math.round(bar.getBoundingClientRect().width),
        };
    });

    try {
        console.log('1. The same defaults give different headers at different widths');
        let { ctx, page } = await open(320, 640);
        let s = await state(page);
        check('320px: no room, so the auto shortcuts stand down',
            !s.browse && !s.tour && s.rows === 1, JSON.stringify(s));
        await ctx.close();

        ({ ctx, page } = await open(412, 915));
        s = await state(page);
        check('412px: both auto shortcuts fit, still one row',
            s.browse && s.tour && s.rows === 1, JSON.stringify(s));
        await ctx.close();

        ({ ctx, page } = await open(800, 400));
        s = await state(page);
        check('landscape 800px: both shown', s.browse && s.tour, JSON.stringify(s));

        console.log('2. Rotation re-decides without a reload');
        await page.setViewportSize({ width: 320, height: 640 });
        await settle(page);
        s = await state(page);
        check('rotating to a narrow viewport stands them down',
            !s.browse && !s.tour && s.rows === 1, JSON.stringify(s));
        await page.setViewportSize({ width: 800, height: 400 });
        await settle(page);
        s = await state(page);
        check('rotating back brings them straight back', s.browse && s.tour, JSON.stringify(s));
        await ctx.close();

        console.log('3. always and never are settings, not measurements');
        ({ ctx, page } = await open(320, 640));
        await page.evaluate(() => window.appearance.setShortcutMode('browse', 'always'));
        await settle(page);
        s = await state(page);
        check('always keeps Browse even where there is no room',
            s.browse, JSON.stringify(s));
        check('and the header is allowed to wrap to make space', s.rows === 2, JSON.stringify(s));
        await page.evaluate(() => window.appearance.setShortcutMode('browse', 'never'));
        await settle(page);
        s = await state(page);
        check('never hides it even where there is plenty of room', !s.browse);
        await ctx.close();

        ({ ctx, page } = await open(800, 400));
        await page.evaluate(() => window.appearance.setShortcutMode('browse', 'never'));
        await settle(page);
        s = await state(page);
        check('never still hides it at 800px', !s.browse, JSON.stringify(s));
        await ctx.close();

        console.log('4. Priority decides who gives up their place first');
        // Do not hard-code a width where "exactly one fits": that boundary moves
        // with the status badge text, the locale and the button scale. Find it
        // by narrowing until one of the two drops, then test priority there.
        ({ ctx, page } = await open(430, 900));
        let boundary = null;
        for (let w = 430; w >= 300; w -= 3) {
            await page.setViewportSize({ width: w, height: 900 });
            await settle(page);
            const cur = await state(page);
            if (cur.browse !== cur.tour) { boundary = w; break; }
        }
        check('there is a width where exactly one auto shortcut fits',
            boundary !== null, boundary === null ? 'none found' : `${boundary}px`);
        if (boundary !== null) {
            let s4 = await state(page);
            check('at that width priority gives the place to Browse',
                s4.browse && !s4.tour, JSON.stringify(s4));
            await page.evaluate(() => window.appearance.setShortcutPriority(['tour', 'browse', 'formula']));
            await settle(page);
            s4 = await state(page);
            check('promoting Tour flips which one survives',
                s4.tour && !s4.browse, JSON.stringify(s4));
        }
        await ctx.close();

        console.log('5. A changing status badge re-decides, in both directions');
        // "ready" -> "loading ClojureScript…" widens the badge and takes room
        // from the shortcuts; going back must give it up again. Neither is a
        // resize, so nothing else would trigger a refit.
        ({ ctx, page } = await open(412, 915));
        let s5 = await state(page);
        check('both fit while the badge is short', s5.browse && s5.tour, JSON.stringify(s5));
        await page.evaluate(() => {
            const badge = document.getElementById('status-badge');
            badge.dataset.originalText = badge.textContent;
            badge.textContent = 'loading ClojureScript…';
        });
        await settle(page);
        s5 = await state(page);
        // Only that a shortcut stood down. A status this long can exceed the
        // header even with every optional button gone, and the fitter is not
        // allowed to hide Search, Menu or Help to fix that.
        check('a longer status stands a shortcut down without a resize',
            !(s5.browse && s5.tour), JSON.stringify(s5));
        await page.evaluate(() => {
            const badge = document.getElementById('status-badge');
            badge.textContent = badge.dataset.originalText || 'ready';
        });
        await settle(page);
        s5 = await state(page);
        check('and shrinking it back brings the shortcut back',
            s5.browse && s5.tour, JSON.stringify(s5));
        await ctx.close();

        console.log('6. The settings list is reachable and keeps focus');
        ({ ctx, page } = await open(412, 915));
        await page.click('#menu-btn');
        await page.click('#btn-appearance');
        const a11y = await page.evaluate(() => {
            const host = document.getElementById('appearance-shortcut-list');
            const rows = [...host.querySelectorAll('.appearance-shortcut-row')];
            const selects = [...host.querySelectorAll('select')];
            const arrows = [...host.querySelectorAll('.appearance-shortcut-move')];
            return {
                everySelectLabelled: selects.every((s) => {
                    const lab = host.querySelector(`label[for="${s.id}"]`);
                    return !!lab && lab.textContent.trim().length > 0;
                }),
                arrowNames: arrows.map((b) => b.getAttribute('aria-label')),
                distinctArrowNames: new Set(arrows.map((b) => b.getAttribute('aria-label'))).size,
                arrowCount: arrows.length,
                rowsHaveGroupName: rows.every((r) => (r.getAttribute('aria-label') || '').length > 0),
                smallestTarget: Math.min(...arrows.map((b) => {
                    const r = b.getBoundingClientRect();
                    return Math.min(r.width, r.height);
                })),
            };
        });
        check('every mode select has a real <label for>', a11y.everySelectLabelled);
        check('each arrow names its own shortcut, so they are distinguishable',
            a11y.distinctArrowNames === a11y.arrowCount, a11y.arrowNames.join(' | '));
        check('each row carries its shortcut as a group name', a11y.rowsHaveGroupName);
        check('arrow touch targets are at least 44px', a11y.smallestTarget >= 44, String(a11y.smallestTarget));

        const focusKept = await page.evaluate(async () => {
            const host = document.getElementById('appearance-shortcut-list');
            const select = host.querySelector('select');
            const name = select.dataset.shortcut;
            select.focus();
            select.value = 'always';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((r) => requestAnimationFrame(r));
            const now = document.activeElement;
            return { inside: host.contains(now), sameShortcut: now && now.dataset.shortcut === name,
                     onBody: now === document.body };
        });
        check('changing a mode does not throw focus out of the dialog',
            focusKept.inside && !focusKept.onBody, JSON.stringify(focusKept));
        check('focus returns to the same shortcut row', focusKept.sameShortcut, JSON.stringify(focusKept));
        await ctx.close();

        console.log('7. The settings row stays readable on a narrow phone');
        ({ ctx, page } = await open(320, 915));
        await page.click('#menu-btn');
        await page.click('#btn-appearance');
        const narrow = await page.evaluate(() => {
            const host = document.getElementById('appearance-shortcut-list');
            const row = host.querySelector('.appearance-shortcut-row');
            const select = row.querySelector('select');
            const rowW = row.getBoundingClientRect().width;
            const selW = select.getBoundingClientRect().width;
            return { rowW: Math.round(rowW), selW: Math.round(selW), ratio: selW / rowW,
                     stacked: getComputedStyle(row).gridTemplateAreas.includes('name') };
        });
        check('the mode select gets the full row width at 320px',
            narrow.ratio > 0.9, JSON.stringify(narrow));
        await ctx.close();

        console.log('8. Legacy on/off values keep meaning what the user chose');
        ({ ctx, page } = await open(800, 400), await 0);
        await page.evaluate(() => {
            localStorage.setItem('scirepl_appearance_show_browse_shortcut', '0');
            localStorage.setItem('scirepl_appearance_show_tour_shortcut', '1');
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__SCIREPL_APP_READY === true, null, { timeout: TIMEOUT });
        const modes = await page.evaluate(() => ({
            browse: window.appearance.getShortcutMode('browse'),
            tour: window.appearance.getShortcutMode('tour'),
        }));
        check("a stored '0' still reads as never", modes.browse === 'never', modes.browse);
        check("a stored '1' still reads as always", modes.tour === 'always', modes.tour);
        await ctx.close();

        console.log(`\nResults: ${count} checks`);
        console.log(allPassed ? 'PASS: All header shortcut tests passed!' : 'FAIL: Some tests failed');
    } catch (err) {
        console.error('FATAL:', err.message);
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
