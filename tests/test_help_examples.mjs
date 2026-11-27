// Playwright test: Copy and Insert buttons on the Help code examples.
//
//   PORT=8085 node server.js
//   node tests/test_help_examples.mjs        (PORT or SCIREPL_TEST_BASE to point elsewhere)
//
// No kernel is needed: Insert appends a cell WITHOUT running it, and that is
// exactly what this suite asserts.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const PORT = process.env.PORT || 8085;
const BASE = (process.env.SCIREPL_TEST_BASE || `http://localhost:${PORT}/`).replace(/\/?$/, '/');
const URL = `${BASE}index.html`;
const TIMEOUT = 60_000;
// sha256 (first 16 hex) of each example's English code, in document order, as it
// was before the comments were wired for translation. English must not drift.
const EN_EXAMPLE_HASHES = [
    'ab55a6e23f43e601', '391609d81fa3b149', '4d877d0beccf8702', 'b1c8e704e4f4c5ff',
    '137aec263b758eb8', '3340169ad943f56c', 'd38d1ca8b4b0c6bd', 'ee097774f50d4283',
    '16f971c6880477fb', 'a4c3262173f36222', '6c246a28d1d838d6', '3eb0a48918b21ae8',
    '414d30f212bdd596', 'ae7f7a140d6f9fd3', '4040314427768f2c', 'e8b59bdb33f80ccf',
];
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
    // Computed independently of the module under test.
    const expectedPy = await page.evaluate((s) => document.querySelector(s)
        .querySelector('code').textContent.replace(/\s+$/, ''), pyPre);
    check('the Python quick start is the example under test',
        expectedPy.startsWith('# Basic math') && expectedPy.includes('np.arange'), expectedPy.slice(0, 40));
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
    const linkSizes = await page.evaluate(() => {
        const wrap = document.querySelector('#help-modal pre[data-example-lang="python"]').parentElement;
        return [...wrap.querySelectorAll('.help-example-show, .help-example-undo')].map((b) => {
            const r = b.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
        });
    });
    check('Show and Undo are at least 44×44 CSS px',
        linkSizes.length === 2 && linkSizes.every((z) => z.w >= 44 && z.h >= 44), JSON.stringify(linkSizes));

    // The live region is a one-shot announcement: a locale switch must not
    // rewrite it (and so re-announce stale news) in the new language.
    const liveBefore = await page.evaluate(() => document.querySelector('#help-modal .help-examples-live').textContent);
    await page.evaluate(async () => { await window.i18n.activate('de'); });
    await page.waitForTimeout(150);
    state = await page.evaluate(() => {
        const region = document.querySelector('#help-modal .help-examples-live');
        return { text: region.textContent, key: region.getAttribute('data-i18n') };
    });
    check('a locale switch does not rewrite the live region',
        state.text === liveBefore && state.key === null, JSON.stringify({ liveBefore, ...state }));
    await page.evaluate(async () => { await window.i18n.activate('en'); });
    await page.waitForTimeout(150);

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

    // If the inserted cell is already gone, Show falls back to the Help button
    // and Undo does not claim to have removed anything.
    const bashBar = '#help-modal .help-example:has(pre[data-example-lang="bash"])';
    await openHelp(page);
    n = await page.evaluate(() => window._cells.length);
    await page.locator(`${bashBar} .help-example-insert`).click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    await page.evaluate(() => window.deleteCell(window._cells[window._cells.length - 1].id));
    await page.locator(`${bashBar} .help-example-show`).click();
    await page.waitForTimeout(150);
    state = await page.evaluate(() => ({
        helpHidden: document.getElementById('help-modal').classList.contains('hidden'),
        focus: document.activeElement && document.activeElement.id,
    }));
    check('Show for a cell that no longer exists closes Help and focuses the Help button',
        state.helpHidden && state.focus === 'help-btn', JSON.stringify(state));
    await openHelp(page);
    n = await page.evaluate(() => window._cells.length);
    await page.locator(`${bashBar} .help-example-insert`).click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    await page.waitForTimeout(120);
    await page.evaluate(() => window.deleteCell(window._cells[window._cells.length - 1].id));
    const liveBeforeUndo = await page.evaluate(() => document.querySelector('#help-modal .help-examples-live').textContent);
    await page.locator(`${bashBar} .help-example-undo`).click();
    await page.waitForTimeout(150);
    state = await page.evaluate(() => document.querySelector('#help-modal .help-examples-live').textContent);
    check('Undo for an already-deleted cell deletes nothing and says so instead of "removed"',
        state !== liveBeforeUndo && /^Not removed/.test(state), JSON.stringify({ liveBeforeUndo, state }));

    /* ---------------- run state while cells execute --------------------- */
    console.log('\n4b. Run state stays truthful while cells execute');
    await page.evaluate(async () => {
        const km = window.kernelManager;
        await km.ensureReady('javascript');
        // Hold any execution whose code contains HOLD_<name> until released.
        window.__holds = {};
        const original = km.execute.bind(km);
        km.execute = (code, language) => {
            const m = /HOLD_(\w+)/.exec(code);
            if (!m) return original(code, language);
            return new Promise((resolve) => {
                window.__holds[m[1]] = () => resolve({ stdout: '', result: null, error: null });
            });
        };
        const sel = document.getElementById('lang-selector');
        sel.value = 'javascript';
        sel.dispatchEvent(new Event('change'));
    });
    const runState = () => page.evaluate(() => ({
        runDisabled: document.getElementById('run-btn').disabled,
        status: document.getElementById('status-badge').getAttribute('data-i18n'),
    }));
    const startHeldRun = async (name) => {
        await page.evaluate(() => document.getElementById('help-modal').classList.add('hidden'));
        await page.fill('#code-input', `// HOLD_${name}`);
        await page.click('#run-btn');
        await page.waitForFunction((k) => Boolean(window.__holds[k]), name, { timeout: TIMEOUT });
    };

    // (a) A cell is running while an example is inserted.
    await startHeldRun('a');
    await openHelp(page);
    n = await page.evaluate(() => window._cells.length);
    await page.locator('#help-modal .help-example:has(> pre[data-example-lang="r"]) .help-example-insert').first().click();
    await page.waitForFunction((c) => window._cells.length === c + 1, n, { timeout: TIMEOUT });
    await page.waitForTimeout(100);
    state = await runState();
    check('(a) Insert during a running cell leaves Run disabled and the status running',
        state.runDisabled && state.status === 'app.status.running', JSON.stringify(state));
    await page.evaluate(() => window.__holds.a());
    await page.waitForFunction(() => !document.getElementById('run-btn').disabled, null, { timeout: TIMEOUT });
    state = await runState();
    check('(a) when that cell finishes, Run is enabled and Ready', !state.runDisabled
        && state.status === 'status.ready', JSON.stringify(state));

    // (b) An executing import ends enabled and Ready.
    state = await page.evaluate(async () => {
        await window.importCells([{ code: '1 + 1', type: 'code', language: 'javascript' }],
            { autoExecute: true });
        return {
            runDisabled: document.getElementById('run-btn').disabled,
            status: document.getElementById('status-badge').getAttribute('data-i18n'),
        };
    });
    check('(b) an autoExecute import ends with Run enabled and Ready',
        !state.runDisabled && state.status === 'status.ready', JSON.stringify(state));

    // (c) A running cell finishes while an import is still in flight.
    await startHeldRun('c1');
    await page.evaluate(() => {
        window.__importDone = false;
        window.importCells([{ code: '// HOLD_c2', type: 'code', language: 'javascript' }],
            { autoExecute: true }).then(() => { window.__importDone = true; });
    });
    await page.waitForFunction(() => Boolean(window.__holds.c2), null, { timeout: TIMEOUT });
    await page.evaluate(() => window.__holds.c1());
    await page.waitForTimeout(150);
    state = await runState();
    check('(c) the finished cell does not re-enable Run while the import still runs',
        state.runDisabled, JSON.stringify(state));
    await page.evaluate(() => window.__holds.c2());
    await page.waitForFunction(() => window.__importDone, null, { timeout: TIMEOUT });
    state = await runState();
    check('(c) once both finish, Run is enabled and Ready',
        !state.runDisabled && state.status === 'status.ready', JSON.stringify(state));
    await page.fill('#code-input', '');
    await page.evaluate(() => {
        const sel = document.getElementById('lang-selector');
        sel.value = 'python';
        sel.dispatchEvent(new Event('change'));
    });

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

    /* ---------------- Show / Undo across notebooks ---------------------- */
    console.log('\n5b. Show and Undo stay bound to the notebook that received the cell');
    const nbs = await page.evaluate(() => {
        const nm = window.notebookManager;
        return { a: nm.getActiveNotebook().id, b: nm.createNotebook({ name: 'Other' }).id };
    });
    const pyBar = '#help-modal .help-example:has(> pre[data-example-lang="python"])';
    const insertInto = async (bar) => {
        await openHelp(page);
        const count = await page.evaluate(() => window._cells.length);
        await page.locator(`${bar} .help-example-insert`).first().click();
        await page.waitForFunction((c) => window._cells.length === c + 1, count, { timeout: TIMEOUT });
        return page.evaluate(() => window._cells[window._cells.length - 1].id);
    };

    // Undo after switching to a notebook that has a cell with the same id.
    const undoId = await insertInto(pyBar);
    state = await page.evaluate(async ({ b, id }) => {
        window.notebookManager.switchTo(b);
        window._cellCounter = id - 1;
        const [twin] = await window.importCells([{ code: 'twin = True', type: 'code', language: 'python' }]);
        return { twinId: twin.id };
    }, { b: nbs.b, id: undoId });
    check('the other notebook now has a cell with the same id', state.twinId === undoId, JSON.stringify(state));
    await page.locator(`${pyBar} .help-example-undo`).first().click();
    await page.waitForTimeout(150);
    state = await page.evaluate(({ a, id }) => {
        const nm = window.notebookManager;
        return {
            twinSurvives: window._cells.some((c) => c.id === id && c.code === 'twin = True'),
            originalSurvives: nm.getNotebook(a).cells.some((c) => c.id === id),
            notice: document.querySelector('#help-modal .help-example:has(> pre[data-example-lang="python"]) .help-example-notice-text').textContent,
            live: document.querySelector('#help-modal .help-examples-live').textContent,
            stillActive: nm.getActiveNotebook().id,
        };
    }, { a: nbs.a, id: undoId });
    check('Undo after a notebook switch deletes nothing: the same-id cell in the open notebook survives',
        state.twinSurvives && state.originalSurvives, JSON.stringify(state));
    check('Undo explains why nothing was removed', /Not removed/.test(state.notice) && /Not removed/.test(state.live)
        && state.stillActive === nbs.b, JSON.stringify(state));

    // Show switches back to the notebook that received the cell.
    await page.evaluate((a) => window.notebookManager.switchTo(a), nbs.a);
    const bashBar2 = '#help-modal .help-example:has(> pre[data-example-lang="bash"])';
    const showId = await insertInto(bashBar2);
    await page.evaluate(() => { window.__shown = window._cells[window._cells.length - 1]; });
    await page.evaluate((b) => window.notebookManager.switchTo(b), nbs.b);
    await page.locator(`${bashBar2} .help-example-show`).click();
    // The notebook scroller animates (scroll-behavior: smooth); wait for it.
    await page.waitForFunction(() => {
        const r = window.__shown.inputCard.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight;
    }, null, { timeout: 5000 }).catch(() => {});
    state = await page.evaluate(({ a, id }) => {
        const card = window.__shown.inputCard;
        const r = card.getBoundingClientRect();
        return {
            active: window.notebookManager.getActiveNotebook().id === a,
            helpHidden: document.getElementById('help-modal').classList.contains('hidden'),
            focused: document.activeElement === card,
            visible: card.isConnected && card.getClientRects().length > 0 && r.bottom > 0 && r.top < innerHeight,
            id: window.__shown.id === id,
        };
    }, { a: nbs.a, id: showId });
    check('Show switches back to the receiving notebook and focuses the inserted cell',
        state.active && state.helpHidden && state.focused && state.visible && state.id, JSON.stringify(state));

    // Show when the receiving notebook has been closed.
    await page.evaluate((b) => window.notebookManager.switchTo(b), nbs.b);
    await insertInto(bashBar2);
    await page.evaluate(({ a, b }) => {
        const nm = window.notebookManager;
        nm.switchTo(a);
        nm.removeNotebook(b);
    }, nbs);
    await page.locator(`${bashBar2} .help-example-show`).click();
    await page.waitForTimeout(200);
    state = await page.evaluate(() => ({
        helpHidden: document.getElementById('help-modal').classList.contains('hidden'),
        focus: document.activeElement && document.activeElement.id,
        live: document.querySelector('body > .help-examples-live')?.textContent || '',
    }));
    check('Show for a closed notebook closes Help, focuses the Help button and says why',
        state.helpHidden && state.focus === 'help-btn' && /no longer available/.test(state.live),
        JSON.stringify(state));

    /* ------------------------------- copy ------------------------------- */
    console.log('\n6. Copy');
    await openHelp(page);
    const rPre = '#help-modal pre[data-example-lang="r"]';
    const expectedR = await page.evaluate((s) => document.querySelector(s)
        .querySelector('code').textContent.replace(/\s+$/, ''), rPre);
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

    /* ------------------------ translated comments ----------------------- */
    console.log('\n8. Example comments follow the UI language; the code does not');
    const loc = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await loc.addInitScript(initScript);
    await loc.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(BASE).origin });
    const page3 = await loc.newPage();
    const errors3 = [];
    page3.on('pageerror', (e) => errors3.push(e.message));
    page3.on('dialog', (d) => d.dismiss().catch(() => {}));
    await ready(page3);
    await openHelp(page3);

    // `template` replaces each translated span with its key, so everything
    // outside the spans (code, comment markers, literals' quotes) can be
    // compared byte-for-byte across locales.
    const snapshot = () => page3.evaluate(() => [...document.querySelectorAll('pre[data-example-lang]')].map((pre) => {
        const code = pre.querySelector('code');
        const clone = code.cloneNode(true);
        for (const el of clone.querySelectorAll('[data-i18n]')) {
            el.replaceWith(document.createTextNode(`\u0000${el.getAttribute('data-i18n')}\u0000`));
        }
        return {
            lang: pre.dataset.exampleLang,
            text: window.helpExamples.exampleCode(pre),
            raw: code.textContent.replace(/\s+$/, ''),
            template: clone.textContent,
            spans: [...code.querySelectorAll('[data-i18n]')].map((el) => [el.getAttribute('data-i18n'), el.textContent]),
            nested: code.querySelectorAll('[data-i18n] *, [data-i18n-html]').length,
            undirected: [...code.querySelectorAll('[data-i18n]')].filter((el) => el.getAttribute('data-i18n-dir') !== 'ltr').length,
        };
    }));
    const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
    const hashes = (shot) => shot.map((e) => createHash('sha256').update(e.raw).digest('hex').slice(0, 16));
    const english = await snapshot();
    const englishHashes = hashes(english);
    check('English example text is byte-identical to the pre-i18n examples',
        JSON.stringify(englishHashes) === JSON.stringify(EN_EXAMPLE_HASHES),
        JSON.stringify(english.filter((e, i) => englishHashes[i] !== EN_EXAMPLE_HASHES[i]).map((e) => e.raw.slice(0, 40))));
    const keys = [...new Set(english.flatMap((e) => e.spans.map(([k]) => k)))];
    check('comments are wired with plain-text spans that are kept left-to-right',
        keys.length >= 40 && english.every((e) => e.nested === 0 && e.undirected === 0),
        JSON.stringify({ keys: keys.length, bad: english.filter((e) => e.nested || e.undirected).map((e) => e.lang) }));
    check('only example keys are used inside code',
        keys.every((k) => /^help\.example(Comment|Label)\./.test(k)),
        JSON.stringify(keys.filter((k) => !/^help\.example(Comment|Label)\./.test(k))));

    const catalogues = await page3.evaluate(async () => {
        const manifest = await (await fetch('i18n/manifest.json', { cache: 'no-store' })).json();
        const out = {};
        for (const { code } of manifest.locales) {
            out[code] = await (await fetch(`i18n/${code}.json`, { cache: 'no-store' })).json();
        }
        return out;
    });
    const enStrings = catalogues.en.strings;
    const sharedLiteral = catalogues.en.__literal || [];
    const locales = Object.keys(catalogues).filter((c) => c !== 'en');
    // Tokens that are code, not prose: each must survive translation verbatim.
    const TOKENS = {
        'help.exampleComment.suppressOutput': [';'],
        'help.exampleComment.installShortcut': ['%install'],
        'help.exampleComment.writeNamedCellResultsFirst': ['"results"'],
        'help.exampleComment.afterUploading': ['myfile.pl'],
        'help.exampleComment.afterAddingSearchPath': ['mylib', '/user/mylib'],
        'help.exampleComment.orUseLoadUrl': ['load_url', 'consult'],
    };
    const catalogueProblems = [];
    for (const k of keys) if (typeof enStrings[k] !== 'string') catalogueProblems.push(`en: missing ${k}`);
    for (const code of locales) {
        const strings = catalogues[code].strings || {};
        const literal = new Set([...sharedLiteral, ...(strings.__literal || [])]);
        for (const k of keys) {
            const v = strings[k];
            if (typeof v !== 'string' || !v.trim()) { catalogueProblems.push(`${code}: missing ${k}`); continue; }
            if (v !== v.trim() || /[\r\n]/.test(v) || BIDI.test(v)) {
                catalogueProblems.push(`${code}: ${k} has edge whitespace, a line break or a bidi control`);
            }
            if (k.startsWith('help.exampleLabel.') && /["\\]/.test(v)) catalogueProblems.push(`${code}: ${k} would break its string literal`);
            if (v === enStrings[k] && !literal.has(k)) catalogueProblems.push(`${code}: ${k} is untranslated and not in __literal`);
            for (const token of TOKENS[k] || []) if (!v.includes(token)) catalogueProblems.push(`${code}: ${k} lost ${token}`);
        }
    }
    check(`every locale (${locales.length}) has every example key, translated safely`,
        locales.length >= 12 && catalogueProblems.length === 0, catalogueProblems.slice(0, 8).join(' | '));

    // Switch language with Help open and every example already decorated.
    const localeProblems = [];
    const copyInsertProblems = [];
    let copyInsertChecked = 0;
    for (const code of locales) {
        await page3.evaluate(async (c) => { await window.i18n.activate(c); }, code);
        const shot = await snapshot();
        const strings = catalogues[code].strings;
        const literal = new Set([...sharedLiteral, ...(strings.__literal || [])]);
        shot.forEach((ex, i) => {
            const en = english[i];
            if (ex.template !== en.template) localeProblems.push(`${code}/${ex.lang}#${i}: code outside comments changed`);
            if (ex.text.split('\n').length !== en.text.split('\n').length) localeProblems.push(`${code}/${ex.lang}#${i}: line count changed`);
            if (BIDI.test(ex.raw)) localeProblems.push(`${code}/${ex.lang}#${i}: bidi controls in the code`);
            for (const [k, v] of ex.spans) {
                if (v !== strings[k]) localeProblems.push(`${code}: ${k} rendered ${JSON.stringify(v)}`);
                if (v === enStrings[k] && !literal.has(k)) localeProblems.push(`${code}: ${k} still English`);
            }
        });
        if (code === 'ja' || code === 'ar') {
            // Copy and Insert hand over exactly what the reader sees.
            const luaWrap = '#help-modal .help-example:has(> pre[data-example-lang="lua"])';
            const rendered = await page3.evaluate(() => document.querySelector('#help-modal pre[data-example-lang="lua"]')
                .querySelector('code').textContent.replace(/\s+$/, ''));
            await page3.locator(`${luaWrap} .help-example-copy`).first().click();
            await page3.waitForTimeout(150);
            const clip = await page3.evaluate(() => navigator.clipboard.readText());
            if (clip !== rendered) copyInsertProblems.push(`${code}: Copy differs from the rendered Lua example`);
            if (!clip.includes(strings['help.exampleComment.luaTables'])) copyInsertProblems.push(`${code}: Copy lost the translated comment`);
            const n = await page3.evaluate(() => window._cells.length);
            await page3.locator(`${luaWrap} .help-example-insert`).first().click();
            await page3.waitForFunction((m) => window._cells.length === m + 1, n, { timeout: TIMEOUT });
            const cell = await page3.evaluate(() => {
                const c = window._cells[window._cells.length - 1];
                return { code: c.code, language: c.language };
            });
            if (cell.code !== rendered || cell.language !== 'lua') copyInsertProblems.push(`${code}: Insert differs from the rendered Lua example`);
            copyInsertChecked++;
        }
    }
    check('in every locale only the comments change, and they show the catalogue text',
        localeProblems.length === 0, localeProblems.slice(0, 8).join(' | '));
    check('Copy and Insert give the translated example exactly as rendered (ja, ar)',
        copyInsertChecked === 2 && copyInsertProblems.length === 0, copyInsertProblems.join(' | '));

    await page3.evaluate(async () => { await window.i18n.activate('en-x-rtl'); });
    const rtlPreview = await snapshot();
    check('the RTL preview leaves the English examples untouched (no bidi controls)',
        rtlPreview.every((e, i) => e.raw === english[i].raw),
        JSON.stringify(rtlPreview.find((e, i) => e.raw !== english[i].raw)?.raw.slice(0, 60)));
    await page3.evaluate(async () => { await window.i18n.activate('en'); });
    check('switching back to English restores the original examples exactly',
        JSON.stringify(hashes(await snapshot())) === JSON.stringify(EN_EXAMPLE_HASHES));
    check('no uncaught page errors while switching languages', errors3.length === 0, errors3.join(' | '));
    await loc.close();
} catch (err) {
    failures++;
    console.log(`\n  [FAIL] test crashed: ${err && err.stack || err}`);
} finally {
    await browser.close();
}

console.log(`\n${failures === 0 ? 'PASS: help example tests passed!' : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures > 0 ? 1 : 0);
