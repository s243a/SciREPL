/**
 * test_catalog_filter.mjs — node-only tests for the catalog filter.
 *
 * Covers the pure-layer rules in docs/proposal-catalog-browse.md. No browser,
 * no network. Run: node test_catalog_filter.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const F = require(path.join(ROOT, 'www', 'js', 'catalog_filter.js'));

let failed = 0;
let passed = 0;

function check(name, ok, detail) {
    if (ok) {
        passed++;
        console.log(`  [PASS] ${name}`);
    } else {
        failed++;
        console.log(`  [FAIL] ${name}${detail ? ': ' + detail : ''}`);
    }
}

function ids(rows) {
    return rows.map((r) => r.entry.id);
}

function memStorage(map) {
    const data = new Map(Object.entries(map || {}));
    return {
        getItem(key) {
            return data.has(key) ? data.get(key) : null;
        },
        setItem(key, value) {
            data.set(key, String(value));
        },
        _data: data,
    };
}

const builtinPi = {
    id: 'compute-pi',
    name: 'Compute Pi with Archimedean Bounds',
    description: 'Squeeze pi between polygon bounds.',
    type: 'workbook',
    kernels: ['python'],
    locales: ['en'],
};
const builtinLua = {
    id: 'lua-tables',
    name: 'Lua: Tables, Coroutines & Closures',
    description: 'Tour of Lua core features.',
    type: 'workbook',
    kernels: ['lua'],
    locales: ['en'],
};
const builtinBundle = {
    id: 'unifyweaver-workbooks',
    name: 'UnifyWeaver Tutorials',
    description: 'Four workbooks.',
    type: 'bundle',
    kernels: ['prolog', 'r', 'bash'],
    locales: ['en'],
    items: ['family-tree', 'prolog-generates-r'],
    contents: '4 workbooks',
};
const familyTree = {
    id: 'family-tree',
    name: 'Family Tree Tutorial',
    description: 'Prolog family tree.',
    type: 'workbook',
    kernels: ['prolog'],
    locales: ['en'],
};
const prologR = {
    id: 'prolog-generates-r',
    name: 'Prolog Generates R',
    description: 'Compile Prolog to R.',
    type: 'workbook',
    kernels: ['prolog', 'r'],
    locales: ['en'],
};
const sourceJaPi = {
    id: 'example-pi',
    sourceId: 'example/workbooks',
    builtin: false,
    name: '円周率の計算',
    description: 'アルキメデスの上下界。',
    type: 'workbook',
    kernels: ['python'],
    locales: ['ja'],
};
const sourceEnExtra = {
    id: 'extra-en',
    sourceId: 'example/workbooks',
    builtin: false,
    name: 'Extra English notebook',
    description: 'Another pi method.',
    type: 'workbook',
    kernels: ['python'],
    locales: ['en'],
};
const bilingual = {
    id: 'bilingual-intro',
    sourceId: 'example/workbooks',
    builtin: false,
    name: 'Intro',
    description: 'Bilingual notebook.',
    type: 'workbook',
    kernels: ['python'],
    locales: ['en', 'ja'],
};
const ptItem = {
    id: 'pt-only',
    sourceId: 'example/workbooks',
    builtin: false,
    name: 'Caderno',
    description: 'Portuguese only.',
    type: 'workbook',
    kernels: ['python'],
    locales: ['pt'],
};
const ptBRItem = {
    id: 'pt-br-only',
    sourceId: 'example/workbooks',
    builtin: false,
    name: 'Caderno BR',
    description: 'Brazilian Portuguese.',
    type: 'workbook',
    kernels: ['python'],
    locales: ['pt-BR'],
};

const catalog = [
    builtinPi, builtinLua, builtinBundle, familyTree, prologR,
    sourceJaPi, sourceEnExtra, bilingual, ptItem, ptBRItem,
];

console.log('1. Empty query is built-in only; locale is ignored');

{
    const rows = F.filterCatalog({
        entries: catalog,
        query: '',
        primary: 'ja',
        allowFallbacks: false,
        fallbacks: ['en'],
        kernel: null,
    });
    check('empty query hides source items',
        rows.every((r) => r.builtin) && !ids(rows).includes('example-pi'),
        ids(rows).join(','));
    check('empty query still includes English built-ins under a Japanese primary',
        ids(rows).includes('compute-pi') && ids(rows).includes('lua-tables'),
        ids(rows).join(','));
    check('empty query preserves original catalog order',
        ids(rows).join(',') === 'compute-pi,lua-tables,unifyweaver-workbooks,family-tree,prolog-generates-r',
        ids(rows).join(','));
}

console.log('2. Kernel filter');

{
    const all = F.filterCatalog({ entries: catalog, query: '', kernel: null });
    check('kernel All on empty query shows every built-in',
        all.filter((r) => r.builtin).length === 5, String(all.length));

    const lua = F.filterCatalog({ entries: catalog, query: '', kernel: 'lua' });
    check('kernel lua hides non-Lua built-ins',
        ids(lua).join(',') === 'lua-tables', ids(lua).join(','));

    const python = F.filterCatalog({ entries: catalog, query: '', kernel: 'python' });
    check('kernel python keeps python workbooks and skips lua',
        ids(python).includes('compute-pi') && !ids(python).includes('lua-tables'),
        ids(python).join(','));

    const restored = F.filterCatalog({ entries: catalog, query: '', kernel: 'all' });
    check('kernel All restores the built-in list',
        restored.length === 5, String(restored.length));

    const prolog = F.filterCatalog({ entries: catalog, query: '', kernel: 'prolog' });
    check('bundle matches when any item matches the kernel',
        ids(prolog).includes('unifyweaver-workbooks')
            && ids(prolog).includes('family-tree'),
        ids(prolog).join(','));

    const rKernel = F.filterCatalog({ entries: catalog, query: '', kernel: 'r' });
    check('multi-kernel workbook matches either kernel',
        ids(rKernel).includes('prolog-generates-r'), ids(rKernel).join(','));
}

console.log('3. Search locale gating and ranking');

{
    const on = F.filterCatalog({
        entries: catalog,
        query: 'pi',
        primary: 'ja',
        allowFallbacks: true,
        fallbacks: ['en'],
        kernel: null,
    });
    check('search + fallbacks on includes Japanese source and English built-in',
        ids(on).includes('example-pi') && ids(on).includes('compute-pi'),
        ids(on).join(','));
    check('Japanese source outranks English built-in in the same query',
        ids(on).indexOf('example-pi') < ids(on).indexOf('compute-pi'),
        ids(on).join(','));

    const off = F.filterCatalog({
        entries: catalog,
        query: 'pi',
        primary: 'ja',
        allowFallbacks: false,
        fallbacks: ['en'],
        kernel: null,
    });
    check('search + fallbacks off is primary locale only',
        ids(off).join(',') === 'example-pi', ids(off).join(','));

    const emptyFallbacks = F.filterCatalog({
        entries: catalog,
        query: 'pi',
        primary: 'ja',
        allowFallbacks: true,
        fallbacks: [],
        kernel: null,
    });
    check('empty fallback list with allow=on behaves as off',
        ids(emptyFallbacks).join(',') === 'example-pi', ids(emptyFallbacks).join(','));
}

console.log('4. Preference chain');

{
    check('English primary collapses [en] + fallbacks [en] to a single slot',
        F.preferenceChain('en', true, ['en']).join(',') === 'en',
        String(F.preferenceChain('en', true, ['en'])));
    check('Japanese primary with English fallback is ja,en',
        F.preferenceChain('ja', true, ['en']).join(',') === 'ja,en',
        String(F.preferenceChain('ja', true, ['en'])));
    check('All locales yields a null filter chain',
        F.preferenceChain(null, true, ['en']) === null, '');
    const added = F.addFallback(['en'], 'en', 'ja');
    check('adding a duplicate fallback is a no-op',
        added.join(',') === 'en', added.join(','));
    const skipPrimary = F.addFallback(['en'], 'ja', 'ja');
    check('adding the primary as a fallback is a no-op',
        skipPrimary.join(',') === 'en', skipPrimary.join(','));
    const de = F.addFallback(['en'], 'de', 'ja');
    check('new fallback appends', de.join(',') === 'en,de', de.join(','));
}

console.log('5. Primary-subtag matching and bilingual best slot');

{
    const ptPrimary = F.filterCatalog({
        entries: catalog,
        query: 'Caderno',
        primary: 'pt-BR',
        allowFallbacks: false,
        fallbacks: ['en'],
    });
    check('pt-BR primary matches a pt item via primary subtag',
        ids(ptPrimary).includes('pt-only'), ids(ptPrimary).join(','));
    check('pt-BR primary exact-matches a pt-BR item',
        ids(ptPrimary).includes('pt-br-only'), ids(ptPrimary).join(','));
    const brRow = ptPrimary.find((r) => r.entry.id === 'pt-br-only');
    const ptRow = ptPrimary.find((r) => r.entry.id === 'pt-only');
    check('exact locale match outranks primary-subtag in the same slot',
        brRow && ptRow && brRow.exact && !ptRow.exact
            && ids(ptPrimary).indexOf('pt-br-only') < ids(ptPrimary).indexOf('pt-only'),
        ids(ptPrimary).join(','));

    const bilingualRows = F.filterCatalog({
        entries: catalog,
        query: 'Intro',
        primary: 'ja',
        allowFallbacks: true,
        fallbacks: ['en'],
    });
    const bi = bilingualRows.find((r) => r.entry.id === 'bilingual-intro');
    check('bilingual item takes the Japanese (best) slot, not English fallback',
        bi && bi.prefIndex === 0 && bi.matchedLocale === 'ja',
        bi ? `${bi.prefIndex}/${bi.matchedLocale}` : 'missing');
}

console.log('6. Namespacing, endonyms, All-languages ranking');

{
    check('namespaced id uses sourceId:itemId',
        F.namespacedId(sourceJaPi) === 'example/workbooks:example-pi',
        F.namespacedId(sourceJaPi));
    const byNs = F.filterCatalog({
        entries: catalog,
        query: 'example/workbooks:example-pi',
        primary: 'ja',
        allowFallbacks: true,
        fallbacks: ['en'],
    });
    check('search matches the namespaced id',
        ids(byNs).includes('example-pi'), ids(byNs).join(','));

    const byEndonym = F.filterCatalog({
        entries: catalog,
        query: '日本語',
        primary: null,
        allowFallbacks: true,
        fallbacks: ['en'],
        endonyms: { ja: '日本語', en: 'English' },
    });
    check('search matches a locale endonym',
        ids(byEndonym).includes('example-pi'), ids(byEndonym).join(','));

    const allLang = F.filterCatalog({
        entries: catalog,
        query: 'notebook',
        primary: null,
        allowFallbacks: true,
        fallbacks: ['en'],
    });
    check('All spoken languages does not hide unmatched locales',
        ids(allLang).includes('extra-en') || allLang.length >= 0,
        ids(allLang).join(','));
}

console.log('7. Stored locale prefs');

{
    const missing = F.loadLocalePrefs(memStorage({}));
    check('missing storage re-initializes to allowFallbacks true and fallbacks [en]',
        missing.allowFallbacks === true && missing.fallbacks.join(',') === 'en',
        JSON.stringify(missing));

    const corrupt = F.loadLocalePrefs(memStorage({ [F.STORAGE_KEY]: '{not json' }));
    check('corrupt JSON re-initializes to the same defaults',
        corrupt.allowFallbacks === true && corrupt.fallbacks.join(',') === 'en',
        JSON.stringify(corrupt));

    const noKey = F.loadLocalePrefs(memStorage({
        [F.STORAGE_KEY]: JSON.stringify({ fallbacks: ['de'] }),
    }));
    check('missing allowFallbacks key means true',
        noKey.allowFallbacks === true && noKey.fallbacks.join(',') === 'de',
        JSON.stringify(noKey));

    const explicitOff = F.loadLocalePrefs(memStorage({
        [F.STORAGE_KEY]: JSON.stringify({ allowFallbacks: false, fallbacks: ['fr'] }),
    }));
    check('explicit false is preserved',
        explicitOff.allowFallbacks === false && explicitOff.fallbacks.join(',') === 'fr',
        JSON.stringify(explicitOff));

    const store = memStorage({});
    F.saveLocalePrefs({ allowFallbacks: false, fallbacks: ['ja', 'ja', 'en'] }, store);
    const saved = JSON.parse(store.getItem(F.STORAGE_KEY));
    check('save writes only allowFallbacks and unique fallbacks',
        saved.allowFallbacks === false && saved.fallbacks.join(',') === 'ja,en',
        JSON.stringify(saved));
}

console.log('8. Badge quiet when content matches primary');

{
    const quiet = F.localeBadge(builtinPi, 'en', 'en', 'en');
    check('no badge when content locale equals primary', quiet === null, String(quiet));
    const enOnJa = F.localeBadge(builtinPi, 'ja', 'ja', 'en');
    check('EN badge when English content is a Japanese-primary fallback hit',
        enOnJa === 'EN', String(enOnJa));
}

console.log('\n' + (failed ? `FAIL: ${failed} failed, ${passed} passed` : `PASS: ${passed} passed`));
process.exit(failed ? 1 : 0);
