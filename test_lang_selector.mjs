// Playwright regression: native language pickers always own descriptive option
// text ("Py - Python"), while a presentation-only overlay keeps their closed
// controls compact. Android can snapshot a native picker before touch handlers
// run, so the option strings must be correct before any interaction and must
// never depend on open/close events.
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
        const select = document.querySelector(sel);
        if (!select) return null;
        const shell = select.closest('.language-selector-shell');
        const compact = shell?.querySelector('.language-selector-abbrev');
        const rect = select.getBoundingClientRect();
        return {
            ariaLabel: select.getAttribute('aria-label'),
            compactAriaHidden: compact?.getAttribute('aria-hidden'),
            compactPointerEvents: compact ? getComputedStyle(compact).pointerEvents : null,
            compactText: compact?.textContent,
            compactClientWidth: compact?.clientWidth,
            compactScrollWidth: compact?.scrollWidth,
            dir: select.dir,
            options: [...select.options].map(option => option.textContent),
            selectedText: select.options[select.selectedIndex]?.textContent,
            width: Math.round(rect.width),
        };
    }, selector);

    const expected = [
        'Py - Python',
        'R',
        'PL - Prolog',
        'Sh - Bash',
        'JS - JavaScript',
        'Lua',
        'TyR - TypR',
        'CLJS - ClojureScript',
    ];

    try {
        await context.addInitScript(() => {
            localStorage.setItem('scirepl_privacy_accepted', '1');
            localStorage.setItem('scirepl_onboarding_seen', '1');
            addEventListener('DOMContentLoaded', () => {
                const version = window.KERNEL_CONFIG?.app?.version;
                if (version) localStorage.setItem('scirepl_whats_new_seen_version', version);
            }, { once: true });
        });
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() => window.__SCIREPL_APP_READY === true, null, { timeout: TIMEOUT });

        console.log('1. Native options are complete before interaction');
        const initial = await state('#lang-selector');
        check('every expected full choice is present',
            expected.every(text => initial.options.includes(text)), initial.options.join(','));
        check('the selected Python choice includes its name',
            initial.selectedText === 'Py - Python', initial.selectedText);
        const doubled = initial.options.filter(text => {
            const parts = text.split(' - ');
            return parts.length === 2 && parts[0].toLocaleLowerCase() === parts[1].toLocaleLowerCase();
        });
        check('names that already equal their abbreviation are not doubled',
            initial.options.includes('R') && initial.options.includes('Lua') && doubled.length === 0,
            doubled.join(','));

        console.log('2. The compact visual label leaves native semantics intact');
        check('the closed composer label is compact', initial.compactText === 'Py', initial.compactText);
        check('the visual label is hidden from accessibility APIs',
            initial.compactAriaHidden === 'true' && initial.compactPointerEvents === 'none');
        check('the real selector has an accessible name',
            initial.ariaLabel === await page.evaluate(() => window.t('editor.programmingLanguageTitle')),
            initial.ariaLabel);
        check('programming-language identifiers keep LTR order', initial.dir === 'ltr', initial.dir);
        check('the closed selector remains abbreviation-sized', initial.width <= 60, `${initial.width}px`);

        console.log('3. Pointer, touch and Back-like dismissal cannot change picker labels');
        await page.dispatchEvent('#lang-selector', 'mousedown');
        await page.dispatchEvent('#lang-selector', 'touchstart');
        await page.press('#lang-selector', 'Escape');
        const afterDismiss = await state('#lang-selector');
        check('all option text is byte-stable across open/dismiss events',
            JSON.stringify(afterDismiss.options) === JSON.stringify(initial.options),
            afterDismiss.options.join(','));
        check('the selected full name and compact overlay remain synchronized',
            afterDismiss.selectedText === 'Py - Python' && afterDismiss.compactText === 'Py');

        console.log('4. User and programmatic changes synchronize the overlay');
        await page.selectOption('#lang-selector', 'prolog');
        const prolog = await state('#lang-selector');
        check('choosing Prolog keeps the full native choice',
            prolog.selectedText === 'PL - Prolog', prolog.selectedText);
        check('choosing Prolog updates the compact label', prolog.compactText === 'PL', prolog.compactText);
        check('selection does not mutate or resize the option set',
            JSON.stringify(prolog.options) === JSON.stringify(initial.options) && prolog.width === initial.width,
            `${initial.width}px -> ${prolog.width}px`);
        const compactFits = await page.evaluate(async () => {
            const select = document.getElementById('lang-selector');
            const results = [];
            for (const option of select.options) {
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(resolve => requestAnimationFrame(resolve));
                const compact = select.parentElement.querySelector('.language-selector-abbrev');
                results.push({
                    value: option.value,
                    text: compact.textContent,
                    clientWidth: compact.clientWidth,
                    scrollWidth: compact.scrollWidth,
                });
            }
            return results;
        });
        check('every compact abbreviation fits without clipping',
            compactFits.every(item => item.scrollWidth <= item.clientWidth), JSON.stringify(compactFits));
        await page.evaluate(() => {
            document.getElementById('lang-selector').value = 'javascript';
            window.notifyComposerContextChanged();
        });
        const programmed = await state('#lang-selector');
        check('programmatic language changes update the compact label',
            programmed.selectedText === 'JS - JavaScript' && programmed.compactText === 'JS',
            `${programmed.selectedText} / ${programmed.compactText}`);

        console.log('5. Dynamically created cell selectors use the same contract');
        await page.selectOption('#lang-selector', 'python');
        await page.click('#cell-type-toggle');
        await page.fill('#code-input', 'A Markdown cell');
        await page.click('#run-btn');
        await page.waitForSelector('.cell-edit-btn', { timeout: TIMEOUT });
        await page.click('.cell-edit-btn');
        await page.waitForSelector('.cell-lang-switch', { timeout: TIMEOUT });
        const cellInitial = await state('.cell-lang-switch');
        check('cell picker is descriptive before interaction',
            expected.every(text => cellInitial.options.includes(text)), cellInitial.options.join(','));
        check('cell picker exposes a full selected name and compact visual label',
            cellInitial.selectedText === 'Py - Python' && cellInitial.compactText === 'Py',
            `${cellInitial.selectedText} / ${cellInitial.compactText}`);
        check('cell picker has a localized accessible name',
            cellInitial.ariaLabel === await page.evaluate(() => window.t('app.cell.actions.languageTitle')),
            cellInitial.ariaLabel);
        await page.selectOption('.cell-lang-switch', 'prolog');
        const cellProlog = await state('.cell-lang-switch');
        check('cell selection synchronizes without rewriting choices',
            cellProlog.selectedText === 'PL - Prolog'
                && cellProlog.compactText === 'PL'
                && JSON.stringify(cellProlog.options) === JSON.stringify(cellInitial.options));

        console.log('6. Compact selectors remain real hit targets on a narrow phone');
        await page.setViewportSize({ width: 320, height: 640 });
        const geometry = await page.evaluate(() => {
            const selectors = [
                document.getElementById('lang-selector'),
                document.querySelector('.cell-lang-switch'),
            ];
            return selectors.map(select => {
                const rect = select.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return {
                    complete: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
                    hitSelf: hit === select,
                    width: Math.round(rect.width),
                };
            });
        });
        check('both selectors are completely inside the 320px viewport',
            geometry.every(item => item.complete), JSON.stringify(geometry));
        check('both selector centres hit the real native control',
            geometry.every(item => item.hitSelf), JSON.stringify(geometry));
        check('both closed controls remain compact',
            geometry.every(item => item.width <= 60), JSON.stringify(geometry));

        console.log('7. RTL does not reorder language identifiers');
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
        const rtl = await state('#lang-selector');
        check('the selector remains explicitly LTR in an RTL document', rtl.dir === 'ltr', rtl.dir);
        check('full option strings are unchanged in RTL',
            JSON.stringify(rtl.options) === JSON.stringify(initial.options), rtl.options.join(','));

        check('no page errors', consoleLogs.filter(log => log.startsWith('[PAGE ERROR]')).length === 0,
            consoleLogs.filter(log => log.startsWith('[PAGE ERROR]')).join(' | '));

        console.log(`\nResults: ${count} checks`);
        console.log(allPassed ? 'PASS: All language selector tests passed!' : 'FAIL: Some tests failed');
    } catch (error) {
        console.error('FATAL:', error.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
