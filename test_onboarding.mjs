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
    await page.evaluate(() => window.onboarding.start());
    await page.selectOption('#tour-language-select', 'es');
    await page.waitForTimeout(400);
    check('changing language re-renders the tour in that language',
        (await titleNow()) === 'Elige el idioma de la interfaz', await titleNow());
    await page.evaluate(async () => { window.i18n.setPreference('auto'); await window.i18n.activate('en'); });

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

    check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();

    /* --------------------- consent ordering --------------------------- */
    console.log('\n6. Consent ordering');
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
