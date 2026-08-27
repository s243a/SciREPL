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

    // Settling has two parts, and conflating them is what made this flaky.
    //
    // FIRST the app must reach its terminal startup state: the badge className
    // says "ready" (exact, locale-independent) AND localization has actually
    // finished. The latter must be i18n's own init() promise — the badge keeps
    // its untranslated "loading…" fallback TEXT after its className has already
    // flipped to "ready", so "class is ready and the text is nonempty" accepts
    // a header that i18n is still about to relabel, which moves the layout
    // after the assertion has read it. No inferring readiness from visible
    // text, and no sleeps.
    //
    // THEN wait for layout to stop moving, since the fitter itself runs on a
    // frame.
    const terminal = (page) => page.waitForFunction(async () => {
        if (window.__SCIREPL_APP_READY !== true) return false;
        // A localization initialization failure must FAIL the run loudly, not
        // quietly degrade into measuring an untranslated header.
        if (window.i18n && window.i18n.init) await window.i18n.init();
        const badge = document.getElementById('status-badge');
        return !!badge && badge.className === 'ready';
    }, null, { timeout: 60_000 });

    const frames = (page) => page.waitForFunction(() => new Promise((resolve) => {
        const signature = () => {
            const bar = document.querySelector('.header-right');
            if (!bar) return 'none';
            return [...bar.children].map((el) => [
                el.id || el.className,
                el.classList.contains('header-shortcut-hidden') ? 0 : 1,
                Math.round(el.getBoundingClientRect().width),
            ].join(':')).join('|') + '#' + Math.round(bar.getBoundingClientRect().height)
              + '#' + (document.getElementById('status-badge') || {}).className;
        };
        const before = signature();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(signature() === before)));
    }), null, { timeout: 30_000 });

    const settle = async (page) => { await terminal(page); await frames(page); };

    const hitTest = (page) => page.evaluate(() => {
        const header = document.getElementById('app-header');
        const bad = [];
        for (const el of header.querySelectorAll('button, select')) {
            const box = el.getBoundingClientRect();
            if (box.width <= 0) continue;
            const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!(at === el || el.contains(at))) {
                bad.push(`${el.id || el.className}→${(at && (at.id || at.className)) || 'null'}`);
            }
        }
        const selector = document.getElementById('notebook-selector-container');
        return {
            misHits: bad,
            controls: selector.querySelectorAll('button, select').length,
            selectorW: Math.round(selector.getBoundingClientRect().width),
        };
    });
    const addNotebook = (page, name) =>
        page.evaluate((n) => window.notebookManager.createNotebook({ name: n }), name);
    const dropped = (page) => page.evaluate(() =>
        document.querySelector('.header-right').dataset.shortcutsDropped);

    // Fit-pass instrumentation for the quiescence and delivery checks: count
    // every _fitHeaderShortcuts() call without changing what it does.
    const instrument = (page) => page.evaluate(() => {
        const m = window.appearance;
        if (!m.__origFit) {
            m.__origFit = m._fitHeaderShortcuts.bind(m);
            m._fitHeaderShortcuts = (...a) => { m.__fitCount += 1; return m.__origFit(...a); };
        }
        m.__fitCount = 0;
    });
    const resetFits = (page) => page.evaluate(() => { window.appearance.__fitCount = 0; });
    const readFits = (page) => page.evaluate(() => window.appearance.__fitCount);
    const fitsOver = (page, frames) => page.evaluate((n) => new Promise((resolve) => {
        const start = window.appearance.__fitCount;
        let i = 0;
        const step = () => (++i >= n)
            ? resolve(window.appearance.__fitCount - start)
            : requestAnimationFrame(step);
        requestAnimationFrame(step);
    }), frames);
    // A bounded pass straight after a change is legitimate (the selector's size
    // observer reports the width the fit itself gave back); drain those frames
    // so the measurement window that follows must be COMPLETELY silent.
    const drainFrames = (page) => page.evaluate(() => new Promise((resolve) => {
        let i = 0;
        const step = () => (++i >= 10) ? resolve() : requestAnimationFrame(step);
        requestAnimationFrame(step);
    }));

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
        // Explicitly a ONE-NOTEBOOK measurement: section 9 shows the same width
        // holds fewer shortcuts once the selector is populated, so this must not
        // be read as "412px is always enough".
        check('412px with a single notebook: both auto shortcuts fit, still one row',
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

        console.log('8. The fitter goes quiet once the header is settled');
        // Round 3: re-observing the ResizeObserver target after every pass
        // scheduled a fresh INITIAL delivery, which queued another pass —
        // about 60 complete fits per second on an idle page, forever. The
        // observers now stay attached, so once the header has settled nothing
        // may run until a real change arrives.
        ({ ctx, page } = await open(412, 915));
        await instrument(page);
        await drainFrames(page);
        await resetFits(page);
        let idleFits = await fitsOver(page, 30);
        check('one notebook: zero fit passes across 30 idle frames',
            idleFits === 0, `fits=${idleFits}`);
        await addNotebook(page, 'Quiescence 2');
        await settle(page);
        const afterMutation = await readFits(page);
        check('a real selector mutation reaches the fitter',
            afterMutation > 0, `fits=${afterMutation}`);
        await drainFrames(page);
        await resetFits(page);
        idleFits = await fitsOver(page, 30);
        check('two notebooks: quiet again once the change is handled',
            idleFits === 0, `fits=${idleFits}`);
        await page.setViewportSize({ width: 800, height: 400 });
        await settle(page);
        const afterResize = await readFits(page);
        check('a real resize reaches the fitter', afterResize > 0, `fits=${afterResize}`);
        await drainFrames(page);
        await resetFits(page);
        idleFits = await fitsOver(page, 30);
        check('and it goes quiet after the resize too', idleFits === 0, `fits=${idleFits}`);
        await ctx.close();

        console.log('9. A populated notebook selector counts as "no room"');
        // The selector is a flex sibling that gets squeezed as the right group
        // grows: its buttons keep their size and overflow, so their centres
        // hit-test to Search/Tour instead of themselves. Nothing resizes, so
        // only a content observer notices — and dropping auto candidates is
        // what gives the selector its width back. At these widths BOTH default
        // candidates must stand down (measured `shortcutsDropped="2"`); round 2
        // wrongly claimed one, behind an assertion that could never fail.
        for (const width of [411, 412, 430]) {
            ({ ctx, page } = await open(width, 915));
            const before = await state(page);
            const droppedBefore = await dropped(page);
            check(`${width}px, one notebook: Browse and Tour both fit, none dropped`,
                before.browse && before.tour && droppedBefore === '0',
                JSON.stringify({ ...before, dropped: droppedBefore }));
            await addNotebook(page, `Second ${width}`);
            await settle(page);                       // no resize: the fitter must react to content
            const hits = await hitTest(page);
            const after = await state(page);
            const droppedAfter = await dropped(page);
            check(`${width}px + 2 notebooks: both auto candidates stand down`,
                !after.browse && !after.tour && droppedAfter === '2',
                JSON.stringify({ ...after, dropped: droppedAfter }));
            check(`${width}px + 2 notebooks: the selector shows its 4 controls`,
                hits.controls === 4, JSON.stringify(hits));
            check(`${width}px + 2 notebooks: every header control hits itself`,
                hits.misHits.length === 0, JSON.stringify(hits));

            // ...and removal must restore the EXACT starting state, not merely
            // one remembered boolean.
            await page.evaluate(() => {
                const list = window.notebookManager.getNotebooks();
                const id = list.length > 1 ? list[list.length - 1].id : null;
                if (!id) throw new Error('expected a second notebook to remove');
                window.notebookManager.removeNotebook(id);
            });
            await settle(page);
            const restored = await state(page);
            const droppedRestored = await dropped(page);
            check(`${width}px: removal restores the exact starting state`,
                restored.browse === before.browse && restored.tour === before.tour
                    && droppedRestored === '0',
                JSON.stringify({ ...restored, dropped: droppedRestored }));
            await ctx.close();
        }

        console.log('10. Renaming re-runs the fitter, and RTL is not assumed left-to-right');
        // The selector draws a short and a long name at identical widths, so a
        // rename cannot prove width growth here — round 2 claimed it did. What
        // it MUST prove is delivery: the rerender reaches the fitter through
        // the content observer, and the header stays fully hittable after it.
        ({ ctx, page } = await open(412, 915));
        await addNotebook(page, 'N2');
        await settle(page);
        await instrument(page);
        await drainFrames(page);
        await resetFits(page);
        await page.evaluate(() => {
            const list = window.notebookManager.getNotebooks();
            const id = list.length ? list[list.length - 1].id : null;
            if (!id) throw new Error('expected a notebook to rename');
            window.notebookManager.renameNotebook(id,
                'A considerably longer notebook name than before');
        });
        await settle(page);
        const renameFits = await readFits(page);
        check('a rename reaches the fitter through the content observer',
            renameFits > 0, `fits=${renameFits}`);
        const renamed = await hitTest(page);
        check('and every control stays hittable after the rename',
            renamed.misHits.length === 0, JSON.stringify(renamed));
        await ctx.close();

        ({ ctx, page } = await open(412, 915));
        // A real RTL locale, awaited to completion — assigning
        // documentElement.dir directly can be overwritten by localization that
        // has not finished, which is exactly the race terminal() exists for.
        await page.evaluate(() => window.i18n.activate('ar'));
        await settle(page);
        const dirNow = await page.evaluate(() => document.documentElement.getAttribute('dir'));
        check('activating Arabic really flips the document to RTL',
            dirNow === 'rtl', String(dirNow));
        await addNotebook(page, 'RTL second');
        await settle(page);
        const rtl = await hitTest(page);
        check('RTL: the groups swap sides and controls still hit themselves',
            rtl.misHits.length === 0, JSON.stringify(rtl));
        await ctx.close();

        console.log('11. The first-run control is readable in long locales and RTL');
        // The onboarding select shares the tour card with its label. On a 320px
        // first run the French value ("Quand il y a de la place") needs more
        // width than a shared row leaves it, so the selected mode was clipped —
        // and an unstyled native select is only about 19px high.
        //
        // Round 4 made this section AUTHORITATIVE. The old version measured as
        // soon as #tour-show-shortcut existed, which is before localization:
        // with i18n fetches delayed it happily measured the raw key
        // 'appearance.shortcutAuto' in an English document and called that
        // French. It also bounded the select against
        // `.tour-panel, #tour-overlay, body` — `.tour-panel` does not exist, so
        // the "panel" was the full-screen overlay and containment was vacuous.
        // Now: await i18n.init() (a rejection FAILS the run), wait for the
        // requested locale to actually be active, assert the hard-coded
        // localized value, and bound against the real #tour-card in both axes.
        //
        // Geometry: the card is NOT capped at the stylesheet's 340px —
        // onboarding's _position() sets an inline max-width of viewport minus
        // 16px, so the card grows with the window (304px at 320, 584px at 600).
        // The clipping risk was always the SHARED LINE giving the select only
        // what the label left; stacked, the select gets the full card width at
        // every viewport.
        const LOCALIZED_AUTO = {
            fr: 'Quand il y a de la place',
            es: 'Cuando haya espacio',
            ar: 'عند توفر مساحة',
        };
        const firstRunBox = async (width, locale, routeDelayMs) => {
            const first = await browser.newContext({ viewport: { width, height: 915 } });
            if (routeDelayMs) {
                await first.route('**/i18n/**', async (route) => {
                    await new Promise((r) => setTimeout(r, routeDelayMs));
                    await route.continue();
                });
            }
            await first.addInitScript((loc) => {
                localStorage.setItem('scirepl_privacy_accepted', '1');
                localStorage.setItem('scirepl_language', loc);
            }, locale);
            const fp = await first.newPage();
            await fp.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await fp.waitForSelector('#tour-show-shortcut', { timeout: TIMEOUT });
            // What the OLD test measured: the select exists before localization.
            const early = await fp.evaluate(() => {
                const select = document.getElementById('tour-show-shortcut');
                return { text: select.options[select.selectedIndex].textContent,
                         lang: document.documentElement.lang };
            });
            // Localization readiness — an init() rejection fails the run.
            await fp.evaluate(() => window.i18n.init());
            await fp.waitForFunction((loc) => document.documentElement.lang === loc,
                locale, { timeout: TIMEOUT });
            const box = await fp.evaluate(() => {
                const select = document.getElementById('tour-show-shortcut');
                const card = select.closest('#tour-card');
                const rect = select.getBoundingClientRect();
                const style = getComputedStyle(select);
                // Measure the chosen option the way the browser will draw it.
                const canvas = document.createElement('canvas').getContext('2d');
                canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                const text = select.options[select.selectedIndex].textContent;
                const padding = parseFloat(style.paddingInlineStart || 0)
                    + parseFloat(style.paddingInlineEnd || 0);
                const c = card ? card.getBoundingClientRect() : null;
                return {
                    text,
                    lang: document.documentElement.lang,
                    needs: Math.ceil(canvas.measureText(text).width + padding + 24),
                    has: Math.round(rect.width),
                    height: Math.round(rect.height),
                    cardFound: !!card,
                    cardW: c && Math.round(c.width),
                    withinCard: !!c
                        && rect.left >= c.left - 1 && rect.right <= c.right + 1
                        && rect.top >= c.top - 1 && rect.bottom <= c.bottom + 1,
                    dir: document.documentElement.dir || 'ltr',
                };
            });
            await first.close();
            return { early, box };
        };
        for (const [locale, dir] of [['fr', 'ltr'], ['es', 'ltr'], ['ar', 'rtl']]) {
            for (const width of [320, 479, 480, 600]) {
                const { box } = await firstRunBox(width, locale);
                check(`${locale}@${width}px first run: the ${locale} value is really active`,
                    box.lang === locale && box.text === LOCALIZED_AUTO[locale],
                    JSON.stringify({ lang: box.lang, text: box.text }));
                check(`${locale}@${width}px first run: mode fits, comfortable, inside #tour-card`,
                    box.cardFound && box.has >= box.needs && box.height >= 36 && box.withinCard,
                    JSON.stringify(box));
                if (dir === 'rtl' && width === 320) {
                    check('ar first run: the document really is RTL', box.dir === 'rtl', box.dir);
                }
            }
        }

        // Delayed-manifest regression: hold every i18n fetch back 4s. The
        // select exists long before that, showing the raw key in an English
        // document — the exact frame the old test measured and passed on. The
        // authoritative sequence must (a) prove that frame is real and (b)
        // still end up measuring genuine French.
        {
            const { early, box } = await firstRunBox(320, 'fr', 4000);
            check('delayed manifest: the untranslated frame is real (raw key before init)',
                early.text === 'appearance.shortcutAuto' && early.lang !== 'fr',
                JSON.stringify(early));
            check('delayed manifest: the measurement is genuine French, not the raw key',
                box.lang === 'fr' && box.text === LOCALIZED_AUTO.fr && box.withinCard,
                JSON.stringify({ lang: box.lang, text: box.text, withinCard: box.withinCard }));
        }

        console.log('12. Legacy on/off values keep meaning what the user chose');
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
