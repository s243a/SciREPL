// Playwright regressions for the shared local-completion surface.
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const APP_URL = process.env.SCIREPL_TEST_BASE || 'http://localhost:8085/';
const TIMEOUT = 120_000;
// Layout engines can report a CSS 44px target as 43.99998px after fractional
// device-pixel rounding. Keep the oracle strict without treating that as loss.
const MIN_TOUCH_TARGET = 43.99;
const APP_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
let failures = 0;
let checks = 0;
function check(name, condition, detail = '') {
    checks++;
    if (!condition) failures++;
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
}

console.log('0. Static shell and translation gates');
const html = readFileSync('www/index.html', 'utf8');
const sw = readFileSync('www/sw.js', 'utf8');
for (const asset of ['js/completion_surface.js', 'js/local_completion.js']) {
    check(`${asset} is loaded by the app`, html.includes(`src="${asset}"`));
    check(`${asset} is precached`, sw.includes(`'./${asset}'`));
}
const freeCompletionSource = readFileSync('www/js/completion_surface.js', 'utf8')
    + readFileSync('www/js/local_completion.js', 'utf8');
check('Free completion modules contain no network or AI-provider path',
    !/\b(?:fetch|XMLHttpRequest|WebSocket|sendMessage)\b|openrouter|anthropic/i.test(freeCompletionSource));
