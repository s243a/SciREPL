// Notebook width (Appearance → Layout): Standard / Wide / Full window.
// On windows of 1000px and wider, Standard is the historical 720px column,
// Wide (the default) caps it at 1200px and Full removes the cap. Below 1000px
// every choice must be exactly today's 720px layout. The input bar follows the
// column. The choice persists across reloads and is applied by the time the
// document is parsed.
// Run the dev server first (PORT=8085 by default), then: node tests/test_notebook_width.mjs
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const APP_URL = `http://localhost:${PORT}/index.html`;
const KEY = 'scirepl_appearance_notebook_width';
let failures = 0, checks = 0;
const check = (name, ok, detail = '') => { checks++; if (!ok) failures++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 240) : ''}`); };

const browser = await chromium.launch({ headless: true });

/** A fresh app with an optional stored width (undefined = never chosen). */
async function open(width, stored) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    await context.addInitScript(([key, value]) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_privacy_accepted_revision', '2026-09-network-guard-v1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        if (value !== null && sessionStorage.getItem('nbw-seeded') !== '1') {
            // Seed once only, so a reload sees what the app itself stored.
            localStorage.setItem(key, value);
            sessionStorage.setItem('nbw-seeded', '1');
        }
        addEventListener('DOMContentLoaded', () => {
            // Recorded before the app's own startup code runs, to show the
            // width was applied with the theme rather than after first render.
            window.__nbwAtDomReady = document.documentElement.getAttribute('data-notebook-width');
            localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG?.app?.version || '');
        }, { once: true });
    }, [KEY, stored === undefined ? null : stored]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await ready(page);
    return { context, page, errors };
}

async function ready(page) {
    await page.waitForFunction(() => window.__SCIREPL_APP_READY === true && !!window.appearance && !!window.appearanceUI, null, { timeout: 120_000 });
    await page.evaluate(() => { for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden'); });
}

/** One JavaScript cell whose output is wider than any column, so even the
 *  shrink-to-content Standard column reaches its cap. */
async function addWideCell(page) {
    await page.selectOption('#lang-selector', 'javascript');
    await page.fill('#code-input', 'console.log("x".repeat(400))');
    await page.click('#run-btn');
    await page.waitForFunction(() => [...document.querySelectorAll('.card-output')].some((o) => o.textContent.includes('xxxx')), null, { timeout: 30_000 });
}

async function geometry(page) {
    return page.evaluate(() => {
        const box = (sel) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            return { left: Math.round(r.left), width: Math.round(r.width), right: Math.round(innerWidth - r.right) };
        };
        return {
            repl: box('#repl'), bar: box('#input-bar'), card: box('#repl .card'),
            attr: document.documentElement.getAttribute('data-notebook-width'),
            scroll: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
        };
    });
}

// Expected column width per viewport and choice ('unset' = never chosen,
// 'junk' = a corrupt stored value; both are Wide).
const EXPECTED = {
    800: { unset: 720, standard: 720, wide: 720, full: 720, junk: 720 },
    1024: { unset: 1024, standard: 720, wide: 1024, full: 1024, junk: 1024 },
    1600: { unset: 1200, standard: 720, wide: 1200, full: 1600, junk: 1200 },
};

try {
    console.log('1. Column and input bar widths per viewport and choice');
    for (const [vw, byChoice] of Object.entries(EXPECTED)) {
        for (const [choice, want] of Object.entries(byChoice)) {
            const { context, page, errors } = await open(Number(vw), choice === 'unset' ? undefined : choice);
            await addWideCell(page);
            const g = await geometry(page);
            const label = `${vw}px ${choice}`;
            check(`${label}: column is ${want}px`, g.repl.width === want, JSON.stringify(g));
            check(`${label}: input bar matches the column`, g.bar.width === g.repl.width && g.bar.left === g.repl.left, JSON.stringify(g));
            check(`${label}: column is centred`, Math.abs(g.repl.left - g.repl.right) <= 1, JSON.stringify(g.repl));
            check(`${label}: cell fills the column inside its padding`, g.card.width === want - 40, JSON.stringify(g.card));
            check(`${label}: no horizontal page overflow`, g.scroll <= g.vw, `${g.scroll} > ${g.vw}`);
            check(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
            await context.close();
        }
    }

    console.log('2. Choosing in Appearance applies live and persists across reload');
    {
        const { context, page, errors } = await open(1600);
        await addWideCell(page);
        let g = await geometry(page);
        check('default is Wide with no attribute on <html>', g.attr === null && g.repl.width === 1200, JSON.stringify(g));
        await page.evaluate(() => window.appearanceUI.open());
        check('select shows Wide by default', await page.inputValue('#appearance-notebook-width') === 'wide');

        await page.selectOption('#appearance-notebook-width', 'standard');
        g = await geometry(page);
        check('Standard applies without reload', g.attr === 'standard' && g.repl.width === 720 && g.bar.width === 720, JSON.stringify(g));
        check('Standard is stored', await page.evaluate((k) => localStorage.getItem(k), KEY) === 'standard');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await ready(page);
        check('Standard is applied by DOMContentLoaded after reload', await page.evaluate(() => window.__nbwAtDomReady) === 'standard');
        await addWideCell(page);
        g = await geometry(page);
        check('Standard persists across reload', g.repl.width === 720 && g.bar.width === 720, JSON.stringify(g));
        await page.evaluate(() => window.appearanceUI.open());
        check('select shows Standard after reload', await page.inputValue('#appearance-notebook-width') === 'standard');

        await page.selectOption('#appearance-notebook-width', 'full');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ready(page);
        check('Full is applied by DOMContentLoaded after reload', await page.evaluate(() => window.__nbwAtDomReady) === 'full');
        await addWideCell(page);
        g = await geometry(page);
        check('Full persists across reload', g.repl.width === 1600 && g.bar.width === 1600, JSON.stringify(g));

        await page.evaluate(() => window.appearanceUI.open());
        await page.click('#appearance-reset');
        g = await geometry(page);
        check('Reset to defaults returns to Wide', g.attr === null && g.repl.width === 1200
            && await page.inputValue('#appearance-notebook-width') === 'wide', JSON.stringify(g));
        check('no page errors', errors.length === 0, errors.join(' | '));
        await context.close();
    }

    console.log('3. With the notebook sidebar, the input bar lines up with the column');
    for (const dir of ['ltr', 'rtl']) {
        for (const [choice, want] of [['wide', 1200], ['full', 1400]]) {
            const { context, page } = await open(1600, choice);
            await page.evaluate((d) => { document.documentElement.dir = d; window.notebookManager.createNotebook({}); }, dir);
            await addWideCell(page);
            const g = await page.evaluate(() => {
                const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) }; };
                const scroller = [...document.querySelectorAll('#repl, .repl-container')].find((e) => e.offsetParent);
                return { sidebar: box(document.getElementById('notebook-sidebar')), repl: box(scroller), bar: box(document.getElementById('input-bar')) };
            });
            const label = `${dir} ${choice}`;
            check(`${label}: sidebar is showing`, g.sidebar.width === 200, JSON.stringify(g));
            check(`${label}: column is ${want}px beside the sidebar`, g.repl.width === want, JSON.stringify(g));
            check(`${label}: input bar has the column's width and position`, g.bar.width === g.repl.width && g.bar.left === g.repl.left, JSON.stringify(g));
            await context.close();
        }
    }
} catch (error) {
    failures++; console.error('  [FAIL] suite aborted:', error);
} finally { await browser.close(); }
console.log(`\n${checks - failures}/${checks} notebook-width checks passed${failures ? `, ${failures} failed` : ''}.`);
process.exit(failures ? 1 : 0);
