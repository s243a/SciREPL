// Playwright test: Browse Packages, Bundles & Workbooks catalog
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const BASE = process.env.SCIREPL_TEST_BASE || 'http://localhost:8085/';
const TIMEOUT = 180_000;
const CATALOG_ROOT = 'https://s243a.github.io/SciREPL-Catalog/';
const CATALOG_RAW_ROOT = 'https://raw.githubusercontent.com/s243a/SciREPL-Catalog/';
const CATALOG_TAG = 'v1.2.3';
const CATALOG_COMMIT = 'a'.repeat(40);
const PRIVACY_REVISION = '2026-08-catalog-sources-v1';

const encodeJson = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');

const goodWorkbookBytes = encodeJson({
    format: 'srwb',
    version: 1,
    notebook: {
        name: 'Cálculo de Pi (catálogo)',
        kernelLanguage: 'prolog',
        cells: [{
            id: 1,
            type: 'markdown',
            language: 'markdown',
            code: '# Cálculo de Pi (catálogo)\n\nContenido verificado en español.',
        }, {
            id: 2,
            type: 'code',
            language: 'prolog',
            name: 'load_unifyweaver_dependency',
            code: "['/user/init.pl'].",
        }, {
            id: 3,
            type: 'code',
            language: 'javascript',
            name: 'must_not_auto_execute',
            code: 'globalThis.__catalogRemoteAutoExecuted = true;',
        }],
    },
});
const goodIpynbBytes = encodeJson({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
        kernelspec: { name: 'javascript', language: 'javascript', display_name: 'JavaScript' },
        language_info: { name: 'javascript' },
    },
    cells: [{
        cell_type: 'markdown',
        metadata: {},
        source: ['# Cuaderno IPYNB verificado\n', 'Contenido en español.'],
    }, {
        cell_type: 'code',
        execution_count: null,
        metadata: { scirepl_language: 'javascript', scirepl_name: 'ipynb_must_not_auto_execute' },
        outputs: [],
        source: ['globalThis.__catalogRemoteIpynbExecuted = true;'],
    }],
});
const expectedBadWorkbookBytes = encodeJson({
    format: 'srwb',
    version: 1,
    notebook: {
        name: 'Libro alterado',
        kernelLanguage: 'python',
        cells: [{ id: 1, type: 'markdown', language: 'markdown', code: '# Original' }],
    },
});
const servedBadWorkbookBytes = Buffer.from(expectedBadWorkbookBytes);
const badMutationOffset = servedBadWorkbookBytes.indexOf(Buffer.from('Original'));
if (badMutationOffset < 0) throw new Error('Tampered catalogue fixture marker is missing.');
servedBadWorkbookBytes[badMutationOffset] = 'T'.charCodeAt(0);

const catalogIndexBytes = encodeJson({
    format_version: '2.0',
    name: 'SciREPL Catalog browser fixture',
    source: 'https://github.com/s243a/SciREPL-Catalog',
    locales: ['es'],
    items: [
        {
            id: 'compute-pi-es-browser',
            name: 'Cálculo de Pi (catálogo)',
            description: 'Libro oficial verificado en español.',
            type: 'workbook',
            kernels: ['prolog', 'javascript'],
            requires: ['unifyweaver-scirepl'],
            locales: ['es'],
            format: 'srwb',
            path: 'workbooks/es/compute-pi-browser.srwb',
            revision: 2,
            size: goodWorkbookBytes.byteLength,
            sha256: sha256(goodWorkbookBytes),
        },
        {
            id: 'tampered-es-browser',
            name: 'Libro alterado (prueba)',
            description: 'Este artefacto debe rechazarse por su digest.',
            type: 'workbook',
            kernels: ['python'],
            locales: ['es'],
            format: 'srwb',
            path: 'workbooks/es/tampered-browser.srwb',
            revision: 1,
            size: expectedBadWorkbookBytes.byteLength,
            sha256: sha256(expectedBadWorkbookBytes),
        },
        {
            id: 'ipynb-es-browser',
            name: 'Cuaderno IPYNB verificado',
            description: 'Cuaderno oficial IPYNB en español.',
            type: 'workbook',
            kernels: ['javascript'],
            locales: ['es'],
            format: 'ipynb',
            path: 'workbooks/es/verified-browser.ipynb',
            revision: 1,
            size: goodIpynbBytes.byteLength,
            sha256: sha256(goodIpynbBytes),
        },
    ],
});
const catalogDescriptorBytes = encodeJson({
    schema: 1,
    tag: CATALOG_TAG,
    commit: CATALOG_COMMIT,
    date: '2026-08-14T21:08:44-06:00',
    catalog: `releases/${CATALOG_TAG}/catalog.json`,
    files_base: `releases/${CATALOG_TAG}/files/`,
    raw_base: `${CATALOG_RAW_ROOT}${CATALOG_COMMIT}/`,
    index: {
        sha256: sha256(catalogIndexBytes),
        size: catalogIndexBytes.byteLength,
        format_version: '2.0',
        items: 3,
    },
});

