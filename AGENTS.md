# AGENTS.md

## Cursor Cloud specific instructions

SciREPL is a **mobile-first, fully client-side scientific notebook/REPL**. There is **no backend or database** — every language kernel (Python/Pyodide, R/webR, Prolog, Bash, JavaScript, Lua, TypR, ClojureScript) runs in-browser via WebAssembly. `server.js` is only a static file server for `www/` plus a narrow CORS proxy (`/proxy?url=...`) restricted to GitHub release downloads. The Android (Capacitor) and Electron (Windows) wrappers just load the same `www/` bundle.

### Scope on a headless Linux VM
- In scope: the **web PWA** (`node server.js` on port 8085) and the root `test_*.mjs` Playwright suites. This is the full core product.
- Out of scope here: the **Android/Capacitor build** (needs Android SDK + emulator) and the **Electron desktop app** (Windows-targeted, needs a display). The Electron node-only unit subset (`npm run test:windows:unit`) can run but only covers the desktop shell, not the product.

### Running and testing
- Dev server: `npm run serve` (= `node server.js`) → http://localhost:8085. Standard scripts live in `package.json`; CI steps are in `.github/workflows/ci.yml`.
- Playwright tests are standalone scripts run directly with node, e.g. `node test_help_vfs_examples.mjs`, `node test_js_kernel.mjs`. They expect the dev server already running on :8085. `node server.js` serves static files with `Cache-Control: no-cache`, so edits to `www/` are picked up on the next request — no server restart needed.
- Exception: `test_pwa_release.mjs` starts its **own** server on :8085, so stop the shared dev server first (or run it in isolation) to avoid a port conflict.
- Lint/static gates (all node-only, fast): `npm run licenses:check`, `npm run release:check`, `npm run i18n:check`, `npm run sw:check`. Run these before committing since CI enforces them.

### Non-obvious gotchas
- `www/js/kernel_config.js` and the large WASM runtimes under `www/vendor/{python,swipl,scittle,...}` are **generated build artifacts, not committed**. They are produced by `npm run configure` (writes `kernel_config.js`) and `npm run fetch:bundles` (downloads ~70 MB of runtimes into `www/vendor/`). Both are in the startup update script. The app still boots without the bundles (kernels fall back to CDN), but tests and offline behavior expect them present.
- `npm run fetch:bundles` needs network access and is idempotent (skips already-downloaded bundles via completion receipts).
- WASM kernel compilation is memory-heavy (Pyodide peaks ~3–4 GB, webR ~1–2 GB). The R kernel (`webR`) and Lua (`Fengari`) still fetch from CDN on first use even in the bundled profile, so R-related tests require network access.
- Playwright with large WASM can hit `ERR_STRING_TOO_LONG` from `page.evaluate()`; the existing tests work around this using `page.addScriptTag()` + DOM `data-*` attributes (see README "Playwright + Large WASM" and `test_help_vfs_examples.mjs`).
