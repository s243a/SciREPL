// Playwright regression: generated UI must translate just like static markup.
// Run `node server.js` first, then `node test_i18n_dynamic.mjs`.
import { chromium } from 'playwright';

const PORT = process.env.PORT || 8085;
const URL = `http://localhost:${PORT}/index.html`;
const TIMEOUT = 60_000;

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? `: ${String(detail).slice(0, 220)}` : ''}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 411, height: 891 } });
await context.addInitScript(() => {
    localStorage.setItem('scirepl_privacy_accepted', '1');
    localStorage.setItem('scirepl_onboarding_seen', '1');
    addEventListener('DOMContentLoaded', () => localStorage.setItem(
        'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
    localStorage.setItem('scirepl_auto_download', '1');
    localStorage.removeItem('scirepl_session_v2');
    localStorage.removeItem('scirepl_session_v1');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

async function activate(code) {
    await page.evaluate(async (locale) => {
        window.i18n.setPreference(locale);
        await window.i18n.activate(locale);
    }, code);
    await page.waitForFunction((locale) => document.documentElement.lang === locale,
        code, { timeout: TIMEOUT });
}

async function dismissModals() {
    await page.evaluate(() => {
        for (const modal of document.querySelectorAll('.modal')) modal.classList.add('hidden');
        document.getElementById('search-bar')?.classList.add('hidden');
        document.getElementById('search-replace-row')?.classList.add('hidden');
    });
}

async function openFromMenu(button, modal) {
    await dismissModals();
    await page.locator('#menu-btn').click();
    await page.locator(button).click();
    await page.locator(modal).waitFor({ state: 'visible', timeout: TIMEOUT });
}

async function radioOptionGeometry(modalSelector) {
    return page.evaluate((selector) => {
        const viewportWidth = document.documentElement.clientWidth;
        return [...document.querySelectorAll(`${selector} .settings-radio-item`)]
            .filter((label) => !label.closest('.hidden'))
            .map((label) => {
                const input = label.querySelector('input[type="radio"]')?.getBoundingClientRect();
                const name = label.querySelector(':scope > span:not(.export-format-desc)')?.getBoundingClientRect();
                const description = label.querySelector(':scope > .export-format-desc')?.getBoundingClientRect();
                const box = label.getBoundingClientRect();
                const direction = getComputedStyle(label).direction;
                return input && name && description ? {
                    name: label.querySelector(':scope > span:not(.export-format-desc)')?.textContent,
                    layout: getComputedStyle(label).display,
                    inlineStartCorrect: direction === 'rtl'
                        ? input.left >= name.right - 0.5
                        : input.right <= name.left + 0.5,
                    inlineGap: direction === 'rtl'
                        ? input.left - name.right
                        : name.left - input.right,
                    verticallySeparated: description.top >= name.bottom - 0.5,
                    contained: [input, name, description].every((rect) => rect.left >= box.left - 0.5
                        && rect.right <= box.right + 0.5
                        && rect.left >= -0.5 && rect.right <= viewportWidth + 0.5),
                } : null;
            });
    }, modalSelector);
}

async function chooseRadio(name, value) {
    await page.evaluate(({ radioName, radioValue }) => {
        const input = document.querySelector(`input[name="${radioName}"][value="${radioValue}"]`);
        if (!input) throw new Error(`missing radio ${radioName}=${radioValue}`);
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { radioName: name, radioValue: value });
}

async function renderedSectionState(ids) {
    return page.evaluate((sectionIds) => Object.fromEntries(sectionIds.map((id) => {
        const element = document.getElementById(id);
        const rect = element?.getBoundingClientRect();
        const rendered = !!(element && getComputedStyle(element).display !== 'none'
            && rect.width > 0 && rect.height > 0);
        return [id, rendered];
    })), ids);
}

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.i18n && window.fileIO && window.notebookManager
        && window.packageCatalog && window.kernelManager && window._cells,
    null, { timeout: TIMEOUT });
    await page.waitForTimeout(500);

    let state = await page.evaluate(() => ({
        hiddenDisplays: [...document.querySelectorAll('.hidden')]
            .filter((element) => [
                'loading-overlay', 'notebook-sidebar', 'appearance-theme-editor',
                'runtime-progress-wrap',
            ].includes(element.id) || element.classList.contains('modal'))
            .map((element) => ({ id: element.id, display: getComputedStyle(element).display })),
        hiddenRunningAnimations: document.getAnimations()
            .filter((animation) => animation.playState === 'running'
                && animation.effect?.target?.closest?.('.hidden'))
            .map((animation) => animation.effect.target.id || animation.effect.target.className),
        headerBackdrop: getComputedStyle(document.getElementById('app-header')).backdropFilter,
    }));
    check('hidden shell subtrees are removed from layout and painting',
        state.hiddenDisplays.length >= 10
        && state.hiddenDisplays.every((item) => item.display === 'none'),
    JSON.stringify(state));
    check('hidden UI has no running animation and the opaque header has no backdrop filter',
        state.hiddenRunningAnimations.length === 0
        && (!state.headerBackdrop || state.headerBackdrop === 'none'),
    JSON.stringify(state));

    console.log('\n1. Generated editor and notebook UI');
    await activate('es');
    state = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        notebook: window.notebookManager.getActiveNotebook()?.name,
        notebookWant: window.t('notebookManager.defaultName', { number: 1 }),
        placeholder: document.getElementById('code-input')?.placeholder,
        placeholderWant: window.t('app.input.codePlaceholder', { language: 'Python' }),
        ready: document.getElementById('status-badge')?.textContent,
        readyWant: window.t('status.ready'),
    }));
    check('Spanish activation updates document metadata', state.lang === 'es' && state.dir === 'ltr', JSON.stringify(state));
    check('generated default notebook name is localized', state.notebook === state.notebookWant && state.notebook !== 'Notebook 1', JSON.stringify(state));
    check('generated code placeholder is localized', state.placeholder === state.placeholderWant && !state.placeholder.startsWith('Type '), JSON.stringify(state));
    check('generated ready status is localized', state.ready === state.readyWant && state.ready !== 'ready', JSON.stringify(state));

    await page.selectOption('#lang-selector', 'javascript');
    await page.locator('#lang-selector').dispatchEvent('change');
    await page.fill('#code-input', '1 + 1');
    await page.click('#run-btn');
    await page.waitForFunction(() => window._cells.length === 1, null, { timeout: TIMEOUT });
    state = await page.evaluate(() => {
        const card = document.querySelector('.card-input');
        return {
            drag: card?.querySelector('.cell-drag-handle')?.title,
            dragWant: window.t('app.cell.actions.dragTitle'),
            edit: card?.querySelector('.cell-edit-btn')?.title,
            editWant: window.t('app.cell.actions.editTitle'),
            remove: card?.querySelector('.cell-delete-btn')?.title,
            removeWant: window.t('app.cell.actions.deleteTitle'),
        };
    });
    check('generated cell action titles are localized', state.drag === state.dragWant
        && state.edit === state.editWant && state.remove === state.removeWant, JSON.stringify(state));

    console.log('\n2. Catalog, memory, Files & Storage, and search');
    await openFromMenu('#btn-browse-packages', '#package-catalog-modal');
    state = await page.evaluate(() => ({
        packages: document.querySelector('.catalog-section-header')?.textContent,
        packagesWant: window.t('packageCatalog.sectionPackages'),
        item: document.querySelector('[data-catalog-id="unifyweaver-scirepl"] .pkg-display-name')?.textContent,
        itemWant: window.t('packageCatalog.item.unifyweaverScirepl.name'),
        description: document.querySelector('[data-catalog-id="unifyweaver-scirepl"] .pkg-description')?.textContent,
        descriptionWant: window.t('packageCatalog.item.unifyweaverScirepl.description'),
        install: document.querySelector('[data-catalog-id="unifyweaver-scirepl"] .pkg-install-btn')?.textContent,
        installWant: window.t('packageCatalog.install'),
    }));
    check('catalog headings, item copy, and action are localized',
        state.packages === state.packagesWant && state.item === state.itemWant
        && state.description === state.descriptionWant && state.install === state.installWant,
    JSON.stringify(state));

    // Generated nodes retain their key/variables, so changing locale while the
    // panel is open must update it in place rather than requiring a close/reopen.
    await activate('fr');
    state = await page.evaluate(() => ({
        description: document.querySelector('[data-catalog-id="unifyweaver-scirepl"] .pkg-description')?.textContent,
        want: window.t('packageCatalog.item.unifyweaverScirepl.description'),
        install: document.querySelector('[data-catalog-id="unifyweaver-scirepl"] .pkg-install-btn')?.textContent,
        installWant: window.t('packageCatalog.install'),
    }));
    check('an open generated catalog retranslates in place',
        state.description === state.want && state.install === state.installWant, JSON.stringify(state));

    await openFromMenu('#btn-export', '#export-modal');
    state = await page.evaluate(() => {
        const content = document.querySelector('#export-modal .modal-content')?.getBoundingClientRect();
        const action = document.getElementById('btn-do-export')?.getBoundingClientRect();
        return content && action ? {
            contentTop: content.top,
            contentBottom: content.bottom,
            actionTop: action.top,
            actionBottom: action.bottom,
        } : null;
    });
    check('the primary Export action is fully visible without initial scrolling',
        state && state.actionTop >= state.contentTop && state.actionBottom <= state.contentBottom + 0.5,
    JSON.stringify(state));

    let radioGeometry = await radioOptionGeometry('#export-modal');
    check('localized Export radio names and descriptions use separate contained rows',
        radioGeometry.length >= 5 && radioGeometry.every((item) => item?.layout === 'grid'
            && item?.inlineStartCorrect && item?.verticallySeparated && item?.contained),
    JSON.stringify(radioGeometry));

    await page.locator('input[name="export-format"][value="markdown"]')
        .locator('xpath=following-sibling::span[contains(@class,"export-format-desc")]').click();
    state = await page.evaluate(() => document.querySelector(
        'input[name="export-format"][value="markdown"]')?.checked);
    check('clicking a radio description selects that export option', state === true, String(state));
    await page.locator('input[name="export-format"][value="html"] + span').click();
    state = await page.evaluate(() => document.querySelector(
        'input[name="export-format"][value="html"]')?.checked);
    check('clicking a radio name selects that export option', state === true, String(state));

    let sectionState = await renderedSectionState([
        'export-image-section', 'export-theme-section', 'export-pagebg-section',
        'export-margins-section',
    ]);
    check('HTML export shows only its applicable option sections',
        sectionState['export-image-section'] && sectionState['export-theme-section']
        && sectionState['export-pagebg-section'] && !sectionState['export-margins-section'],
    JSON.stringify(sectionState));

    await chooseRadio('export-format', 'markdown');
    sectionState = await renderedSectionState([
        'export-image-section', 'export-theme-section', 'export-pagebg-section',
        'export-margins-section',
    ]);
    check('Markdown export hides styled-page and margin options',
        sectionState['export-image-section'] && !sectionState['export-theme-section']
        && !sectionState['export-pagebg-section'] && !sectionState['export-margins-section'],
    JSON.stringify(sectionState));

    await chooseRadio('export-format', 'pdf');
    sectionState = await renderedSectionState([
        'export-image-section', 'export-theme-section', 'export-pagebg-section',
        'export-margins-section',
    ]);
    check('PDF export shows styled-page and margin options but not image packaging',
        !sectionState['export-image-section'] && sectionState['export-theme-section']
        && sectionState['export-pagebg-section'] && sectionState['export-margins-section'],
    JSON.stringify(sectionState));

    await chooseRadio('export-format', 'docx');
    sectionState = await renderedSectionState([
        'export-image-section', 'export-theme-section', 'export-pagebg-section',
        'export-margins-section',
    ]);
    check('DOCX export hides all unrelated option sections',
        Object.values(sectionState).every((rendered) => !rendered), JSON.stringify(sectionState));

    await chooseRadio('export-format', 'pdf');
    await page.locator('#export-modal .modal-close').click();
    await openFromMenu('#btn-export', '#export-modal');
    sectionState = await renderedSectionState([
        'export-image-section', 'export-theme-section', 'export-pagebg-section',
        'export-margins-section',
    ]);
    check('reopening Export resets PDF-only margins back to the HTML state',
        sectionState['export-image-section'] && sectionState['export-theme-section']
        && sectionState['export-pagebg-section'] && !sectionState['export-margins-section'],
    JSON.stringify(sectionState));

    const compactLayouts = [];
    for (const viewport of [{ width: 360, height: 780 }, { width: 640, height: 360 }]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(100);
        compactLayouts.push(await page.evaluate((size) => {
            const modal = document.querySelector('#export-modal .modal-content');
            const action = document.getElementById('btn-do-export');
            const contentRect = modal.getBoundingClientRect();
            const actionRect = action.getBoundingClientRect();
            const visible = (element) => getComputedStyle(element).display !== 'none'
                && element.getBoundingClientRect().height > 0;
            const headings = [...document.querySelectorAll('#export-modal .settings-section')]
                .filter(visible)
                .map((heading) => {
                    const next = heading.nextElementSibling;
                    if (!next || !visible(next)) return null;
                    const h = heading.getBoundingClientRect();
                    const n = next.getBoundingClientRect();
                    return n.top - h.bottom;
                }).filter((gap) => gap != null);
            const adjacentRows = [...document.querySelectorAll('#export-modal .settings-radio-item')]
                .filter(visible)
                .map((row) => {
                    const previous = row.previousElementSibling;
                    if (!previous?.classList.contains('settings-radio-item') || !visible(previous)) return null;
                    return row.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
                }).filter((gap) => gap != null);
            return {
                size,
                actionContained: actionRect.top >= contentRect.top - 0.5
                    && actionRect.bottom <= contentRect.bottom + 0.5,
                headingGaps: headings,
                rowGaps: adjacentRows,
            };
        }, viewport));
    }
    check('short portrait and landscape keep Export reachable with positive row spacing',
        compactLayouts.every((layout) => layout.actionContained
            && layout.headingGaps.length > 0 && layout.headingGaps.every((gap) => gap >= 0)
            && layout.rowGaps.length > 0 && layout.rowGaps.every((gap) => gap > 0)),
    JSON.stringify(compactLayouts));
    await page.setViewportSize({ width: 411, height: 891 });

    await openFromMenu('#btn-export-workbook', '#export-workbook-modal');
    state = await page.evaluate(() => {
        const title = document.querySelector('#export-workbook-modal h2');
        const close = document.querySelector('#export-workbook-modal .modal-close')?.getBoundingClientRect();
        if (!title || !close) return null;
        const range = document.createRange();
        range.selectNodeContents(title);
        const textRects = [...range.getClientRects()].map((rect) => ({
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        }));
        const overlap = textRects.some((rect) => rect.right > close.left
            && rect.left < close.right && rect.bottom > close.top && rect.top < close.bottom);
        return { overlap, textRects, close: { left: close.left, right: close.right } };
    });
    check('a long localized modal title stays clear of the close button',
        state && !state.overlap, JSON.stringify(state));

    radioGeometry = await radioOptionGeometry('#export-workbook-modal');
    check('localized workbook-export radio rows do not overlap',
        radioGeometry.length >= 5 && radioGeometry.every((item) => item?.layout === 'grid'
            && item?.inlineStartCorrect && item?.verticallySeparated && item?.contained),
    JSON.stringify(radioGeometry));

    sectionState = await renderedSectionState([
        'wb-scope-section', 'wb-kernel-section', 'wb-archive-section', 'wb-filetree-section',
    ]);
    check('native workbook export shows scope only',
        sectionState['wb-scope-section'] && !sectionState['wb-kernel-section']
        && !sectionState['wb-archive-section'] && !sectionState['wb-filetree-section'],
    JSON.stringify(sectionState));

    await chooseRadio('wb-export-format', 'ipynb');
    sectionState = await renderedSectionState([
        'wb-scope-section', 'wb-kernel-section', 'wb-archive-section', 'wb-filetree-section',
    ]);
    check('single-notebook Jupyter export shows scope and kernel only',
        sectionState['wb-scope-section'] && sectionState['wb-kernel-section']
        && !sectionState['wb-archive-section'] && !sectionState['wb-filetree-section'],
    JSON.stringify(sectionState));

    await chooseRadio('wb-export-scope', 'all');
    sectionState = await renderedSectionState([
        'wb-scope-section', 'wb-kernel-section', 'wb-archive-section', 'wb-filetree-section',
    ]);
    check('all-tab Jupyter export also shows its archive choice',
        sectionState['wb-scope-section'] && sectionState['wb-kernel-section']
        && sectionState['wb-archive-section'] && !sectionState['wb-filetree-section'],
    JSON.stringify(sectionState));

    await chooseRadio('wb-export-format', 'package');
    sectionState = await renderedSectionState([
        'wb-scope-section', 'wb-kernel-section', 'wb-archive-section', 'wb-filetree-section',
    ]);
    check('package export shows archive and contents without notebook-only controls',
        !sectionState['wb-scope-section'] && !sectionState['wb-kernel-section']
        && sectionState['wb-archive-section'] && sectionState['wb-filetree-section'],
    JSON.stringify(sectionState));

    await openFromMenu('#btn-memory', '#memory-modal');
    await page.locator('#memory-kernel-list .memory-kernel-status').first()
        .waitFor({ state: 'visible', timeout: TIMEOUT });
    state = await page.evaluate(() => ({
        heading: document.querySelector('[data-i18n="memory.kernelMemory"]')?.textContent,
        headingWant: window.t('memory.kernelMemory'),
        statuses: [...document.querySelectorAll('#memory-kernel-list [data-i18n]')]
            .map((el) => ({ key: el.dataset.i18n, text: el.textContent, want: window.t(el.dataset.i18n) })),
    }));
    check('memory heading is localized', state.heading === state.headingWant, JSON.stringify(state));
    check('generated memory labels retain translation provenance',
        state.statuses.length > 0 && state.statuses.every((item) => item.text === item.want),
    JSON.stringify(state.statuses));

    await openFromMenu('#btn-prolog-settings', '#prolog-settings-modal');
    state = await page.evaluate(() => ({
        options: [...document.querySelectorAll('#vfs-kernel-select option')]
            .map((option) => option.textContent),
        suffix: window.t('vfs.notLoadedSuffix'),
        englishLeaked: [...document.querySelectorAll('#vfs-kernel-select option')]
            .some((option) => /\(not loaded\)/i.test(option.textContent)),
        suffixGluedToPath: [...document.querySelectorAll('#vfs-kernel-select option')]
            .some((option) => /\/mnt\/[^\s(]+\(/.test(option.textContent)),
        doubledSeparator: [...document.querySelectorAll('#vfs-kernel-select option')]
            .some((option) => /\/mnt\/\S+\s{2,}\(/.test(option.textContent)),
    }));
    check('generated VFS unloaded labels use the active locale',
        state.options.some((text) => text.includes(state.suffix))
        && !state.englishLeaked && !state.suffixGluedToPath && !state.doubledSeparator,
    JSON.stringify(state));

    // Long notebook/file names must shrink inside the mobile tree rather than
    // pushing the 44 px download/delete touch targets beyond the viewport.
    await page.evaluate(() => {
        window.sharedVFS.mkdirTree('/shared/data');
        for (const name of [
            'call_graph_analysis_17718279.srwb',
            'family_tree_tutorial_17718279.srwb',
            'advanced_recursion_patterns_17718279.srwb',
        ]) {
            window.sharedVFS.writeFile(`/shared/data/${name}`, 'test', 'user');
        }
        window.prologSettings._refreshUnifiedView();
    });
    state = await page.evaluate(() => {
        const viewportRight = document.documentElement.clientWidth;
        const actions = [...document.querySelectorAll('#vfs-file-list .vfs-entry-actions')]
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: rect.width };
            });
        return { viewportRight, actions };
    });
    check('mobile VFS action targets stay fully inside the viewport',
        state.actions.length >= 3
        && state.actions.every((rect) => rect.left >= 0 && rect.right <= state.viewportRight + 0.5),
    JSON.stringify(state));

    await dismissModals();
    await page.evaluate(() => document.documentElement.style.setProperty('--app-top-margin', '37px'));
    await page.click('#search-btn');
    await page.fill('#search-input', '__definitely_absent__');
    await page.locator('#search-input').dispatchEvent('input');
    await page.waitForTimeout(250);
    state = await page.evaluate(() => ({
        count: document.getElementById('search-count')?.textContent,
        want: window.t('app.search.zeroResults'),
        top: document.getElementById('search-bar')?.getBoundingClientRect().top,
        safeTop: parseFloat(getComputedStyle(document.documentElement)
            .getPropertyValue('--app-top-margin')) || 0,
    }));
    check('generated search result count is localized', state.count === state.want, JSON.stringify(state));
    check('mobile search stays below the configured status-bar allowance',
        state.top >= state.safeTop - 0.5, JSON.stringify(state));

    console.log('\n3. Compact translated Appearance controls');
    const appearanceDraftLayouts = [];
    for (const locale of ['ko', 'zh']) {
        await activate(locale);
        await openFromMenu('#btn-appearance', '#appearance-modal');
        appearanceDraftLayouts.push(await page.evaluate((code) => {
            const row = document.querySelector('.appearance-drafts-row');
            const label = row?.querySelector('.appearance-check');
            const labelText = label?.querySelector('span');
            const help = row?.querySelector('.appearance-help');
            const modal = document.getElementById('appearance-modal');
            const rect = (element) => {
                const r = element?.getBoundingClientRect();
                return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                    width: r.width, height: r.height } : null;
            };
            return {
                locale: code,
                direction: row ? getComputedStyle(row).flexDirection : null,
                label: rect(label),
                labelText: rect(labelText),
                help: rect(help),
                backdropFilter: modal ? getComputedStyle(modal).backdropFilter : null,
            };
        }, locale));
    }
    check('Korean and Chinese draft-translation labels remain readable horizontal blocks',
        appearanceDraftLayouts.every((layout) => layout.direction === 'column'
            && layout.labelText?.width > layout.labelText?.height * 2
            && layout.labelText?.height < 80
            && layout.help?.top >= layout.label?.bottom - 0.5),
    JSON.stringify(appearanceDraftLayouts));
    check('mobile modals avoid the costly full-screen backdrop blur',
        appearanceDraftLayouts.every((layout) => !layout.backdropFilter
            || layout.backdropFilter === 'none'), JSON.stringify(appearanceDraftLayouts));

    console.log('\n4. RTL and authoritative privacy copy');
    await activate('ar');
    await dismissModals();

    await openFromMenu('#btn-export', '#export-modal');
    radioGeometry = await radioOptionGeometry('#export-modal');
    check('RTL Export radio rows stay separated and inside their labels',
        radioGeometry.length >= 5 && radioGeometry.every((item) => item?.layout === 'grid'
            && item?.inlineStartCorrect && item?.inlineGap <= 16
            && item?.verticallySeparated && item?.contained),
    JSON.stringify(radioGeometry));
    await dismissModals();

    state = await page.evaluate(() => ({
        attr: document.getElementById('code-input')?.dir,
        computed: getComputedStyle(document.getElementById('code-input')).direction,
    }));
    check('the main code editor remains LTR under an RTL interface',
        state.attr === 'ltr' && state.computed === 'ltr', JSON.stringify(state));
    await page.click('#cell-type-toggle');
    state = await page.evaluate(() => ({
        attr: document.getElementById('code-input')?.dir,
        placeholder: document.getElementById('code-input')?.placeholder,
        want: window.t('app.input.markdownPlaceholder'),
    }));
    check('the main Markdown editor derives direction from its own content',
        state.attr === 'auto'
        && state.placeholder.replace(/[\u2066-\u2069]/g, '') === state.want,
    JSON.stringify(state));
    await page.click('#cell-type-toggle');

    await page.locator('.card-input .cell-edit-btn').first().click();
    state = await page.evaluate(() => {
        const card = document.querySelector('.card-input');
        const editor = card?.querySelector('.cell-editor');
        const actionBar = card?.querySelector('.cell-edit-actions');
        const controls = [...(actionBar?.querySelectorAll('button, select') || [])].map((control) => {
            const rect = control.getBoundingClientRect();
            return {
                text: control.textContent,
                top: Math.round(rect.top),
                height: Math.round(rect.height),
                clipped: rect.left < -0.5 || rect.right > document.documentElement.clientWidth + 0.5,
            };
        });
        return {
            editorDir: editor?.dir,
            editorComputedDir: editor ? getComputedStyle(editor).direction : null,
            actionFlexWrap: actionBar ? getComputedStyle(actionBar).flexWrap : null,
            actionRows: new Set(controls.map((control) => control.top)).size,
            actionControls: controls,
        };
    });
    check('program source remains LTR while editing under an RTL interface',
        state.editorDir === 'ltr' && state.editorComputedDir === 'ltr', JSON.stringify(state));
    check('Arabic mobile edit actions use compact controls instead of tall wrapped buttons',
        state.actionFlexWrap === 'wrap' && state.actionRows <= 2
        && state.actionControls.length === 6
        && state.actionControls.every((control) => control.height <= 36 && !control.clipped),
    JSON.stringify(state));

    const editorLayoutFailures = [];
    for (const width of [320, 360, 411]) {
        await page.setViewportSize({ width, height: 800 });
        for (const locale of ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh']) {
            await activate(locale);
            await page.waitForTimeout(25);
            const layout = await page.evaluate(() => {
                const bar = document.querySelector('.card-input .cell-edit-actions');
                const runBelow = bar?.querySelector('.cell-run-below-btn');
                const barRect = bar?.getBoundingClientRect();
                const controls = [...(bar?.querySelectorAll('button, select') || [])].map((control) => {
                    const rect = control.getBoundingClientRect();
                    return { top: Math.round(rect.top), height: rect.height,
                        left: rect.left, right: rect.right };
                });
                return {
                    rows: new Set(controls.map((control) => control.top)).size,
                    controls,
                    barLeft: barRect?.left,
                    barRight: barRect?.right,
                    compact: runBelow?.classList.contains('cell-action-icon-only'),
                    accessibleLabel: runBelow?.getAttribute('aria-label'),
                    expectedLabel: window.t('app.cell.actions.runAllBelow'),
                    compactIconVisible: runBelow
                        ? getComputedStyle(runBelow.querySelector('.cell-run-below-icon-compact')).display !== 'none'
                        : false,
                };
            });
            if (layout.rows > 2 || layout.controls.length !== 6
                || layout.accessibleLabel !== layout.expectedLabel
                || (layout.compact && !layout.compactIconVisible)
                || layout.controls.some((control) => control.height > 36
                    || control.left < layout.barLeft - 0.5 || control.right > layout.barRight + 0.5)) {
                editorLayoutFailures.push({ width, locale, ...layout });
            }
        }
    }
    check('mobile edit controls stay compact and contained in every locale at 320/360/411px',
        editorLayoutFailures.length === 0, JSON.stringify(editorLayoutFailures));
    await page.setViewportSize({ width: 411, height: 891 });
    await activate('ar');
    await page.locator('.card-input .cell-cancel-btn').first().click();
    state = await page.evaluate(() => {
        const pre = document.querySelector('.card-input pre');
        const output = document.querySelector('.card-output:not(.card-markdown-output) .card-body');
        return {
            sourceDir: pre?.dir,
            sourceComputedDir: pre ? getComputedStyle(pre).direction : null,
            outputComputedDir: output ? getComputedStyle(output).direction : null,
        };
    });
    check('rendered program source and kernel output remain LTR under RTL',
        state.sourceDir === 'ltr' && state.sourceComputedDir === 'ltr'
        && state.outputComputedDir === 'ltr', JSON.stringify(state));

    state = await page.evaluate(() => {
        const card = window._appInternals.createOutputCard(999999, 'markdown');
        const body = card.querySelector('.markdown-body');
        body.textContent = 'Summary: English workbook content.';
        const english = { attr: body.dir, computed: getComputedStyle(body).direction };
        body.textContent = 'ملخص: محتوى عربي.';
        const arabic = { attr: body.dir, computed: getComputedStyle(body).direction };
        card.remove();
        return { english, arabic };
    });
    check('Markdown cells choose direction from their own content, not the UI locale',
        state.english.attr === 'auto' && state.english.computed === 'ltr'
        && state.arabic.attr === 'auto' && state.arabic.computed === 'rtl',
    JSON.stringify(state));

    await page.click('#help-btn');
    await page.locator('#help-modal').waitFor({ state: 'visible', timeout: TIMEOUT });
    state = await page.evaluate(() => {
        const keys = [
            'help.shortcutOr',
            'help.shortcutButton',
            'help.shortcutRunCode',
            'help.shortcutFindWithReplace',
            'help.shortcutInsertFourSpaces',
            'help.shortcutAtEndOfLine',
            'help.shortcutSuppressOutput',
        ];
        const values = keys.map((key) => ({
            key,
            want: window.t(key),
            shown: [...document.querySelectorAll(`[data-i18n="${key}"]`)]
                .map((element) => element.textContent),
        }));
        const technical = [...document.querySelectorAll('#help-modal kbd, #help-modal code')];
        return {
            values,
            technicalDirections: technical.map((element) => getComputedStyle(element).direction),
            runRemainingLegend: document.querySelector('.help-action-legend [data-i18n="app.cell.actions.runAllBelow"]')?.textContent,
            runRemainingWant: window.t('app.cell.actions.runAllBelow'),
            runRemainingIcon: document.querySelector('.help-action-legend code')?.textContent,
        };
    });
    check('Help shortcut prose is translated in Arabic',
        state.values.every((item) => item.shown.length > 0
            && item.shown.every((shown) => shown === item.want)), JSON.stringify(state.values));
    check('Help keyboard and code fragments remain LTR in Arabic',
        state.technicalDirections.length > 0
            && state.technicalDirections.every((direction) => direction === 'ltr'),
    JSON.stringify(state.technicalDirections));
    check('Help documents the adaptive run-remaining icon using the existing translation',
        state.runRemainingIcon === '▶↓' && state.runRemainingLegend === state.runRemainingWant,
    JSON.stringify(state));

    await page.click('#help-privacy-link');
    await page.locator('#privacy-modal').waitFor({ state: 'visible', timeout: TIMEOUT });
    state = await page.evaluate(() => {
        const body = document.querySelector('[data-i18n="privacy.scireplDesignedBePrivacyRespecting"]');
        const notice = document.getElementById('privacy-translation-notice');
        const title = document.querySelector('#privacy-modal h2');
        const close = document.querySelector('#privacy-modal .modal-close')?.getBoundingClientRect();
        const range = document.createRange();
        if (title) range.selectNodeContents(title);
        const titleRects = title ? [...range.getClientRects()] : [];
        return {
            dir: document.documentElement.dir,
            bodyDir: body?.getAttribute('dir'),
            bodyLang: body?.getAttribute('lang'),
            body: body?.textContent,
            official: window.i18n.domains['privacy.en']
                ?.['privacy.scireplDesignedBePrivacyRespecting'],
            noticeHidden: notice?.hidden,
            notice: notice?.textContent,
            noticeWant: `${window.t('privacy.translationNotice')} ${window.t('privacy.viewOfficial')}`,
            titleText: title?.textContent,
            titleWant: window.t('privacy.privacyPolicy'),
            titleCloseOverlap: close ? titleRects.some((rect) => rect.right > close.left
                && rect.left < close.right && rect.bottom > close.top && rect.top < close.bottom) : true,
        };
    });
    check('Arabic switches the application to RTL', state.dir === 'rtl', JSON.stringify(state));
    check('draft legal body is one intact authoritative English LTR unit',
        state.bodyDir === 'ltr' && state.bodyLang === 'en' && state.body === state.official,
    JSON.stringify(state));
    check('privacy translation notice remains readable in Arabic',
        state.noticeHidden === false && state.notice === state.noticeWant,
    JSON.stringify(state));
    check('the authoritative English privacy title remains clear of the mirrored RTL close button',
        state.titleText === state.titleWant && !state.titleCloseOverlap,
    JSON.stringify(state));

    await activate('zh');
    await dismissModals();
    await page.click('#help-btn');
    await page.locator('#help-modal').waitFor({ state: 'visible', timeout: TIMEOUT });
    state = await page.evaluate(() => {
        const content = document.querySelector('#help-modal .modal-content');
        const codeBlocks = [...document.querySelectorAll('#help-modal pre')];
        return {
            clientWidth: content?.clientWidth,
            scrollWidth: content?.scrollWidth,
            independentlyScrollableExamples: codeBlocks.filter((pre) => pre.scrollWidth > pre.clientWidth + 1).length,
        };
    });
    check('Chinese Help prose does not make the whole dialog scroll sideways',
        state.clientWidth > 0 && state.scrollWidth <= state.clientWidth + 1
        && state.independentlyScrollableExamples > 0,
    JSON.stringify(state));

    check('no browser errors occurred', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
    failures++;
    console.error(error.stack || error);
} finally {
    await browser.close();
}

console.log(`\n${failures ? `${failures} failure(s)` : 'All dynamic-localization checks passed.'}`);
process.exit(failures ? 1 : 0);
