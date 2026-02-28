// Service Worker for SciREPL PWA
// Caches app shell on install, caches CDN runtimes (Pyodide, swipl-wasm) on first fetch.

const CACHE_VERSION = 'v1';
const APP_CACHE = 'scirepl-app-' + CACHE_VERSION;
const CDN_CACHE = 'scirepl-cdn-v1';

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
  './js/kernel_manager.js',
  './js/math_mode.js',
  './js/notebook_manager.js',
  './js/prolog_settings.js',
  './js/prolog_vfs.js',
  './js/persistence.js',
  './js/shared_vfs.js',
  './js/package_loader.js',
  './js/package_catalog.js',
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
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old app caches, claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key.startsWith('scirepl-app-') && key !== APP_CACHE)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for app shell and CDN, network-first for everything else
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // App shell: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        // Not in cache — fetch, cache, return
        return fetch(event.request).then(response => {
          // Only cache successful responses for local assets
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(APP_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
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
