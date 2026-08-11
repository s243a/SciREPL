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

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => window.i18n && window.fileIO && window.notebookManager
        && window.packageCatalog && window.kernelManager && window._cells,
    null, { timeout: TIMEOUT });
    await page.waitForTimeout(500);

    console.log('\n1. Generated editor and notebook UI');
    await activate('es');
    let state = await page.evaluate(() => ({
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

    console.log('\n3. RTL and authoritative privacy copy');
    await activate('ar');
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
        return {
            editorDir: editor?.dir,
            editorComputedDir: editor ? getComputedStyle(editor).direction : null,
        };
    });
    check('program source remains LTR while editing under an RTL interface',
        state.editorDir === 'ltr' && state.editorComputedDir === 'ltr', JSON.stringify(state));
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
        };
    });
    check('Help shortcut prose is translated in Arabic',
        state.values.every((item) => item.shown.length > 0
            && item.shown.every((shown) => shown === item.want)), JSON.stringify(state.values));
    check('Help keyboard and code fragments remain LTR in Arabic',
        state.technicalDirections.length > 0
            && state.technicalDirections.every((direction) => direction === 'ltr'),
    JSON.stringify(state.technicalDirections));

    await page.click('#help-privacy-link');
    await page.locator('#privacy-modal').waitFor({ state: 'visible', timeout: TIMEOUT });
    state = await page.evaluate(() => {
        const body = document.querySelector('[data-i18n="privacy.scireplDesignedBePrivacyRespecting"]');
        const notice = document.getElementById('privacy-translation-notice');
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
        };
    });
    check('Arabic switches the application to RTL', state.dir === 'rtl', JSON.stringify(state));
    check('draft legal body is one intact authoritative English LTR unit',
        state.bodyDir === 'ltr' && state.bodyLang === 'en' && state.body === state.official,
    JSON.stringify(state));
    check('privacy translation notice remains readable in Arabic',
        state.noticeHidden === false && state.notice === state.noticeWant,
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
