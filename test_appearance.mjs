// Playwright test: Appearance menu — top margin, button scale, theming, localization.
//
// Run the dev server first:  node server.js    (or PORT=8099 node server.js)
//   node test_appearance.mjs
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 60_000;

// .icon-btn carries `transition: all 0.2s`, so a size read taken immediately
// after a change returns the mid-transition value. Everything that measures a
// button waits this out first — the cause of a long false alarm during
// development.
const TRANSITION_MS = 400;

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_auto_download', '1');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(
        () => window.appearance && window.i18n && window.appearanceUI,
        null, { timeout: 30_000 }
    );
    await page.waitForTimeout(1000);

    const headerPad = () => page.evaluate(
        () => parseFloat(getComputedStyle(document.getElementById('app-header')).paddingTop));
    const btnHeight = () => page.evaluate(
        () => Math.round(document.getElementById('menu-btn').getBoundingClientRect().height));

    /* ---------------------------- top margin ---------------------------- */
    console.log('\n1. Top margin');

    check('the header reserves space for the status bar via a CSS variable',
        await page.evaluate(() => getComputedStyle(document.getElementById('app-header'))
            .paddingTop !== ''), '');

    await page.evaluate(() => window.appearance.setTopMargin(40));
    check('an explicit margin is applied', (await headerPad()) === 50, `padding-top ${await headerPad()}`);

    await page.evaluate(() => window.appearance.setTopMargin(0));
    check('zero is honoured', (await headerPad()) === 10, `padding-top ${await headerPad()}`);
    check('zero is distinct from unset',
        await page.evaluate(() => window.appearance.getTopMargin() === 0));

    await page.evaluate(() => window.appearance.setTopMargin(null));
    check('auto can be restored',
        await page.evaluate(() => window.appearance.getTopMargin() === null));
    check('auto resolves through the safe-area inset, not a fixed number',
        await page.evaluate(() => document.documentElement.style
            .getPropertyValue('--app-top-margin').includes('safe-area-inset-top')));

    check('viewport-fit=cover is set, without which the inset is always zero',
        await page.evaluate(() => (document.querySelector('meta[name="viewport"]')
            ?.getAttribute('content') || '').includes('viewport-fit=cover')));

    /* --------------------------- button scale --------------------------- */
    console.log('\n2. Button scale');

    const base = await btnHeight();
    check('default button size is unchanged from before the feature', base === 28, `${base}px`);

    await page.evaluate(() => window.appearance.setButtonScale(2));
    await page.waitForTimeout(TRANSITION_MS);
    check('2x doubles the button', (await btnHeight()) === base * 2, `${await btnHeight()}px`);

    await page.evaluate(() => window.appearance.setButtonScale(1));
    await page.waitForTimeout(TRANSITION_MS);
    check('1x restores the original size', (await btnHeight()) === base, `${await btnHeight()}px`);

    check('buttons never shrink below their chosen size',
        await page.evaluate(() => getComputedStyle(document.getElementById('menu-btn')).flexShrink === '0'));

    /* ------------------------------ theming ----------------------------- */
    console.log('\n3. Theming');

    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary').trim());

    await page.evaluate(() => window.appearance.setTheme('light'));
    check('light theme applies', (await bg()) === '#ffffff', await bg());
    await page.evaluate(() => window.appearance.setTheme('dark'));
    check('dark theme applies', (await bg()) === '#0d1117', await bg());

    const validation = await page.evaluate(() => ({
        unknownVar: window.appearance.validateTheme('{"vars":{"--nope":"#fff"}}').ok,
        nonColour: window.appearance.validateTheme('{"vars":{"--accent":"banana"}}').ok,
        injection: window.appearance.validateTheme('{"vars":{"--accent":"red;} body{display:none"}}').ok,
        malformed: window.appearance.validateTheme('{not json').ok,
        valid: window.appearance.validateTheme('{"vars":{"--accent":"#ff0000"}}').ok,
    }));
    check('a custom theme rejects unknown variables', validation.unknownVar === false);
    check('a custom theme rejects non-colour values', validation.nonColour === false);
    check('a custom theme rejects values that could break out of the declaration',
        validation.injection === false);
    check('a custom theme rejects malformed JSON', validation.malformed === false);
    check('a valid custom theme is accepted', validation.valid === true);

    await page.evaluate(() => window.appearance.saveCustomTheme('{"name":"T","vars":{"--accent":"#ff0000"}}'));
    check('a custom theme is applied',
        await page.evaluate(() => getComputedStyle(document.documentElement)
            .getPropertyValue('--accent').trim()) === '#ff0000');

    await page.evaluate(() => window.appearance.setTheme('dark'));
    check('switching away from a custom theme clears its overrides',
        await page.evaluate(() => getComputedStyle(document.documentElement)
            .getPropertyValue('--accent').trim()) === '#58a6ff');

    /* --------------------------- localization --------------------------- */
    console.log('\n4. Localization');

    const locales = await page.evaluate(() => window.i18n.available()
        .map((l) => ({ code: l.code, pct: Math.round(l.completeness * 100), partial: l.partial })));
    check('shipped locales are listed', locales.length >= 2, JSON.stringify(locales));
    check('every offered locale meets the completeness threshold',
        locales.every((l) => l.pct >= 80), JSON.stringify(locales));

    // The point of the completeness score: a stub catalogue must not look ready.
    const stubScore = await page.evaluate(() => {
        window.i18n.catalogues.__stub = { 'menu.appearance': 'Appearance' }; // identical to English
        window.i18n._score('__stub');
        const s = window.i18n.completeness.__stub;
        delete window.i18n.catalogues.__stub;
        delete window.i18n.completeness.__stub;
        return s;
    });
    check('a catalogue that merely copies English scores as untranslated',
        stubScore < 0.8, `scored ${Math.round(stubScore * 100)}%`);

    await page.evaluate(() => window.i18n.activate('es'));
    await page.waitForTimeout(200);
    check('switching language translates the UI',
        await page.evaluate(() => window.t('menu.appearance')) === 'Apariencia');
    check('translation reaches the DOM',
        (await page.evaluate(() => document.getElementById('btn-appearance').textContent.trim()))
            === 'Apariencia');
    check('the document language attribute follows',
        await page.evaluate(() => document.documentElement.getAttribute('lang')) === 'es');
    check('the document direction is set',
        ['ltr', 'rtl'].includes(await page.evaluate(() => document.documentElement.getAttribute('dir'))));

    // A draft translation may live in the repo but must not be offered until a
    // human who reads it has signed it off — the completeness score cannot tell
    // a good translation from a confident wrong one.
    const gating = await page.evaluate(() => {
        window.i18n.catalogues.__draft = { 'menu.appearance': 'Apariencia-draft' };
        window.i18n.completeness.__draft = 1;
        window.i18n.LOCALES.push({ code: '__draft', endonym: 'Draft', dir: 'ltr', status: 'draft' });
        const offered = window.i18n.available().some((l) => l.code === '__draft');
        const status = window.i18n.statusOf('__draft');
        window.i18n.LOCALES.pop();
        delete window.i18n.catalogues.__draft;
        delete window.i18n.completeness.__draft;
        return { offered, status };
    });
    check('a complete but unreviewed translation is NOT offered',
        gating.offered === false, `status=${gating.status}`);

    // Layout and language are separate reviews; this is how the first is done
    // without a translation existing.
    await page.evaluate(() => window.i18n.activate('en-x-rtl'));
    await page.waitForTimeout(200);
    check('the RTL preview locale flips document direction',
        await page.evaluate(() => document.documentElement.getAttribute('dir')) === 'rtl');
    check('the RTL preview keeps English strings, so only layout is under test',
        await page.evaluate(() => window.t('menu.appearance')) === 'Appearance');

    await page.evaluate(() => window.i18n.activate('en'));

    // The manifest exists so startup does not fetch every catalogue just to
    // score them — two requests today, twenty at twenty locales.
    const manifest = await page.evaluate(async () => {
        const res = await fetch('i18n/manifest.json');
        const m = await res.json();
        return { ok: res.ok, count: m.locales.length, hasScores: m.locales.every((l) => 'completeness' in l) };
    });
    check('a precomputed locale manifest is served', manifest.ok && manifest.count >= 2);
    check('the manifest carries completeness, so startup need not fetch every catalogue',
        manifest.hasScores);

    const fetched = await page.evaluate(() =>
        Object.keys(window.i18n.catalogues).filter((c) => !c.startsWith('__')));
    check('only the catalogues actually in use are fetched',
        fetched.length <= 3, `loaded: ${fetched.join(', ')}`);

    // Privacy text is legal copy and is reviewed on its own schedule, so a
    // locale can have a reviewed UI and a draft policy at the same time.
    const domains = await page.evaluate(() => ({
        esUi: window.i18n.statusOf('es'),
        esPrivacy: window.i18n.domainStatusOf('es', 'privacy'),
        enPrivacy: window.i18n.domainStatusOf('en', 'privacy'),
    }));
    check('privacy translations are gated separately from the UI',
        domains.esUi === 'reviewed' && domains.esPrivacy === 'draft',
        JSON.stringify(domains));
    check('the English policy is the reviewed, authoritative one',
        domains.enPrivacy === 'reviewed');

    const notice = await page.evaluate(async () => {
        const res = await fetch('i18n/privacy.es.json');
        const d = await res.json();
        return d.strings['privacy.translationNotice'];
    });
    check('a translated policy declares itself informational, pointing at English',
        /informativo/i.test(notice) && /ingl/i.test(notice), notice);

    /* ------------------------------ dialog ------------------------------ */
    console.log('\n5. Dialog');

    await page.evaluate(() => document.getElementById('menu-btn').click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('btn-appearance').click());
    await page.waitForTimeout(300);
    check('the Appearance dialog opens from the menu',
        await page.evaluate(() => !document.getElementById('appearance-modal').classList.contains('hidden')));
    check('the language picker is populated',
        await page.evaluate(() => document.getElementById('appearance-language').options.length >= 2));

    await page.evaluate(() => window.appearance.reset());
    await page.waitForTimeout(TRANSITION_MS);
    check('reset restores the default button size', (await btnHeight()) === 28);
    check('reset restores auto margin',
        await page.evaluate(() => window.appearance.getTopMargin() === null));

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: All appearance tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
