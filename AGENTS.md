# AGENTS.md

## Cursor Cloud specific instructions

SciREPL is a **mobile-first, fully client-side scientific notebook/REPL**. There is **no backend or database** — every language kernel (Python/Pyodide, R/webR, Prolog, Bash, JavaScript, Lua, TypR, ClojureScript) runs in-browser via WebAssembly. `server.js` is only a static file server for `www/` plus a narrow CORS proxy (`/proxy?url=...`) restricted to GitHub release downloads. The Android (Capacitor) and Electron (Windows) wrappers just load the same `www/` bundle.

### Scope on a headless Linux VM
- In scope: the **web PWA** (`node server.js` on port 8085) and the root `test_*.mjs` Playwright suites. This is the full core product.
- Out of scope here: the **Android/Capacitor build** (needs Android SDK + emulator) and the **Electron desktop app** (Windows-targeted, needs a display). The Electron node-only unit subset (`npm run test:windows:unit`) can run but only covers the desktop shell, not the product.

### Running and testing
- Dev server: `npm run serve` (= `node server.js`) → http://localhost:8085. Standard scripts live in `package.json`; CI steps are in `.github/workflows/ci.yml`.
- Playwright tests are standalone scripts run directly with node, e.g. `node test_help_vfs_examples.mjs`, `node test_js_kernel.mjs`. They expect the dev server already running on :8085. `node server.js` serves static files with `Cache-Control: no-cache`, so edits to `www/` are picked up on the next request — no server restart needed.
- **Two suites do not honour `PORT`.** `test_runtime_metadata.mjs` and `test_browse_catalog.mjs` read `SCIREPL_TEST_BASE` (a full URL) instead. Running them with only `PORT` set silently points them at :8085 and they fail against whatever is there — which looks like a product bug but is not.
- `test_pwa_release.mjs` starts its **own** server on **:8086** (override with `PORT`), so it can run alongside the shared dev server without a port conflict.
- Static gates, all node-only and fast — run before committing, because CI enforces every one:
  `npm run licenses:check`, `npm run release:check`, `npm run i18n:check` (includes `privacy:check`), `npm run sw:check`, `npm run verify:bundles`, `npm run test:sources`.

### Generated vs committed
Getting this wrong is the most common way to break the build.

- `www/js/kernel_config.js` **is committed**. `npm run configure` regenerates it from `build-profiles.json` + `package.json`; commit the result. It is also part of the service-worker app shell (see below).
- `www/vendor/` is **mixed**, not uniformly generated:
  - **Committed:** the small libraries — `plotly`, `katex`, `marked`, `hljs`, `jszip`, `pako`, `brush`, `typr`. Their exact bytes are pinned by sha256 in `third-party-components.json`.
  - **Fetched and gitignored:** the large WASM runtimes — `pyodide` (note: `pyodide`, not `python`), `swipl`, `scittle`. `npm run fetch:bundles` downloads roughly 80 MB into these.
- The app still boots without the fetched bundles (those kernels fall back to CDN), but the offline tests expect them present.

### Non-obvious gotchas
- **Service-worker app shell.** Changing *any* file listed in `APP_SHELL` in `www/sw.js` — `index.html`, the CSS, most of `www/js/**`, every i18n catalogue, `kernel_config.js` — requires bumping `CACHE_VERSION` in `www/sw.js` and then running `npm run sw:lock`. `scripts/check-sw-shell.mjs` fails CI otherwise. The lock is **append-only**: never reuse, rewrite, or lower a version, and never hand-edit `www/sw-shell.lock.json`.
- **Licence manifest.** Touching anything under `www/vendor/` that the manifest pins requires `npm run licenses:generate`, which rewrites `www/open-source-licenses.html` and `THIRD_PARTY_NOTICES.md`. Both are compared byte for byte by `licenses:check`.
- **Do not remove the `-text` entries in `.gitattributes`.** They keep the sha256-pinned files and the generated notices byte-identical across platforms. Without them, Windows CI rewrites LF to CRLF on checkout and the licence gate fails on files nobody edited.
- **Release identity lives only in `package.json`** (`version`, `android.versionCode`, `releaseChannel`). `android/app/build.gradle` reads it. Never hand-edit a version in the Gradle files.
- `npm run fetch:bundles` needs network access and is idempotent (skips already-downloaded bundles via completion receipts).
- WASM kernel compilation is memory-heavy (Pyodide peaks ~3–4 GB, webR ~1–2 GB). The R kernel (`webR`) and Lua (`Fengari`) still fetch from CDN on first use even in the bundled profile, so R-related tests require network access.
- Playwright with large WASM can hit `ERR_STRING_TOO_LONG` from `page.evaluate()`; the existing tests work around this using `page.addScriptTag()` + DOM `data-*` attributes (see the "Playwright Tests" section of `README.md` and `test_help_vfs_examples.mjs`).