const catalogRoutes = new Map([
    [`${CATALOG_ROOT}stable.json`, catalogDescriptorBytes],
    [`${CATALOG_ROOT}releases/${CATALOG_TAG}/catalog.json`, catalogIndexBytes],
    [`${CATALOG_ROOT}releases/${CATALOG_TAG}/files/workbooks/es/compute-pi-browser.srwb`, goodWorkbookBytes],
    [`${CATALOG_RAW_ROOT}${CATALOG_COMMIT}/workbooks/es/compute-pi-browser.srwb`, goodWorkbookBytes],
    [`${CATALOG_ROOT}releases/${CATALOG_TAG}/files/workbooks/es/tampered-browser.srwb`, servedBadWorkbookBytes],
    [`${CATALOG_RAW_ROOT}${CATALOG_COMMIT}/workbooks/es/tampered-browser.srwb`, servedBadWorkbookBytes],
    [`${CATALOG_ROOT}releases/${CATALOG_TAG}/files/workbooks/es/verified-browser.ipynb`, goodIpynbBytes],
    [`${CATALOG_RAW_ROOT}${CATALOG_COMMIT}/workbooks/es/verified-browser.ipynb`, goodIpynbBytes],
]);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => consoleLogs.push(`[PAGE ERROR] ${err.message}`));

    let allPassed = true;
    const results = [];
    const testLog = (name, passed, detail) => {
        const mark = passed ? 'PASS' : 'FAIL';
        if (!passed) allPassed = false;
        results.push({ name, passed, detail });
        console.log(`  [${mark}] ${name}${detail ? ': ' + detail : ''}`);
    };

    try {
        console.log('1. Navigating to SciREPL...');

        const context = browser.contexts()[0];
        const remoteCatalogRequests = [];
        await context.route('https://s243a.github.io/SciREPL-Catalog/**', async route => {
            const url = route.request().url();
            remoteCatalogRequests.push(url);
            const body = catalogRoutes.get(url);
            if (!body) return route.abort('blockedbyclient');
            await route.fulfill({
                status: 200,
                contentType: url.endsWith('.srwb')
                    ? 'application/json' : 'application/json; charset=utf-8',
                body,
            });
        });
        await context.route('https://raw.githubusercontent.com/s243a/SciREPL-Catalog/**', async route => {
            const url = route.request().url();
            remoteCatalogRequests.push(url);
            const body = catalogRoutes.get(url);
            if (!body) return route.abort('blockedbyclient');
            await route.fulfill({ status: 200, contentType: 'application/json', body });
        });
        await context.route('https://api.github.com/repos/s243a/SciREPL-Catalog/**', route => {
            remoteCatalogRequests.push(route.request().url());
            return route.abort('blockedbyclient');
        });
        await context.addInitScript(({ privacyRevision }) => {
            if (!sessionStorage.getItem('catalog_test_seeded')) {
                sessionStorage.setItem('catalog_test_seeded', '1');
                localStorage.setItem('scirepl_privacy_accepted', '1');
                localStorage.setItem('scirepl_privacy_accepted_revision', privacyRevision);
                localStorage.setItem('scirepl_onboarding_seen', '1');
                localStorage.setItem('scirepl_auto_execute', '1');
                addEventListener('DOMContentLoaded', () => {
                    localStorage.setItem('scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version);
                }, { once: true });
                localStorage.removeItem('scirepl_installed_packages');
            }
        }, { privacyRevision: PRIVACY_REVISION });

        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        testLog('Remote catalogue stays idle until Browse is opened',
            remoteCatalogRequests.length === 0, remoteCatalogRequests.join(', '));


        // ── Test: Menu button text ──

        console.log('2. Testing menu button text...');

        const btnText = await page.evaluate(() => {
            return document.getElementById('btn-browse-packages')?.textContent?.trim();
        });
        testLog('Menu button includes Packages, Bundles & Workbooks',
            btnText && btnText.includes('Packages, Bundles & Workbooks'), btnText);

        // ── Test: Modal title ──

        console.log('3. Testing modal title...');

        const modalTitle = await page.evaluate(() => {
            const modal = document.getElementById('package-catalog-modal');
            return modal?.querySelector('h2')?.textContent?.trim();
        });
        testLog('Modal title includes Packages, Bundles & Workbooks',
            modalTitle === 'Browse Packages, Bundles & Workbooks', modalTitle);

        // ── Test: Open catalog modal ──

        console.log('4. Opening catalog modal...');

        await page.evaluate(() => {
            document.getElementById('btn-browse-packages').click();
        });

        await page.waitForSelector('#package-catalog-modal:not(.hidden)', { timeout: 5000 });
        testLog('Catalog modal opens', true);

        // ── Test: Section headers ──

        console.log('5. Testing section headers...');

        const sections = await page.evaluate(() => {
            const headers = document.querySelectorAll('#package-catalog-list .catalog-section-header');
            return Array.from(headers).map(h => h.textContent.trim());
        });

        testLog('Has "Packages" section', sections.includes('Packages'), sections.join(', '));
        testLog('Has "Bundles" section', sections.includes('Bundles'), sections.join(', '));
        testLog('Has "Workbooks" section', sections.includes('Workbooks'), sections.join(', '));
        testLog('Sections are ordered Packages, Bundles, Workbooks',
            sections.join('|') === 'Packages|Bundles|Workbooks', sections.join(', '));

        // ── Test: Catalog entries ──

        console.log('6. Testing catalog entries...');

        const cards = await page.evaluate(() => {
            const items = document.querySelectorAll('#package-catalog-list .pkg-card');
            return Array.from(items).map(card => {
                return {
                    name: card.querySelector('strong')?.textContent?.trim(),
                    kernels: card.querySelector('.pkg-kernels')?.textContent?.trim(),
                    contents: card.querySelector('.pkg-contents')?.textContent?.trim(),
                    requires: card.querySelector('.pkg-requires')?.textContent?.trim(),
                    buttonText: card.querySelector('.pkg-install-btn')?.textContent?.trim(),
                    buttonDisabled: !!card.querySelector('.pkg-install-btn')?.disabled,
                    hasInstallBtn: !!card.querySelector('.pkg-install-btn')
                };
            });
        });

        testLog('Has at least 18 catalog entries', cards.length >= 18, `${cards.length} entries`);

        const packageEntry = cards.find(c => c.name === 'UnifyWeaver SciREPL');
        const bundleEntry = cards.find(c => c.name === 'UnifyWeaver Tutorials & Compiler Demos');
        const workbookEntry = cards.find(c => c.name === 'Life Expectancy Analysis');
        const computePiEntry = cards.find(c => c.name === 'Compute Pi with Archimedean Bounds');
        const generatedLuaEntry = cards.find(c => c.name === 'Prolog Generates Lua');
        const generatedCljsEntry = cards.find(c => c.name === 'Prolog Generates ClojureScript');
        const nQueensEntry = cards.find(c => c.name === 'N-Queens: Prolog to ClojureScript');
        const typrIntroEntry = cards.find(c => c.name === 'TypR Introduction');
        const generatedTyprEntry = cards.find(c => c.name === 'Prolog Generates TypR');
        const callGraphEntry = cards.find(c => c.name === 'Call Graph Analysis and SCC Detection');

        testLog('Package entry exists', !!packageEntry);
        testLog('Clean profile offers the dependency package for installation',
            packageEntry?.buttonText === 'Install' && !packageEntry?.buttonDisabled,
            `${packageEntry?.buttonText}, disabled=${packageEntry?.buttonDisabled}`);
        testLog('UnifyWeaver bundle entry exists', !!bundleEntry);
        testLog('UnifyWeaver bundle advertises four workbooks', bundleEntry?.contents === '4 workbooks', bundleEntry?.contents);
        testLog('UnifyWeaver bundle displays its package dependency',
            bundleEntry?.requires === 'Requires: UnifyWeaver SciREPL', bundleEntry?.requires);
        testLog('Workbook entry exists', !!workbookEntry);
        testLog('Workbook shows python, r kernels', workbookEntry?.kernels === 'python, r', workbookEntry?.kernels);
        testLog('Compute Pi workbook exists', !!computePiEntry);
        testLog('Compute Pi workbook uses the Python kernel',
            computePiEntry?.kernels === 'python', computePiEntry?.kernels);
        testLog('Generated Lua entry exists', !!generatedLuaEntry);
        testLog('Generated Lua shows prolog, lua kernels', generatedLuaEntry?.kernels === 'prolog, lua', generatedLuaEntry?.kernels);
        const generatedLuaDefinition = await page.evaluate(() => {
            const item = window.packageCatalog.packages.find(p => p.id === 'prolog-generates-lua');
            return { revision: item?.revision, description: item?.description || '' };
        });
        testLog('Generated Lua advertises named queries and direct cell I/O',
            generatedLuaDefinition.description.includes('named query source cell') &&
            generatedLuaDefinition.description.includes('direct Lua cell I/O'));
        testLog('Generated Lua has an update revision',
            generatedLuaDefinition.revision === 2, String(generatedLuaDefinition.revision));
        testLog('Generated ClojureScript entry exists', !!generatedCljsEntry);
        testLog('Generated ClojureScript shows prolog, clojurescript kernels',
            generatedCljsEntry?.kernels === 'prolog, clojurescript', generatedCljsEntry?.kernels);
        testLog('N-Queens ClojureScript workbook exists', !!nQueensEntry);
        testLog('N-Queens workbook uses the Prolog and ClojureScript kernels',
            nQueensEntry?.kernels === 'prolog, clojurescript', nQueensEntry?.kernels);
        testLog('TypR introduction entry exists', !!typrIntroEntry);
        testLog('TypR introduction shows typr, r kernels', typrIntroEntry?.kernels === 'typr, r', typrIntroEntry?.kernels);
        const typrIntroDefinition = await page.evaluate(() => {
            const item = window.packageCatalog.packages.find(p => p.id === 'typr-introduction');
            return { revision: item?.revision, description: item?.description || '' };
        });
        testLog('TypR introduction advertises source directives',
            typrIntroDefinition.description.includes('source/type-check/transpiler'));
        testLog('TypR introduction has an update revision',
            typrIntroDefinition.revision === 1, String(typrIntroDefinition.revision));
        testLog('Generated TypR entry exists', !!generatedTyprEntry);
        testLog('Generated TypR shows prolog, typr, r kernels', generatedTyprEntry?.kernels === 'prolog, typr, r', generatedTyprEntry?.kernels);
        testLog('Call Graph workbook entry exists', !!callGraphEntry);
        const tutorialRevisions = await page.evaluate(() => {
            const byId = Object.fromEntries(window.packageCatalog.packages.map(item => [item.id, item]));
            return {
                familyTree: byId['unifyweaver-family-tree']?.revision,
                recursionPatterns: byId['unifyweaver-recursion-patterns']?.revision,
                callGraph: byId['unifyweaver-call-graph']?.revision,
            };
        });
        testLog('Family Tree workbook has the clean-output revision',
            tutorialRevisions.familyTree === 2, String(tutorialRevisions.familyTree));
        testLog('Recursion Patterns workbook has the clean-output revision',
            tutorialRevisions.recursionPatterns === 2, String(tutorialRevisions.recursionPatterns));
        testLog('Call Graph workbook has the clean-output revision',
            tutorialRevisions.callGraph === 3, String(tutorialRevisions.callGraph));

        console.log('6b. Testing catalog search and filter chrome...');

        const filterDefaults = await page.evaluate(() => {
            const spoken = document.getElementById('catalog-spoken-language');
            const kernel = document.getElementById('catalog-kernel');
            const allow = document.getElementById('catalog-allow-fallbacks');
            return {
                spoken: spoken?.value,
                i18nCurrent: window.i18n?.current,
                kernel: kernel?.value,
                allow: !!allow?.checked,
                summary: document.getElementById('catalog-fallback-summary')?.textContent?.trim() || '',
                locales: window.packageCatalog.builtinPackages.map(p => (p.locales || []).join(',')),
            };
        });
        testLog('Spoken-language select equals i18n.current on open',
            filterDefaults.spoken === filterDefaults.i18nCurrent,
            `${filterDefaults.spoken} vs ${filterDefaults.i18nCurrent}`);
        testLog('Kernel select equals All on open',
            filterDefaults.kernel === 'all', filterDefaults.kernel);
        testLog('Allow fallbacks is on by default',
            filterDefaults.allow === true, String(filterDefaults.allow));
        testLog('English primary does not duplicate English in the fallback summary',
            !/then English/i.test(filterDefaults.summary), filterDefaults.summary);
        testLog('Every built-in entry declares locales [en]',
            filterDefaults.locales.length >= 18 && filterDefaults.locales.every(v => v === 'en'),
            filterDefaults.locales.slice(0, 3).join('|'));

        await page.click('#catalog-edit-fallbacks');
        const fallbackFocus = await page.evaluate(() => ({
            active: document.activeElement?.id,
            browseHidden: document.getElementById('catalog-browse-panel')?.classList.contains('hidden'),
            fallbackHidden: document.getElementById('catalog-fallback-panel')?.classList.contains('hidden'),
        }));
        testLog('Opening fallback settings moves focus into the visible panel',
            fallbackFocus.active === 'catalog-fallback-back'
                && fallbackFocus.browseHidden === true
                && fallbackFocus.fallbackHidden === false,
            JSON.stringify(fallbackFocus));
        await page.click('#catalog-fallback-back');
        const browseFocus = await page.evaluate(() => ({
            active: document.activeElement?.id,
            browseHidden: document.getElementById('catalog-browse-panel')?.classList.contains('hidden'),
            fallbackHidden: document.getElementById('catalog-fallback-panel')?.classList.contains('hidden'),
        }));
        testLog('Returning to browse moves focus out of the hidden fallback panel',
            browseFocus.active === 'catalog-edit-fallbacks'
                && browseFocus.browseHidden === false
                && browseFocus.fallbackHidden === true,
            JSON.stringify(browseFocus));

        const hasJa = await page.evaluate(() =>
            [...document.getElementById('catalog-spoken-language').options]
                .some(o => o.value === 'ja'));
        if (hasJa) {
            await page.selectOption('#catalog-spoken-language', 'ja');
            const jaState = await page.evaluate(() => ({
                summary: document.getElementById('catalog-fallback-summary')?.textContent?.trim() || '',
                cards: document.querySelectorAll('#package-catalog-list .pkg-card').length,
            }));
            testLog('Fallback summary lists English when primary is not en',
                /English/i.test(jaState.summary), jaState.summary);
            testLog('Empty search still shows all built-in cards after changing spoken language',
                jaState.cards >= 18, String(jaState.cards));
            await page.selectOption('#catalog-spoken-language', filterDefaults.i18nCurrent || 'en');
        } else {
            testLog('Fallback summary lists English when primary is not en', false, 'ja option missing');
        }

        // --- "Always show built-in items" gates the default view ---
        if (hasJa) {
            await page.selectOption('#catalog-spoken-language', 'ja');
            await page.evaluate(() => {
                const c = document.getElementById('catalog-allow-fallbacks');
                if (c?.checked) c.click();               // fallbacks off: strict ja
            });
            const before = await page.evaluate(() => ({
                cards: document.querySelectorAll('#package-catalog-list .pkg-card').length,
                hint: !document.getElementById('catalog-builtins-hint')?.hidden,
                checked: document.getElementById('catalog-show-builtins')?.checked,
            }));
            testLog('Exemption on: strict ja empty view still shows every built-in',
                before.cards >= 18 && before.checked === true,
                `cards=${before.cards} checked=${before.checked}`);
            testLog('Hint explains foreign-language built-ins are being shown',
                before.hint === true, String(before.hint));

            await page.evaluate(() => document.getElementById('catalog-show-builtins')?.click());
            const gated = await page.evaluate(() => ({
                cards: document.querySelectorAll('#package-catalog-list .pkg-card').length,
                empty: document.querySelector('#package-catalog-list .catalog-empty')?.textContent?.trim() || '',
                stored: JSON.parse(localStorage.getItem('scirepl_catalog_locale') || '{}').showBuiltins,
            }));
            testLog('Unchecking hides English built-ins on the strict ja empty view',
                gated.cards === 0, `cards=${gated.cards}`);
            testLog('Gated empty view names the language, not a generic no-items',
                gated.empty.length > 0 && !/No items available/i.test(gated.empty), gated.empty);
            testLog('showBuiltins=false persists to localStorage',
                gated.stored === false, String(gated.stored));

            await page.evaluate(() => document.getElementById('catalog-show-builtins')?.click());
            await page.evaluate(() => {
                const c = document.getElementById('catalog-allow-fallbacks');
                if (c && !c.checked) c.click();          // restore defaults
            });
            const restored = await page.evaluate(() =>
                document.querySelectorAll('#package-catalog-list .pkg-card').length);
            testLog('Re-checking restores the full built-in list', restored >= 18, String(restored));
            await page.selectOption('#catalog-spoken-language', filterDefaults.i18nCurrent || 'en');
        } else {
            testLog('Exemption on: strict ja empty view still shows every built-in', false, 'ja option missing');
        }

        await page.selectOption('#catalog-kernel', 'lua');
        const luaCards = await page.evaluate(() =>
            [...document.querySelectorAll('#package-catalog-list .pkg-card')].map(card => ({
                name: card.querySelector('strong')?.textContent?.trim(),
                kernels: card.querySelector('.pkg-kernels')?.textContent?.trim() || '',
            })));
        testLog('Kernel lua hides non-Lua built-in cards',
            luaCards.length > 0 && luaCards.every(c => c.kernels.split(',').some(k => k.trim() === 'lua')),
            luaCards.map(c => `${c.name} [${c.kernels}]`).join('; '));

        await page.selectOption('#catalog-kernel', 'all');
        const restoredCards = await page.evaluate(() =>
            document.querySelectorAll('#package-catalog-list .pkg-card').length);
        testLog('Kernel All restores the built-in list',
            restoredCards >= 18, String(restoredCards));

        await page.setViewportSize({ width: 360, height: 740 });
        const narrowLayout = await page.evaluate(() => {
            const modal = document.querySelector('#package-catalog-modal .modal-content');
            const search = document.getElementById('catalog-search');
            const toolbar = document.querySelector('.catalog-toolbar');
            if (!modal || !search || !toolbar) return { ok: false };
            return {
                ok: true,
                overflow: modal.scrollWidth > modal.clientWidth + 2,
                searchVisible: search.getBoundingClientRect().width > 80,
                toolbarHeight: toolbar.getBoundingClientRect().height,
            };
        });
        testLog('Filter chrome wraps on a 360×740 viewport without horizontal overflow',
            narrowLayout.ok && !narrowLayout.overflow && narrowLayout.searchVisible,
            JSON.stringify(narrowLayout));

        // ── Verified remote SciREPL Catalog release ──

        console.log('6c. Testing the verified remote catalogue source...');

        await page.waitForFunction(() =>
            window.packageCatalog?._sourceResult?.status === 'verified', null, { timeout: 10_000 });
        const sourceState = await page.evaluate(() => ({
            status: window.packageCatalog._sourceResult?.status,
            tag: window.packageCatalog._sourceResult?.provenance?.tag,
            commit: window.packageCatalog._sourceResult?.provenance?.commit,
            remoteIds: window.packageCatalog._remoteEntries.map(item => item.id),
            builtinCount: window.packageCatalog.builtinPackages.length,
            summary: document.getElementById('catalog-source-summary')?.textContent?.trim() || '',
            privacyCurrent: localStorage.getItem('scirepl_privacy_accepted') === '1'
                && localStorage.getItem('scirepl_privacy_accepted_revision')
                    === window.kernelManager?.constructor?.PRIVACY_POLICY_REVISION,
            privacyRevision: localStorage.getItem('scirepl_privacy_accepted_revision'),
        }));
        testLog('Stable release descriptor and index verify locally',
            sourceState.status === 'verified' && sourceState.tag === CATALOG_TAG
                && sourceState.commit === CATALOG_COMMIT,
            JSON.stringify(sourceState));
        testLog('Catalogue network test accepts the current privacy revision',
            sourceState.privacyCurrent === true && sourceState.privacyRevision === PRIVACY_REVISION,
            `${sourceState.privacyCurrent} @ ${sourceState.privacyRevision}`);
        testLog('Verified source adds three official rows without changing built-ins',
            sourceState.remoteIds.join('|') === 'compute-pi-es-browser|tampered-es-browser|ipynb-es-browser'
                && sourceState.builtinCount >= 18,
            `remote=${sourceState.remoteIds.join(',')} builtins=${sourceState.builtinCount}`);
        testLog('Stable release path does not call the GitHub API',
            remoteCatalogRequests.every(url => !url.startsWith('https://api.github.com/')),
            remoteCatalogRequests.join(', '));
        const sourceControls = await page.evaluate(() => {
            document.getElementById('catalog-edit-source').click();
            const panel = document.getElementById('catalog-source-panel');
            const values = [...document.getElementById('catalog-source-mode').options]
                .map(option => option.value);
            const host = document.getElementById('catalog-source-host').value;
            const visible = !panel.classList.contains('hidden');
            document.getElementById('catalog-source-back').click();
            return { visible, values, host };
        });
        testLog('Source chooser exposes stable, release, commit, and development channels',
            sourceControls.visible
                && sourceControls.values.join('|') === 'stable|release|commit|development'
                && sourceControls.host === CATALOG_ROOT,
            JSON.stringify(sourceControls));
        const translatedSourceSummary = await page.evaluate(() => {
            const summary = document.getElementById('catalog-source-summary');
            const before = summary?.textContent?.trim() || '';
            document.dispatchEvent(new CustomEvent('i18n:changed'));
            return { before, after: summary?.textContent?.trim() || '' };
        });
        testLog('Language refresh preserves the selected source and release tag',
            translatedSourceSummary.before === translatedSourceSummary.after
                && translatedSourceSummary.after.includes(CATALOG_TAG),
            JSON.stringify(translatedSourceSummary));
        const atomicImportFallback = await page.evaluate(async () => {
            const atomic = window.fileIO.importWorkbook;
            const legacy = window.fileIO.importIpynb;
            let legacyCalls = 0;
            window.fileIO.importWorkbook = undefined;
            window.fileIO.importIpynb = () => { legacyCalls++; };
            let rejected = false;
            try {
                await window.packageCatalog._doImport({
                    id: 'remote-without-atomic-import',
                    type: 'workbook',
                    format: 'ipynb',
                    sourceId: 'scirepl-catalog',
                    _catalog: { sha256: '0'.repeat(64) },
                }, new Blob(['{}'], { type: 'application/json' }));
            } catch (_) {
                rejected = true;
            } finally {
                window.fileIO.importWorkbook = atomic;
                window.fileIO.importIpynb = legacy;
            }
            return { rejected, legacyCalls };
        });
        testLog('Verified remote workbooks never fall back to auto-executing legacy import',
            atomicImportFallback.rejected && atomicImportFallback.legacyCalls === 0,
            JSON.stringify(atomicImportFallback));

        const hasEs = await page.evaluate(() =>
            [...document.getElementById('catalog-spoken-language').options]
                .some(option => option.value === 'es'));
        testLog('Spanish is available as a spoken-language filter', hasEs);
        if (hasEs) {
            await page.selectOption('#catalog-spoken-language', 'es');
            await page.evaluate(() => {
                const allow = document.getElementById('catalog-allow-fallbacks');
                if (allow?.checked) allow.click();
                const builtins = document.getElementById('catalog-show-builtins');
                if (builtins?.checked) builtins.click();
            });
            const strictSpanish = await page.evaluate(() => ({
                cards: [...document.querySelectorAll('#package-catalog-list .pkg-card')].map(card => ({
                    key: card.dataset.catalogKey,
                    name: card.querySelector('strong')?.textContent?.trim(),
                })),
                allowFallbacks: document.getElementById('catalog-allow-fallbacks')?.checked,
                showBuiltins: document.getElementById('catalog-show-builtins')?.checked,
            }));
            testLog('Strict Spanish empty view shows official Spanish workbooks',
                strictSpanish.cards.length === 3
                    && strictSpanish.cards.every(card => card.key.startsWith('scirepl-catalog:'))
                    && strictSpanish.allowFallbacks === false
                    && strictSpanish.showBuiltins === false,
                JSON.stringify(strictSpanish));

            const invalidDependency = await page.evaluate(async () => {
                localStorage.setItem('scirepl_auto_switch_workbook', '0');
                const catalog = window.packageCatalog;
                const originalFetch = catalog._fetchCatalogItem.bind(catalog);
                let artifactFetches = 0;
                catalog._fetchCatalogItem = async (...args) => {
                    artifactFetches++;
                    return originalFetch(...args);
                };
                const notebooksBefore = window.notebookManager.getNotebooks().length;
                const installedBefore = localStorage.getItem('scirepl_installed_packages');
                const invalid = {
                    ...catalog._remoteEntries[0],
                    id: 'runtime-mutated-dependency',
                    catalogKey: 'scirepl-catalog:runtime-mutated-dependency',
                    requires: ['unknown-package'],
                };
                catalog._remoteEntries.push(invalid);
                const button = document.createElement('button');
                button.dataset.catalogKey = invalid.catalogKey;
                try {
                    await catalog._install(button);
                    return {
                        artifactFetches,
                        button: button.textContent.trim(),
                        installedChanged: localStorage.getItem('scirepl_installed_packages')
                            !== installedBefore,
                        notebookDelta: window.notebookManager.getNotebooks().length
                            - notebooksBefore,
                    };
                } finally {
                    catalog._remoteEntries = catalog._remoteEntries.filter(item => item !== invalid);
                    catalog._fetchCatalogItem = originalFetch;
                }
            });
            testLog('Unknown remote dependency fails before fetch or notebook/package mutation',
                invalidDependency.button === 'Failed'
                    && invalidDependency.artifactFetches === 0
                    && !invalidDependency.installedChanged
                    && invalidDependency.notebookDelta === 0,
                JSON.stringify(invalidDependency));

            await page.evaluate(() => {
                delete window.__catalogRemoteAutoExecuted;
                window.__catalogRemoteEnsureReadyCalls = 0;
                window.__catalogRemoteOriginalEnsureReady = window.kernelManager.ensureReady;
                window.kernelManager.ensureReady = function (...args) {
                    window.__catalogRemoteEnsureReadyCalls++;
                    return window.__catalogRemoteOriginalEnsureReady.apply(this, args);
                };
                window.__catalogRemoteOriginalDoImport =
                    window.packageCatalog._doImport.bind(window.packageCatalog);
                window.__catalogRemoteImportEnsureDeltas = {};
                window.packageCatalog._doImport = async function (pkg, blob) {
                    const before = window.__catalogRemoteEnsureReadyCalls;
                    const result = await window.__catalogRemoteOriginalDoImport(pkg, blob);
                    window.__catalogRemoteImportEnsureDeltas[pkg.id] =
                        window.__catalogRemoteEnsureReadyCalls - before;
                    return result;
                };
            });
            await page.click(
                '.pkg-card[data-catalog-key="scirepl-catalog:compute-pi-es-browser"] .pkg-install-btn');
            await page.waitForFunction(() => window.notebookManager.getNotebooks().some(notebook =>
                notebook.catalogId === 'scirepl-catalog:compute-pi-es-browser'),
            null, { timeout: 10_000 });
            const installedRemote = await page.evaluate(() => {
                const notebook = window.notebookManager.getNotebooks().find(item =>
                    item.catalogId === 'scirepl-catalog:compute-pi-es-browser');
                const entry = window.packageCatalog.packages.find(item =>
                    item.catalogKey === 'scirepl-catalog:compute-pi-es-browser');
                return {
                    name: notebook?.name,
                    installed: window.packageCatalog._isInstalled(entry),
                    catalogId: notebook?.catalogId,
                    catalogRevision: notebook?.catalogRevision,
                    catalogSourceId: notebook?.catalogSourceId,
                    catalogRef: notebook?.catalogRef,
                    catalogCommit: notebook?.catalogCommit,
                    catalogPath: notebook?.catalogPath,
                    catalogSha256: notebook?.catalogSha256,
                    autoExecuteEnabled: localStorage.getItem('scirepl_auto_execute') === '1',
                    sentinelPresent: notebook?.cells?.some(cell =>
                        cell.name === 'must_not_auto_execute'
                            && cell.code.includes('__catalogRemoteAutoExecuted')),
                    sentinelExecuted: window.__catalogRemoteAutoExecuted === true,
                    ensureReadyCalls: window.__catalogRemoteEnsureReadyCalls,
                    workbookEnsureReadyCalls:
                        window.__catalogRemoteImportEnsureDeltas?.['compute-pi-es-browser'],
                    requires: entry?.requires,
                    dependencyInstalled: window.packageCatalog._isInstalled(
                        window.packageCatalog.packages.find(item => item.id === 'unifyweaver-scirepl')),
                    rememberedDependencies: JSON.parse(
                        localStorage.getItem('scirepl_installed_packages') || '[]'),
                };
            });
            testLog('Official remote workbook installs through the normal import path',
                installedRemote.installed
                    && installedRemote.name === 'Cálculo de Pi (catálogo)'
                    && installedRemote.catalogRevision === 2,
                JSON.stringify(installedRemote));
            testLog('Remote install records namespaced, immutable provenance',
                installedRemote.catalogId === 'scirepl-catalog:compute-pi-es-browser'
                    && installedRemote.catalogSourceId === 'scirepl-catalog'
                    && installedRemote.catalogRef === CATALOG_TAG
                    && installedRemote.catalogCommit === CATALOG_COMMIT
                    && installedRemote.catalogPath === 'workbooks/es/compute-pi-browser.srwb'
                    && installedRemote.catalogSha256 === sha256(goodWorkbookBytes),
                JSON.stringify(installedRemote));
            testLog('Verified remote workbook never auto-executes with auto-execute enabled',
                installedRemote.autoExecuteEnabled
                    && installedRemote.sentinelPresent
                    && !installedRemote.sentinelExecuted
                    && installedRemote.workbookEnsureReadyCalls === 0,
                JSON.stringify(installedRemote));
            testLog('Remote dependency metadata installs UnifyWeaver from a clean profile',
                installedRemote.requires?.join('|') === 'unifyweaver-scirepl'
                    && installedRemote.dependencyInstalled
                    && installedRemote.rememberedDependencies.some(item =>
                        item?.id === 'unifyweaver-scirepl'),
                JSON.stringify(installedRemote));

            const dependencyRepair = await page.evaluate(async () => {
                const catalog = window.packageCatalog;
                const key = 'scirepl-catalog:compute-pi-es-browser';
                const entry = catalog.packages.find(item => item.catalogKey === key);
                const button = document.querySelector(
                    '.pkg-card[data-catalog-key="' + key + '"] .pkg-install-btn');
                const notebooksBefore = window.notebookManager.getNotebooks().slice();
                const originalFetch = catalog._fetchCatalogItem;
                const originalImport = catalog._doImport;
                const originalSetTimeout = window.setTimeout;
                const fetched = { failure: [], success: [] };
                const workbookImports = { failure: 0, success: 0 };
                let phase = 'failure';
                let result;
                catalog._fetchCatalogItem = async function (pkg) {
                    fetched[phase].push(pkg?.id || '');
                    if (phase === 'failure' && pkg?.id === 'unifyweaver-scirepl') {
                        throw new Error('deliberate dependency repair failure');
                    }
                    return originalFetch.call(this, pkg);
                };
                catalog._doImport = async function (pkg, blob) {
                    if (pkg?.id === 'compute-pi-es-browser') workbookImports[phase]++;
                    return originalImport.call(this, pkg, blob);
                };
                // Keep the deliberate failure's three-second label-reset timer
                // from racing the immediate success phase of this regression.
                window.setTimeout = function (callback, delay, ...args) {
                    if (delay === 3000) return 0;
                    return originalSetTimeout(callback, delay, ...args);
                };
                try {
                    localStorage.removeItem('scirepl_installed_packages');
                    catalog._syncInstallButtons();
                    const initial = {
                        state: catalog._installState(entry),
                        label: button?.textContent?.trim(),
                        expected: window.t('packageCatalog.update'),
                        disabled: button?.disabled,
                    };

                    const failureButton = document.createElement('button');
                    failureButton.dataset.catalogKey = key;
                    await catalog._install(failureButton);
                    const failure = {
                        state: catalog._installState(entry),
                        label: failureButton.textContent.trim(),
                        expected: window.t('packageCatalog.failed'),
                        disabled: failureButton.disabled,
                    };

                    phase = 'success';
                    await catalog._install(button);
                    const notebooksAfter = window.notebookManager.getNotebooks();
                    result = {
                        initial,
                        failure,
                        success: {
                            state: catalog._installState(entry),
                            label: button?.textContent?.trim(),
                            expected: window.t('packageCatalog.installed'),
                            disabled: button?.disabled,
                            dependencyInstalled: catalog._isInstalled(
                                catalog.packages.find(item => item.id === 'unifyweaver-scirepl')),
                        },
                        fetched,
                        workbookImports,
                        sameNotebooks: notebooksAfter.length === notebooksBefore.length
                            && notebooksAfter.every((notebook, index) =>
                                notebook === notebooksBefore[index]),
                    };
                } finally {
                    catalog._fetchCatalogItem = originalFetch;
                    catalog._doImport = originalImport;
                    window.setTimeout = originalSetTimeout;
                }
                return result;
            });
            testLog('Current workbook with a missing dependency exposes an Update repair',
                dependencyRepair.initial.state === 'outdated'
                    && dependencyRepair.initial.label === dependencyRepair.initial.expected
                    && !dependencyRepair.initial.disabled,
                JSON.stringify(dependencyRepair));
            testLog('Failed dependency-only repair stays actionable without touching the workbook',
                dependencyRepair.failure.state === 'outdated'
                    && dependencyRepair.failure.label === dependencyRepair.failure.expected
                    && !dependencyRepair.failure.disabled
                    && dependencyRepair.fetched.failure.join('|') === 'unifyweaver-scirepl'
                    && dependencyRepair.workbookImports.failure === 0
                    && dependencyRepair.sameNotebooks,
                JSON.stringify(dependencyRepair));
            testLog('Dependency-only repair installs the package without refetching or reimporting the workbook',
                dependencyRepair.success.state === 'current'
                    && dependencyRepair.success.label === dependencyRepair.success.expected
                    && dependencyRepair.success.disabled
                    && dependencyRepair.success.dependencyInstalled
                    && dependencyRepair.fetched.success.join('|') === 'unifyweaver-scirepl'
                    && dependencyRepair.workbookImports.success === 0
                    && dependencyRepair.sameNotebooks,
                JSON.stringify(dependencyRepair));

            await page.evaluate(() => { delete window.__catalogRemoteIpynbExecuted; });
            await page.click(
                '.pkg-card[data-catalog-key="scirepl-catalog:ipynb-es-browser"] .pkg-install-btn');
            await page.waitForFunction(() => window.notebookManager.getNotebooks().some(notebook =>
                notebook.catalogId === 'scirepl-catalog:ipynb-es-browser'),
            null, { timeout: 10_000 });
            const installedIpynb = await page.evaluate(() => {
                const notebook = window.notebookManager.getNotebooks().find(item =>
                    item.catalogId === 'scirepl-catalog:ipynb-es-browser');
                return {
                    present: !!notebook,
                    sentinelPresent: notebook?.cells?.some(cell =>
                        cell.name === 'ipynb_must_not_auto_execute'
                            && cell.code.includes('__catalogRemoteIpynbExecuted')),
                    sentinelExecuted: window.__catalogRemoteIpynbExecuted === true,
                    ensureReadyCalls: window.__catalogRemoteEnsureReadyCalls,
                    workbookEnsureReadyCalls:
                        window.__catalogRemoteImportEnsureDeltas?.['ipynb-es-browser'],
                    sha256: notebook?.catalogSha256,
                };
            });
            testLog('Verified IPYNB import is hash-bound and never auto-executes',
                installedIpynb.present
                    && installedIpynb.sentinelPresent
                    && !installedIpynb.sentinelExecuted
                    && installedIpynb.workbookEnsureReadyCalls === 0
                    && installedIpynb.sha256 === sha256(goodIpynbBytes),
                JSON.stringify(installedIpynb));
            await page.evaluate(() => {
                if (window.__catalogRemoteOriginalEnsureReady) {
                    window.kernelManager.ensureReady = window.__catalogRemoteOriginalEnsureReady;
                }
                if (window.__catalogRemoteOriginalDoImport) {
                    window.packageCatalog._doImport = window.__catalogRemoteOriginalDoImport;
                }
                delete window.__catalogRemoteOriginalEnsureReady;
                delete window.__catalogRemoteEnsureReadyCalls;
                delete window.__catalogRemoteOriginalDoImport;
                delete window.__catalogRemoteImportEnsureDeltas;
                localStorage.setItem('scirepl_auto_execute', '0');
                localStorage.removeItem('scirepl_auto_switch_workbook');
            });

            const dependencyRun = await page.evaluate(async () => {
                const notebook = window.notebookManager.getNotebooks().find(item =>
                    item.catalogId === 'scirepl-catalog:compute-pi-es-browser');
                const cell = notebook?.cells?.find(item =>
                    item.name === 'load_unifyweaver_dependency');
                if (!cell) return { cell: false };
                const result = await window.kernelManager.execute(cell.code, cell.language);
                return {
                    cell: true,
                    stdout: result?.stdout || '',
                    error: result?.error || '',
                };
            });
            testLog('Clean-profile remote workbook runs after its dependency is installed',
                dependencyRun.cell && !dependencyRun.error
                    && /true\./.test(dependencyRun.stdout),
                JSON.stringify(dependencyRun));

            const tamperedResult = await page.evaluate(async () => {
                const catalog = window.packageCatalog;
                const entry = catalog.packages.find(item =>
                    item.catalogKey === 'scirepl-catalog:tampered-es-browser');
                const before = catalog._catalogId(entry);
                try {
                    await catalog._fetchCatalogItem(entry);
                    return { rejected: false, before };
                } catch (error) {
                    return {
                        rejected: true,
                        error: error?.message || String(error),
                        before,
                        imported: window.notebookManager.getNotebooks().some(notebook =>
                            notebook.catalogId === before),
                    };
                }
            });
            testLog('Digest-mismatched workbook fails closed before import',
                tamperedResult.rejected && !tamperedResult.imported
                    && /SHA-256/.test(tamperedResult.error || ''),
                JSON.stringify(tamperedResult));

            const requestCountBeforeReload = remoteCatalogRequests.length;
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#run-btn:not([disabled])');
            await page.waitForFunction(() => window.notebookManager?.getNotebooks().some(notebook =>
                notebook.catalogId === 'scirepl-catalog:compute-pi-es-browser'),
            null, { timeout: 10_000 });
            const persistedRemote = await page.evaluate(() => {
                const notebook = window.notebookManager.getNotebooks().find(item =>
                    item.catalogId === 'scirepl-catalog:compute-pi-es-browser');
                return notebook ? {
                    catalogId: notebook.catalogId,
                    catalogRevision: notebook.catalogRevision,
                    catalogSourceId: notebook.catalogSourceId,
                    catalogRef: notebook.catalogRef,
                    catalogCommit: notebook.catalogCommit,
                    catalogPath: notebook.catalogPath,
                    catalogSha256: notebook.catalogSha256,
                } : null;
            });
            testLog('Remote workbook provenance survives app reload',
                persistedRemote?.catalogId === 'scirepl-catalog:compute-pi-es-browser'
                    && persistedRemote?.catalogRevision === 2
                    && persistedRemote?.catalogSourceId === 'scirepl-catalog'
                    && persistedRemote?.catalogRef === CATALOG_TAG
                    && persistedRemote?.catalogCommit === CATALOG_COMMIT
                    && persistedRemote?.catalogSha256 === sha256(goodWorkbookBytes),
                JSON.stringify(persistedRemote));

            await page.evaluate(() => document.getElementById('btn-browse-packages').click());
            await page.waitForFunction(() =>
                window.packageCatalog?._sourceResult?.status === 'cached', null, { timeout: 10_000 });
            testLog('Fresh verified catalogue cache restores without another network request',
                remoteCatalogRequests.length === requestCountBeforeReload,
                `${requestCountBeforeReload} before, ${remoteCatalogRequests.length} after`);

            await page.click('#catalog-edit-source');
            page.once('dialog', dialog => dialog.accept());
            await page.click('#catalog-source-clear-data');
            await page.waitForFunction(() =>
                window.packageCatalog?._sourceResult?.status === 'cleared');
            const clearedSource = await page.evaluate(() => ({
                remoteCount: window.packageCatalog._remoteEntries.length,
                status: document.getElementById('catalog-source-status')?.textContent?.trim() || '',
            }));
            testLog('Explicit source reset clears verified cache and trust state from the UI',
                clearedSource.remoteCount === 0 && /cleared/i.test(clearedSource.status),
                JSON.stringify(clearedSource));
            await page.click('#catalog-source-back');

            await page.selectOption('#catalog-spoken-language', 'en');
            await page.evaluate(() => {
                const allow = document.getElementById('catalog-allow-fallbacks');
                if (allow && !allow.checked) allow.click();
                const builtins = document.getElementById('catalog-show-builtins');
                if (builtins && !builtins.checked) builtins.click();
            });
        }

        const bundleDefinition = await page.evaluate(() => {
            const bundle = window.packageCatalog.packages.find(p => p.id === 'unifyweaver-workbooks');
            return { items: bundle?.items || [], requires: bundle?.requires || [] };
        });
        testLog('Bundle matches package-builder workbook list',
            bundleDefinition.items.join('|') === [
                'unifyweaver-family-tree',
                'unifyweaver-recursion-patterns',
                'unifyweaver-call-graph',
                'prolog-generates-r'
            ].join('|'), bundleDefinition.items.join(', '));
        testLog('Bundle declares UnifyWeaver package dependency',
            bundleDefinition.requires.includes('unifyweaver-scirepl'), bundleDefinition.requires.join(', '));

        const bundleInstall = await page.evaluate(async () => {
            const catalog = window.packageCatalog;
            const bundle = catalog.packages.find(p => p.id === 'unifyweaver-workbooks');
            await catalog._ensureDependencies(bundle);
            await catalog._doImport(bundle, null);
            catalog._syncInstallButtons();
            const names = window.notebookManager.getNotebooks().map(nb => nb.name);
            return { names, installed: catalog._isInstalled(bundle) };
        });
        for (const name of [
            'Family Tree Tutorial with UnifyWeaver',
            'Advanced Recursion Patterns in UnifyWeaver',
            'Call Graph Analysis and SCC Detection',
            'Prolog Generates R: Compiler Demo'
        ]) {
            testLog(`Bundle installs ${name}`, bundleInstall.names.includes(name));
        }
        testLog('Bundle reports Installed after all members are present', bundleInstall.installed);

        const callGraphWorkbook = await page.evaluate(async () => {
            try {
                const resp = await fetch('workbooks/03_call_graph_analysis.ipynb');
                if (!resp.ok) return { fetched: false, error: `HTTP ${resp.status}` };
                const workbook = await resp.json();
                const codeCells = (workbook.cells || [])
                    .filter(cell => cell.cell_type === 'code')
                    .map(cell => (cell.source || []).join(''));
                const scc = codeCells.find(code => code.includes("% Find SCCs using Tarjan's algorithm")) || '';
                const classification = codeCells.find(code => code.includes('% Check each SCC')) || '';
                const saveDot = codeCells.find(code => code.includes('even_odd_graph.dot') && code.includes('open(')) || '';
                const ordered = (code, snippets) => {
                    let position = -1;
                    return snippets.every(snippet => {
                        position = code.indexOf(snippet, position + 1);
                        return position >= 0;
                    });
                };
                const prose = (workbook.cells || [])
                    .map(cell => (cell.source || []).join(''))
                    .join('\n');
                return {
                    fetched: true,
                    sccSelfContained: ordered(scc, ['build_call_graph(', 'find_sccs(']),
                    classificationSelfContained: ordered(classification,
                        ['build_call_graph(', 'find_sccs(', 'forall(member(']),
                    dotSaveSelfContained: ordered(saveDot, ['build_call_graph(', 'generate_dot(', 'open(']),
                    dotSaveClosesSafely: saveDot.includes('setup_call_cleanup('),
                    dotSaveUsesSharedVfs: saveDot.includes("'/shared/data/even_odd_graph.dot'"),
                    groupTerminologyIsAccurate: prose.includes('mutually recursive predicate group') &&
                        !prose.includes('All predicates reachable from cousin/2'),
                };
            } catch (error) {
                return { fetched: false, error: error.message };
            }
        });
        testLog('Call Graph workbook fetches', callGraphWorkbook.fetched, callGraphWorkbook.error || '');
        testLog('SCC display cell reconstructs its graph', callGraphWorkbook.sccSelfContained);
        testLog('SCC classification cell reconstructs graph and components',
            callGraphWorkbook.classificationSelfContained);
        testLog('DOT save cell reconstructs its graph and DOT source', callGraphWorkbook.dotSaveSelfContained);
        testLog('DOT save cell closes its stream safely', callGraphWorkbook.dotSaveClosesSafely);
        testLog('DOT save cell writes to SharedVFS', callGraphWorkbook.dotSaveUsesSharedVfs);
        testLog('Predicate-group explanation describes an SCC', callGraphWorkbook.groupTerminologyIsAccurate);

        // ── Test: Workbook fetch via pages_url ──

        console.log('7. Testing workbook fetch...');

        const installResult = await page.evaluate(async () => {
            try {
                const resp = await fetch('workbooks/life_expectancy_csv_demo.ipynb');
                if (!resp.ok) return { fetched: false, error: `HTTP ${resp.status}` };
                const text = await resp.text();
                const parsed = JSON.parse(text);
                return {
                    fetched: true,
                    hasNbformat: parsed.nbformat === 4,
                    cellCount: parsed.cells?.length || 0
                };
            } catch (e) {
                return { fetched: false, error: e.message };
            }
        });

        testLog('Workbook fetches from pages_url', installResult.fetched, installResult.error || '');
        if (installResult.fetched) {
            testLog('Workbook is valid ipynb (nbformat 4)', installResult.hasNbformat);
            testLog('Workbook has cells', installResult.cellCount > 5, `${installResult.cellCount} cells`);
        }

        // ── Test: Generated Lua workbook ──

        console.log('8. Testing generated Lua workbook...');

        const luaWorkbookResult = await page.evaluate(async () => {
            try {
                const resp = await fetch('workbooks/prolog-generates-lua.srwb');
                if (!resp.ok) return { fetched: false, error: 'HTTP ' + resp.status };
                const workbook = await resp.json();
                const cells = workbook.notebook?.cells || [];
                const embedded = cells.find(cell => cell.name === 'compile_embedded');
                const vfs = cells.find(cell => cell.name === 'compile_vfs');
                const query = cells.find(cell => cell.name === 'lua_queries');
                const cellIo = cells.find(cell => cell.name === 'lua_cell_io');
                const target = cells.find(cell => cell.name === 'lua_written');
                const compilerCode = [embedded?.code || '', vfs?.code || ''];
                return {
                    fetched: true,
                    bothReadNamedQueries: compilerCode.every(code =>
                        /nb_read\('lua_queries', '\.code', _?QuerySource\)/.test(code)),
                    hasInlineQueryFormatter: compilerCode.some(code =>
                        code.includes('format(string(Queries)')),
                    hasInlineQueryProgram: compilerCode.some(code =>
                        code.includes('find_all("alice")')),
                    queryIsSourceCell: query?.language === 'lua' &&
                        query?.code?.startsWith('#!source\n'),
                    queryHasHighlightedProgram: query?.code?.includes('local results = find_all("alice")'),
                    demonstratesCellIo: cellIo?.language === 'lua' &&
                        cellIo?.code?.includes('nb.read("lua_queries", ".code")') &&
                        cellIo?.code?.includes('nb.write("lua_written", ".code", note)'),
                    hasWriteTarget: target?.language === 'lua'
                };
            } catch (e) {
                return { fetched: false, error: e.message };
            }
        });

        testLog('Generated Lua workbook fetches from pages_url', luaWorkbookResult.fetched, luaWorkbookResult.error || '');
        if (luaWorkbookResult.fetched) {
            testLog('Both Lua compiler cells read the named query source', luaWorkbookResult.bothReadNamedQueries);
            testLog('Lua compiler cells omit inline query formatters', !luaWorkbookResult.hasInlineQueryFormatter);
            testLog('Lua compiler cells omit inline query programs', !luaWorkbookResult.hasInlineQueryProgram);
            testLog('Lua queries live in a highlighted source-only cell',
                luaWorkbookResult.queryIsSourceCell && luaWorkbookResult.queryHasHighlightedProgram);
            testLog('Lua workbook demonstrates direct cell read and write',
                luaWorkbookResult.demonstratesCellIo && luaWorkbookResult.hasWriteTarget);
        }

        // ── Test: Generated TypR workbook ──

        console.log('9. Testing generated TypR workbook...');

        const typrWorkbookResult = await page.evaluate(async () => {
            try {
                const resp = await fetch('workbooks/prolog-generates-typr.srwb');
                if (!resp.ok) return { fetched: false, error: 'HTTP ' + resp.status };
                const workbook = await resp.json();
                const compileCell = workbook.notebook?.cells?.find(cell => cell.name === 'compile_to_typr');
                const queryCell = workbook.notebook?.cells?.find(cell => cell.name === 'typr_queries');
                const rCompileCell = workbook.notebook?.cells?.find(cell => cell.name === 'compile_to_r');
                const rQueryCell = workbook.notebook?.cells?.find(cell => cell.name === 'r_queries');
                const code = compileCell?.code || '';
                return {
                    fetched: true,
                    readsNamedPrologCell: /nb_read\('family_tree', '\.code', _?PrologSrc\)/.test(code),
                    readsNamedQueryCell: /nb_read\('typr_queries', '\.code', _?QuerySource\)/.test(code),
                    hasInlineQueryProgram: code.includes('format(string(Queries)'),
                    queryIsSourceCell: queryCell?.language === 'typr' && queryCell?.code?.startsWith('#!source\n'),
                    forwardsVariadicResults: queryCell?.code?.includes('paste(sep = ", ", ...results)'),
                    rQueriesAreSeparate: !rCompileCell?.code?.includes('format(string(Queries)') &&
                        rQueryCell?.language === 'r' && rQueryCell?.code?.includes('ancestor_all("alice")')
                };
            } catch (e) {
                return { fetched: false, error: e.message };
            }
        });

        testLog('Generated TypR workbook fetches from pages_url', typrWorkbookResult.fetched, typrWorkbookResult.error || '');
        if (typrWorkbookResult.fetched) {
            testLog('Generated TypR compiler reads the named Prolog source cell', typrWorkbookResult.readsNamedPrologCell);
            testLog('Generated TypR compiler reads the named query source cell', typrWorkbookResult.readsNamedQueryCell);
            testLog('Generated TypR compiler omits inline query programs', !typrWorkbookResult.hasInlineQueryProgram);
            testLog('Generated TypR queries use a non-executing source cell', typrWorkbookResult.queryIsSourceCell);
            testLog('Generated TypR queries forward the descendant list through variadic paste',
                typrWorkbookResult.forwardsVariadicResults);
            testLog('Plain R queries live in their own highlighted cell', typrWorkbookResult.rQueriesAreSeparate);
        }

        // ── Test: stale catalog workbook update ──

        console.log('10. Testing stale workbook update...');

        const workbookUpdate = await page.evaluate(async () => {
            const catalog = window.packageCatalog;
            const nm = window.notebookManager;
            const pkg = catalog.packages.find(item => item.id === 'prolog-generates-typr');

            // Simulate a workbook restored from before catalog revisions existed.
            const stale = nm.createNotebook({
                name: pkg.notebookName,
                cells: [{ code: 'user-edited legacy content', type: 'code', language: 'typr' }]
            });
            catalog._syncInstallButtons();
            const button = document.querySelector(
                `.pkg-install-btn[data-catalog-key="${catalog._catalogId(pkg)}"]`);
            const before = button.textContent.trim();

            const response = await fetch(pkg.pages_url);
            await catalog._doImport(pkg, await response.blob());
            catalog._syncInstallButtons();

            const matches = nm.getNotebooks().filter(nb => nb.name === pkg.notebookName);
            const updated = matches[0];
            const backup = nm.getNotebook(stale.id);
            const compileCell = updated?.cells?.find(cell => cell.name === 'compile_to_typr');
            return {
                before,
                after: button.textContent.trim(),
                disabled: button.disabled,
                matchCount: matches.length,
                catalogId: updated?.catalogId,
                catalogRevision: updated?.catalogRevision,
                backupName: backup?.name,
                backupCode: backup?.cells?.[0]?.code,
                backupCatalogId: backup?.catalogId,
                readsNamedCell: /nb_read\('family_tree', '\.code', _?PrologSrc\)/.test(compileCell?.code || ''),
                readsNamedQueries: /nb_read\('typr_queries', '\.code', _?QuerySource\)/.test(compileCell?.code || '')
            };
        });

        testLog('Stale TypR workbook is labelled Update', workbookUpdate.before === 'Update', workbookUpdate.before);
        testLog('Update installs one current workbook under the canonical name',
            workbookUpdate.matchCount === 1, `${workbookUpdate.matchCount} copies`);
        testLog('Update preserves user-edited legacy content as a backup',
            workbookUpdate.backupName?.startsWith('Prolog Generates TypR: Compiler Demo (backup of ') &&
            workbookUpdate.backupCode === 'user-edited legacy content' &&
            workbookUpdate.backupCatalogId == null,
            workbookUpdate.backupName || 'missing backup');
        testLog('Updated workbook records its catalog revision',
            workbookUpdate.catalogId === 'prolog-generates-typr' && workbookUpdate.catalogRevision === 4,
            `${workbookUpdate.catalogId}@${workbookUpdate.catalogRevision}`);
        testLog('Updated workbook uses the named family_tree cell', workbookUpdate.readsNamedCell);
        testLog('Updated workbook uses the named typr_queries cell', workbookUpdate.readsNamedQueries);
        testLog('Updated workbook is labelled Installed',
            workbookUpdate.after === 'Installed' && workbookUpdate.disabled,
            `${workbookUpdate.after}, disabled=${workbookUpdate.disabled}`);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#run-btn:not([disabled])');
        await page.evaluate(() => document.getElementById('btn-browse-packages').click());
        const persistedUpdateState = await page.evaluate(() => {
            const catalog = window.packageCatalog;
            const pkg = catalog.packages.find(item => item.id === 'prolog-generates-typr');
            const notebook = window.notebookManager.getNotebooks().find(nb => nb.name === pkg.notebookName);
            return {
                installed: catalog._isInstalled(pkg),
                catalogId: notebook?.catalogId,
                catalogRevision: notebook?.catalogRevision
            };
        });
        testLog('Workbook revision survives app reload',
            persistedUpdateState.installed &&
            persistedUpdateState.catalogId === 'prolog-generates-typr' &&
            persistedUpdateState.catalogRevision === 4);

        // ── Test: importIpynb integration ──

        console.log('11. Testing importIpynb integration...');

        const importResult = await page.evaluate(async () => {
            const resp = await fetch('workbooks/life_expectancy_csv_demo.ipynb');
            const text = await resp.text();

            window.fileIO.importIpynb(text);
            const cellsAfter = window._cells ? window._cells.length : 0;

            // Check that cells include content from the workbook
            const hasLifeExp = (window._cells || []).some(c =>
                c.code && c.code.includes('Life Expectancy')
            );

            return { cellsAfter, hasLifeExp };
        });

        testLog('importIpynb loads workbook content', importResult.hasLifeExp,
            `${importResult.cellsAfter} cells, hasLifeExp=${importResult.hasLifeExp}`);

        // ── Test: Clear History resets catalog installation state ──

        console.log('12. Testing Clear History package-state reset...');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT }),
            page.evaluate(() => {
                const button = document.getElementById('btn-clear-session');
                button.click();
                button.click();
            })
        ]);
        await page.waitForSelector('#run-btn:not([disabled])');
        await page.evaluate(() => document.getElementById('btn-browse-packages').click());
        const clearedPackageState = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('#package-catalog-list .pkg-card')];
            const card = cards.find(item => item.querySelector('strong')?.textContent?.trim() === 'UnifyWeaver SciREPL');
            const button = card?.querySelector('.pkg-install-btn');
            return {
                stored: localStorage.getItem('scirepl_installed_packages'),
                buttonText: button?.textContent?.trim(),
                disabled: !!button?.disabled
            };
        });
        testLog('Clear History removes remembered package installations',
            clearedPackageState.stored === null, clearedPackageState.stored || 'not stored');
        testLog('Catalog shows Install after Clear History and reload',
            clearedPackageState.buttonText === 'Install' && !clearedPackageState.disabled,
            `${clearedPackageState.buttonText}, disabled=${clearedPackageState.disabled}`);

        // --- Summary ---
        console.log('\n' + '='.repeat(50));
        const passCount = results.filter(r => r.passed).length;
        console.log(`Results: ${passCount}/${results.length} passed`);
        console.log(allPassed ? '\nPASS: All browse catalog tests passed!' : '\nFAIL: Some tests failed');

    } catch (err) {
        console.error('FATAL:', err.message);
        console.error('Console logs:', consoleLogs.slice(-15).join('\n'));
        allPassed = false;
    } finally {
        await browser.close();
        process.exit(allPassed ? 0 : 1);
    }
})();
