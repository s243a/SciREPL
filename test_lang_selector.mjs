// Playwright test: language selectors show the abbreviation when closed and
// "Py - Python" once the list is open.
//
// A native <select> renders the same text in its closed control and in its
// open list, so this is a swap on open/close rather than two pieces of markup.
// The properties worth pinning are therefore: the closed control never shows a
// full name, the open list always does, the swap does not resize the control
// (it sits in the composer row, which would shift), a language whose
// abbreviation is already its name is not doubled, and cells built after load
// behave the same as the footer selector.
import { chromium } from 'playwright';

const TIMEOUT = 180_000;
const APP_URL = process.env.SCIREPL_TEST_BASE || 'http://localhost:8085/';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

    let allPassed = true;
    let count = 0;
    const check = (name, passed, detail) => {
        count++;
        if (!passed) allPassed = false;
        console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
    };

    const state = (selector) => page.evaluate((sel) => {
        const s = document.querySelector(sel);
        if (!s) return null;
        return {
            width: Math.round(s.getBoundingClientRect().width),
            options: [...s.options].map(o => o.textContent),
            selectedText: s.options[s.selectedIndex]?.textContent,
        };
    }, selector);

    try {
        await context.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => {
                const v = window.KERNEL_CONFIG?.app?.version;
                if (v) localStorage.setItem('scirepl_whats_new_seen_version', v);
            }, { once: true });
        });
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() => window.__SCIREPL_APP_READY === true, null, { timeout: TIMEOUT });

        console.log('1. Footer selector, closed');
        const closed = await state('#lang-selector');
        check('closed control shows only abbreviations',
            closed.options.every(t => !t.includes(' - ')), closed.options.join(','));
        check('the abbreviations are the expected set',
            closed.options.includes('Py') && closed.options.includes('CLJS'), closed.options.join(','));

        console.log('2. Opening the list');
        await page.dispatchEvent('#lang-selector', 'mousedown');
        const open = await state('#lang-selector');
        check('Prolog reads "PL - Prolog"', open.options.includes('PL - Prolog'));
        check('ClojureScript reads "CLJS - ClojureScript"', open.options.includes('CLJS - ClojureScript'));
        // Python is the selected language on load, so it deliberately stays
        // short — see section 4. Section 7 reopens the list with Prolog
        // selected, which is where "Py - Python" is asserted.
        check('every unselected multi-word language gained its name',
            ['PL - Prolog', 'Sh - Bash', 'JS - JavaScript', 'TyR - TypR']
                .every(t => open.options.includes(t)), open.options.join(','));

        console.log('3. A language whose abbreviation is its name is not doubled');
        check('R stays "R", not "R - R"',
            open.options.includes('R') && !open.options.includes('R - R'));
        check('Lua stays "Lua", not "Lua - Lua"',
            open.options.includes('Lua') && !open.options.includes('Lua - Lua'));
        // Repo-agnostic form of the same rule: Pro also ships an AI entry whose
        // abbreviation is its name, and any future one must not double either.
        const doubled = open.options.filter(t => {
            const parts = t.split(' - ');
            return parts.length === 2 && parts[0] === parts[1];
        });
        check('no language is rendered as "X - X"', doubled.length === 0, doubled.join(','));

        console.log('4. The closed control never shows a truncated full name');
        // Android's WebView keeps the closed control visible behind its native
        // dialog, and a Back-button dismiss fires neither change nor focusout —
        // so the selected option must never carry the long text in the first
        // place, or the control is stranded reading "PL -".
        check('the selected option stays short while the list is open',
            !open.selectedText.includes(' - '), open.selectedText);
        check('the other options are still expanded',
            open.options.filter(t => t.includes(' - ')).length >= 4,
            open.options.join(','));

        console.log('5. The swap does not move the composer');
        check('control keeps its closed width while open',
            open.width === closed.width, `${closed.width} -> ${open.width}`);

        console.log('6. Choosing a language collapses it again');
        await page.selectOption('#lang-selector', 'prolog');
        const after = await state('#lang-selector');
        check('closed control is back to the abbreviation', after.selectedText === 'PL', after.selectedText);
        check('no option is left expanded',
            after.options.every(t => !t.includes(' - ')), after.options.join(','));
        check('width is restored', after.width === closed.width, `${closed.width} -> ${after.width}`);

        console.log('7. Escape collapses without choosing');
        await page.dispatchEvent('#lang-selector', 'mousedown');
        const reopened = await state('#lang-selector');
        check('reopened list expands again', reopened.options.includes('Py - Python'));
        await page.press('#lang-selector', 'Escape');
        const escaped = await state('#lang-selector');
        check('Escape restores the abbreviations',
            escaped.options.every(t => !t.includes(' - ')), escaped.options.join(','));

        console.log('8. A cell dropdown built after load behaves the same');
        // Put the composer back on Python (step 5 left it on Prolog) and make a
        // cell, then open its editor — the per-cell dropdown is built by
        // enterEditMode, so it does not exist until the pencil is clicked.
        await page.selectOption('#lang-selector', 'python');
        await page.fill('#code-input', '1 + 1');
        await page.click('#run-btn');
        await page.waitForSelector('.cell-edit-btn', { timeout: TIMEOUT });
        await page.click('.cell-edit-btn');
        await page.waitForSelector('.cell-lang-switch', { timeout: TIMEOUT });
        const cellClosed = await state('.cell-lang-switch');
        check('cell dropdown starts collapsed',
            cellClosed.options.every(t => !t.includes(' - ')), cellClosed.options.join(','));
        await page.dispatchEvent('.cell-lang-switch', 'mousedown');
        const cellOpen = await state('.cell-lang-switch');
        // Python is this cell's selected language, so "Py" correctly stays short;
        // the expansion is visible on the options the user is choosing between.
        check('cell dropdown expands the unselected options',
            cellOpen.options.filter(t => t.includes(' - ')).length >= 4, cellOpen.options.join(','));
        check('cell dropdown leaves its selected option short',
            !cellOpen.selectedText.includes(' - '), cellOpen.selectedText);
        check('cell dropdown keeps its width',
            cellOpen.width === cellClosed.width, `${cellClosed.width} -> ${cellOpen.width}`);

        check('no page errors', consoleLogs.filter(l => l.startsWith('[PAGE ERROR]')).length === 0,
            consoleLogs.filter(l => l.startsWith('[PAGE ERROR]')).join(' | '));

        console.log(`\nResults: ${count} checks`);
        console.log(allPassed ? 'PASS: All language selector tests passed!' : 'FAIL: Some tests failed');
    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