check('Free does not load an AI completion provider',
    !/src=["'][^"']*ai[_-]completion/i.test(html));
const completionKeys = [
    'autocomplete.accept', 'autocomplete.acceptLocalAria',
    'autocomplete.acceptLocalAriaWithSuggestion',
    'autocomplete.localCompletion', 'autocomplete.modeAuto',
    'autocomplete.modeOn', 'autocomplete.modeOff'
];
for (const file of readdirSync('www/i18n').filter((name) =>
    /^(?:en|ar|bn|de|es|fr|hi|id|ja|ko|pt-BR|ru|zh)\.json$/.test(name))) {
    const strings = JSON.parse(readFileSync('www/i18n/' + file, 'utf8')).strings;
    check(`${file} has every completion string`, completionKeys.every((key) =>
        typeof strings[key] === 'string' && strings[key].trim()),
    completionKeys.filter((key) => !strings[key]).join(','));
}

const browser = await chromium.launch({ headless: true });

async function open(options = {}) {
    const context = await browser.newContext({
        viewport: options.viewport || { width: 800, height: 700 },
        hasTouch: !!options.hasTouch
    });
    await context.addInitScript((settings) => {
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        localStorage.setItem('scirepl_local_completion', settings.completion || 'on');
        localStorage.setItem('scirepl_whats_new_seen_version', settings.appVersion);
    }, { completion: options.completion || 'on', appVersion: APP_VERSION });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(async () => {
        if (window.i18n?.init) await window.i18n.init();
        return window.__SCIREPL_APP_READY === true
            && document.getElementById('status-badge')?.className === 'ready';
    }, null, { timeout: TIMEOUT });
    return { context, page, pageErrors };
}

async function setComposer(page, value, selection = value.length) {
    await page.evaluate(({ value, selection }) => {
        const input = document.getElementById('code-input');
        input.focus();
        input.value = value;
        input.selectionStart = input.selectionEnd = selection;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }, { value, selection });
}

async function waitGhost(page, suffix) {
    await page.waitForFunction((wanted) => {
        const shell = document.querySelector('.completion-editor-composer');
        return shell?.classList.contains('has-completion')
            && shell.querySelector('.completion-ghost-suffix')?.textContent === wanted;
    }, suffix, { timeout: 10_000 });
}

try {
    console.log('1. Composer value, ghost, acceptance, and legacy Tab');
    let { context, page, pageErrors } = await open();
    const completionRequests = [];
    page.on('request', (request) => completionRequests.push(request.url()));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    let state = await page.evaluate(() => {
        const shell = document.querySelector('.completion-editor-composer');
        const input = document.getElementById('code-input');
        const button = document.querySelector('#input-bar .composer-primary-action > .completion-accept-btn');
        return {
            value: input.value,
            suffix: shell.querySelector('.completion-ghost-suffix').textContent,
            mirrorHidden: shell.querySelector('.completion-ghost').getAttribute('aria-hidden'),
            mirrorTag: shell.querySelector('.completion-ghost').tagName,
            buttonHidden: button.hidden,
            buttonLabel: button.getAttribute('aria-label'),
            controls: button.getAttribute('aria-controls'),
            runVisibility: getComputedStyle(document.getElementById('run-btn')).visibility,
            actionHit: (() => {
                const rect = button.getBoundingClientRect();
                const hit = document.elementFromPoint(
                    rect.left + rect.width / 2, rect.top + rect.height / 2
                );
                return hit === button || button.contains(hit);
            })()
        };
    });
    check('ghost does not mutate the textarea', state.value === 'pri', JSON.stringify(state));
    check('mirror is non-authoritative and excluded from the accessibility tree',
        state.mirrorHidden === 'true' && state.mirrorTag === 'DIV', JSON.stringify(state));
    check('accept control is labelled and controls the composer',
        !state.buttonHidden && state.buttonLabel === 'Accept local code completion: print'
        && state.controls === 'code-input', JSON.stringify(state));
    check('Run swaps to a hittable Accept action in the first painted suggestion frame',
        state.runVisibility === 'hidden' && state.actionHit, JSON.stringify(state));
    check('the textarea advertises inline completion without exposing the visual mirror',
        await page.getAttribute('#code-input', 'aria-autocomplete') === 'inline');
    const widthWithSuggestion = await page.locator('#code-input').evaluate((element) =>
        element.getBoundingClientRect().width);
    await setComposer(page, 'xyz');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const widthWithoutSuggestion = await page.locator('#code-input').evaluate((element) =>
        element.getBoundingClientRect().width);
    check('showing Accept never changes the composer width or reflows source text',
        Math.abs(widthWithSuggestion - widthWithoutSuggestion) < 0.5,
        JSON.stringify({ widthWithSuggestion, widthWithoutSuggestion }));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    state = await page.evaluate(() => {
        const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const luminance = (value) => {
            const channels = rgb(value).map((part) => {
                const normalized = part / 255;
                return normalized <= 0.04045 ? normalized / 12.92
                    : Math.pow((normalized + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        const measure = () => {
            const suffix = getComputedStyle(document.querySelector('.completion-ghost-suffix'));
            const editor = getComputedStyle(document.getElementById('code-input'));
            const a = luminance(suffix.color);
            const b = luminance(editor.backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        document.documentElement.dataset.theme = 'dark';
        const dark = measure();
        document.documentElement.dataset.theme = 'light';
        const light = measure();
        document.documentElement.dataset.theme = 'dark';
        return { dark, light };
    });
    check('ghost text remains distinguishable in dark and light themes',
        state.dark >= 4.5 && state.light >= 4.5, JSON.stringify(state));
    await page.keyboard.press('ArrowRight');
    await waitGhost(page, 'nt');
    state = await page.evaluate(() => ({
        value: document.getElementById('code-input').value,
        caret: document.getElementById('code-input').selectionStart
    }));
    check('Right Arrow remains ordinary caret navigation and never accepts',
        state.value === 'pri' && state.caret === 3, JSON.stringify(state));
    await page.keyboard.press('Shift+Tab');
    state = await page.evaluate(() => ({
        value: document.getElementById('code-input').value,
        focused: document.activeElement === document.getElementById('code-input')
    }));
    check('Shift+Tab preserves reverse focus navigation instead of accepting',
        state.value === 'pri' && !state.focused, JSON.stringify(state));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.keyboard.press('Tab');
    state = await page.evaluate(() => ({
        value: document.getElementById('code-input').value,
        caret: document.getElementById('code-input').selectionStart,
        cells: window._cells.length,
        runVisibility: getComputedStyle(document.getElementById('run-btn')).visibility,
        acceptHidden: document.querySelector(
            '#input-bar .composer-primary-action > .completion-accept-btn'
        ).hidden
    }));
    check('Tab accepts only the suffix without executing',
        state.value === 'print' && state.caret === 5 && state.cells === 0
        && state.runVisibility === 'visible' && state.acceptHidden, JSON.stringify(state));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('typing and accepting local completion makes no network request',
        completionRequests.length === 0, completionRequests.join(' | '));
    await setComposer(page, 'xyz');
    await page.keyboard.press('Tab');
    state = await page.evaluate(() => document.getElementById('code-input').value);
    check('Tab still inserts four spaces without a suggestion', state === 'xyz    ', JSON.stringify(state));

    await page.evaluate(() => {
        window.__completionBeforeInputs = [];
        document.getElementById('code-input').addEventListener('beforeinput', (event) => {
            window.__completionBeforeInputs.push({
                inputType: event.inputType,
                data: event.data
            });
        });
    });
    await page.click('#code-input');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('pri');
    await waitGhost(page, 'nt');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Control+Z');
    state = await page.evaluate(() => ({
        value: document.getElementById('code-input').value,
        beforeInputs: window.__completionBeforeInputs
    }));
    check('keyboard completion acceptance is one native undo transaction',
        state.value === 'pri'
        && state.beforeInputs.some((item) => item.inputType === 'insertText' && item.data === 'nt'),
        JSON.stringify(state));
    await page.keyboard.press('Control+Shift+Z');
    check('keyboard completion acceptance participates in Redo',
        await page.inputValue('#code-input') === 'print');

    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('ret');
    await waitGhost(page, 'urn');
    await page.click('#input-bar .composer-primary-action > .completion-accept-btn');
    await page.keyboard.press('Control+Z');
    check('pointer completion acceptance is reversible without losing editor focus',
        await page.evaluate(() => {
            const input = document.getElementById('code-input');
            return input.value === 'ret' && document.activeElement === input;
        }));
    await page.keyboard.press('Control+Shift+Z');
    check('pointer completion acceptance participates in Redo',
        await page.inputValue('#code-input') === 'return');

    console.log('2. Eligibility, shrinking, and Escape precedence');
    await setComposer(page, 'ret');
    await waitGhost(page, 'urn');
    await setComposer(page, 'retu');
    await waitGhost(page, 'rn');
    check('matching input shrinks the suffix', true);
    for (const probe of ["'pri", '# pri', 'obj.pri', 'pri tail']) {
        await setComposer(page, probe, probe === 'pri tail' ? 3 : probe.length);
        const visible = await page.evaluate(() =>
            document.querySelector('.completion-editor-composer').classList.contains('has-completion'));
        check(`${JSON.stringify(probe)} is outside v1 completion`, !visible);
    }
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.keyboard.press('Escape');
    state = await page.evaluate(() => ({
        value: document.getElementById('code-input').value,
        visible: document.querySelector('.completion-editor-composer').classList.contains('has-completion')
    }));
    check('Escape dismisses without changing the composer', state.value === 'pri' && !state.visible);

    await setComposer(page, 'x = 1\n'.repeat(60) + 'pri');
    await page.evaluate(() => {
        const input = document.getElementById('code-input');
        input.scrollTop = input.scrollHeight;
        input.dispatchEvent(new Event('scroll'));
    });
    await waitGhost(page, 'nt');
    await page.evaluate(() => {
        const input = document.getElementById('code-input');
        input.scrollTop = 0;
        input.dispatchEvent(new Event('scroll'));
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('scrolling the caret/ghost out of view withdraws the proposal and action',
        await page.evaluate(() =>
            !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    await page.evaluate(() => {
        const input = document.getElementById('code-input');
        input.scrollTop = input.scrollHeight;
        input.dispatchEvent(new Event('scroll'));
    });
    await waitGhost(page, 'nt');
    check('scrolling the caret back into view safely restores the same proposal', true);
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');

    console.log('3. Programmatic context changes and setting override');
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.selectOption('#lang-selector', 'r');
    check('changing language clears completion', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    await setComposer(page, '%%python\npri');
    await waitGhost(page, 'nt');
    check('%%python uses Python completion even when the selector says R', true);
    await page.selectOption('#lang-selector', 'python');
    await setComposer(page, '%%bash\npri');
    check('a non-Python %% magic suppresses Python completion', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    await setComposer(page, '%pip install pri');
    check('%pip requirement text never receives identifier completion', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.click('#cell-type-toggle');
    check('Markdown clears completion', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    await page.click('#cell-type-toggle');
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.selectOption('#setting-local-completion', 'off');
    state = await page.evaluate(() => ({
        stored: localStorage.getItem('scirepl_local_completion'),
        visible: document.querySelector('.completion-editor-composer').classList.contains('has-completion')
    }));
    check('the Settings control persists Off and clears completion immediately',
        state.stored === 'off' && !state.visible, JSON.stringify(state));
    await page.selectOption('#setting-local-completion', 'auto');
    state = await page.evaluate(() => ({
        stored: localStorage.getItem('scirepl_local_completion'),
        selected: document.getElementById('setting-local-completion').value
    }));
    check('Auto remains an explicit unset choice rather than a persisted inference',
        state.stored === null && state.selected === 'auto', JSON.stringify(state));
    await page.evaluate(() => document.getElementById('settings-modal').classList.add('hidden'));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    check('Auto enables local completion on a desktop pointer', true);
    await page.evaluate(() => {
        const checkbox = document.getElementById('setting-large-touch');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.body.classList.contains('force-mobile')
        && !document.querySelector('.completion-editor-composer').classList.contains('has-completion'));
    check('enabling Large Touch immediately disables an existing Auto suggestion', true);
    await page.evaluate(() => {
        const checkbox = document.getElementById('setting-large-touch');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitGhost(page, 'nt');
    check('disabling Large Touch immediately restores eligible Auto completion', true);
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.selectOption('#setting-local-completion', 'on');
    await page.evaluate(() => document.getElementById('settings-modal').classList.add('hidden'));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');

    console.log('4. Execution lifecycle is identity-only and generation-safe');
    state = await page.evaluate(async () => {
        const km = window.kernelManager;
        const started = [];
        const settled = [];
        const invalidated = [];
        const onStarted = (event) => started.push(event.detail);
        const onSettled = (event) => settled.push(event.detail);
        const onInvalidated = (event) => invalidated.push(event.detail);
        window.addEventListener('scirepl:kernel-execution-started', onStarted);
        window.addEventListener('scirepl:kernel-execution-settled', onSettled);
        window.addEventListener('scirepl:kernel-invalidated', onInvalidated);
        await km.trackExecution('lifecycle-test', async () => ({ stdout: 'SECRET_RESULT' }), {
            origin: 'autocomplete-test', code: 'SECRET_CODE'
        });
        await km.trackExecution('lifecycle-test', async () => ({ error: 'SECRET_ERROR' }), {
            origin: 'autocomplete-test'
        });
        try {
            await km.trackExecution('lifecycle-test', async () => {
                throw new Error('SECRET_THROW');
            }, { origin: 'autocomplete-test' });
        } catch (_) { /* propagation is expected */ }

        class ProbeKernel {
            isReady() { return true; }
            async destroy() { this.destroyed = true; }
        }
        km.register('completion-generation-probe', ProbeKernel);
        km.getKernel('completion-generation-probe');
        const generationBefore = km.getKernelGeneration('completion-generation-probe');
        await km.destroyKernel('completion-generation-probe');
        const generationInvalidated = km.getKernelGeneration('completion-generation-probe');
        km.getKernel('completion-generation-probe');
        const generationRecreated = km.getKernelGeneration('completion-generation-probe');
        await km.destroyKernel('completion-generation-probe');
        delete km._registry['completion-generation-probe'];

        const originalTrack = km.trackExecution;
        const routed = [];
        km.trackExecution = async (language, _fn, meta) => {
            routed.push({ language, origin: meta?.origin, keys: Object.keys(meta || {}) });
            return { wrapped: true };
        };
        await window._appInternals.executeCode('%%python\nSECRET_MAGIC', 'r');
        await window._appInternals.executeCode('%pip install SECRET_REQUIREMENT', 'python');
        km.trackExecution = originalTrack;

        window.removeEventListener('scirepl:kernel-execution-started', onStarted);
        window.removeEventListener('scirepl:kernel-execution-settled', onSettled);
        window.removeEventListener('scirepl:kernel-invalidated', onInvalidated);
        return {
            started,
            settled,
            invalidated,
            active: km.isExecutionActive('lifecycle-test'),
            serialized: JSON.stringify({ started, settled, invalidated }),
            generations: [generationBefore, generationInvalidated, generationRecreated],
            routed
        };
    });
    check('success, returned error, and throw all emit a settled outcome',
        state.settled.map((item) => item.outcome).join(',') === 'ok,reported-error,threw',
        JSON.stringify(state.settled));
    check('lifecycle payloads expose IDs and timing but never code or results',
        state.started.length === 3 && state.settled.length === 3 && !state.active
        && state.started.every((item) => Number.isSafeInteger(item.executionId)
            && item.language === 'lifecycle-test')
        && !/SECRET_CODE|SECRET_RESULT|SECRET_ERROR|SECRET_THROW/.test(state.serialized));
    check('destroy/recreate advances kernel generations and emits invalidation',
        state.generations[0] < state.generations[1]
        && state.generations[1] < state.generations[2]
        && state.invalidated.some((item) => item.language === 'completion-generation-probe'),
        JSON.stringify(state.generations));
    check('Python magic and %pip paths enter the lifecycle envelope before execution',
        state.routed.length === 2
        && state.routed.every((item) => item.language === 'python'
            && item.origin === 'app-python'
            && item.keys.join(',') === 'origin'), JSON.stringify(state.routed));

    console.log('5. Existing-cell binding and teardown');
    await page.evaluate(() => {
        const id = 9001;
        const card = window._appInternals.createInputCard('pri', id, 'code', 'python');
        window._appInternals.getRepl().appendChild(card);
        window._cells.push({
            id, code: 'pri', type: 'code', language: 'python', name: '',
            inputCard: card, outputCard: null
        });
        card.querySelector('.cell-edit-btn').click();
    });
    await page.waitForFunction(() => document.querySelector('.completion-editor-cell.has-completion'));
    state = await page.evaluate(() => ({
        composerValue: document.getElementById('code-input').value,
        editorValue: document.querySelector('.cell-editor').value,
        editorSuffix: document.querySelector('.completion-editor-cell .completion-ghost-suffix').textContent
    }));
    check('existing-cell suggestion is scoped to that editor',
        state.editorValue === 'pri' && state.editorSuffix === 'nt', JSON.stringify(state));
    await page.keyboard.press('Escape');
    check('first Escape dismisses suggestion but keeps edit mode', await page.evaluate(() =>
        !!document.querySelector('.cell-editor')
        && !document.querySelector('.completion-editor-cell').classList.contains('has-completion')));
    await page.keyboard.press('Escape');
    check('second Escape retains existing cancel-edit behavior', await page.evaluate(() =>
        !document.querySelector('.cell-editor') && !document.querySelector('.completion-editor-cell')));

    await page.evaluate(() => {
        for (const def of [
            { id: 9002, code: 'pri' },
            { id: 9003, code: 'ret' }
        ]) {
            const card = window._appInternals.createInputCard(def.code, def.id, 'code', 'python');
            window._appInternals.getRepl().appendChild(card);
            window._cells.push({
                id: def.id, code: def.code, type: 'code', language: 'python', name: '',
                inputCard: card, outputCard: null
            });
            card.querySelector('.cell-edit-btn').click();
        }
    });
    await page.selectOption('.card-input[data-cell-id="9002"] .cell-lang-switch', 'r');
    await page.evaluate(() =>
        document.querySelector('.card-input[data-cell-id="9002"] .cell-lang-apply-all').click());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    state = await page.evaluate(() => ({
        languages: [9002, 9003].map((id) => ({
            model: window._cells.find((cell) => cell.id === id)?.language,
            selector: document.querySelector(`.card-input[data-cell-id="${id}"] .cell-lang-switch`)?.value
        })),
        visible: document.querySelectorAll('.completion-editor-cell.has-completion').length
    }));
    check('Apply-to-all synchronizes every open editor model, selector, and completion context',
        state.languages.every((item) => item.model === 'r' && item.selector === 'r')
        && state.visible === 0, JSON.stringify(state));
    await page.selectOption('.card-input[data-cell-id="9002"] .cell-lang-switch', 'python');
    await page.evaluate(() =>
        document.querySelector('.card-input[data-cell-id="9002"] .cell-lang-apply-all').click());
    await page.evaluate(() => {
        const editor = document.querySelector('.card-input[data-cell-id="9003"] .cell-editor');
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9003"] .completion-ghost-suffix')?.textContent === 'urn');
    await page.keyboard.press('Tab');
    state = await page.evaluate(() => ({
        first: document.querySelector('.card-input[data-cell-id="9002"] .cell-editor').value,
        second: document.querySelector('.card-input[data-cell-id="9003"] .cell-editor').value,
        surfaces: window.localCompletion.controller.surfaces.size
    }));
    check('Tab accepts in only the focused one of two independent cell editors',
        state.first === 'pri' && state.second === 'return' && state.surfaces === 3,
        JSON.stringify(state));
    await page.evaluate(() => {
        const editor = document.querySelector('.card-input[data-cell-id="9002"] .cell-editor');
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9002"] .completion-ghost-suffix')?.textContent === 'nt');
    await page.click('.card-input[data-cell-id="9002"] .completion-accept-btn');
    state = await page.evaluate(() => {
        const editor = document.querySelector('.card-input[data-cell-id="9002"] .cell-editor');
        return {
            value: editor.value,
            focused: document.activeElement === editor,
            label: document.querySelector('.card-input[data-cell-id="9002"] .completion-accept-btn')
                .getAttribute('aria-label')
        };
    });
    check('the cell Accept action inserts exactly once and restores editor focus',
        state.value === 'print' && state.focused
        && state.label === 'Accept local code completion', JSON.stringify(state));
    await page.evaluate(() => {
        for (const id of [9002, 9003]) {
            document.querySelector(`.card-input[data-cell-id="${id}"] .cell-cancel-btn`)?.click();
        }
    });
    check('leaving both edit modes destroys their surfaces and listeners', await page.evaluate(() =>
        window.localCompletion.controller.surfaces.size === 1
        && document.querySelectorAll('.completion-editor-cell').length === 0));

    state = await page.evaluate(() => {
        const manager = window.notebookManager;
        const active = manager.getActiveNotebook();
        manager.renameNotebook(active.id, 'Autocomplete regression');
        return {
            id: manager.getActiveNotebook().id,
            name: manager.getActiveNotebook().name
        };
    });
    check('renaming a notebook does not masquerade as a notebook switch',
        state.name === 'Autocomplete regression' && !!state.id, JSON.stringify(state));

    state = await page.evaluate(() => {
        const manager = window.notebookManager;
        const originalId = manager.getActiveNotebook().id;
        const temporary = manager.createNotebook({ name: 'Completion teardown' });
        manager.switchTo(temporary.id);
        const id = 9011;
        const card = window._appInternals.createInputCard('pri', id, 'code', 'python');
        window._appInternals.getRepl().appendChild(card);
        window._cells.push({
            id, code: 'pri', type: 'code', language: 'python', name: '',
            inputCard: card, outputCard: null
        });
        card.querySelector('.cell-edit-btn').click();
        const withTemporaryEditor = window.localCompletion.controller.surfaces.size;
        manager.switchTo(originalId);
        manager.removeNotebook(temporary.id);
        return {
            withTemporaryEditor,
            afterRemoval: window.localCompletion.controller.surfaces.size,
            removed: !document.getElementById('repl-' + temporary.id),
            active: manager.getActiveNotebook().id
        };
    });
    check('removing a hidden notebook destroys its completion surfaces',
        state.withTemporaryEditor === 2 && state.afterRemoval === 1
        && state.removed && !!state.active, JSON.stringify(state));

    state = await page.evaluate(() => {
        const baseline = window.localCompletion.controller.surfaces.size;
        const id = 9020;
        const card = window._appInternals.createInputCard('pri', id, 'code', 'python');
        window._appInternals.getRepl().appendChild(card);
        window._cells.push({
            id, code: 'pri', type: 'code', language: 'python',
            name: 'vfs-completion-regression', inputCard: card, outputCard: null
        });
        card.querySelector('.cell-edit-btn').click();
        return { baseline, index: window._cells.length - 1 };
    });
    const vfsBaselineSurfaces = state.baseline;
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9020"] .completion-ghost-suffix')?.textContent === 'nt');
    state = await page.evaluate(() => {
        const index = window._cells.findIndex((cell) => cell.id === 9020);
        const wrote = window.notebookVFS._setCellProperty(index, '.language', 'r');
        const card = document.querySelector('.card-input[data-cell-id="9020"]');
        return {
            wrote,
            model: window._cells[index].language,
            selector: card.querySelector('.cell-lang-switch').value,
            dataset: card.dataset.language,
            visible: card.querySelector('.completion-editor-cell').classList.contains('has-completion')
        };
    });
    check('NotebookVFS language writes synchronize the open editor and clear stale Python completion',
        state.wrote && state.model === 'r' && state.selector === 'r'
        && state.dataset === 'r' && !state.visible, JSON.stringify(state));

    await page.evaluate(() => {
        const index = window._cells.findIndex((cell) => cell.id === 9020);
        window.notebookVFS._setCellProperty(index, '.language', 'python');
        window.notebookVFS._setCellProperty(index, '.type', 'markdown');
    });
    state = await page.evaluate(() => {
        const card = document.querySelector('.card-input[data-cell-id="9020"]');
        const editor = card.querySelector('.cell-editor');
        return {
            model: window._cells.find((cell) => cell.id === 9020).type,
            dataset: card.dataset.cellType,
            markdownCard: card.classList.contains('card-markdown'),
            editorDir: editor.dir,
            spellcheck: editor.spellcheck,
            typeLabel: card.querySelector('.cell-type-switch-btn').textContent,
            visible: card.querySelector('.completion-editor-cell').classList.contains('has-completion')
        };
    });
    check('NotebookVFS type writes synchronize Markdown UI and completion context',
        state.model === 'markdown' && state.dataset === 'markdown' && state.markdownCard
        && state.editorDir === 'auto' && state.spellcheck && state.typeLabel === 'Md'
        && !state.visible, JSON.stringify(state));

    await page.evaluate(() => {
        const index = window._cells.findIndex((cell) => cell.id === 9020);
        window.notebookVFS._setCellProperty(index, '.type', 'code');
        window.notebookVFS._setCellProperty(index, '.code', 'ret');
        const editor = document.querySelector('.card-input[data-cell-id="9020"] .cell-editor');
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9020"] .completion-ghost-suffix')?.textContent === 'urn');
    state = await page.evaluate(() => {
        const card = document.querySelector('.card-input[data-cell-id="9020"]');
        const cell = window._cells.find((item) => item.id === 9020);
        return {
            modelCode: cell.code,
            editorCode: card.querySelector('.cell-editor').value,
            type: cell.type,
            dataset: card.dataset.cellType,
            dir: card.querySelector('.cell-editor').dir
        };
    });
    check('NotebookVFS source writes replace an open editor authoritatively',
        state.modelCode === 'ret' && state.editorCode === 'ret'
        && state.type === 'code' && state.dataset === 'code' && state.dir === 'ltr',
        JSON.stringify(state));

    await page.evaluate(() => {
        localStorage.setItem('scirepl_enabled_languages', JSON.stringify(['r']));
        window.fileIO._rebuildLanguageDropdowns();
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9020"] .completion-ghost-suffix')?.textContent === 'urn');
    state = await page.evaluate(() => {
        const card = document.querySelector('.card-input[data-cell-id="9020"]');
        const cell = window._cells.find((item) => item.id === 9020);
        const result = {
            model: cell.language,
            selector: card.querySelector('.cell-lang-switch').value,
            hasPythonOption: !!card.querySelector('.cell-lang-switch option[value="python"]'),
            visible: card.querySelector('.completion-editor-cell').classList.contains('has-completion')
        };
        localStorage.removeItem('scirepl_enabled_languages');
        window.fileIO._rebuildLanguageDropdowns();
        const main = document.getElementById('lang-selector');
        main.value = 'python';
        main.dispatchEvent(new Event('change', { bubbles: true }));
        return result;
    });
    check('language-profile rebuilding preserves an edited cell\'s authoritative language',
        state.model === 'python' && state.selector === 'python'
        && state.hasPythonOption && state.visible, JSON.stringify(state));

    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(async () => { await window.i18n.activate('de'); });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('.card-input[data-cell-id="9020"] .cell-editor').press('Escape');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    state = await page.evaluate(() => {
        const actions = document.querySelector('.card-input[data-cell-id="9020"] .cell-edit-actions');
        const controls = [...actions.querySelectorAll(':scope > button, :scope > select')]
            .filter((control) => {
                const rect = control.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const rows = [];
        for (const control of controls) {
            const rect = control.getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            if (!rows.some((known) => Math.abs(known - center) < 1)) rows.push(center);
        }
        return {
            rows: rows.length,
            compact: actions.querySelector('.cell-run-below-btn')
                .classList.contains('cell-action-icon-only'),
            allHit: controls.every((control) => {
                const rect = control.getBoundingClientRect();
                const hit = document.elementFromPoint(
                    rect.left + rect.width / 2, rect.top + rect.height / 2
                );
                return hit === control || control.contains(hit);
            })
        };
    });
    check('locale changes while Accept is visible restore a compact, hittable legacy toolbar',
        state.rows <= 2 && state.compact && state.allHit, JSON.stringify(state));

    await page.setViewportSize({ width: 411, height: 640 });
    await page.evaluate(async () => { await window.i18n.activate('fr'); });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const normalFrenchCompaction = await page.evaluate(() => {
        const button = document.querySelector(
            '.card-input[data-cell-id="9020"] .cell-run-below-btn'
        );
        return button.classList.contains('cell-action-icon-only');
    });
    await page.evaluate(() => {
        const editor = document.querySelector('.card-input[data-cell-id="9020"] .cell-editor');
        editor.focus();
        editor.value = 'pri';
        editor.selectionStart = editor.selectionEnd = editor.value.length;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9020"] .completion-ghost-suffix')?.textContent === 'nt');
    await page.evaluate(async () => {
        await window.i18n.activate('es');
        await window.i18n.activate('fr');
        window.dispatchEvent(new Event('resize'));
    });
    await page.click('.card-input[data-cell-id="9020"] .completion-accept-btn');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    state = await page.evaluate(() => {
        const actions = document.querySelector('.card-input[data-cell-id="9020"] .cell-edit-actions');
        const centers = [];
        for (const control of actions.querySelectorAll(':scope > button, :scope > select')) {
            const rect = control.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            const center = rect.top + rect.height / 2;
            if (!centers.some((known) => Math.abs(known - center) < 1)) centers.push(center);
        }
        return {
            rows: centers.length,
            runVisible: getComputedStyle(actions.querySelector('.cell-run-btn')).display !== 'none',
            runBelowVisible: getComputedStyle(actions.querySelector('.cell-run-below-btn')).display !== 'none',
            compact: actions.querySelector('.cell-run-below-btn')
                .classList.contains('cell-action-icon-only')
        };
    });
    check('pointer acceptance restores the normal two-row toolbar without unnecessary compaction',
        state.rows <= 2 && state.runVisible && state.runBelowVisible
        && state.compact === normalFrenchCompaction,
        JSON.stringify({ ...state, normalFrenchCompaction }));
    await page.evaluate(async () => { await window.i18n.activate('en'); });
    await page.setViewportSize({ width: 800, height: 700 });

    await page.click('#search-btn');
    await page.evaluate(() => {
        const index = window._cells.findIndex((cell) => cell.id === 9020);
        window.notebookVFS._setCellProperty(index, '.code', 'uniqueSearchReplaceToken');
        const search = document.getElementById('search-input');
        const replacement = document.getElementById('replace-input');
        search.value = 'uniqueSearchReplaceToken';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        if (document.getElementById('search-replace-row').classList.contains('hidden')) {
            document.getElementById('search-replace-toggle').click();
        }
        replacement.value = 'pri';
        document.getElementById('replace-one-btn').click();
        document.querySelector('.card-input[data-cell-id="9020"] .cell-editor').focus();
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9020"] .completion-ghost-suffix')?.textContent === 'nt');
    state = await page.evaluate(() => {
        const cell = window._cells.find((item) => item.id === 9020);
        return {
            model: cell.code,
            editor: cell.inputCard.querySelector('.cell-editor').value
        };
    });
    check('Search/Replace synchronizes an open editor and its completion source',
        state.model === 'pri' && state.editor === 'pri', JSON.stringify(state));
    await page.click('#search-close-btn');

    state = await page.evaluate((baseline) => {
        const removed = window.notebookVFS.deleteCell('vfs-completion-regression');
        return {
            removed,
            surfaces: window.localCompletion.controller.surfaces.size,
            baseline,
            cardGone: !document.querySelector('.card-input[data-cell-id="9020"]')
        };
    }, vfsBaselineSurfaces);
    check('NotebookVFS deletion destroys the edited cell completion surface',
        state.removed && state.surfaces === state.baseline && state.cardGone, JSON.stringify(state));

    state = await page.evaluate(() => {
        const baseline = window.localCompletion.controller.surfaces.size;
        const id = 9021;
        const card = window._appInternals.createInputCard('pri', id, 'code', 'python');
        window._appInternals.getRepl().appendChild(card);
        window._cells.push({
            id, code: 'pri', type: 'code', language: 'python', name: '',
            inputCard: card, outputCard: null
        });
        card.querySelector('.cell-edit-btn').click();
        const whileEditing = window.localCompletion.controller.surfaces.size;
        const notebook = window.notebookManager.getActiveNotebook();
        window.fileIO._clearNotebookForImport(notebook);
        return {
            baseline,
            whileEditing,
            afterReplacement: window.localCompletion.controller.surfaces.size,
            remainingCells: window._cells.length,
            cardGone: !document.querySelector('.card-input[data-cell-id="9021"]')
        };
    });
    check('workbook replacement destroys every edited-cell completion surface',
        state.whileEditing === state.baseline + 1
        && state.afterReplacement === state.baseline
        && state.remainingCells === 0 && state.cardGone, JSON.stringify(state));

    console.log('6. IME and stale asynchronous result protection');
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.evaluate(() => {
        const input = document.getElementById('code-input');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ぷ' }));
    });
    check('compositionstart removes the suggestion', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    state = await page.evaluate(() => {
        const input = document.getElementById('code-input');
        const event = new KeyboardEvent('keydown', {
            key: 'Tab', bubbles: true, cancelable: true, isComposing: true
        });
        input.dispatchEvent(event);
        return { value: input.value, defaultPrevented: event.defaultPrevented };
    });
    check('composition keys bypass app shortcuts without cancelling the IME default',
        state.value === 'pri' && !state.defaultPrevented, JSON.stringify(state));
    state = await page.evaluate(() => {
        const input = document.getElementById('code-input');
        const session = window.sessionManager.session;
        const previousHistory = [...session.history];
        const previousIndex = session.historyIndex;
        session.history = ['print(123)'];
        session.historyIndex = -1;
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowUp', bubbles: true, cancelable: true, isComposing: true
        });
        input.dispatchEvent(event);
        const result = {
            value: input.value,
            defaultPrevented: event.defaultPrevented,
            historyIndex: session.historyIndex
        };
        session.history = previousHistory;
        session.historyIndex = previousIndex;
        return result;
    });
    check('IME candidate arrows bypass composer history without cancelling the native key',
        state.value === 'pri' && !state.defaultPrevented && state.historyIndex === -1,
        JSON.stringify(state));
    await page.evaluate(() => {
        const input = document.getElementById('code-input');
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ぷ' }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' }));
    });
    await waitGhost(page, 'nt');

    let resolveLate;
    await page.evaluate(() => {
        window.__lateCompletion = {};
        window.__lateCompletion.promise = new Promise((resolve) => {
            window.__lateCompletion.resolve = resolve;
        });
        window.localCompletion.controller.registerProvider({
            priority: -10,
            automatic: true,
            suggest(snapshot) {
                if (!snapshot.value.endsWith('zz')) return null;
                return window.__lateCompletion.promise;
            }
        });
    });
    await setComposer(page, 'zz');
    await setComposer(page, 'changed');
    await page.evaluate(() => window.__lateCompletion.resolve({
        text: 'Late', source: 'test', range: { start: 2, end: 2 }
    }));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('late result cannot attach to changed text', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    state = await page.evaluate(async () => {
        const surface = [...window.localCompletion.controller.surfaces]
            .find((item) => item.options.surface === 'composer');
        const original = surface.request.bind(surface);
        let requests = 0;
        surface.request = (...args) => {
            requests++;
            return original(...args);
        };
        window.visualViewport?.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        surface.request = original;
        return { supported: !!window.visualViewport, requests };
    });
    check('visual-viewport pan events re-evaluate suggestion geometry',
        !state.supported || state.requests > 0, JSON.stringify(state));

    console.log('7. Touch acceptance remains inside the usable UI');
    await page.setViewportSize({ width: 320, height: 640 });
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    state = await page.evaluate(() => {
        const button = document.querySelector('#input-bar .composer-primary-action > .completion-accept-btn');
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                    width: rect.width, height: rect.height },
            viewport: { width: innerWidth, height: innerHeight },
            hit: hit === button || button.contains(hit)
        };
    });
    check('accept chip is fully visible and hit-tests to itself',
        state.rect.left >= 0 && state.rect.right <= state.viewport.width
        && state.rect.top >= 0 && state.rect.bottom <= state.viewport.height
        && state.rect.width >= MIN_TOUCH_TARGET && state.rect.height >= MIN_TOUCH_TARGET
        && state.hit, JSON.stringify(state));
    await page.click('#input-bar .composer-primary-action > .completion-accept-btn');
    state = await page.evaluate(() => {
        const input = document.getElementById('code-input');
        return { value: input.value, caret: input.selectionStart, focused: document.activeElement === input };
    });
    check('touch acceptance restores focus and exact caret',
        state.value === 'print' && state.caret === 5 && state.focused, JSON.stringify(state));

    await page.evaluate(() => {
        const id = 9012;
        const card = window._appInternals.createInputCard('pri', id, 'code', 'python');
        window._appInternals.getRepl().appendChild(card);
        window._cells.push({
            id, code: 'pri', type: 'code', language: 'python', name: '',
            inputCard: card, outputCard: null
        });
        card.querySelector('.cell-edit-btn').click();
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9012"] .completion-ghost-suffix')?.textContent === 'nt');
    state = await page.evaluate(() => {
        const actions = document.querySelector('.card-input[data-cell-id="9012"] .cell-edit-actions');
        const button = actions.querySelector('.completion-accept-btn');
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const rows = new Set([...actions.children]
            .filter((element) => getComputedStyle(element).display !== 'none')
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return Math.round(rect.top + rect.height / 2);
            })).size;
        return {
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                width: rect.width, height: rect.height },
            hit: hit === button || button.contains(hit),
            rows,
            runHidden: getComputedStyle(actions.querySelector('.cell-run-btn')).display === 'none',
            label: button.getAttribute('aria-label')
        };
    });
    check('existing-cell Accept remains a labelled 44px target within two mobile rows',
        state.rect.width >= MIN_TOUCH_TARGET && state.rect.height >= MIN_TOUCH_TARGET && state.hit
        && state.rows <= 2 && state.runHidden
        && state.label === 'Accept local code completion: print', JSON.stringify(state));
    state = await page.evaluate(async () => {
        const results = [];
        for (const locale of ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh']) {
            await window.i18n.activate(locale);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const actions = document.querySelector('.card-input[data-cell-id="9012"] .cell-edit-actions');
            const button = actions.querySelector('.completion-accept-btn');
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            const rows = new Set([...actions.children]
                .filter((element) => getComputedStyle(element).display !== 'none')
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return Math.round(rect.top + rect.height / 2);
                })).size;
            results.push({
                locale, rows, width: rect.width, height: rect.height,
                within: rect.left >= 0 && rect.right <= innerWidth,
                hit: hit === button || button.contains(hit),
                labelled: button.getAttribute('aria-label')?.includes('print')
            });
        }
        await window.i18n.activate('en');
        return results;
    });
    check('all 13 locales keep the cell Accept action usable at phone width',
        state.every((item) => item.rows <= 2 && item.width >= MIN_TOUCH_TARGET
            && item.height >= MIN_TOUCH_TARGET
            && item.within && item.hit && item.labelled),
        JSON.stringify(state.filter((item) => !(item.rows <= 2
            && item.width >= MIN_TOUCH_TARGET && item.height >= MIN_TOUCH_TARGET
            && item.within && item.hit && item.labelled))));
    const toolbarFailures = [];
    for (const width of [361, 375, 390, 411, 430, 480, 481, 500, 600, 768]) {
        await page.setViewportSize({ width, height: 640 });
        const probes = await page.evaluate(async () => {
            const output = [];
            for (const locale of ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh']) {
                await window.i18n.activate(locale);
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const actions = document.querySelector('.card-input[data-cell-id="9012"] .cell-edit-actions');
                const button = actions.querySelector('.completion-accept-btn');
                const cardRect = actions.closest('.card-input').getBoundingClientRect();
                const rect = button.getBoundingClientRect();
                const rows = new Set([...actions.children]
                    .filter((element) => getComputedStyle(element).display !== 'none')
                    .map((element) => {
                        const rect = element.getBoundingClientRect();
                        return Math.round(rect.top + rect.height / 2);
                    })).size;
                const controls = [...actions.querySelectorAll(':scope > button, :scope > select')]
                    .filter((control) => {
                        const style = getComputedStyle(control);
                        const controlRect = control.getBoundingClientRect();
                        return style.display !== 'none' && style.visibility !== 'hidden'
                            && controlRect.width > 0 && controlRect.height > 0;
                    });
                const controlsSafe = controls.every((control) => {
                    const controlRect = control.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                        controlRect.left + controlRect.width / 2,
                        controlRect.top + controlRect.height / 2
                    );
                    return controlRect.left >= Math.max(0, cardRect.left) - 1
                        && controlRect.right <= Math.min(innerWidth, cardRect.right) + 1
                        && hit && (hit === control || control.contains(hit));
                });
                output.push({ locale, rows, width: rect.width, height: rect.height,
                    within: rect.left >= 0 && rect.right <= innerWidth,
                    controlsSafe, visibleControls: controls.length });
            }
            await window.i18n.activate('en');
            return output;
        });
        for (const probe of probes) {
            if (probe.rows > 2 || probe.width < 44 || probe.height < 44
                || !probe.within || !probe.controlsSafe) {
                toolbarFailures.push({ viewport: width, ...probe });
            }
        }
    }
    check('cell completion and every visible action stay hittable through 768px in every locale',
        toolbarFailures.length === 0, JSON.stringify(toolbarFailures));
    await page.setViewportSize({ width: 320, height: 240 });
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px');
        window.mathMode?.publishPaletteSpace();
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('a short retained-inset notebook fails closed when no full cell action can fit',
        await page.evaluate(() => {
            const card = document.querySelector('.card-input[data-cell-id="9012"]');
            return !card.querySelector('.completion-editor-cell').classList.contains('has-completion')
                && card.querySelector('.completion-accept-btn').hidden;
        }));
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
        const editor = document.querySelector('.card-input[data-cell-id="9012"] .cell-editor');
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9012"] .completion-ghost-suffix')?.textContent === 'nt');
    check('restoring usable notebook height restores cell completion', true);
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '500px');
        window.mathMode?.publishPaletteSpace();
    });
    await page.waitForFunction(() =>
        !document.querySelector('.card-input[data-cell-id="9012"] .completion-editor-cell')
            .classList.contains('has-completion'));
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px');
        window.mathMode?.publishPaletteSpace();
    });
    await page.waitForFunction(() =>
        document.querySelector('.card-input[data-cell-id="9012"] .completion-ghost-suffix')?.textContent === 'nt');
    check('dynamic footer/safe-inset geometry restores completion without new typing', true);
    await page.click('.card-input[data-cell-id="9012"] .completion-accept-btn');
    await page.click('.card-input[data-cell-id="9012"] .cell-cancel-btn');

    await page.setViewportSize({ width: 320, height: 240 });
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '48px');
        document.documentElement.style.setProperty('--safe-area-inset-left', '20px');
        document.documentElement.style.setProperty('--safe-area-inset-right', '12px');
        window.mathMode?.publishPaletteSpace();
    });
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    state = await page.evaluate(() => {
        const ids = [
            document.getElementById('code-input'),
            document.querySelector('#input-bar .composer-primary-action > .completion-accept-btn')
        ];
        const boundary = innerHeight - 48;
        const suffix = document.querySelector('.completion-editor-composer .completion-ghost-suffix');
        const suffixRange = document.createRange();
        suffixRange.selectNodeContents(suffix);
        return {
            boundary,
            viewportWidth: innerWidth,
            runHidden: (() => {
                const style = getComputedStyle(document.getElementById('run-btn'));
                return style.display === 'none' || style.visibility === 'hidden';
            })(),
            suffixRects: [...suffixRange.getClientRects()].map((rect) => ({
                left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                width: rect.width, height: rect.height
            })),
            rects: ids.map((element) => {
                const rect = element.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2,
                    Math.min(rect.bottom - 1, rect.top + rect.height / 2));
                return {
                    id: element.id || element.className,
                    left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                    width: rect.width, height: rect.height,
                    hit: hit === element || element.contains(hit),
                    hitName: hit ? (hit.id || hit.className || hit.tagName) : null
                };
            })
        };
    });
    check('short viewport swaps Run for Accept without covering the composer or unsafe inset',
        state.runHidden
        && state.rects.every((rect) => rect.left >= 20 && rect.right <= state.viewportWidth - 12
            && rect.top >= 0 && rect.bottom <= state.boundary && rect.hit)
        && state.suffixRects.length > 0
        && state.suffixRects.every((rect) => rect.left >= 20 && rect.right <= state.viewportWidth - 12
            && rect.top >= 0 && rect.bottom <= state.boundary && rect.width > 0 && rect.height > 0),
        JSON.stringify(state));

    await page.evaluate(async () => { await window.i18n.activate('ar'); });
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    state = await page.evaluate(() => {
        const input = document.getElementById('code-input');
        const mirror = document.querySelector('.completion-editor-composer .completion-ghost');
        const button = document.querySelector('#input-bar .composer-primary-action > .completion-accept-btn');
        return {
            documentDir: document.documentElement.dir,
            inputDir: input.dir,
            mirrorDir: getComputedStyle(mirror).direction,
            label: button.getAttribute('aria-label')
        };
    });
    check('Arabic UI preserves LTR code/ghost and retranslates the accept action',
        state.documentDir === 'rtl' && state.inputDir === 'ltr' && state.mirrorDir === 'ltr'
        && state.label === 'قبول إكمال التعليمات البرمجية المحلي: print', JSON.stringify(state));

    check('browser run produced no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();

    console.log('8. Auto preference remains conservative on touch');
    ({ context, page, pageErrors } = await open({
        completion: 'auto', viewport: { width: 320, height: 640 }, hasTouch: true
    }));
    await page.evaluate(() => {
        const original = window.matchMedia;
        window.matchMedia = (query) => query === '(any-pointer: coarse)'
            ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
            : original(query);
        window.localCompletion.refreshAll();
    });
    await setComposer(page, 'pri');
    check('auto mode does not enable completion on a coarse pointer', await page.evaluate(() =>
        !document.querySelector('.completion-editor-composer').classList.contains('has-completion')));
    await page.evaluate(() => window.localCompletion.setPreference('on'));
    await setComposer(page, 'pri');
    await waitGhost(page, 'nt');
    await page.tap('#input-bar .composer-primary-action > .completion-accept-btn');
    check('a real touch event accepts without running or losing the caret', await page.evaluate(() => {
        const input = document.getElementById('code-input');
        return input.value === 'print' && input.selectionStart === 5
            && document.activeElement === input && window._cells.length === 0;
    }));
    check('touch-auto run produced no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
} finally {
    await browser.close();
}

console.log(`\n${checks - failures}/${checks} autocomplete browser checks passed.`);
if (failures) process.exit(1);
