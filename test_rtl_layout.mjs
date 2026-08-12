// Playwright test: right-to-left layout.
//
// Layout and language are separate reviews. This one checks that the interface
// mirrors, using the en-x-rtl pseudo-locale so it runs on English strings — a
// native speaker asked to review Arabic should be reporting translation
// problems, not misplaced margins.
//
//   node server.js            (or PORT=8099 node server.js)
//   node test_rtl_layout.mjs
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 60_000;

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 160) : ''}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_onboarding_seen', '1');
    addEventListener('DOMContentLoaded', () => localStorage.setItem(
        'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    localStorage.setItem('scirepl_auto_download', '1');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Computed value of one property, in the current direction. */
const cssOf = (selector, prop) => page.evaluate(
    ({ s, p }) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).getPropertyValue(p).trim() : null;
    }, { s: selector, p: prop });

/** Where an element sits relative to its parent's box, as start/end offsets. */
const offsets = (selector) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || !el.offsetParent) return null;
    const a = el.getBoundingClientRect();
    const b = el.offsetParent.getBoundingClientRect();
    return { left: Math.round(a.left - b.left), right: Math.round(b.right - a.right) };
}, selector);

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.i18n && window.appearance, null, { timeout: 30_000 });
    await page.waitForTimeout(800);

    /* ------------------------------ baseline ----------------------------- */
    console.log('\n1. The source stays free of physical direction properties');

    // The whole point: if someone reintroduces margin-left, RTL silently breaks
    // again and no amount of translation review will catch it.
    const physical = await page.evaluate(async () => {
        const files = ['css/style.css', 'css/notebooks.css'];
        const bad = [];
        for (const f of files) {
            const text = await (await fetch(f)).text();
            const re = /(^|[\s;{])((?:margin|padding|border)-(?:left|right)\s*:|text-align\s*:\s*(?:left|right)|float\s*:\s*(?:left|right))/gm;
            let m;
            while ((m = re.exec(text))) bad.push(`${f}: ${m[2].trim()}`);
        }
        return bad;
    });
    check('no physical margin/padding/border/text-align remain in the stylesheets',
        physical.length === 0, physical.slice(0, 5).join(' | '));

    /* ------------------------------- ltr --------------------------------- */
    console.log('\n2. Left-to-right is unchanged');

    await page.evaluate(() => window.i18n.activate('en'));
    await page.waitForTimeout(300);
    check('document direction is ltr', await page.evaluate(
        () => document.documentElement.getAttribute('dir')) === 'ltr');

    const ltrClose = await offsets('#privacy-modal .modal-close')
        || await offsets('#help-modal .modal-close');
    const ltrMenuAlign = await cssOf('.menu-grid button', 'text-align');
    check('menu buttons read from the start edge', ltrMenuAlign === 'start', ltrMenuAlign);

    // A blockquote's rule should sit on the side the text starts from.
    // .markdown-body is built at runtime for markdown cells, so the probe has
    // to construct the same nesting the rule is written against.
    const quoteBorders = () => page.evaluate(() => {
        const host = document.createElement('div');
        host.className = 'markdown-body';
        const el = document.createElement('blockquote');
        host.appendChild(el);
        document.body.appendChild(host);
        const cs = getComputedStyle(el);
        const out = { left: cs.borderLeftWidth, right: cs.borderRightWidth };
        host.remove();
        return out;
    });
    const ltrQuote = await quoteBorders();
    check('the blockquote rule is on the start side under ltr',
        ltrQuote.left !== '0px' && ltrQuote.right === '0px', JSON.stringify(ltrQuote));

    /* ------------------------------- rtl --------------------------------- */
    console.log('\n3. Right-to-left mirrors');

    await page.evaluate(() => window.i18n.activate('en-x-rtl'));
    await page.waitForTimeout(400);
    check('document direction flips to rtl', await page.evaluate(
        () => document.documentElement.getAttribute('dir')) === 'rtl');

    const rtlMenuAlign = await cssOf('.menu-grid button', 'text-align');
    check('menu buttons still read from the start edge, which is now the right',
        rtlMenuAlign === 'start', rtlMenuAlign);

    const rtlQuote = await quoteBorders();
    check('a blockquote rule moves to the other side under rtl',
        ltrQuote.left !== rtlQuote.left && ltrQuote.left === rtlQuote.right,
        `ltr ${JSON.stringify(ltrQuote)} rtl ${JSON.stringify(rtlQuote)}`);

    // The close button is positioned, not flowed: this is the inset-inline-end
    // conversion, and the case a hand-written [dir=rtl] override usually misses.
    await page.evaluate(() => document.getElementById('help-btn').click());
    await page.waitForTimeout(300);
    const rtlClose = await offsets('#help-modal .modal-close');
    check('the modal close button moves to the opposite corner',
        rtlClose && rtlClose.left < rtlClose.right,
        `rtl offsets ${JSON.stringify(rtlClose)}`);
    await page.evaluate(() => document.getElementById('help-modal').classList.add('hidden'));

    // Nothing should overflow horizontally once mirrored.
    const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('the page does not scroll sideways under rtl', overflow <= 1, `${overflow}px`);

    /* ---------------------------- real locale ---------------------------- */
    console.log('\n4. A real RTL locale behaves the same');

    await page.evaluate(() => window.i18n.activate('ar'));
    await page.waitForTimeout(400);
    check('Arabic sets rtl', await page.evaluate(
        () => document.documentElement.getAttribute('dir')) === 'rtl');
    check('Arabic sets the language attribute', await page.evaluate(
        () => document.documentElement.getAttribute('lang')) === 'ar');
    check('menu buttons align from the start under Arabic',
        (await cssOf('.menu-grid button', 'text-align')) === 'start');
    const arOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('Arabic does not scroll sideways', arOverflow <= 1, `${arOverflow}px`);

    /* ------------------- identifiers inside rtl text -------------------- */
    console.log('\n5. Latin identifiers survive inside right-to-left text');

    // The bidi algorithm resolves the leading dot of ".srwb" against the
    // paragraph direction, which in Arabic strands it at the far end of the run
    // — the extension renders as "srwb" with a loose dot elsewhere. Caught by
    // screenshotting the menu; invisible in the catalogue, where the text is fine.
    const isolated = await page.evaluate(() => {
        const el = document.getElementById('btn-import-file');
        return el ? el.textContent : null;
    });
    const LRI = '\u2066', PDI = '\u2069';
    check('the import label exists to inspect', typeof isolated === 'string', isolated);
    check('Latin runs are wrapped in directional isolates under rtl',
        isolated.includes(LRI) && isolated.includes(PDI),
        JSON.stringify(isolated));
    check('the extension keeps its leading dot attached',
        /\u2066\.srwb, \.ipynb/.test(isolated), JSON.stringify(isolated));
    check('the Arabic prose is untouched — this is typography, not translation',
        /[\u0600-\u06FF]/.test(isolated));

    const literalDirection = await page.evaluate(() => {
        const el = document.createElement('span');
        window.setI18nText(el, 'loading.sciRepl');
        return {
            text: el.textContent,
            dir: el.getAttribute('dir'),
            autoDir: el.getAttribute('data-i18n-auto-dir'),
        };
    });
    check('a catalogue-declared literal is one whole left-to-right element in RTL',
        literalDirection.dir === 'ltr' && literalDirection.autoDir === 'ltr'
            && literalDirection.text === 'Sci REPL',
        JSON.stringify(literalDirection));

    const nativeMessages = await page.evaluate(() => ({
        latin: window.tNative('notebookManager.confirm.deleteNamed', {
            name: 'Q4 \u202Eevil.srwb',
        }),
        arabic: window.tNative('notebookManager.confirm.deleteNamed', {
            name: 'تحليل Claude.srwb',
        }),
        scrubbed: window.i18n.nativeMessage('Path: /nb/Q4 \u202Eevil.srwb'),
    }));
    check('native confirmations isolate a Latin interpolation as one unit',
        nativeMessages.latin.includes(`${LRI}Q4 evil.srwb${PDI}`),
        JSON.stringify(nativeMessages.latin));
    check('native confirmations preserve an RTL value and its inner Latin extension',
        nativeMessages.arabic.includes('\u2067')
            && nativeMessages.arabic.includes(`${LRI}Claude.srwb${PDI}`),
        JSON.stringify(nativeMessages.arabic));
    check('native-dialog formatting removes caller-supplied bidi overrides',
        !nativeMessages.latin.includes('\u202E') && !nativeMessages.scrubbed.includes('\u202E'),
        JSON.stringify(nativeMessages));

    // Applying it twice would nest isolates and grow the string on every
    // re-render, which happens whenever the locale is reapplied.
    const stable = await page.evaluate(() => {
        const el = document.getElementById('btn-import-file');
        window.i18n.applyToDom();
        window.i18n.applyToDom();
        return el.textContent;
    });
    check('re-rendering does not stack isolates', stable === isolated,
        `${(stable.match(/\u2066/g) || []).length} vs ${(isolated.match(/\u2066/g) || []).length}`);

    await page.evaluate(() => window.i18n.activate('en'));
    await page.waitForTimeout(300);
    const ltrLabel = await page.evaluate(() =>
        document.getElementById('btn-import-file').textContent);
    check('left-to-right text carries no isolates, which would be pointless there',
        !ltrLabel.includes(LRI), JSON.stringify(ltrLabel));

    await page.evaluate(() => window.i18n.activate('en'));
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.message}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: RTL layout tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
