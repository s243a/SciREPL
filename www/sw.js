// Service Worker for SciREPL PWA
// Caches app shell on install, caches CDN runtimes (Pyodide, swipl-wasm) on first fetch.

const CACHE_VERSION = 'v185';

// Marker entry recording whether an app cache finished installing. Stored in
// the cache itself so the answer travels with it and survives a restart.
const COMPLETE_MARKER = './__app-shell-complete';

// Opportunistic repair throttle. A partial current cache whose missing files
// become reachable again (the user comes back online) must fill its gaps even
// though those files are still served from the older complete cache and so are
// never re-fetched on their own. On same-origin fetches, if the current cache is
// incomplete, retry the missing entries — throttled so it is not run per asset.
let _repairInFlight = null;
let _lastRepairDone = 0;
function maybeRepairInBackground(event) {
  // Serialize: one repair at a time, shared by every concurrent request. The
  // promise is assigned SYNCHRONOUSLY, before any await, so N simultaneous
  // requests all see it set and pass the same promise to waitUntil — the old
  // code awaited cacheIsComplete before recording anything, so 30 requests
  // launched 30 identical fetches of the same missing asset.
  if (_repairInFlight) { event.waitUntil(_repairInFlight); return; }
  if (Date.now() - _lastRepairDone < 5000) return;   // cooldown between attempts
  _repairInFlight = (async () => {
    try {
      if (!(await cacheIsComplete(APP_CACHE))) await repairShell(APP_CACHE);
    } finally {
      _lastRepairDone = Date.now();
      _repairInFlight = null;
    }
  })();
  event.waitUntil(_repairInFlight);
}
const APP_CACHE = 'scirepl-app-' + CACHE_VERSION;
const CDN_CACHE = 'scirepl-cdn-v3';

// App shell: local assets to pre-cache on install
const APP_SHELL = [
  './',
  './index.html',
  './privacy.html',
  './open-source-licenses.html',
  './manifest.json',
  './css/style.css',
  './css/notebooks.css',
  './js/app.js',
  './js/bridge.js',
  './js/brush_wasm.js',
  './js/archive_extractors.js',
  './js/indexeddb_store.js',
  './js/kernel_config.js',
  './js/pip_resolver.js',
  './js/md_math.js',
  './js/i18n.js',
  './js/appearance.js',
  './js/appearance_ui.js',
  './js/onboarding.js',
  './js/release_highlights.js',
  './js/whats_new.js',
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
  './js/catalog_filter.js',
  './js/catalog_source.js',
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
  './workbooks/nqueens-transpile.ipynb',
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
  'unpkg.com',
];

// Large bundled runtimes are intentionally cached on first use rather than
// pre-cached with APP_SHELL. Keep this list narrow: an arbitrary same-origin
// data path must not gain runtime-like cache privileges merely by being under
// the worker's scope.
const BUNDLED_RUNTIME_PATH_PREFIXES = [
  'vendor/pyodide/',
  'vendor/swipl/',
];

function isCDNRequest(url) {
  return CDN_DOMAINS.includes(url.hostname.toLowerCase());
}

function safelyDecodedPathname(url) {
  try { return decodeURIComponent(url.pathname).toLowerCase(); }
  catch (_) { return url.pathname.toLowerCase(); }
}

/**
 * Runtime responses may live indefinitely only when their URL names an exact,
 * immutable version. Rolling aliases and repository indexes must always go to
 * the network: caching either under a cache-first policy silently freezes what
 * "latest" means and can make package discovery stale for years.
 */
function isImmutableRuntimeRequest(request, url) {
  if (!['GET', 'HEAD'].includes(request.method) || !isCDNRequest(url) || url.search) return false;
  const pathname = safelyDecodedPathname(url);
  if (/(?:^|\/)latest(?:\/|$)/.test(pathname) || /@latest(?:\/|$)/.test(pathname)) {
    return false;
  }
  if (/(?:^|\/)packages(?:\.(?:gz|rds|json))?$/.test(pathname)
      || /(?:^|\/)(?:index|repodata)(?:\.[^/]*)?\.json$/.test(pathname)) {
    return false;
  }

  // npm-swipl-wasm uses a slash-separated package selector rather than semver
  // in one segment. `3/8/2` is pinned; `3/latest` is excluded above.
  if (url.hostname.toLowerCase() === 'swi-prolog.github.io') {
    return /\/npm-swipl-wasm\/\d+\/\d+\/\d+\//.test(pathname);
  }

  // Pyodide and webR use /vX.Y.Z/; jsDelivr/unpkg npm assets use
  // package@X.Y.Z. Pre-release/build suffixes remain exact versions.
  const semver = '\\d+\\.\\d+\\.\\d+(?:-[0-9a-z.-]+)?(?:\\+[0-9a-z.-]+)?';
  return new RegExp('/v' + semver + '/').test(pathname)
    || new RegExp('@v?' + semver + '(?:/|$)').test(pathname);
}

