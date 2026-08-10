// Service Worker for SciREPL PWA
// Caches app shell on install, caches CDN runtimes (Pyodide, swipl-wasm) on first fetch.

const CACHE_VERSION = 'v130';

// Marker entry recording whether an app cache finished installing. Stored in
// the cache itself so the answer travels with it and survives a restart.
const COMPLETE_MARKER = './__app-shell-complete';
const APP_CACHE = 'scirepl-app-' + CACHE_VERSION;
const CDN_CACHE = 'scirepl-cdn-v2';

// App shell: local assets to pre-cache on install
const APP_SHELL = [
  './',
  './index.html',
  './privacy.html',
  './manifest.json',
  './css/style.css',
  './css/notebooks.css',
  './js/app.js',
  './js/bridge.js',
  './js/brush_wasm.js',
  './js/archive_extractors.js',
  './js/indexeddb_store.js',
  './js/kernel_config.js',
  './js/i18n.js',
  './js/appearance.js',
  './js/appearance_ui.js',
  './js/onboarding.js',
  // Every shipped locale is precached. A catalogue fetched on demand fails
  // offline and silently falls back to English, which defeats the point of
  // translating for users who may have no connection at all. Kept in sync by
  // scripts/build-i18n-manifest.mjs, which fails the build on a missing entry.
  './i18n/manifest.json',
  './i18n/ar.json',
  './i18n/bn.json',
  './i18n/de.json',
  './i18n/en.json',
  './i18n/es.json',
  './i18n/fr.json',
  './i18n/hi.json',
  './i18n/id.json',
  './i18n/ja.json',
  './i18n/ko.json',
  './i18n/pt-BR.json',
  './i18n/ru.json',
  './i18n/zh.json',
  './i18n/privacy.ar.json',
  './i18n/privacy.bn.json',
  './i18n/privacy.de.json',
  './i18n/privacy.en.json',
  './i18n/privacy.es.json',
  './i18n/privacy.fr.json',
  './i18n/privacy.hi.json',
  './i18n/privacy.id.json',
  './i18n/privacy.ja.json',
  './i18n/privacy.ko.json',
  './i18n/privacy.pt-BR.json',
  './i18n/privacy.ru.json',
  './i18n/privacy.zh.json',
  './js/kernel_manager.js',
  './js/math_mode.js',
  './js/notebook_manager.js',
  './js/prolog_settings.js',
  './js/prolog_vfs.js',
  './js/persistence.js',
  './js/shared_vfs.js',
  './js/notebook_vfs.js',
  './js/package_loader.js',
  './js/package_catalog.js',
  './vendor/hljs/highlight.min.js',
  './vendor/hljs/lua.min.js',
  './vendor/hljs/atom-one-dark.min.css',
  './js/export.js',
  './js/file_io.js',
  './js/prelude.py',
  './js/sharedfs.py',
  './js/r_prelude.R',
  './js/prolog_prelude.pl',
  './js/kernels/python.js',
  './js/kernels/prolog.js',
  './js/kernels/bash.js',
  './js/kernels/javascript.js',
  './js/kernels/r.js',
  './js/kernels/lua.js',
  './js/kernels/typr.js',
  './js/kernels/clojurescript.js',
  './vendor/scittle/scittle.js',
  './vendor/typr/typr_wasm.js',
  './vendor/typr/typr_wasm_bg.wasm',
  './vendor/katex/katex.min.css',
  './vendor/katex/katex.min.js',
  './vendor/marked/marked.min.js',
  './vendor/plotly/plotly-basic.min.js',
  './vendor/jszip/jszip.min.js',
  './vendor/pako/pako_inflate.min.js',
  './vendor/brush/brush_wasm.js',
  './vendor/brush/brush_wasm_bg.wasm',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Same-origin catalog payloads. Pre-cache these so an installed PWA can add
  // packages, bundles, and workbooks without cross-origin or network access.
  './packages/unifyweaver_scirepl.zip',
  './workbooks/01_family_tree_tutorial.ipynb',
  './workbooks/02_recursion_patterns.ipynb',
  './workbooks/03_call_graph_analysis.ipynb',
  './workbooks/life_expectancy_csv_demo.ipynb',
  './workbooks/r_ggplot2_showcase.ipynb',
  './workbooks/r_tidyverse_wrangling.ipynb',
  './workbooks/r_statistics.ipynb',
  './workbooks/lua-tables-coroutines.srwb',
  './workbooks/lua-parsing-coroutines.srwb',
  './workbooks/prolog-generates-r.srwb',
  './workbooks/prolog-generates-clojurescript.srwb',
  './workbooks/prolog-generates-lua.srwb',
  './workbooks/compute-pi-workbook.srwb',
  './workbooks/typr-intro.srwb',
  './workbooks/prolog-generates-typr.srwb',
];

// CDN domains to cache (Pyodide ~25MB, swipl-wasm ~10MB, webR ~50MB)
const CDN_DOMAINS = [
  'cdn.jsdelivr.net',
  'swi-prolog.github.io',
  'webr.r-wasm.org',
];

function isCDNRequest(url) {
  return CDN_DOMAINS.some(domain => url.hostname.toLowerCase().includes(domain));
}

