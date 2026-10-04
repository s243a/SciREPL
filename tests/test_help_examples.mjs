// Playwright test: Copy and Insert buttons on the Help code examples.
//
//   PORT=8085 node server.js
//   node tests/test_help_examples.mjs        (PORT or SCIREPL_TEST_BASE to point elsewhere)
//
// No kernel is needed: Insert appends a cell WITHOUT running it, and that is
// exactly what this suite asserts.
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const BASE = (process.env.SCIREPL_TEST_BASE || `http://localhost:${PORT}/`).replace(/\/?$/, '/');
const URL = `${BASE}index.html`;
const TIMEOUT = 60_000;
const KNOWN = ['python', 'r', 'prolog', 'bash', 'javascript', 'lua', 'typr', 'clojurescript', 'markdown'];

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + String(detail).slice(0, 220) : ''}`);
};

const initScript = () => {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_onboarding_seen', '1');
    addEventListener('DOMContentLoaded', () => localStorage.setItem(
        'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    localStorage.setItem('scirepl_auto_download', '1');
};

async function ready(page) {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.__SCIREPL_APP_READY && window.helpExamples
        && window.i18n && document.querySelector('#help-modal .help-example'), null, { timeout: TIMEOUT });
}

async function openHelp(page) {
    await page.evaluate(() => {
        for (const modal of document.querySelectorAll('.modal')) modal.classList.add('hidden');
    });
    await page.click('#help-btn');
    await page.locator('#help-modal').waitFor({ state: 'visible', timeout: TIMEOUT });
}

const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(initScript);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(BASE).origin });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    /* ------------------------------ markup ------------------------------ */
    console.log('\n1. Every Help example is tagged');
    await ready(page);
    const markup = await page.evaluate(async (known) => {
        const html = await (await fetch('index.html', { cache: 'no-store' })).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const pres = [...doc.querySelectorAll('#help-modal pre, #prolog-settings-modal pre')];
        return {
            total: pres.length,
            help: doc.querySelectorAll('#help-modal pre').length,
            untagged: pres.filter((p) => !known.includes(p.getAttribute('data-example-lang')))
                .map((p) => p.textContent.slice(0, 40)),
            notLtr: pres.filter((p) => p.getAttribute('dir') !== 'ltr').length,
            prompts: pres.filter((p) => /^(>>>|\$ |In \[)/m.test(p.textContent)).length,
            langs: pres.map((p) => p.getAttribute('data-example-lang')),
            mixed: pres.filter((p) => /# Python —/.test(p.textContent) && /% Prolog —/.test(p.textContent)).length,
        };
    }, KNOWN);
    check('every Help and Files-modal <pre> carries a known data-example-lang',
        markup.untagged.length === 0, JSON.stringify(markup.untagged));
    check('16 tagged examples (15 in Help, 1 in Files & Storage)',
        markup.total === 16 && markup.help === 15, JSON.stringify(markup.langs));
    check('every example is explicitly left-to-right', markup.notLtr === 0, markup.notLtr);
    check('no example contains a prompt or output line', markup.prompts === 0, markup.prompts);
    check('the Shared Filesystem example is split into one block per language', markup.mixed === 0);

    /* ------------------------------ toolbar ----------------------------- */
    console.log('\n2. Each example has one Copy and one Insert button');
    await openHelp(page);
    const bars = await page.evaluate(() => [...document.querySelectorAll('#help-modal pre[data-example-lang]')]
        .map((pre) => {
            const wrap = pre.parentElement;
            const copies = wrap.querySelectorAll(':scope > .help-example-bar .help-example-copy');
            const inserts = wrap.querySelectorAll(':scope > .help-example-bar .help-example-insert');
            const chip = wrap.querySelector('.help-example-lang');
            return {
                lang: pre.dataset.exampleLang,
                wrapped: wrap.classList.contains('help-example'),
                copies: copies.length,
                inserts: inserts.length,
                chip: chip && chip.textContent,
                copyAria: copies[0] && copies[0].getAttribute('aria-label'),
                insertAria: inserts[0] && inserts[0].getAttribute('aria-label'),
            };
        }));
    check('every Help example is wrapped with exactly one Copy and one Insert',
        bars.length === 15 && bars.every((b) => b.wrapped && b.copies === 1 && b.inserts === 1),
        JSON.stringify(bars.filter((b) => !(b.wrapped && b.copies === 1 && b.inserts === 1))));
    check('button names include the visible label and the language name',
        bars.every((b) => b.chip && b.copyAria.includes('Copy') && b.copyAria.includes(b.chip)
            && b.insertAria.includes('Insert') && b.insertAria.includes(b.chip)),
        JSON.stringify(bars[0]));
    const sizes = await page.evaluate(() => [...document.querySelectorAll(
        '#help-modal .help-example-btn')].map((b) => {
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
    }));
    check('every button is at least 44×44 CSS px on a 390-px phone',
        sizes.length === 30 && sizes.every((s) => s.w >= 44 && s.h >= 44),
        JSON.stringify(sizes.filter((s) => s.w < 44 || s.h < 44)));
    const noSideScroll = await page.evaluate(() => {
        const c = document.querySelector('#help-modal .modal-content');
        return c.scrollWidth <= c.clientWidth + 1;
    });
    check('the toolbars do not make Help scroll sideways', noSideScroll);

    /* ------------------------------ insert ------------------------------ */
    console.log('\n3. Insert appends a cell without running it');
    const before = await page.evaluate(() => window._cells.length);
    const pyPre = '#help-modal pre[data-example-lang="python"]';
    const expectedPy = await page.evaluate((s) => window.helpExamples.exampleCode(document.querySelector(s)), pyPre);
    await page.locator(`#help-modal .help-example:has(> pre[data-example-lang="python"]) .help-example-insert`).first().click();
    await page.waitForFunction((n) => window._cells.length === n + 1, before, { timeout: TIMEOUT });
    await page.waitForTimeout(150);
    let state = await page.evaluate(() => {
        const cell = window._cells[window._cells.length - 1];
        const wrap = document.querySelector('#help-modal pre[data-example-lang="python"]').parentElement;
        const notice = wrap.querySelector('.help-example-notice');
        return {
            language: cell.language, type: cell.type, code: cell.code, id: cell.id,
            outputCard: cell.outputCard, inDom: cell.inputCard.isConnected,
            helpOpen: !document.getElementById('help-modal').classList.contains('hidden'),
            live: document.querySelector('#help-modal .help-examples-live').textContent,
            noticeHidden: notice.hidden, noticeText: notice.textContent,
            label: wrap.querySelector('.help-example-insert .help-example-label').textContent,
        };
    });
    check('the new cell is a Python code cell with the example text',
        state.language === 'python' && state.type === 'code' && state.code === expectedPy,
        JSON.stringify({ language: state.language, type: state.type }));
    check('the cell was not executed (no output card)', state.outputCard === null && state.inDom);
    check('Help stays open after Insert', state.helpOpen);
    check('the live region announces the cell number',
        new RegExp(`cell ${state.id}\\b`).test(state.live), state.live);
    check('the Added · Show · Undo line is visible',
        !state.noticeHidden && state.noticeText.includes(`cell ${state.id}`)
            && state.noticeText.includes('Show') && state.noticeText.includes('Undo'), state.noticeText);
    check('the Insert label confirms briefly', state.label === 'Added', state.label);
    const pyId = state.id;

    // Persistence: the inserted cell survives a reload like any other cell.
    const savedCount = await page.evaluate(() => window._cells.length);
    await ready(page);
    await page.waitForFunction((n) => window._cells.length === n, savedCount, { timeout: 15_000 })
        .catch(() => {});
    state = await page.evaluate((id) => ({
        count: window._cells.length,
        cell: (window._cells.find((c) => c.id === id) || {}).language,
    }), pyId);
    check('the inserted cell persists across a reload',
        state.count === savedCount && state.cell === 'python', JSON.stringify(state));

    await openHelp(page);
    const prologPre = '#help-modal pre[data-example-lang="prolog"]';
    let n = await page.evaluate(() => window._cells.length);
    await page.locator(`#help-modal .help-example:has(> pre[data-example-lang="prolog"]) .help-example-insert`).first().click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    state = await page.evaluate(() => window._cells[window._cells.length - 1]);
    check('a Prolog example becomes a Prolog cell', state.language === 'prolog' && state.type === 'code');

    // The Files & Storage modal's usage example uses the same code path.
    n = await page.evaluate(() => window._cells.length);
    await page.evaluate(() => {
        document.getElementById('help-modal').classList.add('hidden');
        document.getElementById('prolog-settings-modal').classList.remove('hidden');
    });
    await page.locator('#prolog-settings-modal .help-example-insert').click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    state = await page.evaluate(() => ({
        cell: window._cells[window._cells.length - 1].code,
        live: document.querySelector('#prolog-settings-modal .help-examples-live')?.textContent,
    }));
    check('the Files & Storage Prolog example inserts too',
        state.cell.startsWith('% After uploading myfile.pl:'), state.cell.slice(0, 40));
    await page.waitForTimeout(150);
    check('the Files & Storage modal has its own live region', /cell \d+/.test(state.live || '')
        || /cell \d+/.test(await page.evaluate(() =>
            document.querySelector('#prolog-settings-modal .help-examples-live')?.textContent || '')));
    await page.evaluate(() => document.getElementById('prolog-settings-modal').classList.add('hidden'));

    // A markdown-tagged example becomes a markdown cell.
    await openHelp(page);
    await page.evaluate(() => {
        const pre = document.createElement('pre');
        pre.id = 'md-fixture';
        pre.dataset.exampleLang = 'markdown';
        const code = document.createElement('code');
        code.textContent = '# Heading\n\nSome *text*.';
        pre.appendChild(code);
        document.querySelector('#help-modal .modal-content').appendChild(pre);
        window.helpExamples.init();
    });
    n = await page.evaluate(() => window._cells.length);
    await page.locator('.help-example:has(#md-fixture) .help-example-insert').click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    state = await page.evaluate(() => window._cells[window._cells.length - 1]);
    check('a markdown-tagged example becomes a markdown cell',
        state.type === 'markdown' && state.code === '# Heading\n\nSome *text*.', state.type);
    await page.evaluate(() => document.querySelector('.help-example:has(#md-fixture)').remove());

    /* ---------------------------- undo / show --------------------------- */
    console.log('\n4. Undo and Show');
    n = await page.evaluate(() => window._cells.length);
    await page.locator(`#help-modal .help-example:has(pre[data-example-lang="lua"]) .help-example-insert`).first().click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    const luaId = await page.evaluate(() => window._cells[window._cells.length - 1].id);
    await page.locator('#help-modal .help-example:has(pre[data-example-lang="lua"]) .help-example-undo').first().click();
    await page.waitForTimeout(150);
    state = await page.evaluate((id) => ({
        count: window._cells.length,
        present: window._cells.some((c) => c.id === id),
        card: Boolean(document.querySelector(`.card-input[data-cell-id="${id}"]`)),
        noticeHidden: document.querySelector('#help-modal .help-example:has(pre[data-example-lang="lua"]) .help-example-notice').hidden,
        live: document.querySelector('#help-modal .help-examples-live').textContent,
    }), luaId);
    check('Undo removes exactly the inserted cell',
        state.count === n && !state.present && !state.card, JSON.stringify(state));
    check('Undo hides the notice and announces the removal',
        state.noticeHidden && /removed/i.test(state.live), state.live);

    n = await page.evaluate(() => window._cells.length);
    await page.locator('#help-modal .help-example:has(pre[data-example-lang="bash"]) .help-example-insert').click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    const bashId = await page.evaluate(() => window._cells[window._cells.length - 1].id);
    await page.locator('#help-modal .help-example:has(pre[data-example-lang="bash"]) .help-example-show').click();
    await page.waitForTimeout(200);
    state = await page.evaluate((id) => {
        const card = document.querySelector(`.card-input[data-cell-id="${id}"]`);
        const r = card.getBoundingClientRect();
        return {
            helpHidden: document.getElementById('help-modal').classList.contains('hidden'),
            focused: document.activeElement === card,
            inView: r.bottom > 0 && r.top < innerHeight,
            language: card.dataset.language,
        };
    }, bashId);
    check('Show closes Help and focuses the new cell',
        state.helpHidden && state.focused && state.inView && state.language === 'bash', JSON.stringify(state));

    /* ------------------- insert while a cell is edited ------------------ */
    console.log('\n5. Insert while another cell is being edited');
    const editId = await page.evaluate(() => window._cells[0].id);
    await page.locator(`.card-input[data-cell-id="${editId}"] .cell-edit-btn`).click();
    await page.locator(`.card-input[data-cell-id="${editId}"] .cell-editor`).fill('edited = 42');
    await page.fill('#code-input', 'draft in composer');
    await openHelp(page);
    n = await page.evaluate(() => window._cells.length);
    await page.locator('#help-modal .help-example:has(pre[data-example-lang="javascript"]) .help-example-insert').click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    await page.evaluate(() => document.getElementById('help-modal').classList.add('hidden'));
    state = await page.evaluate((id) => {
        const card = document.querySelector(`.card-input[data-cell-id="${id}"]`);
        const editor = card.querySelector('.cell-editor');
        const composer = document.getElementById('code-input');
        return {
            editing: card.classList.contains('editing'),
            editorValue: editor && editor.value,
            composerValue: composer.value,
            composerVisible: composer.offsetParent !== null && getComputedStyle(composer).visibility !== 'hidden',
            runEnabled: !document.getElementById('run-btn').disabled,
            lastLang: window._cells[window._cells.length - 1].language,
        };
    }, editId);
    check('the open cell editor keeps its unsaved text',
        state.editing && state.editorValue === 'edited = 42', JSON.stringify(state));
    check('the composer keeps its draft, stays visible and Run stays enabled',
        state.composerValue === 'draft in composer' && state.composerVisible && state.runEnabled,
        JSON.stringify(state));
    check('the example still lands at the end as a JavaScript cell', state.lastLang === 'javascript');
    await page.locator(`.card-input[data-cell-id="${editId}"] .cell-cancel-btn`).click();
    state = await page.evaluate((id) => ({
        editing: document.querySelector(`.card-input[data-cell-id="${id}"]`).classList.contains('editing'),
    }), editId);
    check('the edit can still be cancelled normally afterwards', !state.editing);
    await page.fill('#code-input', '');

    /* ------------------------------- copy ------------------------------- */
    console.log('\n6. Copy');
    await openHelp(page);
    const rPre = '#help-modal pre[data-example-lang="r"]';
    const expectedR = await page.evaluate((s) => window.helpExamples.exampleCode(document.querySelector(s)), rPre);
    await page.locator(`#help-modal .help-example:has(> pre[data-example-lang="r"]) .help-example-copy`).first().click();
    await page.waitForTimeout(150);
    state = await page.evaluate(async (s) => ({
        clip: await navigator.clipboard.readText(),
        label: document.querySelector(s).parentElement.querySelector('.help-example-copy .help-example-label').textContent,
        live: document.querySelector('#help-modal .help-examples-live').textContent,
    }), rPre);
    check('Copy puts exactly the example code on the clipboard', state.clip === expectedR,
        JSON.stringify(state.clip.slice(0, 40)));
    check('Copy confirms visibly and to screen readers',
        state.label === 'Copied' && state.live === 'Copied', JSON.stringify(state));
    await page.waitForTimeout(2200);
    state = await page.evaluate((s) => document.querySelector(s).parentElement
        .querySelector('.help-example-copy .help-example-label').textContent, rPre);
    check('the Copy label reverts after the confirmation', state === 'Copy', state);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();

    /* ---------------------- copy without Clipboard API ------------------ */
    console.log('\n7. Copy falls back when the Clipboard API is unavailable');
    const legacy = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await legacy.addInitScript(initScript);
    await legacy.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
    });
    const page2 = await legacy.newPage();
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push(e.message));
    await ready(page2);
    await openHelp(page2);
    await page2.locator('#help-modal .help-example-copy').first().click();
    await page2.waitForTimeout(200);
    state = await page2.evaluate(() => ({
        hasApi: Boolean(navigator.clipboard),
        live: document.querySelector('#help-modal .help-examples-live').textContent,
        leftovers: document.querySelectorAll('body > textarea.visually-hidden').length,
    }));
    check('without navigator.clipboard the fallback reports Copied or the manual-copy message',
        !state.hasApi && (state.live === 'Copied' || /copy it manually/.test(state.live)), JSON.stringify(state));
    check('the fallback leaves no hidden textarea behind', state.leftovers === 0);
    check('no uncaught page errors in the fallback path', errors2.length === 0, errors2.join(' | '));
    await legacy.close();
} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.stack || err}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: help example tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