function runtimeProbeMarkerUrl(url) {
  return new URL('./__scirepl_runtime_probes__/' + encodeURIComponent(url.href),
    self.registration.scope).href;
}

async function responseFromRuntimeProbe(cache, request, url) {
  // CacheStorage cannot store a HEAD Request. If the same immutable GET was
  // cached, synthesize the bodyless HEAD response from its status/headers.
  const cachedGet = await cache.match(url.href);
  if (cachedGet) {
    return new Response(null, {
      status: cachedGet.status,
      statusText: cachedGet.statusText,
      headers: cachedGet.headers,
    });
  }

  // webR also probes optional paths that legitimately return 404 and may never
  // issue a GET. Store that method-specific fact under a synthetic GET key;
  // this is safe only because isImmutableRuntimeRequest already proved the
  // probed URL names an exact version.
  const marker = await cache.match(runtimeProbeMarkerUrl(url));
  if (!marker) return null;
  try {
    const record = await marker.json();
    if (record.url !== url.href || record.method !== 'HEAD'
        || ![200, 404].includes(record.status)) return null;
    return new Response(null, { status: record.status, headers: record.headers || {} });
  } catch (_) {
    return null;
  }
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
    // Start from an empty cache under this version's name. If CACHE_VERSION was
    // reused while an app-shell asset changed, the old entries would otherwise
    // linger and a failed new fetch would leave the STALE response present —
    // shellIsComplete() would then see the file and mark a mixed cache complete.
    // Deleting first means a failed fetch leaves the file ABSENT, so presence is
    // a truthful completeness signal.
    await caches.delete(APP_CACHE);
    const cache = await caches.open(APP_CACHE);

    try {
      await cache.addAll(APP_SHELL);
    } catch (err) {
      console.warn('[sw] atomic precache failed, falling back to per-entry:', err);
      const results = await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
      const failed = APP_SHELL.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) {
        console.error(`[sw] ${failed.length} of ${APP_SHELL.length} app-shell entries ` +
          'could not be cached and will be unavailable offline:', failed);
      }
    }

    const complete = await markCompleteness(cache);
    // Activate regardless, but note: activating the WORKER is not the same as
    // serving its shell. The fetch handler always serves from the newest
    // COMPLETE cache (servingCacheName), so an incomplete update does not take
    // effect — the user keeps getting the last complete shell as one coherent
    // set. Activating anyway is what lets this worker's own fetch handler run
    // and repair its cache once the missing files are reachable again; a worker
    // that stayed subordinate could never fill its gaps.
    if (!complete) {
      console.warn('[sw] shell incomplete; serving the last complete version until repaired');
    }
    await self.skipWaiting();
  })());
});

/** Write the completeness marker for a cache from its current contents. */
async function markCompleteness(cache) {
  const complete = await shellIsComplete(cache);
  await cache.put(COMPLETE_MARKER, new Response(complete ? 'complete' : 'partial', {
    headers: { 'content-type': 'text/plain' },
  }));
  return complete;
}

/**
 * Try to finish a partial current-version cache: fetch the entries it is
 * missing, AWAIT each write, then recompute the marker. Returns true if the
 * cache is complete afterwards. This is the repair half of repair-and-promote;
 * activate() calls it and then recomputes the serving cache, so a cache that
 * fills its gaps becomes the served version without waiting for a fresh install.
 */
async function repairShell(cacheName) {
  const cache = await caches.open(cacheName);
  const missing = [];
  for (const url of APP_SHELL) {
    if (!(await cache.match(url))) missing.push(url);
  }
  for (const url of missing) {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res && res.ok) await cache.put(url, res.clone());
    } catch { /* still offline for this one; leave it missing */ }
  }
  return markCompleteness(cache);
}

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
// clientId -> the cache that document was pinned to at navigation. Keeps a
// single document coherent for its whole session even if a newer version is
// promoted underneath it; a reload (new navigation) re-pins to the newest.
// Client pins live in a durable cache, not process memory: service workers are
// terminated while idle, and an in-memory Map lost the pin on restart — an open
// v1 document then received v2 assets. clientId is stable for a document's life,
// so the durable record survives worker restarts and keeps the session coherent.
const PIN_CACHE = 'scirepl-pins-v1';
const PIN_PREFIX = './__pin/';

