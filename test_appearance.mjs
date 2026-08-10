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
    localStorage.setItem('scirepl_onboarding_seen', '1');
    localStorage.setItem('scirepl_auto_download', '1');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const xssFired = [];
page.on('console', (m) => { if (/XSS-FIRED/.test(m.text())) xssFired.push(m.text()); });
page.on('dialog', (d) => { xssFired.push('dialog:' + d.message()); d.dismiss().catch(() => {}); });
page.on('request', (r) => { if (/xss-evil/.test(r.url())) xssFired.push('request:' + r.url()); });

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

    /* ------------------- dark is the product default -------------------- */
    console.log('\n3b. Dark is the default, on a light-mode device');

    // Every case below runs on a device reporting prefers-color-scheme: light,
    // because that is the only configuration where "default to dark" and
    // "default to auto" give different answers. Testing this on a dark device
    // would pass either way and prove nothing.
    const lightDevice = await browser.newContext({ colorScheme: 'light' });
    await lightDevice.addInitScript(() => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_auto_download', '1');
    });
    const lp = await lightDevice.newPage();
    await lp.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await lp.waitForFunction(() => window.appearance, null, { timeout: 30_000 });

    const themeState = () => lp.evaluate(() => ({
        resolved: window.appearance.getTheme(),
        attr: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
    }));

    check('the device really does report light, or this section proves nothing',
        await lp.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches));

    let st = await themeState();
    check('fresh storage resolves to dark, not the device preference',
        st.resolved === 'dark' && st.bg === '#0d1117', JSON.stringify(st));

    for (const bad of ['', 'AUTO', 'midnight', 'null', '{}']) {
        await lp.evaluate((v) => {
            localStorage.setItem('scirepl_appearance_theme', v);
            window.appearance.apply();
        }, bad);
        st = await themeState();
        check(`an invalid stored theme (${JSON.stringify(bad)}) falls back to dark`,
            st.resolved === 'dark' && st.bg === '#0d1117', JSON.stringify(st));
    }

    // 'custom' with no stored custom theme is the same class of broken value.
    await lp.evaluate(() => {
        localStorage.setItem('scirepl_appearance_theme', 'custom');
        localStorage.removeItem('scirepl_appearance_custom_theme');
        window.appearance.apply();
    });
    st = await themeState();
    check('theme=custom with no custom theme stored falls back to dark',
        st.resolved === 'dark' && st.bg === '#0d1117', JSON.stringify(st));

    // The point of the change: 'auto' must remain reachable deliberately.
    await lp.evaluate(() => window.appearance.setTheme('auto'));
    st = await themeState();
    check('"Match system" is still selectable and still follows the device',
        st.resolved === 'auto' && st.bg === '#ffffff', JSON.stringify(st));

    await lp.evaluate(() => window.appearance.setTheme('light'));
    check('an explicit light choice is honoured',
        (await themeState()).bg === '#ffffff');

    await lp.evaluate(() => window.appearance.reset());
    st = await themeState();
    check('reset restores dark on a light-mode device, not auto',
        st.resolved === 'dark' && st.bg === '#0d1117', JSON.stringify(st));

    // Reset must not leave the system listener driving the theme afterwards.
    await lp.emulateMedia({ colorScheme: 'dark' });
    await lp.emulateMedia({ colorScheme: 'light' });
    st = await themeState();
    check('after reset, a device theme change does not move the app off dark',
        st.resolved === 'dark' && st.bg === '#0d1117', JSON.stringify(st));

    await lightDevice.close();

    /* --------------------------- localization --------------------------- */
    console.log('\n4. Localization');

    const locales = await page.evaluate(() => window.i18n.available()
        .map((l) => ({ code: l.code, pct: Math.round(l.completeness * 100), partial: l.partial })));
    check('English is always available', locales.some((l) => l.code === 'en'),
        JSON.stringify(locales));
    check('every offered locale meets the completeness threshold',
        locales.every((l) => l.pct >= 80), JSON.stringify(locales));
    // Completeness, not review status, is what withholds a locale now: an
    // unreviewed translation someone can read beats English they cannot, but a
    // barely-started one is worse than English rather than better.
    check('every offered locale is complete enough to be usable',
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

    // activate() bypasses the offered-locale filter on purpose: it is how a
    // reviewer inspects a draft in situ. es is a draft, and still switchable.
    await page.evaluate(() => window.i18n.activate('es'));
    await page.waitForTimeout(300);
    // The menu icon lives in the string, so the button keeps it in every
    // language — assert on the word rather than pinning the exact label.
    check('a draft locale can still be activated for review',
        (await page.evaluate(() => window.t('menu.appearance'))).includes('Apariencia'),
        await page.evaluate(() => window.t('menu.appearance')));
    check('translation reaches the DOM',
        (await page.evaluate(() => document.getElementById('btn-appearance').textContent))
            .includes('Apariencia'));
    check('the menu icon survives translation',
        (await page.evaluate(() => document.getElementById('btn-appearance').textContent))
            .includes('\u{1F3A8}'));
    check('untranslated keys fall back to English rather than showing the key id',
        await page.evaluate(() => {
            window.i18n.catalogues.en['__test_fallback_sample'] = 'Sample English Fallback';
            const v = window.t('__test_fallback_sample');
            delete window.i18n.catalogues.en['__test_fallback_sample'];
            return v && !v.includes('.') && v === 'Sample English Fallback';
        }));
    check('the document language attribute follows',
        await page.evaluate(() => document.documentElement.getAttribute('lang')) === 'es');
    check('the document direction is set',
        ['ltr', 'rtl'].includes(await page.evaluate(() => document.documentElement.getAttribute('dir'))));

    // A draft is offered, because withholding it hands an unreadable interface
    // to the people it was translated for. What it must never do is pass itself
    // off as reviewed — the completeness score cannot tell a good translation
    // from a confident wrong one, so the label has to carry that.
    const gating = await page.evaluate(() => {
        window.i18n.catalogues.__draft = { 'menu.appearance': 'Apariencia-draft' };
        window.i18n.completeness.__draft = 1;
        window.i18n.LOCALES.push({ code: '__draft', endonym: 'Draft', dir: 'ltr', status: 'draft' });
        const entry = window.i18n.available().find((l) => l.code === '__draft');
        const status = window.i18n.statusOf('__draft');
        window.i18n.LOCALES.pop();
        delete window.i18n.catalogues.__draft;
        delete window.i18n.completeness.__draft;
        return { offered: Boolean(entry), flagged: Boolean(entry && entry.draft), status };
    });
    check('a complete but unreviewed translation IS offered', gating.offered === true,
        `status=${gating.status}`);
    check('but it is flagged as a draft rather than passed off as reviewed',
        gating.flagged === true, `status=${gating.status}`);

    // Layout and language are separate reviews; this is how the first is done
    // without a translation existing.
    await page.evaluate(() => window.i18n.activate('en-x-rtl'));
    await page.waitForTimeout(200);
    check('the RTL preview locale flips document direction',
        await page.evaluate(() => document.documentElement.getAttribute('dir')) === 'rtl');
    check('the RTL preview keeps English strings, so only layout is under test',
        (await page.evaluate(() => window.t('menu.appearance'))).includes('Appearance'));

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
    const domains = await page.evaluate(() => {
        // Independence has to be tested on data that actually differs, so use a
        // synthetic locale rather than whichever real one happens to differ today.
        window.i18n.LOCALES.push({
            code: '__dom', endonym: 'D', dir: 'ltr', status: 'reviewed',
            domains: { privacy: { status: 'draft' } },
        });
        const out = {
            ui: window.i18n.statusOf('__dom'),
            privacy: window.i18n.domainStatusOf('__dom', 'privacy'),
            enPrivacy: window.i18n.domainStatusOf('en', 'privacy'),
        };
        window.i18n.LOCALES.pop();
        return out;
    });
    check('privacy is gated separately from the UI, in both directions',
        domains.ui === 'reviewed' && domains.privacy === 'draft',
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

    /* ------------- draft translations, and the policy notice ------------ */
    console.log('\n4b. Drafts are usable; the policy says it is unofficial');

    const draftState = async (showDrafts, deviceLangs) => await page.evaluate(
        async ({ show, langs }) => {
            window.i18n.setShowDrafts(show);
            const orig = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
            Object.defineProperty(navigator, 'languages', { get: () => langs, configurable: true });
            const out = {
                offered: window.i18n.available().map((l) => l.code),
                resolvedAuto: window.i18n.resolve('auto'),
                drafts: window.i18n.available().filter((l) => l.draft).map((l) => l.code),
            };
            if (orig) Object.defineProperty(Navigator.prototype, 'languages', orig);
            return out;
        }, { show: showDrafts, langs: deviceLangs });

    // Someone who cannot read English cannot use the app, so an unreviewed
    // translation they can read is offered rather than withheld.
    let d = await draftState(true, ['ar', 'en']);
    check('an unreviewed locale is offered by default', d.offered.includes('ar'), d.offered.join(','));
    check('detection follows the device into a draft locale', d.resolvedAuto === 'ar', d.resolvedAuto);
    check('drafts are labelled as under review, not passed off as finished',
        d.drafts.includes('ar'), d.drafts.join(','));

    // English whenever the device language has nothing usable behind it.
    d = await draftState(true, ['is-IS']);
    check('an unavailable device language falls back to English', d.resolvedAuto === 'en', d.resolvedAuto);
    d = await draftState(true, ['es-MX']);
    check('a regional variant falls back to its base language', d.resolvedAuto === 'es', d.resolvedAuto);

    // Completeness is the gate that remains: a barely-started locale is worse
    // than English, not better.
    const thin = await page.evaluate(() => {
        const es = window.i18n.LOCALES.find((l) => l.code === 'es');
        const keep = { c: window.i18n.completeness.es, s: es.status };
        window.i18n.completeness.es = 0.17;
        if (window.i18n.catalogues.es) window.i18n.catalogues.es.__status = 'draft';
        const offered = window.i18n.available().some((l) => l.code === 'es');
        window.i18n.completeness.es = keep.c;
        return offered;
    });
    check('a barely-translated locale is still withheld', thin === false);

    // Turning drafts off is for comparing against English, and must work.
    d = await draftState(false, ['ar', 'en']);
    check('drafts can be switched off to see only reviewed translations',
        !d.offered.includes('ar'), d.offered.join(','));
    check('with drafts off, an unreviewed device language falls back to English',
        d.resolvedAuto === 'en', d.resolvedAuto);
    await page.evaluate(() => window.i18n.setShowDrafts(true));

    // The policy is machine translated everywhere but English, and has to say so
    // in a language the reader actually reads.
    const policyNotice = await page.evaluate(async () => {
        const el = document.getElementById('privacy-translation-notice');
        const out = {};
        await window.i18n.activate('en');
        out.enHidden = el.hidden;
        await window.i18n.activate('ja');
        out.ja = { hidden: el.hidden, text: el.textContent };
        await window.i18n.activate('ar');
        out.ar = { hidden: el.hidden, text: el.textContent };
        await window.i18n.activate('en');
        return out;
    });
    check('the English policy carries no translation notice — it is the official text',
        policyNotice.enHidden === true);
    check('a translated policy declares itself unofficial, in that language',
        policyNotice.ja.hidden === false && /情報提供|英語/.test(policyNotice.ja.text), policyNotice.ja.text);
    check('the notice is translated for RTL readers too, not left in English',
        policyNotice.ar.hidden === false && /[\u0600-\u06FF]/.test(policyNotice.ar.text), policyNotice.ar.text);
    check('the notice points at English as the official policy',
        /英語|إنجليز/.test(policyNotice.ja.text + policyNotice.ar.text));

    await page.evaluate(async () => {
        window.i18n.setPreference('auto');
        await window.i18n.activate('en');
    });

    // Localisation must update interactive elements in place. Replacing the
    // privacy link used to strip its id and listener; on a warm reload that made
    // the inline bootstrap throw before _startApp(), so saved cells never
    // restored even though persistence itself was intact.
    const privacyLink = await page.evaluate(async () => {
        const before = document.getElementById('help-privacy-link');
        await window.i18n.activate('es');
        await window.i18n.activate('en');
        const after = document.getElementById('help-privacy-link');
        if (after) after.click();
        const modal = document.getElementById('privacy-modal');
        const out = {
            exists: Boolean(after),
            sameNode: before === after,
            opensPolicy: Boolean(modal && !modal.classList.contains('hidden')),
            text: after ? after.textContent : '',
        };
        if (modal) modal.classList.add('hidden');
        return out;
    });
    check('localisation preserves the live privacy link and its click handler',
        privacyLink.exists && privacyLink.sameNode && privacyLink.opensPolicy,
        JSON.stringify(privacyLink));

    /* --------------------- recovering from bad CSS ---------------------- */
    console.log('\n4c. Custom CSS cannot lock the user out');

    // "Reset it from the menu" is no help when the CSS is what hid the menu.
    const lockout = await page.evaluate(() => {
        window.appearance.setCustomCss('#menu-btn { display: none !important; }');
        return {
            applied: !!document.getElementById('appearance-custom-css'),
            stored: window.appearance.getCustomCss(),
            quarantined: window.appearance.getQuarantinedCss(),
            menuVisible: getComputedStyle(document.getElementById('menu-btn')).display !== 'none',
        };
    });
    check('CSS that hides the menu button is rolled back', lockout.applied === false);
    check('the menu button is still usable', lockout.menuVisible === true);
    check('the rolled-back CSS is kept, not discarded — it is the user\'s work',
        lockout.quarantined.includes('display: none'), lockout.quarantined);
    check('it is no longer applied on the next load', lockout.stored === '');
    check('the user is told what happened',
        await page.evaluate(() => !!document.getElementById('appearance-css-quarantine')));

    // The contract is "the menu stays reachable", not "these particular rules get
    // rolled back". Some of these do not even take effect — a flex item has
    // min-width:auto, so width:0 does not shrink it — and rolling back CSS that
    // was harmless would be its own bug. So assert the invariant, whichever way
    // it is satisfied.
    for (const [name, css] of [
        ['zero-sized', '#menu-btn { width: 0 !important; height: 0 !important; }'],
        ['click-through', '#menu-btn { pointer-events: none !important; }'],
        ['invisible', '#menu-btn { opacity: 0 !important; }'],
        ['off-screen', '#menu-btn { position: fixed !important; left: -9999px !important; }'],
        ['collapsed header', '#app-header { display: none !important; }'],
    ]) {
        const r = await page.evaluate((c) => {
            window.appearance.clearQuarantinedCss();
            window.appearance.setCustomCss(c);
            const el = document.getElementById('menu-btn');
            const box = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
                reachable: box.width >= 8 && box.height >= 8
                    && cs.display !== 'none' && cs.visibility !== 'hidden'
                    && parseFloat(cs.opacity) >= 0.1 && cs.pointerEvents !== 'none'
                    && box.right > 0 && box.bottom > 0
                    && box.left < window.innerWidth && box.top < window.innerHeight,
                rolledBack: !document.getElementById('appearance-custom-css'),
            };
        }, css);
        check(`the menu survives "${name}" CSS`, r.reachable === true,
            `rolledBack=${r.rolledBack}`);
    }

    // Harmless CSS must still work, or the guard is just breaking the feature.
    const benign = await page.evaluate(() => {
        window.appearance.clearQuarantinedCss();
        window.appearance.setCustomCss('#app-header { letter-spacing: 0.5px; }');
        return {
            applied: !!document.getElementById('appearance-custom-css'),
            quarantined: window.appearance.getQuarantinedCss(),
        };
    });
    check('CSS that does not lock anyone out is left alone', benign.applied === true);
    check('and is not quarantined', benign.quarantined === '');
    await page.evaluate(() => window.appearance.setCustomCss(''));

    /* ---------------- translated markup cannot execute ------------------ */
    console.log('\n4e. The inline-markup sanitiser is not an XSS hole');

    // Catalogues are repo assets, but data-i18n-html is the one place translated
    // text reaches innerHTML, and a translator pasting from a rich-text editor is
    // an ordinary accident. An unsupported wrapper must be unwrapped only after
    // its subtree is sanitised, or a nested handler is lifted up intact.
    const vectors = [
        ['nested img/onerror', '<div><img src=x onerror="console.log(\'XSS-FIRED-a\')"></div>'],
        ['svg script', '<span><svg><script>console.log(\'XSS-FIRED-b\')</script></svg>keep</span>'],
        ['deeply nested', '<foo><bar><img src=x onerror="console.log(\'XSS-FIRED-c\')"></bar></foo>'],
        ['svg xlink js', '<svg><a xlink:href="javascript:console.log(\'XSS-FIRED-d\')">x</a></svg>'],
        ['bare script', '<script>console.log(\'XSS-FIRED-e\')</script>text'],
        ['iframe', '<div><iframe src="//xss-evil.example"></iframe>body</div>'],
    ];
    for (const [name, html] of vectors) {
        const out = await page.evaluate((h) => {
            const host = document.createElement('div');
            host.setAttribute('data-i18n-html', '__xssprobe');
            document.body.appendChild(host);
            const cat = window.i18n.catalogues[window.i18n.current]
                = window.i18n.catalogues[window.i18n.current] || {};
            cat.__xssprobe = h;
            window.i18n.applyToDom(document.body);
            const rendered = host.innerHTML;
            host.remove();
            delete cat.__xssprobe;
            return rendered;
        }, html);
        check(`sanitiser drops dangerous nodes: ${name}`,
            !/<img|<script|<iframe|onerror|javascript:|<svg/i.test(out), out.slice(0, 80));
    }
    // Wait a beat so any onerror/onload that was going to fire, has.
    await page.waitForTimeout(400);
    check('no injected handler executed or fetched',
        xssFired.length === 0, xssFired.slice(0, 3).join(' | '));

    // Legitimate inline markup must still survive, or the sanitiser is just
    // breaking the feature it protects.
    const kept = await page.evaluate(() => {
        const host = document.createElement('div');
        host.setAttribute('data-i18n-html', '__keepprobe');
        document.body.appendChild(host);
        const cat = window.i18n.catalogues[window.i18n.current]
            = window.i18n.catalogues[window.i18n.current] || {};
        cat.__keepprobe = 'Use <code>%pip install</code> or see '
            + '<a href="https://example.com">docs</a> <strong>now</strong>.';
        window.i18n.applyToDom(document.body);
        const rendered = host.innerHTML;
        host.remove();
        delete cat.__keepprobe;
        return rendered;
    });
    check('safe inline markup is preserved',
        /<code>%pip install<\/code>/.test(kept) && /<strong>now<\/strong>/.test(kept)
        && /href="https:\/\/example\.com"/.test(kept), kept.slice(0, 100));

    /* --------- applying CSS through the visibly-open dialog ------------- */
    console.log('\n4h. Apply works through the open dialog; exactly three checks');

    // The real user path: open Appearance, type CSS, click Apply — the dialog is
    // visibly covering the header. The guard must not mistake the app's own
    // dialog for a user-created obstruction. (The other CSS tests call the model
    // directly with the dialog closed, so they never exercised this.)
    await page.evaluate(() => document.getElementById('menu-btn').click());
    await page.waitForTimeout(120);
    await page.evaluate(() => document.getElementById('btn-appearance').click());
    await page.waitForTimeout(200);
    const throughDialog = await page.evaluate(() => {
        window.appearance.clearQuarantinedCss();
        document.getElementById('appearance-custom-css-input').value = '#app-header { letter-spacing: .5px; }';
        document.getElementById('appearance-css-apply').click();
        return {
            dialogWasOpen: !document.getElementById('appearance-modal').classList.contains('hidden'),
            applied: !!document.getElementById('appearance-custom-css'),
            quarantined: !!window.appearance.getQuarantinedCss(),
        };
    });
    check('the Appearance dialog was actually open during Apply', throughDialog.dialogWasOpen);
    check('benign CSS applied through the open dialog is not quarantined',
        throughDialog.applied === true && throughDialog.quarantined === false);
    await page.evaluate(() => {
        document.getElementById('appearance-modal').classList.add('hidden');
        window.appearance.setCustomCss('');
    });
    await page.waitForTimeout(200);

    // Elementary lockouts the earlier check missed: pointer-events, opacity on
    // the menu, the dialog hidden, the button pushed off-screen.
    for (const [name, css] of [
        ['btn-appearance pointer-events:none', '#btn-appearance { pointer-events: none !important; }'],
        ['menu-modal opacity:0', '#menu-modal { opacity: 0 !important; }'],
        ['appearance-modal display:none', '#appearance-modal { display: none !important; }'],
        ['menu-btn off-screen', '#menu-btn { position: fixed !important; left: 100vw !important; }'],
        ['menu-btn pointer-events:none', '#menu-btn { pointer-events: none !important; }'],
    ]) {
        const rolledBack = await page.evaluate((c) => {
            window.appearance.clearQuarantinedCss();
            window.appearance.setCustomCss(c);
            return !document.getElementById('appearance-custom-css');
        }, css);
        check(`lockout via ${name} is rolled back`, rolledBack === true);
    }
    await page.evaluate(() => window.appearance.setCustomCss(''));

    // The delayed re-check must run exactly three times (initial + ~900 + ~3000)
    // and then stop — not loop forever on harmless CSS.
    const checkCount = await page.evaluate(async () => {
        let n = 0;
        const orig = window.appearance._runEscapeCheck.bind(window.appearance);
        window.appearance._runEscapeCheck = function (...a) { n++; return orig(...a); };
        window.appearance.clearQuarantinedCss();
        window.appearance.setCustomCss('#app-header { letter-spacing: .4px; }');
        await new Promise((r) => setTimeout(r, 5200));
        window.appearance._runEscapeCheck = orig;
        return n;
    });
    check('the escape check runs exactly three times, not in a loop',
        checkCount === 3, `ran ${checkCount} times`);
    await page.evaluate(() => window.appearance.setCustomCss(''));

    /* --------- deeper lockouts, editor recovery, modal a11y ------------- */
    console.log('\n4f. Deeper CSS lockouts, editor recovery, dialog a11y');

    // The escape route is menu button -> menu -> Appearance button. Hiding any
    // link in it, or covering the menu button, is a lockout even when the button
    // itself still has a box.
    for (const [name, css] of [
        ['hides the menu modal', '#menu-modal { display: none !important; }'],
        ['hides the Appearance entry', '#btn-appearance { display: none !important; }'],
        ['covers the button with a pseudo-overlay',
            'body::after { content:""; position:fixed; inset:0; z-index:99999; background:#000; }'],
    ]) {
        const rolledBack = await page.evaluate((c) => {
            window.appearance.clearQuarantinedCss();
            window.appearance.setCustomCss(c);
            return !document.getElementById('appearance-custom-css');
        }, css);
        check(`CSS that ${name} is rolled back`, rolledBack === true);
    }

    // A stored lockout must be caught at startup, not only at apply time — that
    // is what makes recovery work on Android without ?safe.
    const startupRecovery = await page.evaluate(() => {
        localStorage.setItem('scirepl_appearance_custom_css', '#menu-btn{display:none!important}');
        window.appearance.clearQuarantinedCss();
        window.appearance.apply();     // re-runs the guard, as a fresh load would
        return {
            applied: !!document.getElementById('appearance-custom-css'),
            quarantined: window.appearance.getQuarantinedCss().includes('display'),
            customCleared: window.appearance.getCustomCss() === '',
        };
    });
    check('a stored lockout is neutralised on load', startupRecovery.applied === false);
    check('the offending CSS is kept for the user to fix', startupRecovery.quarantined === true);
    check('and is not re-applied next launch', startupRecovery.customCleared === true);

    // The editor shows the quarantined CSS rather than an empty box.
    await page.evaluate(() => { document.getElementById('menu-btn').click(); });
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById('btn-appearance').click());
    await page.waitForTimeout(200);
    check('the Appearance dialog has dialog semantics',
        await page.evaluate(() => {
            const c = document.querySelector('#appearance-modal .modal-content');
            return c.getAttribute('role') === 'dialog' && c.getAttribute('aria-modal') === 'true'
                && !!c.getAttribute('aria-labelledby');
        }));
    check('opening the dialog moves focus into it',
        await page.evaluate(() => document.getElementById('appearance-modal')
            .contains(document.activeElement)));
    check('the rolled-back CSS is loaded into the editor, not lost',
        await page.evaluate(() => document.getElementById('appearance-custom-css-input')
            .value.includes('display')));
    check('the editor explains the rollback',
        await page.evaluate(() => !document.getElementById('appearance-css-error').hidden));

    // Tab stays trapped; Escape closes and restores focus.
    for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
    check('Tab is trapped inside the Appearance dialog',
        await page.evaluate(() => document.getElementById('appearance-modal')
            .contains(document.activeElement)));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('Escape closes the Appearance dialog',
        await page.evaluate(() => document.getElementById('appearance-modal')
            .classList.contains('hidden')));
    check('focus is restored to the page, not left on body',
        await page.evaluate(() => document.activeElement && document.activeElement !== document.body));

    // A clean edit clears the rollback state.
    const cleared = await page.evaluate(() => {
        document.getElementById('appearance-custom-css-input').value = '#app-header{letter-spacing:.2px}';
        document.getElementById('appearance-css-apply').click();
        return {
            applied: !!document.getElementById('appearance-custom-css'),
            quarantineGone: window.appearance.getQuarantinedCss() === '',
        };
    });
    check('a subsequent clean edit applies', cleared.applied === true);
    check('and clears the quarantine', cleared.quarantineGone === true);
    await page.evaluate(() => window.appearance.setCustomCss(''));

    /* --------- custom CSS survives a real reload; delayed attacks -------- */
    console.log('\n4g. Custom CSS on a real reload, and delayed-animation attacks');

    // The regression Sol caught: apply() runs while #loading-overlay still
    // covers the menu, so the escape check saw the app's own overlay and
    // quarantined harmless CSS on every reload. Prove a stored benign rule
    // survives a genuine navigation.
    {
        const rc = await browser.newContext();
        await rc.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            localStorage.setItem('scirepl_auto_download', '1');
            localStorage.setItem('scirepl_appearance_custom_css', '#app-header { letter-spacing: .5px; }');
        });
        const rp = await rc.newPage();
        await rp.goto(URL, { waitUntil: 'load', timeout: TIMEOUT });
        await rp.waitForFunction(() => window.appearance, null, { timeout: 30_000 });
        await rp.waitForFunction(() => {
            const o = document.getElementById('loading-overlay');
            return !o || o.classList.contains('hidden');
        }, null, { timeout: 60_000 }).catch(() => {});
        await rp.waitForTimeout(1200);
        const r = await rp.evaluate(() => ({
            applied: !!document.getElementById('appearance-custom-css'),
            stored: window.appearance.getCustomCss() !== '',
            quarantined: !!window.appearance.getQuarantinedCss(),
        }));
        check('benign CSS survives a real reload — applied', r.applied === true);
        check('benign CSS survives a real reload — still stored', r.stored === true);
        check('benign CSS is not falsely quarantined by the loading overlay',
            r.quarantined === false);
        await rc.close();
    }

    // A delayed animation that hides the menu button must be caught at apply
    // time (keyframe inspection), before the delay elapses.
    const delayedAttack = await page.evaluate(() => {
        window.appearance.clearQuarantinedCss();
        window.appearance.setCustomCss(
            '@keyframes vanish { to { opacity: 0; pointer-events: none; } }'
            + ' #menu-btn { animation: vanish 1s 2s forwards; }');
        return {
            applied: !!document.getElementById('appearance-custom-css'),
            quarantined: window.appearance.getQuarantinedCss().includes('vanish'),
        };
    });
    check('a delayed hiding animation is quarantined before it fires',
        delayedAttack.applied === false && delayedAttack.quarantined === true);

    // Control: an animation that does not touch hiding properties is allowed.
    const benignAnim = await page.evaluate(() => {
        window.appearance.clearQuarantinedCss();
        window.appearance.setCustomCss(
            '@keyframes pulse { 50% { letter-spacing: 1px; } }'
            + ' #app-header { animation: pulse 2s infinite; }');
        return { applied: !!document.getElementById('appearance-custom-css') };
    });
    check('a benign animation is not rolled back', benignAnim.applied === true);
    await page.evaluate(() => window.appearance.setCustomCss(''));

    /* ----------------- legal text follows its own review ---------------- */
    console.log('\n4d. Privacy status controls the legal text');

    const legal = await page.evaluate(async () => {
        await window.i18n.load('es');
        await window.i18n.activate('es');
        const enDom = window.i18n.domains['privacy.en'];
        const out = {
            // The policy strings now live in the domain catalogue, so the domain
            // status gates exactly the text it authorises.
            policyInDomain: !!(enDom && enDom['privacy.youUseScireplEntirelyAt']),
            policyNotInGeneral: !('privacy.youUseScireplEntirelyAt' in window.i18n.catalogues.en),
            privacyStatus: window.i18n.domainStatusOf('es', 'privacy'),
            bodyIsEnglish: window.t('privacy.youUseScireplEntirelyAt')
                === enDom['privacy.youUseScireplEntirelyAt'],
            // The consent button is legal, not chrome: English when unreviewed.
            consentIsEnglish: window.t('privacy.iUnderstand') === enDom['privacy.iUnderstand'],
            noticeTranslated: window.t('privacy.translationNotice')
                !== enDom['privacy.translationNotice'],
            uiTranslated: window.t('menu.appearance')
                !== window.i18n.catalogues.en['menu.appearance'],
            flagged: window.i18n.legalTextIsUntranslated(),
        };
        // Flip the domain to reviewed: the body must switch to Spanish.
        const es = window.i18n.LOCALES.find((l) => l.code === 'es');
        const saved = es && es.domains;
        if (es) es.domains = { privacy: { status: 'reviewed' } };
        out.bodySpanishWhenReviewed = window.t('privacy.youUseScireplEntirelyAt')
            !== enDom['privacy.youUseScireplEntirelyAt'];
        if (es) es.domains = saved;
        await window.i18n.activate('en');
        return out;
    });
    check('the policy text lives in the privacy domain catalogue, not the general one',
        legal.policyInDomain === true && legal.policyNotInGeneral === true);
    check('the Spanish privacy catalogue is still a draft', legal.privacyStatus === 'draft');
    check('an unreviewed policy body falls back to the authoritative English',
        legal.bodyIsEnglish === true);
    check('the consent button is English too when the policy is unreviewed',
        legal.consentIsEnglish === true);
    check('the unofficial-translation notice is still translated', legal.noticeTranslated === true);
    check('the rest of the UI is unaffected by the legal gate', legal.uiTranslated === true);
    check('the state is reported, so the notice can explain it', legal.flagged === true);
    check('marking the privacy domain reviewed switches the body to that language',
        legal.bodySpanishWhenReviewed === true);

    // Concurrent activations must not leave the DOM on an older locale.
    const raced = await page.evaluate(async () => {
        const a = window.i18n.activate('es');
        const bb = window.i18n.activate('ja');
        const cc = window.i18n.activate('en');
        await Promise.all([a, bb, cc]);
        return {
            lang: document.documentElement.getAttribute('lang'),
            current: window.i18n.current,
        };
    });
    check('the last activation wins a race, not whichever resolves last',
        raced.lang === 'en' && raced.current === 'en', JSON.stringify(raced));

    // A stale activation must not stamp its notice over the winning locale.
    const staleNotice = await page.evaluate(async () => {
        await window.i18n.load('es');
        await window.i18n.load('ja');
        const a = window.i18n.activate('es');   // not awaited first
        const b2 = window.i18n.activate('ja');
        await Promise.all([a, b2]);
        await new Promise((r) => setTimeout(r, 300));
        const notice = document.getElementById('privacy-translation-notice');
        const out = {
            current: window.i18n.current,
            lang: document.documentElement.getAttribute('lang'),
            noticeText: notice ? notice.textContent : '',
            enDom: window.i18n.domains['privacy.en']['privacy.translationNotice'],
            jaDom: window.i18n.domains['privacy.ja']['privacy.translationNotice'],
        };
        await window.i18n.activate('en');
        return out;
    });
    check('a stale activation does not leave the wrong-language notice',
        staleNotice.current === 'ja' && staleNotice.lang === 'ja'
        && staleNotice.noticeText === staleNotice.jaDom, JSON.stringify({
            current: staleNotice.current, lang: staleNotice.lang,
        }));

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
