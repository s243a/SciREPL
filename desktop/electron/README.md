# SciREPL — Windows/Electron shell (Phase 0 feasibility spike)

A thin Electron shell around the **existing** prepared `www/` application. It is
the Windows-specific half of the split described in
[`docs/WINDOWS_STORE_PROPOSAL.md`](../../docs/WINDOWS_STORE_PROPOSAL.md):

```
www/, kernels, WASM, workbooks, formats, persistence   ← shared, untouched
android/, capacitor.config.json                        ← Android only
desktop/electron/                                      ← Windows only  (this directory)
```

Nothing here is referenced by the Android project, and nothing here imports
Capacitor. The shared application code imports neither framework — the shell
loads `www/` exactly as the PWA does, and the app takes its existing browser
code paths because `window.Capacitor` is absent.

**Status: feasibility spike, Free edition only.** There is no packaging, no
Microsoft Store integration and no entitlement logic here, deliberately. See
[`docs/WINDOWS_ELECTRON_SPIKE.md`](../../docs/WINDOWS_ELECTRON_SPIKE.md) for
measured results and the recommendation.

## Commands

Run from the repository root:

```bash
npm run windows:install    # install Electron (isolated; see "Dependency isolation")
npm run dev:windows        # configure + fetch runtimes + launch the shell
npm run test:windows       # all shell tests (needs Electron + a display)
npm run test:windows:unit  # policy unit tests only (no display, no Electron binary)
```

Individual suites:

```bash
node desktop/electron/test/run-all.mjs security persistence
SCIREPL_COMPARE_BASELINE=1 node desktop/electron/test/kernels.test.mjs
```

Playwright is the shared test driver — `_electron.launch()` drives the shell and
`chromium.launch()` drives the browser baseline. `npm install` provides the
Playwright *package* but not its browser binaries, so the baseline comparison
additionally needs:

```bash
npx playwright install chromium
```

These are additive. `npm run build`, `build:release:aab`, `build:play` and the
Android/PWA workflows are untouched.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SCIREPL_WWW` | serve a different prepared `www/` tree |
| `SCIREPL_USER_DATA` | use a specific profile directory (the persistence tests rely on this) |
| `SCIREPL_COMPARE_BASELINE=1` | also run the kernel probes in plain Chromium and compare |
| `SCIREPL_ELECTRON_NO_SANDBOX=1` | launch with `--no-sandbox` for containers without a usable setuid helper. The security suite records this and refuses to claim the sandbox was verified. |

## Dependency isolation

Electron is declared in `desktop/electron/package.json`, **not** in the root
`package.json`. That is the point: `npm install` at the repository root — which
is what the Android build and the existing CI do — must not download a ~220 MB
Chromium runtime. Only `npm run windows:install` does.

Electron is pinned exactly (`43.3.0`, no range).

## Origin model

The shell serves the application from a custom standard scheme:

```
app://scirepl/index.html
```

registered as `standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`
and `allowServiceWorkers`.

`file://` was rejected, not merely disliked: it gives documents an **opaque**
origin, which in Chromium means no service worker registration, unreliable
IndexedDB, blocked `fetch()` of relative URLs, and no `Content-Type`, so
`WebAssembly.instantiateStreaming` rejects. A stable non-opaque origin is what
makes notebook and SharedVFS state survive a restart. This is verified by
`test/persistence.test.mjs`, not assumed.

`protocol.js` is the only place that maps a URL to a file, and it refuses
anything that escapes `www/` (including percent-encoded traversal).

## Security model

The renderer is treated as **fully untrusted**, because SciREPL's JavaScript
kernel executes notebook cells with `new AsyncFunction(code)` in the main world
(`www/js/kernels/javascript.js`). There is no realm boundary between SciREPL's
own UI code and user-authored notebook code, so anything reachable from `window`
is reachable by a notebook cell.

The shell therefore **withholds capability rather than filtering it**:

| Setting | Value |
| --- | --- |
| `nodeIntegration` | `false` (also in workers and sub-frames) |
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `webviewTag` | `false` |
| remote module | not installed, not enabled |
| exposed API | `getAppInfo()`, `getDistributionInfo()` — read-only, nullary |

There is no `invoke`, `send`, filesystem, or shell escape hatch. Navigation off
the app origin is blocked; `target="_blank"` links are handed to the system
browser via `setWindowOpenHandler` and never open a child window. Permission
requests are denied wholesale. A restrictive CSP is applied to documents and
scripts by the protocol handler, so `www/index.html` is unchanged and the PWA
is unaffected.

`'unsafe-eval'` and `'wasm-unsafe-eval'` are permitted and cannot be removed —
the JavaScript kernel, Scittle and Pyodide all require them. The CSP is
restrictive about *origins*, which is the part that protects a packaged app.

### Known divergence: the Ko-fi widget

`www/index.html:407` loads the Ko-fi support widget from
`https://storage.ko-fi.com`. That origin is **deliberately not** on the
allowlist, so the widget is blocked and the support button does not appear in
the shell. It degrades silently — the widget is already guarded by
`if (typeof kofiwidget2 !== 'undefined')` — and the rest of the Help panel is
unaffected.

Allowing it would grant a third-party host arbitrary script execution in the
same realm that runs user notebooks, which is not a trade worth making for a
donate button. See `KOFI_EXCLUSION` in `protocol.js`; the exclusion is pinned by
`policy.unit.test.mjs` and `security.test.mjs` so it stays a decision rather than
drifting. The proper fix is a shared change — replace the widget with a plain
`target="_blank"` link — which is proposed as Phase 1 follow-up work.

## Files

| File | Role |
| --- | --- |
| `main.js` | lifecycle, window creation, single-instance lock, storage flush on quit |
| `protocol.js` | the `app://` scheme, MIME types, path containment, CSP |
| `security.js` | navigation / window-open / permission policy |
| `preload.js` | the entire renderer-visible surface (two read-only calls) |
| `ipc.js` | the canonical IPC allowlist, owned by the main process |
| `test/` | see below |

## Tests

| Suite | Needs Electron? | Covers |
| --- | --- | --- |
| `policy.unit.test.mjs` | no | path containment, external-URL policy, IPC allowlist, CSP shape |
| `shell-launch.test.mjs` | yes | origin, secure context, relative assets, WASM MIME + streaming, reload |
| `security.test.mjs` | yes | Node unreachable from notebook code, preload surface, navigation policy, webPreferences |
| `artifact-boundary.test.mjs` | yes | Free-only content; no bundled R, no entitlement code |
| `download.test.mjs` | yes | blob URLs and the `<a download>` path under `app://` |
| `persistence.test.mjs` | yes | IndexedDB / SharedVFS / localStorage across a real restart |
| `kernels.test.mjs` | yes | one execution per kernel + SharedVFS; optional browser A/B |
| `offline.test.mjs` | yes | bundled kernels with the network cut; CDN kernels fail cleanly |

`test/probes/kernels.mjs` holds the kernel assertions and is driven by **both**
the Electron runner and the Chromium baseline runner, so a difference in results
is a real platform difference rather than two divergent test suites. Export
*correctness* is not re-tested here — the existing browser tests in the
repository root already cover it and that logic is platform-independent.
