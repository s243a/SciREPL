// Playwright test: first-run onboarding tour.
//   node server.js   then   node test_onboarding.mjs
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/index.html`;
const PRIVACY_REVISION = '2026-08-catalog-sources-v1';
let failures = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 160) : ''}`);
};

const browser = await chromium.launch({ headless: true });

/** A page that has accepted privacy but never seen the tour. */
async function firstRunPage() {
    const ctx = await browser.newContext();
    await ctx.addInitScript((revision) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision', revision);
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    }, PRIVACY_REVISION);
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

    const languageName = await page.evaluate(() => {
        const select = document.getElementById('tour-language-select');
        const label = select?.labels?.[0];
        return {
            labelFor: label?.htmlFor,
            label: label?.textContent,
            want: window.t('whatsNew.displayLanguage'),
        };
    });
    check('the Tour display-language picker has a real translated label',
        languageName.labelFor === 'tour-language-select'
        && languageName.label === languageName.want,
    JSON.stringify(languageName));

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
    check('the Tour language picker label re-renders in the selected locale',
        await page.evaluate(() => {
            const select = document.getElementById('tour-language-select');
            const label = select?.labels?.[0];
            return label?.textContent === window.t('whatsNew.displayLanguage')
                && label.textContent !== 'Display language';
        }));
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
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
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
    await emptyCtx.addInitScript((revision) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision', revision);
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.setItem('scirepl_session_v2', JSON.stringify({ cells: [], history: [] }));
        localStorage.removeItem('scirepl_onboarding_seen');
    }, PRIVACY_REVISION);
    const emptyPage = await emptyCtx.newPage();
    await emptyPage.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await emptyPage.waitForTimeout(2000);
    check('an empty session still counts as a new user',
        await emptyPage.evaluate(() => !!document.getElementById('tour-overlay')));
    await emptyCtx.close();

    // Menu-created preferences (default programming language, installed
    // packages, notebook-VFS settings) all count as prior use, per Sol.
    for (const [name, key, val] of [
        ['a chosen default language', 'scirepl_default_language', 'prolog'],
        ['installed packages', 'scirepl_installed_packages', '["numpy"]'],
        ['notebook VFS settings', 'scirepl_nbvfs_settings', '{}'],
        ['a saved export format', 'scirepl_export_format', 'pdf'],
    ]) {
        const ctx = await browser.newContext();
        await ctx.addInitScript((kv) => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem(kv.key, kv.val);
        }, { key, val });
        const pg = await ctx.newPage();
        await pg.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await pg.waitForTimeout(1600);
        check(`${name} grandfathers the user`,
            await pg.evaluate(() => localStorage.getItem('scirepl_onboarding_seen') === 'grandfathered'));
        await ctx.close();
    }

    console.log('\n7. Consent and the tour');

    // A legacy boolean records consent to the old policy, but it does not
    // authorise the newly disclosed runtime-metadata request. Re-consent must
    // outrank the tour just like the original privacy dialog.
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_privacy_accepted_revision');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const p2 = await ctx2.newPage();
    await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await p2.waitForTimeout(2200);
    check('a first-run user sees the tour with only legacy consent',
        await p2.evaluate(() => !!document.getElementById('tour-overlay')));
    check('legacy consent is not current consent for runtime metadata',
        await p2.evaluate(() => window.kernelManager.hasCurrentPrivacyConsent() === false));

    await p2.evaluate(() => {
        window.__reconsent = window.kernelManager._ensurePrivacyConsent({
            requireCurrentRevision: true,
        });
    });
    await p2.waitForSelector('#privacy-modal:not(.hidden)');
    check('the tour hides itself while revised consent is up',
        await p2.evaluate(() => {
            const t = document.getElementById('tour-overlay');
            return !t || getComputedStyle(t).display === 'none';
        }));
    check('the consent dialog is the thing on screen',
        await p2.evaluate(() => !document.getElementById('privacy-modal')
            .classList.contains('hidden')));

    await p2.click('#privacy-accept-btn');
    await p2.evaluate(() => window.__reconsent);
    check('accepting revised consent stores the exact policy revision',
        await p2.evaluate((revision) =>
            localStorage.getItem('scirepl_privacy_accepted_revision') === revision,
        PRIVACY_REVISION));
    await p2.waitForTimeout(900);
    check('the tour comes back once revised consent has been dealt with',
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

    /* --------------- replay stays subordinate to dialogs ---------------- */
    console.log('\n12. Replayed tours respect blocking dialogs');

    for (const seed of ['seen', 'grandfathered']) {
        const ctx = await browser.newContext();
        await ctx.addInitScript((sd) => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_auto_download', '1');
            if (sd === 'seen') localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => localStorage.setItem(
                'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
            if (sd === 'grandfathered') {
                localStorage.setItem('scirepl_session_v2', JSON.stringify({
                    cells: [{ id: 1, language: 'python', code: 'x' }], history: [],
                }));
            }
        }, seed);
        const pg = await ctx.newPage();
        await pg.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await pg.waitForFunction(() => window.onboarding, null, { timeout: 30_000 });
        await pg.waitForTimeout(1600);
        await pg.evaluate(() => window.onboarding.start());
        await pg.waitForTimeout(200);
        check(`replay starts for a ${seed} user`,
            await pg.evaluate(() => {
                const t = document.getElementById('tour-overlay');
                return !!t && getComputedStyle(t).display !== 'none';
            }));
        await pg.evaluate(() => document.getElementById('runtime-download-modal').classList.remove('hidden'));
        await pg.waitForTimeout(300);
        check(`a runtime dialog hides the replayed tour (${seed})`,
            await pg.evaluate(() => {
                const t = document.getElementById('tour-overlay');
                return !t || getComputedStyle(t).display === 'none';
            }));
        await ctx.close();
    }

    /* --------- focus lands on visible controls, not hidden menus -------- */
    console.log('\n13. Focus never lands inside a hidden menu');

    const ctxF = await browser.newContext();
    await ctxF.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    });
    const pf = await ctxF.newPage();
    await pf.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pf.waitForFunction(() => window.appearance, null, { timeout: 30_000 });
    await pf.waitForTimeout(600);
    // Open Appearance from the menu, then close: focus must not return into the
    // now-hidden menu (btn-appearance), which is inert.
    await pf.evaluate(() => document.getElementById('menu-btn').click());
    await pf.waitForTimeout(120);
    await pf.evaluate(() => document.getElementById('btn-appearance').click());
    await pf.waitForTimeout(200);
    await pf.keyboard.press('Escape');
    await pf.waitForTimeout(200);
    const focusAfter = await pf.evaluate(() => {
        const a = document.activeElement;
        return {
            id: a ? a.id : null,
            inHiddenMenu: !!(a && a.closest && a.closest('#menu-modal.hidden')),
            isMenuBtn: a === document.getElementById('menu-btn'),
        };
    });
    check('focus does not return into the hidden menu', focusAfter.inHiddenMenu === false,
        JSON.stringify(focusAfter));
    check('focus lands on the visible menu button', focusAfter.isMenuBtn === true,
        JSON.stringify(focusAfter));

    // Hidden modals are inert: their descendants are not focusable.
    check('a hidden modal is inert',
        await pf.evaluate(() => document.getElementById('menu-modal').inert === true));
    await ctxF.close();

    /* --------- language select keeps focus after re-render ------------- */
    console.log('\n14. Language change keeps focus on the selector');

    const ctxL = await browser.newContext();
    await ctxL.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const pl = await ctxL.newPage();
    await pl.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pl.waitForFunction(() => window.onboarding && window.i18n, null, { timeout: 30_000 });
    await pl.waitForTimeout(2200);
    // Make a draft reviewable so the picker offers a second option to switch to.
    await pl.evaluate(async () => {
        await window.i18n.load('es');
        const es = window.i18n.LOCALES.find((l) => l.code === 'es');
        if (es) { es.status = 'reviewed'; es.completeness = 1; }
        if (window.i18n.catalogues.es) window.i18n.catalogues.es.__status = 'reviewed';
        window.i18n.completeness.es = 1;
        window.onboarding.start();
    });
    await pl.waitForTimeout(200);
    await pl.selectOption('#tour-language-select', 'es');
    await pl.waitForTimeout(400);
    const langFocus = await pl.evaluate(() => {
        const a = document.activeElement;
        return { isSelect: a && a.id === 'tour-language-select', notBody: a !== document.body };
    });
    check('focus stays on the language selector after it re-renders',
        langFocus.isSelect === true, JSON.stringify(langFocus));
    check('focus does not fall to <body>', langFocus.notBody === true);
    await ctxL.close();

    /* ---------- cards fit a keyboard-shrunken visual viewport ---------- */
    console.log('\n15. Cards fit the visual viewport, not just the layout one');

    for (const dims of [{ w: 320, h: 180, off: 0 }, { w: 320, h: 120, off: 0 },
                        { w: 360, h: 200, off: 120 }]) {
        const ctx = await browser.newContext({ viewport: { width: 400, height: 640 } });
        await ctx.addInitScript((d) => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.removeItem('scirepl_onboarding_seen');
            // Emulate the on-screen keyboard shrinking the visual viewport below
            // the layout viewport — which window.innerHeight does not reflect.
            const fake = {
                width: d.w, height: d.h, offsetLeft: 0, offsetTop: d.off,
                addEventListener() {}, removeEventListener() {},
            };
            Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
        }, dims);
        const pg = await ctx.newPage();
        await pg.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await pg.waitForFunction(() => window.onboarding, null, { timeout: 30_000 });
        await pg.waitForTimeout(1800);
        await pg.evaluate(() => window.onboarding.start());
        await pg.waitForTimeout(200);
        const total = await pg.evaluate(() => window.onboarding.steps.length);
        const overflow = [];
        for (let i = 0; i < total; i++) {
            const rr = await pg.evaluate((d) => {
                const c = document.getElementById('tour-card').getBoundingClientRect();
                // Bounds are checked against the VISUAL viewport region, per Sol.
                const within = c.left >= -1 && c.top >= d.off - 1
                    && c.right <= d.w + 1 && c.bottom <= d.off + d.h + 1;
                return { step: window.onboarding.index, within };
            }, dims);
            if (!rr.within) overflow.push(rr);
            await pg.keyboard.press('ArrowRight');
            await pg.waitForTimeout(150);
        }
        check(`every card fits a ${dims.w}x${dims.h} visual viewport (offset ${dims.off})`,
            overflow.length === 0, JSON.stringify(overflow));
        await ctx.close();
    }

    /* ------- closing the tour during locale activation is safe --------- */
    console.log('\n16. Escape/Skip/restart during a delayed locale activation');

    const ctxR = await browser.newContext();
    await ctxR.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const pr = await ctxR.newPage();
    const pageErrs = [];
    pr.on('pageerror', (e) => pageErrs.push(e.message));
    await pr.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pr.waitForFunction(() => window.onboarding && window.i18n, null, { timeout: 30_000 });
    await pr.waitForTimeout(2200);

    for (const closeVia of ['escape', 'skip', 'restart']) {
        const threw = await pr.evaluate(async (how) => {
            const before = window.__err ? window.__err.length : 0;
            window.__err = window.__err || [];
            window.addEventListener('error', (e) => window.__err.push(e.message), { once: true });

            window.onboarding.start();
            const sel = document.getElementById('tour-language-select');
            // Make activate() slow so the close lands mid-flight.
            const realActivate = window.i18n.activate.bind(window.i18n);
            window.i18n.activate = (c) => new Promise((res) => setTimeout(() =>
                realActivate(c).then(res), 250));
            sel.value = 'es';
            const changePromise = sel.dispatchEvent(new Event('change'));
            // Immediately close/restart, before activate resolves.
            if (how === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            else if (how === 'skip') window.onboarding.finish();
            else window.onboarding.start();
            await new Promise((r) => setTimeout(r, 500));
            window.i18n.activate = realActivate;
            return (window.__err.length - before) > 0;
        }, closeVia);
        check(`closing the tour via ${closeVia} mid-activation does not throw`, threw === false);
    }
    check('no uncaught page errors from the activation race',
        pageErrs.filter((m) => /querySelector|null/.test(m)).length === 0,
        pageErrs.slice(0, 2).join(' | '));
    await ctxR.close();

    /* ------- two quick language changes: only the newest wins ---------- */
    console.log('\n17. Rapid language changes do not fight over focus');

    const ctxT = await browser.newContext();
    await ctxT.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.removeItem('scirepl_onboarding_seen');
    });
    const pt = await ctxT.newPage();
    const tErrs = [];
    pt.on('pageerror', (e) => tErrs.push(e.message));
    await pt.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await pt.waitForFunction(() => window.onboarding && window.i18n, null, { timeout: 30_000 });
    await pt.waitForTimeout(2200);

    const race = await pt.evaluate(async () => {
        for (const code of ['es', 'fr']) {
            await window.i18n.load(code);
            const l = window.i18n.LOCALES.find((x) => x.code === code);
            if (l) { l.status = 'reviewed'; l.completeness = 1; }
            if (window.i18n.catalogues[code]) window.i18n.catalogues[code].__status = 'reviewed';
            window.i18n.completeness[code] = 1;
        }
        window.onboarding.start();
        const sel = document.getElementById('tour-language-select');
        // Two quick changes. The tour text must end consistent with the locale
        // that actually won (i18n.current) — never a stale mismatch — and the
        // stale change handler must not steal focus back to the selector.
        const realA = window.i18n.activate.bind(window.i18n);
        window.i18n.activate = (code) =>
            new Promise((res) => setTimeout(() => realA(code).then(res), 120));
        sel.value = 'es'; sel.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 20));
        sel.value = 'fr'; sel.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 600));
        window.i18n.activate = realA;
        const title = document.getElementById('tour-title');
        const active = document.activeElement;
        return {
            titleMatchesCurrent: !!title && title.textContent === window.t('tour.language.title'),
            current: window.i18n.current,
            lang: document.documentElement.getAttribute('lang'),
            focusStolen: !!active && active.id === 'tour-language-select'
                && window.__afterHandlers === true,
        };
    });
    check('the tour text ends consistent with the winning locale',
        race.titleMatchesCurrent === true, JSON.stringify(race));
    check('the DOM language matches the winning locale', race.lang === race.current);
    check('no page error from the rapid language race', tErrs.length === 0,
        tErrs.slice(0, 2).join(' | '));

    // Restarting the tour during a slow activation must re-render the fresh tour
    // in the active locale and not have the stale handler steal its focus.
    const restart = await pt.evaluate(async () => {
        window.onboarding.finish();
        window.onboarding.start();
        const sel = document.getElementById('tour-language-select');
        const realA = window.i18n.activate.bind(window.i18n);
        window.i18n.activate = (code) => new Promise((res) => setTimeout(() => realA(code).then(res), 300));
        sel.value = 'es'; sel.dispatchEvent(new Event('change'));  // slow es activation begins
        await new Promise((r) => setTimeout(r, 30));
        window.onboarding.start();          // restart mid-activation
        await new Promise((r) => setTimeout(r, 600));  // es completes -> i18n:changed
        window.i18n.activate = realA;
        const overlay = document.getElementById('tour-overlay');
        const title = document.getElementById('tour-title');
        return {
            oneOverlay: document.querySelectorAll('#tour-overlay').length === 1,
            focusInTour: !!overlay && overlay.contains(document.activeElement),
            current: window.i18n.current,
            titleText: title ? title.textContent : '',
            expected: window.t('tour.language.title'),
        };
    });
    check('restart during activation leaves exactly one tour', restart.oneOverlay === true);
    check('the stale handler does not yank focus out of the restarted tour',
        restart.focusInTour === true);
    // The replacement tour must re-render in the locale the pending activation
    // settled on, not stay stale.
    check('the restarted tour re-renders in the completed locale',
        restart.current === 'es' && restart.titleText === restart.expected,
        JSON.stringify({ current: restart.current, title: restart.titleText }));
    await ctxT.close();

} catch (err) {
    failures++;
    console.log(`\n  [FAIL] crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: All onboarding tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
