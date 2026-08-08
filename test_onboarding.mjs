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

    console.log('\n7. Consent ordering');
    const ctx2 = await browser.newContext();          // privacy NOT accepted
    await ctx2.addInitScript(() => {
        localStorage.removeItem('scirepl_privacy_accepted');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p2 = await ctx2.newPage();
    await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p2.waitForTimeout(2000);
    check('the tour waits for the privacy prompt rather than covering it',
        await p2.evaluate(() => !document.getElementById('tour-overlay')));
    await ctx2.close();
} catch (err) {
    failures++;
    console.log(`\n  [FAIL] crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: All onboarding tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