// Install: pre-cache app shell
// cache.addAll() is atomic: one 404 anywhere in APP_SHELL rejects the whole
// install, skipWaiting() never runs, and the app silently has no offline
// support at all. That was a narrow risk with forty entries; it is a real one
// now that every shipped locale is listed and the list is derived from
// filenames.
//
// So: try the fast atomic path, and if it fails, cache entries individually so
// a single bad path costs one file instead of the entire offline experience.
// The failures are logged with their URLs, because the alternative to a loud
// partial install is a silent total one.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    try {
      await cache.addAll(APP_SHELL);
    } catch (err) {
      console.warn('[sw] atomic precache failed, falling back to per-entry:', err);
      const results = await Promise.allSettled(
        APP_SHELL.map(url => cache.add(url))
      );
      const failed = APP_SHELL.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) {
        console.error(`[sw] ${failed.length} of ${APP_SHELL.length} app-shell entries ` +
          'could not be cached and will be unavailable offline:', failed);
      }
    }

    // Record whether this version's shell is actually complete. A partial
    // install must not be allowed to replace a working previous version:
    // deleting the old cache in that state is how a user ends up worse off
    // offline after an upgrade than before it.
    const complete = await shellIsComplete(cache);
    await cache.put(COMPLETE_MARKER, new Response(complete ? 'complete' : 'partial', {
      headers: { 'content-type': 'text/plain' },
    }));
    if (!complete) {
      console.warn('[sw] app shell incomplete; the previous cache will be kept as a fallback');
    }
    await self.skipWaiting();
  })());
});

/** Every app-shell entry present in this cache? */
async function shellIsComplete(cache) {
  const missing = [];
  for (const url of APP_SHELL) {
    if (!(await cache.match(url))) missing.push(url);
  }
  if (missing.length) console.warn('[sw] missing from app cache:', missing.slice(0, 10));
  return missing.length === 0;
}

/** Did the given cache finish installing? */
async function cacheIsComplete(name) {
  try {
    const c = await caches.open(name);
    const marker = await c.match(COMPLETE_MARKER);
    return Boolean(marker) && (await marker.text()) === 'complete';
  } catch { return false; }
}

/**
 * The cache the app actually serves from: the NEWEST complete app cache.
 *
 * This is the whole coherence story. An upgrade that only half-installed does
 * not become the serving version — the app keeps running the last version that
 * installed completely, as one consistent set, rather than a new index.html
 * stitched to an old app.js. caches.keys() is in creation order, so the last
 * complete one is the newest; a plain caches.match() would instead have taken
 * the OLDEST copy of any file present in several caches.
 */
async function servingCacheName() {
  const keys = (await caches.keys()).filter((k) => k.startsWith('scirepl-app-'));
  let serving = null;
  for (const k of keys) {               // oldest -> newest; keep the last complete
    if (await cacheIsComplete(k)) serving = k;
  }
  // No complete cache yet (first run, or a first install that was partial):
  // fall back to this version's cache so the app is not left with nothing.
  return serving || APP_CACHE;
}

// Activate: retain the serving version and the current one; prune the rest.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const serving = await servingCacheName();
    const keys = await caches.keys();

    await Promise.all(keys.map(async (key) => {
      // Stale CDN runtimes are re-fetchable and not the offline lifeline.
      if (key.startsWith('scirepl-cdn-')) {
        if (key !== CDN_CACHE) await caches.delete(key);
        return;
      }
      if (!key.startsWith('scirepl-app-')) return;
      // Keep exactly two things: what we serve (newest complete) and this
      // version's own cache (APP_CACHE), which a later fetch may yet complete.
      // Everything else — superseded complete caches and dead partials — goes.
      if (key === serving || key === APP_CACHE) return;
      await caches.delete(key);
    }));

    await self.clients.claim();
  })());
});

// Fetch: cache-first for app shell and CDN, network-first for everything else
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // The public Pro landing and privacy pages are not part of the PWA app shell.
  // Always let the browser fetch them normally so marketing/policy edits are not
  // held behind the app's cache-first lifecycle.
  const appScopePath = new URL(self.registration.scope).pathname;
  if (url.origin === self.location.origin && url.pathname.startsWith(`${appScopePath}pro/`)) {
    return;
  }

  // App shell: served entirely from ONE coherent version — the newest cache
  // that installed completely. A half-installed upgrade therefore does not take
  // effect until it is whole; the user keeps running the last good version as a
  // consistent set rather than a mix. Never an unqualified caches.match(): that
  // searches oldest-first and would splice files across versions.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const serving = await caches.open(await servingCacheName());
      const hit = await serving.match(event.request);
      if (hit) return hit;

      // Not in the serving shell (a genuinely new asset, or a cold first run):
      // fetch it, and populate THIS version's cache so a later completion check
      // can flip it to the serving version.
      const response = await fetch(event.request);
      if (response.ok && event.request.method === 'GET') {
        const current = await caches.open(APP_CACHE);
        current.put(event.request, response.clone());
      }
      return response;
    })());
    return;
  }

  // CDN runtimes (Pyodide, swipl-wasm): cache-first
  if (isCDNRequest(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CDN_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else: network only (ko-fi, GitHub releases, etc.)
});