async function setPin(clientId, name) {
  if (!clientId) return;
  const cache = await caches.open(PIN_CACHE);
  await cache.put(PIN_PREFIX + clientId, new Response(name, {
    headers: { 'content-type': 'text/plain' },
  }));
}
async function getPin(clientId) {
  if (!clientId) return null;
  const cache = await caches.open(PIN_CACHE);
  const res = await cache.match(PIN_PREFIX + clientId);
  return res ? res.text() : null;
}

async function cacheNameForClient(event) {
  // A navigation (re)pins the resulting document to the newest complete cache —
  // this is the only point promotion takes effect, so a live document never
  // switches versions mid-session.
  if (event.request.mode === 'navigate') {
    const newest = await servingCacheName();
    const navId = event.resultingClientId || event.clientId;
    await setPin(navId, newest);
    // A navigation may have freed the PREVIOUS document's pin; prune in the
    // background so a superseded cache does not linger until the next activate.
    // Protect this navigation's own client — it is not yet in clients.matchAll().
    event.waitUntil(pruneAppCaches({ keepClientId: navId }));
    return newest;
  }
  // A subresource is served from its document's pinned cache, read durably.
  const pinned = await getPin(event.clientId);
  if (pinned && (await caches.has(pinned))) return pinned;
  return await servingCacheName();
}

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

/**
 * Delete superseded app caches, but keep: the serving cache (newest complete),
 * this worker's own cache (a repair may complete it), and any cache a still-open
 * client is pinned to. Stale pin records (for gone documents) are dropped, which
 * is what eventually frees an old cache for deletion. Runs at activate and,
 * opportunistically, when a navigation re-pins a client — reloads do not re-run
 * activate, so without the second trigger an unpinned old cache would linger.
 */
async function pruneAppCaches({ cdn, keepClientId } = {}) {
  const serving = await servingCacheName();
  const liveIds = new Set((await self.clients.matchAll().catch(() => [])).map((c) => c.id));
  if (keepClientId) liveIds.add(keepClientId);
  const pinned = new Set();
  try {
    const pinCache = await caches.open(PIN_CACHE);
    for (const req of await pinCache.keys()) {
      const id = new URL(req.url).pathname.split('/').pop();
      if (!liveIds.has(id)) { await pinCache.delete(req); continue; }
      const res = await pinCache.match(req);
      if (res) pinned.add((await res.text()).trim());
    }
  } catch { /* pin cache unavailable; default retention still holds */ }

  for (const key of await caches.keys()) {
    if (cdn && key.startsWith('scirepl-cdn-') && key !== CDN_CACHE) {
      await caches.delete(key);
      continue;
    }
    if (!key.startsWith('scirepl-app-')) continue;
    if (key === serving || key === APP_CACHE || pinned.has(key)) continue;
    await caches.delete(key);
  }
}

// Activate: retain the serving version and the current one; prune the rest.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Repair-and-promote: if this version's cache is partial, try to fetch its
    // missing entries now (awaited), so a transient failure during install does
    // not strand the update forever. If it completes here, it becomes the
    // serving version; if not, the previous complete cache keeps serving.
    if (!(await cacheIsComplete(APP_CACHE))) {
      try { await repairShell(APP_CACHE); } catch { /* stay subordinate */ }
    }

    await pruneAppCaches({ cdn: true });

    await self.clients.claim();
  })());
});

