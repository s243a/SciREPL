/**
 * catalog_filter.js — pure ranking/matching for Browse Packages.
 *
 * No DOM, no fetch. Browser script tag attaches `CatalogFilter` on
 * globalThis; Node can `require()` the same file. The ranking rules live in
 * docs/proposal-catalog-browse.md (Spoken-language filter, Programming-language
 * filter, Search rules).
 */
(function (root, factory) {
    const api = factory();
    root.CatalogFilter = api;
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'scirepl_catalog_locale';
    const DEFAULT_PREFS = Object.freeze({
        allowFallbacks: true,
        fallbacks: Object.freeze(['en']),
        // Empty-search view: keep every built-in entry visible regardless of
        // content language. Off = apply the same locale chain the search view
        // uses. Default on, so first open always shows the full curated list.
        showBuiltins: true,
    });

    function isAllLocale(primary) {
        return primary == null || primary === '' || String(primary).toLowerCase() === 'all';
    }

    function isAllKernel(kernel) {
        return kernel == null || kernel === '' || String(kernel).toLowerCase() === 'all';
    }

    function isBuiltin(entry) {
        if (!entry) return false;
        if (entry.builtin === false || entry.source === true) return false;
        if (entry.sourceId) return false;
        return true;
    }

    function contentLocales(entry) {
        const raw = entry && entry.locales;
        if (!Array.isArray(raw) || raw.length === 0) return ['en'];
        const out = [];
        const seen = new Set();
        for (const code of raw) {
            if (code == null || code === '') continue;
            const key = String(code);
            const lower = key.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            out.push(key);
        }
        return out.length ? out : ['en'];
    }

    function uniqueCodes(codes) {
        const out = [];
        const seen = new Set();
        for (const code of codes || []) {
            if (code == null || code === '') continue;
            const key = String(code);
            const lower = key.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            out.push(key);
        }
        return out;
    }

    /**
     * Effective preference order used for *filtering* when a primary locale
     * is set: `[primary, ...fallbacks]` with the primary removed from the
     * tail. Empty fallbacks with allow=on is the same chain as allow=off.
     * `null` means All spoken languages (no locale gate).
     */
    function preferenceChain(primary, allowFallbacks, fallbacks) {
        if (isAllLocale(primary)) return null;
        const head = String(primary);
        if (!allowFallbacks) return [head];
        const rest = uniqueCodes(fallbacks).filter((code) =>
            code.toLowerCase() !== head.toLowerCase());
        if (rest.length === 0) return [head];
        return [head, ...rest];
    }

    /**
     * Ranking chain. When primary is All, locale never hides; the fallback
     * list still orders hits (or, with allow=off, nobody is preferred).
     */
    function rankingChain(primary, allowFallbacks, fallbacks) {
        const filtered = preferenceChain(primary, allowFallbacks, fallbacks);
        if (filtered) return filtered;
        if (!allowFallbacks) return [];
        return uniqueCodes(fallbacks);
    }

    function primarySubtag(code) {
        return String(code).split('-')[0].toLowerCase();
    }

    /**
     * Does `itemLocale` match preference slot `slot`?
     * Exact code wins over equal primary subtag (`pt-BR` matches `pt`).
     */
    function localeFitsSlot(itemLocale, slot) {
        const item = String(itemLocale);
        const want = String(slot);
        if (item.toLowerCase() === want.toLowerCase()) return 'exact';
        if (primarySubtag(item) === primarySubtag(want)) return 'subtag';
        return null;
    }

    /**
     * Best preference-slot hit for an entry.
     * @returns {{index:number, exact:boolean, locale:string}|null}
     */
    function bestLocaleMatch(entry, chain) {
        if (!chain || chain.length === 0) return null;
        const locales = contentLocales(entry);
        let best = null;
        for (let i = 0; i < chain.length; i++) {
            const slot = chain[i];
            for (const loc of locales) {
                const fit = localeFitsSlot(loc, slot);
                if (!fit) continue;
                const exact = fit === 'exact';
                if (!best || i < best.index || (i === best.index && exact && !best.exact)) {
                    best = { index: i, exact, locale: loc };
                    if (exact && i === 0) return best;
                }
            }
        }
        return best;
    }

    function findEntry(all, ref) {
        if (!ref || !all) return null;
        return all.find((p) => p && (p.id === ref || p.name === ref)) || null;
    }

    function kernelMatches(entry, kernel, all) {
        if (isAllKernel(kernel)) return true;
        if (!entry) return false;
        const want = String(kernel);
        const kernels = entry.kernels;
        if (!Array.isArray(kernels) || kernels.length === 0) return true;
        if (kernels.some((k) => String(k) === want)) return true;
        if (entry.type === 'bundle' && Array.isArray(entry.items)) {
            for (const ref of entry.items) {
                const child = findEntry(all, ref);
                if (child && child !== entry && kernelMatches(child, kernel, all)) {
                    return true;
                }
            }
        }
        return false;
    }

    function namespacedId(entry) {
        if (!entry || !entry.id) return '';
        return entry.sourceId ? `${entry.sourceId}:${entry.id}` : String(entry.id);
    }

    function queryMatches(entry, query, endonyms, all) {
        const needle = query.toLowerCase();
        const blobs = [];
        const push = (value) => {
            if (value == null || value === '') return;
            blobs.push(String(value));
        };
        push(entry.id);
        push(entry.name);
        push(entry.displayName);
        push(entry.notebookName);
        push(entry.description);
        push(entry.contents);
        push(namespacedId(entry));
        push(entry.sourceId);
        if (Array.isArray(entry.kernels)) {
            for (const k of entry.kernels) push(k);
        }
        for (const loc of contentLocales(entry)) {
            push(loc);
            if (endonyms && endonyms[loc]) push(endonyms[loc]);
            const base = primarySubtag(loc);
            if (endonyms && endonyms[base]) push(endonyms[base]);
        }
        if (Array.isArray(entry.items)) {
            for (const ref of entry.items) {
                push(ref);
                const child = findEntry(all, ref);
                if (child) {
                    push(child.name);
                    push(child.id);
                }
            }
        }
        return blobs.some((text) => text.toLowerCase().includes(needle));
    }

    /**
     * @param {object} opts
     * @param {object[]} opts.entries
     * @param {string} [opts.query]
     * @param {string|null} [opts.primary] null/All = every spoken language
     * @param {boolean} [opts.allowFallbacks]
     * @param {string[]} [opts.fallbacks]
     * @param {string|null} [opts.kernel] null/All = every kernel
     * @param {Record<string,string>} [opts.endonyms]
     * @returns {Array<{entry:object, originalIndex:number, prefIndex:number,
     *   exact:boolean, matchedLocale:?string, builtin:boolean}>}
     */
    function filterCatalog(opts) {
        const options = opts || {};
        const all = Array.isArray(options.entries) ? options.entries : [];
        const query = String(options.query == null ? '' : options.query).trim();
        const emptyQuery = query === '';
        const primary = options.primary;
        const allowFallbacks = options.allowFallbacks !== false;
        const fallbacks = options.fallbacks;
        const kernel = options.kernel;
        const endonyms = options.endonyms || {};
        // Empty-search built-ins are normally exempt from the locale gate; the
        // showBuiltins pref (default on) turns that exemption off so a strict
        // user's default view honours the same chain as search.
        const showBuiltins = options.showBuiltins !== false;
        const rank = rankingChain(primary, allowFallbacks, fallbacks);
        const chain = preferenceChain(primary, allowFallbacks, fallbacks);
        const filteringLocale = (!emptyQuery || !showBuiltins) && chain;

        const rows = [];
        for (let i = 0; i < all.length; i++) {
            const entry = all[i];
            if (!entry) continue;
            const builtin = isBuiltin(entry);
            if (emptyQuery && !builtin) continue;
            if (!kernelMatches(entry, kernel, all)) continue;
            if (!emptyQuery && !queryMatches(entry, query, endonyms, all)) continue;

            let loc = null;
            if (!emptyQuery || !showBuiltins) {
                loc = bestLocaleMatch(entry, rank);
                if (filteringLocale && !loc) continue;
            }

            rows.push({
                entry,
                originalIndex: i,
                prefIndex: emptyQuery ? 0 : (loc ? loc.index : Number.POSITIVE_INFINITY),
                exact: emptyQuery ? true : !!(loc && loc.exact),
                matchedLocale: loc ? loc.locale : null,
                builtin,
            });
        }

        rows.sort((a, b) => {
            if (a.prefIndex !== b.prefIndex) return a.prefIndex - b.prefIndex;
            if (a.exact !== b.exact) return a.exact ? -1 : 1;
            if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
            return a.originalIndex - b.originalIndex;
        });
        return rows;
    }

    /**
     * Badge code for a card, or null when it should stay quiet.
     * Skip when the best content locale is the primary (or, if primary is
     * All, the app locale).
     */
    function localeBadge(entry, primary, appLocale, matchedLocale) {
        const shown = matchedLocale
            || (bestLocaleMatch(entry, [isAllLocale(primary) ? appLocale : primary]) || {}).locale
            || contentLocales(entry)[0];
        if (!shown) return null;
        const compareTo = isAllLocale(primary) ? appLocale : primary;
        if (compareTo && shown.toLowerCase() === String(compareTo).toLowerCase()) {
            return null;
        }
        return String(shown).toUpperCase();
    }

    function addFallback(fallbacks, code, primary) {
        if (code == null || code === '') return uniqueCodes(fallbacks);
        const next = String(code);
        if (primary && next.toLowerCase() === String(primary).toLowerCase()) {
            return uniqueCodes(fallbacks);
        }
        const current = uniqueCodes(fallbacks);
        if (current.some((c) => c.toLowerCase() === next.toLowerCase())) return current;
        return current.concat([next]);
    }

    function normalizeLocalePrefs(raw) {
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
            return {
                allowFallbacks: DEFAULT_PREFS.allowFallbacks,
                fallbacks: DEFAULT_PREFS.fallbacks.slice(),
                showBuiltins: DEFAULT_PREFS.showBuiltins,
            };
        }
        const allowFallbacks = raw.allowFallbacks === false ? false : true;
        // Same corruption rule as allowFallbacks: only an explicit false is
        // false. A missing key or partial write must not come up strict.
        const showBuiltins = raw.showBuiltins === false ? false : true;
        let fallbacks;
        if (!Object.prototype.hasOwnProperty.call(raw, 'fallbacks') || !Array.isArray(raw.fallbacks)) {
            fallbacks = DEFAULT_PREFS.fallbacks.slice();
        } else {
            fallbacks = uniqueCodes(raw.fallbacks.filter((c) => typeof c === 'string' && c));
        }
        return { allowFallbacks, fallbacks, showBuiltins };
    }

    function loadLocalePrefs(storage) {
        const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!store || typeof store.getItem !== 'function') {
            return normalizeLocalePrefs(null);
        }
        let raw = null;
        try {
            const text = store.getItem(STORAGE_KEY);
            if (text == null || text === '') return normalizeLocalePrefs(null);
            raw = JSON.parse(text);
        } catch (_) {
            return normalizeLocalePrefs(null);
        }
        return normalizeLocalePrefs(raw);
    }

    function saveLocalePrefs(prefs, storage) {
        const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        const normalized = normalizeLocalePrefs(prefs);
        if (!store || typeof store.setItem !== 'function') return normalized;
        store.setItem(STORAGE_KEY, JSON.stringify({
            allowFallbacks: normalized.allowFallbacks,
            fallbacks: normalized.fallbacks,
            showBuiltins: normalized.showBuiltins,
        }));
        return normalized;
    }

    return {
        STORAGE_KEY,
        DEFAULT_PREFS,
        isBuiltin,
        isAllLocale,
        contentLocales,
        uniqueCodes,
        preferenceChain,
        rankingChain,
        bestLocaleMatch,
        kernelMatches,
        namespacedId,
        filterCatalog,
        localeBadge,
        addFallback,
        normalizeLocalePrefs,
        loadLocalePrefs,
        saveLocalePrefs,
    };
}));
