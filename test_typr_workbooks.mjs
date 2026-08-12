/** End-to-end regression test for both TypR catalog workbooks. */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8085';
const TIMEOUT = 300_000;

function assert(condition, message, detail = '') {
    if (!condition) throw new Error(message + (detail ? `: ${detail}` : ''));
    console.log(`  PASS: ${message}`);
}

async function installCatalogItem(page, name) {
    await page.evaluate(() => {
        document.getElementById('btn-browse-packages').click();
    });
    await page.waitForSelector('#package-catalog-modal:not(.hidden)');

    await page.evaluate(async (itemName) => {
        const cards = [...document.querySelectorAll('#package-catalog-list .pkg-card')];
        const card = cards.find(c => c.querySelector('strong')?.textContent?.trim() === itemName);
        if (!card) throw new Error(`Catalog item not found: ${itemName}`);
        const button = card.querySelector('.pkg-install-btn');
        await window.packageCatalog._install(button);
    }, name);
}

async function runAllAndCollect(page) {
    await page.evaluate(async () => window.runAllCells());
    return page.evaluate(() => (window._cells || []).map(cell => ({
        name: cell.name,
        language: cell.language,
        code: cell.code,
        output: cell.outputCard?.querySelector('.card-body')?.textContent || '',
        error: !!cell.outputCard?.classList.contains('card-error'),
        plots: cell.outputCard?.querySelectorAll('.js-plotly-plot').length || 0,
    })));
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
        localStorage.clear();
        localStorage.setItem('scirepl_privacy_accepted', '1');
        localStorage.setItem('scirepl_onboarding_seen', '1');
        addEventListener('DOMContentLoaded', () => localStorage.setItem(
            'scirepl_whats_new_seen_version', window.KERNEL_CONFIG.app.version), { once: true });
        localStorage.setItem('scirepl_auto_download', '1');
        localStorage.removeItem('scirepl_enabled_languages');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.on('console', msg => {
        const text = msg.text();
        if (/error|TypR|dependency|Prolog/i.test(text)) {
            console.log('  [page]', text.substring(0, 240));
        }
    });

    try {
        console.log('1. Loading SciREPL...');
        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForSelector('#run-btn:not([disabled])');

        console.log('\n2. Installing and running TypR Introduction...');
        await installCatalogItem(page, 'TypR Introduction');
        const intro = await runAllAndCollect(page);
        const introErrors = intro.filter(c => c.error);
        assert(introErrors.length === 0, 'TypR Introduction Run All has no error cards',
            introErrors.map(c => c.name).join(', '));

        const square = intro.find(c => c.name === 'square');
        const forwarding = intro.find(c => c.name === 'variadic_forwarding');
        const transpile = intro.find(c => c.name === 'transpile_demo');
        const forwardingR = await page.evaluate(source => {
            const kernel = window.kernelManager.getKernel('typr');
            const compiled = kernel._typrModule.compile(source);
            const main = compiled.r_code.indexOf('# === Main Code ===');
            return compiled.r_code.substring(main >= 0 ? main : 0);
        }, forwarding?.code || '');
        assert(square?.output.includes('7 squared = 49'), 'typed square executes', square?.output);
        assert(forwarding?.output.includes('Names: count, enabled'),
            'heterogeneous named arguments survive variadic forwarding',
            `${forwarding?.output}\nGenerated R:\n${forwardingR}`);
        assert(!forwarding?.output.includes('Type errors'), 'variadic forwarding type-checks');
        assert(transpile?.output.includes('fib'), 'typed recursive function transpiles');

        console.log('\n3. Installing and running Prolog Generates TypR...');
        await installCatalogItem(page, 'Prolog Generates TypR');

        const dependency = await page.evaluate(() => {
            const installed = JSON.parse(localStorage.getItem('scirepl_installed_packages') || '[]');
            return installed.some(p => p.name === 'UnifyWeaver SciREPL');
        });
        assert(dependency, 'catalog installs and remembers the UnifyWeaver dependency');

        const generated = await runAllAndCollect(page);
        const generatedErrors = generated.filter(c => c.error);
        assert(generatedErrors.length === 0, 'Prolog Generates TypR Run All has no error cards',
            generatedErrors.map(c => `${c.name || '(unnamed)'}: ${c.output}`).join(' | '));

        const compileCell = generated.find(c => c.name === 'compile_to_typr');
        const querySourceCell = generated.find(c => c.name === 'typr_queries');
        const typrCell = generated.find(c => c.name === 'typr_output');
        const rCell = generated.find(c => c.name === 'r_output');
        const rQueries = generated.find(c => c.name === 'r_queries');
        const querySourceUi = await page.evaluate(() => {
            const cell = (window._cells || []).find(c => c.name === 'typr_queries');
            const code = cell?.inputCard?.querySelector('pre code');
            const badge = cell?.inputCard?.querySelector('.source-only-badge');
            const executable = (window._cells || []).find(c => c.name === 'typr_output');
            const magicCard = window._appInternals.createInputCard(
                '%%typr\n  #!SOURCE\nlet stored <- 1;', 99999, 'code', 'python'
            );
            const magicHasBadge = !!magicCard.querySelector('.source-only-badge');
            magicCard.remove();
            return {
                hasCode: !!code,
                stringTokens: code?.querySelectorAll('.hljs-string').length || 0,
                badgeText: badge?.textContent?.trim(),
                badgeTitle: badge?.title,
                badgeAria: badge?.getAttribute('aria-label'),
                badgeRole: badge?.getAttribute('role'),
                sourceOnlyClass: cell?.inputCard?.classList.contains('card-source-only'),
                sourceOnlyData: cell?.inputCard?.dataset.sourceOnly,
                hasOutputCard: !!cell?.outputCard,
                executableHasBadge: !!executable?.inputCard?.querySelector('.source-only-badge'),
                magicHasBadge,
            };
        });
        const sourceBadgeAccessibility = await page.locator('.source-only-badge').first().ariaSnapshot();
        const generatedR = await page.evaluate(source => {
            const kernel = window.kernelManager.getKernel('typr');
            return kernel._typrModule.compile(source).r_code;
        }, typrCell?.code || '');
        assert(/nb_read\('family_tree', '\.code', _?PrologSrc\)/.test(compileCell?.code || ''),
            'compiler reads Prolog source from the named family_tree cell');
        assert(querySourceCell?.code.startsWith('#!source\n') &&
            querySourceCell.code.includes('ancestor_all("alice")'),
            'TypR queries live in a named source cell');
        assert(/nb_read\('typr_queries', '\.code', _?QuerySource\)/.test(compileCell?.code || ''),
            'compiler reads queries from the named typr_queries cell');
        assert(!compileCell?.code.includes('format(string(Queries)'),
            'compiler cell contains no inline TypR query program');
        assert(querySourceUi.hasCode && querySourceUi.stringTokens > 0,
            'TypR query source receives syntax highlighting',
            JSON.stringify(querySourceUi));
        assert(!querySourceCell?.error && querySourceCell?.output === '',
            '#!source keeps the named query fragment non-executing during Run All');
        assert(querySourceUi.badgeText === 'source only' &&
            querySourceUi.badgeTitle?.includes('no output is expected') &&
            querySourceUi.badgeAria === querySourceUi.badgeTitle &&
            querySourceUi.badgeRole === 'note',
            'source-only cell shows an accessible explanatory badge',
            JSON.stringify(querySourceUi));
        assert(sourceBadgeAccessibility.includes('note') &&
            sourceBadgeAccessibility.includes('no output is expected'),
            'source-only explanation appears in Chromium accessibility tree',
            sourceBadgeAccessibility);
        assert(querySourceUi.sourceOnlyClass && querySourceUi.sourceOnlyData === 'true' &&
            !querySourceUi.hasOutputCard && !querySourceUi.executableHasBadge &&
            querySourceUi.magicHasBadge,
            'direct and %%typr source fragments are marked without mislabelling executable cells',
            JSON.stringify(querySourceUi));

        const sourceBadgeLifecycle = await page.evaluate(() => {
            const cells = window._cells || [];
            const index = cells.findIndex(c => c.name === 'typr_queries');
            const cell = cells[index];
            const original = cell.code;
            const withoutDirective = original.replace(/^\s*#!source\s*\r?\n/i, '');

            window.notebookVFS._setCellProperty(index, '.code', withoutDirective);
            const removed = !cell.inputCard.querySelector('.source-only-badge') &&
                !cell.inputCard.classList.contains('card-source-only');

            window.notebookVFS._setCellProperty(index, '.code', original);
            const restored = !!cell.inputCard.querySelector('.source-only-badge') &&
                cell.inputCard.dataset.sourceOnly === 'true';
            return { removed, restored };
        });
        assert(sourceBadgeLifecycle.removed && sourceBadgeLifecycle.restored,
            'source-only badge follows Notebook VFS code changes',
            JSON.stringify(sourceBadgeLifecycle));

        await page.setViewportSize({ width: 360, height: 740 });
        const mobileHeader = await page.evaluate(() => {
            const cell = (window._cells || []).find(c => c.name === 'typr_queries');
            const header = cell?.inputCard?.querySelector('.card-label');
            return {
                clientWidth: header?.clientWidth || 0,
                scrollWidth: header?.scrollWidth || 0,
            };
        });
        assert(mobileHeader.clientWidth > 0 && mobileHeader.scrollWidth <= mobileHeader.clientWidth,
            'named source-only header fits a 360px mobile viewport',
            JSON.stringify(mobileHeader));
        assert(compileCell?.output.includes('TypR code written to cell'), 'Prolog populates the TypR cell');
        assert(typrCell?.code.includes('fn(start: char)') && !typrCell.code.includes('@{'),
            'UnifyWeaver emits native typed TypR without raw-R traversal blocks');
        assert(!typrCell?.output.includes('Type errors'), 'generated TypR type-checks', typrCell?.output);
        assert(typrCell?.output.includes('Descendants of alice: bob, charlie, diana, eve, frank'),
            'generated TypR spreads the descendant list into comma-separated variadic arguments',
            `${typrCell?.output}\nGenerated casts:\n${generatedR.split('\n').filter(line => line.includes('as.Array')).join('\n')}`);
        assert(typrCell?.output.includes('alice is ancestor of eve: TRUE'),
            'generated TypR check query succeeds', typrCell?.output);
        assert(!rCell?.error && !rCell?.code.includes('Descendants of alice:'),
            'R compiler output contains definitions rather than appended queries', rCell?.code);
        assert(rQueries?.output.includes('Descendants of alice:') &&
            rQueries.output.includes('alice is ancestor of eve: TRUE') && !rQueries.error,
            'separate highlighted R query cell executes after generated definitions',
            rQueries?.output);

        console.log('\n4. Installing and running Prolog Generates Lua...');
        await page.setViewportSize({ width: 1280, height: 900 });
        await installCatalogItem(page, 'Prolog Generates Lua');
        const generatedLua = await runAllAndCollect(page);
        const luaErrors = generatedLua.filter(c => c.error);
        assert(luaErrors.length === 0, 'Prolog Generates Lua Run All has no error cards',
            luaErrors.map(c => `${c.name || '(unnamed)'}: ${c.output}`).join(' | '));

        const luaQueries = generatedLua.find(c => c.name === 'lua_queries');
        const compileEmbedded = generatedLua.find(c => c.name === 'compile_embedded');
        const compileVfs = generatedLua.find(c => c.name === 'compile_vfs');
        const luaEmbedded = generatedLua.find(c => c.name === 'lua_embedded');
        const luaVfs = generatedLua.find(c => c.name === 'lua_vfs');
        const luaCellIo = generatedLua.find(c => c.name === 'lua_cell_io');
        const luaWritten = generatedLua.find(c => c.name === 'lua_written');
        const luaSourceUi = await page.evaluate(() => {
            const cell = (window._cells || []).find(c => c.name === 'lua_queries');
            const code = cell?.inputCard?.querySelector('pre code');
            const badge = cell?.inputCard?.querySelector('.source-only-badge');
            return {
                stringTokens: code?.querySelectorAll('.hljs-string').length || 0,
                badgeText: badge?.textContent?.trim(),
                badgeRole: badge?.getAttribute('role'),
                sourceOnlyClass: cell?.inputCard?.classList.contains('card-source-only'),
                hasOutputCard: !!cell?.outputCard,
            };
        });

        assert(luaQueries?.code.startsWith('#!source\n') &&
            luaQueries.code.includes('local results = find_all("alice")'),
            'Lua queries live in a named source cell');
        assert(!luaQueries?.error && luaQueries?.output === '' &&
            luaSourceUi.badgeText === 'source only' &&
            luaSourceUi.badgeRole === 'note' &&
            luaSourceUi.sourceOnlyClass && !luaSourceUi.hasOutputCard,
            '#!source keeps the highlighted Lua query program non-executing',
            JSON.stringify(luaSourceUi));
        assert(luaSourceUi.stringTokens > 0, 'Lua query strings retain syntax highlighting',
            JSON.stringify(luaSourceUi));
        for (const compiler of [compileEmbedded, compileVfs]) {
            assert(/nb_read\('lua_queries', '\.code', _?QuerySource\)/.test(compiler?.code || ''),
                `${compiler?.name} reads the named Lua query cell`);
            assert(!compiler?.code.includes('format(string(Queries)') &&
                !compiler?.code.includes('find_all("alice")'),
                `${compiler?.name} contains no inline Lua query program`);
        }
        for (const target of [luaEmbedded, luaVfs]) {
            const output = target?.output?.toLowerCase() || '';
            assert(target?.code.includes('local results = find_all("alice")') &&
                !target.code.includes('#!source'),
                `${target?.name} receives the named Lua queries`);
            assert(output.includes('descendants of alice:') && output.includes('eve') &&
                output.includes('alice -> eve: true') && output.includes('alice -> frank: true'),
                `${target?.name} executes the generated transitive closure`, target?.output);
        }
        assert(luaCellIo?.output.includes('Lua read lua_queries and wrote lua_written'),
            'Lua reads and writes notebook cells through nb.read/nb.write', luaCellIo?.output);
        assert(luaWritten?.code.includes('Written from Lua after reading lua_queries'),
            'Lua nb.write updates the named target cell', luaWritten?.code);

        console.log('\n5. Installing and running Prolog Generates ClojureScript...');
        await installCatalogItem(page, 'Prolog Generates ClojureScript');
        const generatedCljs = await runAllAndCollect(page);
        const cljsErrors = generatedCljs.filter(c => c.error);
        assert(cljsErrors.length === 0, 'Prolog Generates ClojureScript Run All has no error cards',
            cljsErrors.map(c => `${c.name || '(unnamed)'}: ${c.output}`).join(' | '));

        const compileCljs = generatedCljs.find(c => c.name === 'compile_to_clojurescript');
        const cljsDefinitions = generatedCljs.find(c => c.name === 'cljs_output');
        const cljsQueries = generatedCljs.find(c => c.name === 'cljs_queries');
        assert(!compileCljs?.code.includes('format(string(Queries)') &&
            !compileCljs?.code.includes('find-all "alice"'),
            'ClojureScript compiler cell contains definitions rather than inline queries',
            compileCljs?.code);
        assert(cljsDefinitions?.code.includes('(def base-relation') &&
            !cljsDefinitions.code.includes('Descendants of alice:') &&
            cljsDefinitions.code.trimEnd().endsWith('nil'),
            'generated ClojureScript definitions live in their own cell',
            cljsDefinitions?.code);
        assert(cljsQueries?.code.includes('(find-all "alice")') &&
            cljsQueries.output.includes('Descendants of alice:') &&
            cljsQueries.output.includes('eve') && cljsQueries.output.includes('frank') &&
            cljsQueries.output.includes('alice is ancestor of eve: true') &&
            cljsQueries.output.includes('alice is ancestor of frank: true'),
            'separate highlighted ClojureScript queries execute with readable line breaks',
            cljsQueries?.output);
        assert(cljsQueries?.output.split('\n').filter(Boolean).length === 3,
            'ClojureScript query output contains three separate lines', cljsQueries?.output);

        console.log('\n6. Installing and running Compute Pi with Archimedean Bounds...');
        await installCatalogItem(page, 'Compute Pi with Archimedean Bounds');
        const computePi = await runAllAndCollect(page);
        const computeErrors = computePi.filter(c => c.error);
        assert(computeErrors.length === 0, 'Compute Pi Run All has no error cards',
            computeErrors.map(c => `${c.name || '(unnamed)'}: ${c.output}`).join(' | '));
        const geometry = computePi.find(c => c.name === 'geometry');
        const bounds = computePi.find(c => c.name === 'bounds');
        const accuracy = computePi.find(c => c.name === 'accuracy');
        const symbolic = computePi.find(c => c.name === 'symbolic_limit');
        const comparison = computePi.find(c => c.name === 'comparison');
        assert(geometry?.plots === 1, 'Compute Pi renders the circle-and-hexagon plot',
            String(geometry?.plots));
        assert(bounds?.output.includes('3.000000000000') &&
            bounds.output.includes('3.464101615138') &&
            bounds.output.includes('Final enclosure:'),
            'Compute Pi reports valid lower and upper polygon bounds', bounds?.output);
        assert(accuracy?.output.includes('786,432') && accuracy.output.includes('2.51e-11'),
            'Compute Pi reports its computed ten-decimal enclosure', accuracy?.output);
        assert(symbolic?.output.includes('limit as n approaches infinity = pi'),
            'Compute Pi symbolic limit is pi rather than zero', symbolic?.output);
        assert(comparison?.output.includes('20,000,000,000 terms') &&
            comparison.output.includes('786,432 sides') &&
            comparison.output.includes('7 terms per arctangent'),
            'Compute Pi comparison uses computed, internally consistent work estimates',
            comparison?.output);

        console.log('\nAll generated-language workbook regressions passed.');
    } finally {
        await browser.close();
    }
})().catch(err => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