// Fetch: cache-first for the scoped app shell and immutable CDN resources.
// Requests outside this registration's app scope, and explicit no-store
// requests, remain under the browser's normal network/cache handling.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // A caller using no-store is explicitly asking for a fresh response. In
  // particular, verified catalog metadata uses this mode when checking for a
  // newer release or a suspiciously moved ref. Never satisfy or populate one
  // of our long-lived caches for such a request.
  if (event.request.cache === 'no-store') return;

  // The public Pro landing and privacy pages are not part of the PWA app shell.
  // Always let the browser fetch them normally so marketing/policy edits are not
  // held behind the app's cache-first lifecycle.
  const appScopePath = new URL(self.registration.scope).pathname;
  const isScopedAppRequest = url.origin === self.location.origin &&
    url.pathname.startsWith(appScopePath);
  const scopedAppPath = isScopedAppRequest ? url.pathname.slice(appScopePath.length) : '';
  const isAppShellRequest = isScopedAppRequest && !url.search && APP_SHELL.some(
    (entry) => entry.replace(/^\.\//, '') === scopedAppPath,
  );
  const isBundledRuntimeRequest = isScopedAppRequest && !url.search &&
    ['GET', 'HEAD'].includes(event.request.method) && BUNDLED_RUNTIME_PATH_PREFIXES.some(
      (prefix) => scopedAppPath.startsWith(prefix),
    );
  if (isScopedAppRequest && url.pathname.startsWith(`${appScopePath}pro/`)) {
    return;
  }

  // Chromium can present an explicit no-store subresource fetch to a service
  // worker as `reload`. A reloaded document may also pass that value to later
  // ordinary fetches, so the mode alone is ambiguous. In that case, keep cache
  // handling only for the explicit offline classes: the enumerated app shell,
  // narrowly allowlisted bundled-runtime directories, and immutable CDN URLs.
  // Everything unlisted (including catalog metadata) stays fresh and is never
  // inserted into a long-lived cache.
  if (event.request.cache === 'reload' && event.request.mode !== 'navigate' &&
      !isAppShellRequest && !isBundledRuntimeRequest &&
      !isImmutableRuntimeRequest(event.request, url)) return;

  // App shell: served entirely from ONE coherent version — the newest cache
  // that installed completely. A half-installed upgrade therefore does not take
  // effect until it is whole; the user keeps running the last good version as a
  // consistent set rather than a mix. Never an unqualified caches.match(): that
  // searches oldest-first and would splice files across versions.
  if (isScopedAppRequest) {
    // Kick a background repair if this version installed only partially; the
    // response itself still comes from the coherent serving cache below.
    maybeRepairInBackground(event);
    event.respondWith((async () => {
      const serving = await caches.open(await cacheNameForClient(event));
      const hit = await serving.match(event.request);
      if (hit) return hit;

      // Not in the serving shell (a genuinely new asset, or a cold first run):
      // fetch it, and populate THIS version's cache so a later completion check
      // can flip it to the serving version.
      const response = await fetch(event.request);
      if (response.ok && event.request.method === 'GET') {
        const current = await caches.open(APP_CACHE);
        await current.put(event.request, response.clone());
        // A shell entry just landed — if it was the last one missing, mark the
        // cache complete so the next request (and the next activate) can promote
        // it. Cheap: only recompute when the URL is actually part of the shell.
        const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
        if (APP_SHELL.some((u) => u.replace(/^\.\//, '') === path)) {
          await markCompleteness(current);
        }
      }
      return response;
    })());
    return;
  }

  // Runtime CDN assets: cache-first only for immutable, exact-version URLs.
  // Mutable aliases, indexes, and query-bearing requests deliberately fall
  // through to the browser's normal network handling and are never inserted
  // into our long-lived runtime cache.
  if (isCDNRequest(url)) {
    if (!isImmutableRuntimeRequest(event.request, url)) return;
    event.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      if (event.request.method === 'HEAD') {
        const cachedProbe = await responseFromRuntimeProbe(cache, event.request, url);
        if (cachedProbe) return cachedProbe;
        const response = await fetch(event.request);
        if (response.status === 200 || response.status === 404) {
          const headers = {};
          for (const name of ['content-type', 'content-encoding', 'access-control-allow-origin']) {
            const value = response.headers.get(name);
            if (value) headers[name] = value;
          }
          await cache.put(runtimeProbeMarkerUrl(url), new Response(JSON.stringify({
            schemaVersion: 1,
            method: 'HEAD',
            url: url.href,
            status: response.status,
            headers,
          }), { headers: { 'content-type': 'application/json' } }));
        }
        return response;
      }
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      // A 404 is immutable for an exact-version path and is therefore safe to
      // remember; it is often an optional webR file probe. Mutable paths never
      // reach this branch.
      if (response.status === 200 || response.status === 404) {
        await cache.put(event.request, response.clone());
      }
      return response;
    })());
    return;
  }

  // Everything else: network only (GitHub releases, user-requested URLs, etc.)
});
