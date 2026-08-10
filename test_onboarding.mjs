// Playwright test: first-run onboarding tour.
//   node server.js   then   node test_onboarding.mjs
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/index.html`;
let failures = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 160) : ''}`);
};

const browser = await chromium.launch({ headless: true });

/** A page that has accepted privacy but never seen the tour. */
async function firstRunPage() {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p.waitForFunction(() => window.onboarding && window.i18n, null, { timeout: 30_000 });
    return { ctx, page: p, errs };
}

try {
    /* --------------------------- first run --------------------------- */
    console.log('\n1. First run');
    const { ctx, page, errs } = await firstRunPage();
    await page.waitForSelector('#tour-overlay', { timeout: 10_000 });
    check('the tour starts automatically on first run', true);

    const stepCount = await page.evaluate(() => window.onboarding.steps.length);
    check('every step with a visible target is included', stepCount >= 4, `${stepCount} steps`);

    check('it opens on the display-language step',
        await page.evaluate(() => !!document.getElementById('tour-language-select')));

    // The distinction that makes this tour worth having.
    const titles = await page.evaluate(() =>
        window.onboarding.steps.map((s) => window.t(s.titleKey)));
    check('display language and programming language are never called just "language"',
        titles.filter((x) => /language/i.test(x))
            .every((x) => /display language|programming language/i.test(x)),
        JSON.stringify(titles.filter((x) => /language/i.test(x))));

    /* ------------------------- navigation ---------------------------- */
    console.log('\n2. Navigation');
    const titleNow = () => page.evaluate(() => document.getElementById('tour-title').textContent);
    const first = await titleNow();
    await page.click('#tour-next');
    check('Next advances', (await titleNow()) !== first);
    await page.click('#tour-back');
    check('Back returns', (await titleNow()) === first);

    check('a spotlight is positioned over the highlighted control', await page.evaluate(() => {
        document.getElementById('tour-next').click();
        const s = document.getElementById('tour-spotlight');
        const r = s.getBoundingClientRect();
        return s.style.display !== 'none' && r.width > 0 && r.height > 0;
    }));

    /* ------------------- absent targets are illustrated ---------------- */
    console.log('\n3. Cells that do not exist yet');
    const cellSteps = await page.evaluate(() => {
        const ids = window.onboarding.steps.map((s) => s.id);
        return {
            included: ids.includes('editCell') && ids.includes('editCellLanguage'),
            liveCells: document.querySelectorAll('.cell-edit-btn').length,
        };
    });
    check('cell steps still appear on an empty notebook, as illustrations',
        cellSteps.included && cellSteps.liveCells === 0, JSON.stringify(cellSteps));

    check('the tour never fabricates a notebook cell',
        await page.evaluate(() => document.querySelectorAll('.cell-edit-btn').length === 0));

    /* ------------------------ language switch ------------------------- */
    console.log('\n4. Language');
    // The picker only lists locales that are reviewed and complete enough, so
    // with es back to draft after the UI extraction, English is the only real
    // entry. Mark it reviewed in memory to exercise the switching path — the
    // gate itself is covered in test_appearance.
    const offered = await page.evaluate(async () => {
        await window.i18n.load('es');
        const es = window.i18n.LOCALES.find((l) => l.code === 'es');
        if (es) { es.status = 'reviewed'; es.completeness = 1; }
        // statusOf() prefers the status declared inside the catalogue over the
        // manifest entry, so both have to say reviewed.
        if (window.i18n.catalogues.es) window.i18n.catalogues.es.__status = 'reviewed';
        window.i18n.completeness.es = 1;
        return window.i18n.available().map((l) => l.code);
    });
    check('the picker lists only usable locales',
        offered.includes('en') && offered.includes('es'), offered.join(','));

    await page.evaluate(() => window.onboarding.start());
    await page.selectOption('#tour-language-select', 'es');
    await page.waitForTimeout(500);
    check('changing language re-renders the tour in that language',
        (await titleNow()) === 'Elige el idioma de la interfaz', await titleNow());
    await page.evaluate(async () => {
        const es = window.i18n.LOCALES.find((l) => l.code === 'es');
        if (es) { es.status = 'draft'; es.completeness = 0.17; }
        if (window.i18n.catalogues.es) window.i18n.catalogues.es.__status = 'draft';
        window.i18n.setPreference('auto');
        await window.i18n.activate('en');
    });

    /* ---------------------------- finish ------------------------------ */
    console.log('\n5. Finishing');
    await page.evaluate(() => window.onboarding.finish());
    check('finishing removes the overlay',
        await page.evaluate(() => !document.getElementById('tour-overlay')));
    check('finishing records that it has been seen',
        await page.evaluate(() => localStorage.getItem('scirepl_onboarding_seen') === '1'));

    // A fresh context that has already seen the tour. The first-run context
    // cannot be reused here: its addInitScript re-runs on every navigation and
    // would clear the flag again, so a reload there proves nothing.
    const seenCtx = await browser.newContext();
    await seenCtx.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
    });
    const seenPage = await seenCtx.newPage();
    await seenPage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await seenPage.waitForTimeout(1800);
    check('it does not reappear once seen',
        await seenPage.evaluate(() => !document.getElementById('tour-overlay')));
    await seenCtx.close();

    check('Help offers to replay it',
        await page.evaluate(() => !!document.getElementById('btn-show-tour')));
    await page.evaluate(() => document.getElementById('btn-show-tour').click());
    await page.waitForTimeout(400);
    check('replaying from Help works',
        await page.evaluate(() => !!document.getElementById('tour-overlay')));

    // The tour explains where Help is, so an entry only inside Help is circular
    // for exactly the user who needs it. The main menu carries one too.
    const menuReplay = await page.evaluate(async () => {
        localStorage.setItem('scirepl_onboarding_seen', '1');
        document.getElementById('menu-btn').click();
        await new Promise((r) => setTimeout(r, 200));
        const btn = document.getElementById('btn-show-tour-menu');
        if (!btn) return { present: false };
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
        return {
            present: true,
            started: Boolean(document.getElementById('tour-overlay')),
            menuClosed: document.getElementById('menu-modal').classList.contains('hidden'),
        };
    });
    check('the main menu offers the tour, not only Help', menuReplay.present === true);
    check('replaying from the menu works', menuReplay.started === true);
    check('replaying from the menu closes the menu behind it', menuReplay.menuClosed === true);
    await page.evaluate(() => window.onboarding.finish());


    check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();

    /* --------------------- consent ordering --------------------------- */
    /* ---------------- existing installs are grandfathered --------------- */
    console.log('\n6. Upgrading an existing install');

    // Someone who already has saved cells knows where the menu is. Showing them
    // a six-step introduction on upgrade reads as a regression, so the tour is
    // marked seen without being shown — and stays reachable from the menu.
    const upgradeCtx = await browser.newContext();
    await upgradeCtx.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.setItem('scirepl_session_v2', JSON.stringify({
            cells: [{ id: 1, language: 'python', code: 'print(1)' }], history: [],
        }));
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const upgradePage = await upgradeCtx.newPage();
    await upgradePage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await upgradePage.waitForTimeout(1800);
    check('an install with saved work is not interrupted by the tour',
        await upgradePage.evaluate(() => !document.getElementById('tour-overlay')));
    check('grandfathering is recorded distinctly from completing the tour',
        await upgradePage.evaluate(() =>
            localStorage.getItem('scirepl_onboarding_seen')) === 'grandfathered');
    check('the tour is still reachable from the menu after grandfathering',
        await upgradePage.evaluate(() => !!document.getElementById('btn-show-tour-menu')));
    await upgradeCtx.close();

    // Consent alone must not count as "established" — a brand-new user accepts
    // the privacy prompt too, so it cannot tell the two populations apart.
    const emptyCtx = await browser.newContext();
    await emptyCtx.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.setItem('scirepl_session_v2', JSON.stringify({ cells: [], history: [] }));
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const emptyPage = await emptyCtx.newPage();
    await emptyPage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await emptyPage.waitForTimeout(2000);
    check('an empty session still counts as a new user',
        await emptyPage.evaluate(() => !!document.getElementById('tour-overlay')));
    await emptyCtx.close();

    console.log('\n7. Consent and the tour');

    // Consent is requested lazily, and only for runtimes fetched from a CDN —
    // on a build with Python bundled it may never be requested at all. Gating
    // the tour on the accepted flag therefore meant a first-run user never saw
    // it. What matters is that the tour never covers the consent dialog.
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => {
        localStorage.removeItem('scirepl_privacy_accepted');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p2 = await ctx2.newPage();
    await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p2.waitForTimeout(2200);
    check('a first-run user sees the tour even before consent has been asked for',
        await p2.evaluate(() => !!document.getElementById('tour-overlay')));

    // The consent dialog outranks the tour whenever it appears, including
    // part-way through — which is what happens the first time a user runs a
    // cell needing a CDN runtime.
    await p2.evaluate(() => document.getElementById('privacy-modal').classList.remove('hidden'));
    await p2.waitForTimeout(500);
    check('the tour hides itself while the consent dialog is up',
        await p2.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !t || getComputedStyle(t).display === 'none';
        }));
    check('the consent dialog is the thing on screen',
        await p2.evaluate(() => !document.getElementById('privacy-modal')
            .classList.contains('hidden')));

    await p2.evaluate(() => document.getElementById('privacy-modal').classList.add('hidden'));
    await p2.waitForTimeout(900);
    check('the tour comes back once consent has been dealt with',
        await p2.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !!t && getComputedStyle(t).display !== 'none';
        }));
    await ctx2.close();

    /* ------------------------- keyboard and focus ----------------------- */
    console.log('\n8. Keyboard and focus');

    const ctx3 = await browser.newContext();
    await ctx3.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p3 = await ctx3.newPage();
    await p3.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p3.waitForTimeout(2200);

    check('focus moves into the dialog rather than staying behind it',
        await p3.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !!t && t.contains(document.activeElement);
        }));

    // Tab must cycle inside the dialog; escaping it puts focus on controls the
    // overlay is covering, which a keyboard user cannot see.
    for (let i = 0; i < 12; i++) await p3.keyboard.press('Tab');
    check('Tab stays inside the dialog', await p3.evaluate(() => {
        const t = document.getElementById('tour-overlay');
        return !!t && t.contains(document.activeElement);
    }));
    await p3.keyboard.press('Shift+Tab');
    check('Shift+Tab also stays inside', await p3.evaluate(() => {
        const t = document.getElementById('tour-overlay');
        return !!t && t.contains(document.activeElement);
    }));

    await p3.keyboard.press('Escape');
    await p3.waitForTimeout(400);
    check('Escape closes the tour',
        await p3.evaluate(() => !document.getElementById('tour-overlay')));
    check('focus is handed back to the page, not lost on <body>',
        await p3.evaluate(() => document.activeElement
            && document.activeElement !== document.body));
    await ctx3.close();

    /* ------------------------- start is idempotent ---------------------- */
    console.log('\n9. Races: double-start, stray keys, runtime dialog');

    const ctx4 = await browser.newContext();
    await ctx4.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p4 = await ctx4.newPage();
    await p4.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p4.waitForTimeout(2200);

    // Double-start must not stack overlays or listeners.
    await p4.evaluate(() => { window.onboarding.start(); window.onboarding.start(); });
    await p4.waitForTimeout(150);
    check('a second start does not stack a second overlay',
        await p4.evaluate(() => document.querySelectorAll('#tour-overlay').length) === 1);

    // One ArrowRight advances exactly one step — the accumulated-listener bug
    // moved it two. Read the progress counter before and after.
    const step0 = await p4.evaluate(() => window.onboarding.index);
    await p4.keyboard.press('ArrowRight');
    await p4.waitForTimeout(120);
    const step1 = await p4.evaluate(() => window.onboarding.index);
    check('one ArrowRight advances exactly one step', step1 === step0 + 1, `${step0} -> ${step1}`);

    // Even after several start() calls, a keypress still advances one.
    await p4.evaluate(() => { window.onboarding.start(); window.onboarding.start(); window.onboarding.start(); });
    await p4.waitForTimeout(120);
    const a = await p4.evaluate(() => window.onboarding.index);
    await p4.keyboard.press('ArrowRight');
    await p4.waitForTimeout(120);
    const bb = await p4.evaluate(() => window.onboarding.index);
    check('still one step per key after repeated starts', bb === a + 1, `${a} -> ${bb}`);
    await p4.evaluate(() => window.onboarding.finish());
    await ctx4.close();

    // Runtime-download dialog (first R/Prolog run) must also outrank the tour,
    // exactly like the privacy dialog.
    const ctx5 = await browser.newContext();
    await ctx5.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p5 = await ctx5.newPage();
    await p5.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p5.waitForTimeout(2200);
    check('tour is up before the runtime dialog appears',
        await p5.evaluate(() => !!document.getElementById('tour-overlay')));
    await p5.evaluate(() => document.getElementById('runtime-download-modal').classList.remove('hidden'));
    await p5.waitForTimeout(400);
    check('the runtime-download dialog hides the tour',
        await p5.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !t || getComputedStyle(t).display === 'none';
        }));
    check('focus is not left inside the hidden tour',
        await p5.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !t || !t.contains(document.activeElement);
        }));
    await p5.evaluate(() => document.getElementById('runtime-download-modal').classList.add('hidden'));
    await p5.waitForTimeout(700);
    check('the tour returns after the runtime dialog closes',
        await p5.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !!t && getComputedStyle(t).display !== 'none';
        }));
    await ctx5.close();

    /* --------------------- tiny viewport containment -------------------- */
    console.log('\n10. Every card fits a 320x240 viewport');

    const ctxS = await browser.newContext({ viewport: { width: 320, height: 240 } });
    await ctxS.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const pS = await ctxS.newPage();
    await pS.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pS.waitForTimeout(2200);
    await pS.evaluate(() => window.onboarding.start());
    await pS.waitForTimeout(200);

    const overflowByStep = [];
    const total = await pS.evaluate(() => window.onboarding.steps.length);
    for (let i = 0; i < total; i++) {
        const r = await pS.evaluate(() => {
            const card = document.getElementById('tour-card');
            const b = card.getBoundingClientRect();
            return {
                withinX: b.left >= -1 && b.right <= window.innerWidth + 1,
                withinY: b.top >= -1 && b.bottom <= window.innerHeight + 1,
                step: window.onboarding.index,
            };
        });
        overflowByStep.push(r);
        await pS.keyboard.press('ArrowRight');
        await pS.waitForTimeout(180);
    }
    check('no tour card overflows the 320x240 viewport horizontally',
        overflowByStep.every((r) => r.withinX),
        JSON.stringify(overflowByStep.filter((r) => !r.withinX)));
    check('no tour card overflows vertically',
        overflowByStep.every((r) => r.withinY),
        JSON.stringify(overflowByStep.filter((r) => !r.withinY)));
    await ctxS.close();

    /* ---------------- manual start during the 600ms delay --------------- */
    console.log('\n11. Manual start during the first-run delay');

    const ctxD = await browser.newContext();
    await ctxD.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const pD = await ctxD.newPage();
    await pD.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Start manually inside the 600ms auto-start window, then let it elapse.
    await pD.waitForTimeout(150);
    await pD.evaluate(() => window.onboarding.start());
    await pD.waitForTimeout(1200);
    check('a manual start inside the auto-start delay yields one overlay, not two',
        await pD.evaluate(() => document.querySelectorAll('#tour-overlay').length) === 1);
    await ctxD.close();

} catch (err) {
    failures++;
    console.log(`\n  [FAIL] crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: All onboarding tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
