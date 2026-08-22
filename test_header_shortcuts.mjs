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
        return { ctx, page };
    };

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
        await page.waitForTimeout(400);
        s = await state(page);
        check('rotating to a narrow viewport stands them down',
            !s.browse && !s.tour && s.rows === 1, JSON.stringify(s));
        await page.setViewportSize({ width: 800, height: 400 });
        await page.waitForTimeout(400);
        s = await state(page);
        check('rotating back brings them straight back', s.browse && s.tour, JSON.stringify(s));
        await ctx.close();

        console.log('3. always and never are settings, not measurements');
        ({ ctx, page } = await open(320, 640));
        await page.evaluate(() => window.appearance.setShortcutMode('browse', 'always'));
        await page.waitForTimeout(200);
        s = await state(page);
        check('always keeps Browse even where there is no room',
            s.browse, JSON.stringify(s));
        check('and the header is allowed to wrap to make space', s.rows === 2, JSON.stringify(s));
        await page.evaluate(() => window.appearance.setShortcutMode('browse', 'never'));
        await page.waitForTimeout(200);
        s = await state(page);
        check('never hides it even where there is plenty of room', !s.browse);
        await ctx.close();

        ({ ctx, page } = await open(800, 400));
        await page.evaluate(() => window.appearance.setShortcutMode('browse', 'never'));
        await page.waitForTimeout(200);
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
            await page.waitForTimeout(120);
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
            await page.waitForTimeout(300);
            s4 = await state(page);
            check('promoting Tour flips which one survives',
                s4.tour && !s4.browse, JSON.stringify(s4));
        }
        await ctx.close();

        console.log('5. Legacy on/off values keep meaning what the user chose');
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
