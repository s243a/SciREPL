# Phase 0: Windows Electron feasibility spike — results

Companion to [`WINDOWS_STORE_PROPOSAL.md`](WINDOWS_STORE_PROPOSAL.md), which
proposed Electron as a Windows-only shell around the existing web application.
This document records what was **actually built and measured**, using the Free
edition only.

**Recommendation: proceed to Phase 1.** No incompatibility was found between
SciREPL and a packaged Electron origin. Every enabled kernel behaves identically
to the browser baseline, and notebook/SharedVFS state survives a real restart.
Two findings change the *shape* of the Phase 1 plan and are described below.

---

## 1. Read this first: what "verified" means here

> **Except where §2.1 says otherwise, all automated results in this document
> were produced on Linux (WSL2, kernel 6.18, x64) with Electron 43.3.0 /
> Chromium 150.**

### 2.1 What has now run on Windows

A first `windows-latest` CI run has happened. Partial result:

| Suite | Windows result |
| --- | --- |
| `policy-unit` | **52/52 passed on Windows** |
| everything else | **did not run** — the shell failed to launch |

The Windows `policy-unit` pass is worth more than the Linux one: it exercised
path containment against real `D:\` drive-letter paths and backslash separators,
including the percent-encoded traversal cases. Those assertions are now verified
on the target platform.

The launch failure was a bug in the **test harness**, not the shell: the Electron
executable path was hardcoded as `dist/electron`, which does not exist on
Windows (`dist/electron.exe`). Playwright surfaced it only as
`Error: Process failed to launch!`. Fixed by asking the `electron` package for
its own platform-specific path — the package resolves it from the `path.txt`
its installer writes — plus a launch-failure message that reports the
executable, args and platform instead of failing opaquely.

**The Windows suite has therefore not yet completed. No Electron-dependent
result in this document is Windows-verified.** The next run on the spike branch
is the one that settles it.

That is a real limitation and it is not glossed over anywhere below. Every claim
is tagged:

| Tag | Meaning |
| --- | --- |
| **[verified]** | An automated test in `desktop/electron/test/` executed and passed. Output quoted or reproducible by running the suite. |
| **[verified, platform-independent]** | As above, and the behaviour is decided by Chromium/Electron code that does not vary by host OS (origin semantics, storage keying, `webPreferences`, CSP). Windows re-verification is expected to be a formality, but it has not happened. |
| **[pending Windows]** | Not executed. Listed in §9 with the exact steps to run. |

Nothing in this document claims a Windows-only check passed.

---

## 2. What was built

A thin shell under `desktop/electron/`, ~126 kB of source, five files:

| File | Role |
| --- | --- |
| `main.js` | lifecycle, window creation, single-instance lock, storage flush on quit |
| `protocol.js` | the `app://scirepl` scheme, MIME map, path containment, CSP |
| `security.js` | navigation / window-open / permission policy |
| `preload.js` | the entire renderer-visible surface — two read-only calls |
| `ipc.js` | the canonical IPC allowlist, owned by the main process |

It loads the **unmodified** prepared `www/` tree. No file under `www/`,
`android/`, `scripts/`, or `capacitor.config.json` was changed (§7).

Electron lives in `desktop/electron/package.json`, **not** the root
`package.json`, so a root `npm install` — what the Android build and existing CI
do — does not download a ~220 MB Chromium runtime. Electron is pinned exactly to
`43.3.0`.

---

## 3. Origin/protocol decision

**Decision: a custom standard scheme, `app://scirepl/`, not `file://`.**

Registered with `standard`, `secure`, `supportFetchAPI`, `corsEnabled`,
`stream`, `allowServiceWorkers`, `codeCache`.

`file://` was rejected on concrete grounds, not preference. It gives documents an
**opaque** origin, and SciREPL is origin-sensitive in five separate ways:

| Requirement | Under `file://` | Under `app://scirepl` |
| --- | --- | --- |
| IndexedDB (notebooks, SharedVFS) | unreliable / unpartitioned | **[verified]** survives restart |
| Service worker registration | impossible (opaque origin) | supported (scheme is `secure`) |
| `fetch()` of relative URLs | blocked | **[verified]** works |
| `WebAssembly.instantiateStreaming` | fails — no `Content-Type` | **[verified]** `compileStreaming` succeeds |
| Relative asset resolution | fragile | **[verified]** KaTeX, Marked, Plotly, JSZip, hljs all load |

Measured under the shell **[verified, platform-independent]**:

```
window.location.origin  === "app://scirepl"     (not "null" — non-opaque)
window.isSecureContext  === true
fetch('js/kernel_config.js')      200 text/javascript
fetch('vendor/brush/brush_wasm_bg.wasm')  200 application/wasm
WebAssembly.compileStreaming(...)  resolves
```

`protocol.js` is the only code that maps a URL to a file, and it refuses
traversal in raw and percent-encoded forms (`/../`, `/%2e%2e/`, `/..%2f`,
`%00`, malformed `%ZZ`) **[verified]**, plus the prefix-confusion case where a
sibling path merely starts with the root's name.

### A real bug this decision surfaced

`security.js` originally classified in-app navigation by comparing
`url.origin === 'app://scirepl'`. That is wrong in the **main process**:
`registerSchemesAsPrivileged({standard:true})` teaches *Chromium* the scheme, but
the main process parses URLs with **Node's** implementation, which has no such
registry and reports `origin === 'null'` for a non-special scheme. The
`will-navigate` handler would therefore have classified every in-app navigation
as external and blocked the app from navigating within itself.

Caught by `policy.unit.test.mjs`, confirmed by running both parsers, and fixed by
comparing `protocol` + `hostname`. `security.test.mjs` now asserts in-app
navigation is *permitted*, not merely that external navigation is blocked.
Worth recording because any future custom-scheme logic in the main process has
the same trap.

---

## 4. Security model

### The finding that drives the design

SciREPL's JavaScript kernel executes notebook cells with
`new AsyncFunction(code)` **in the main renderer realm**
(`www/js/kernels/javascript.js:70-71`). Scittle, Fengari and Pyodide's JS bridge
reach the same `window`. There is **no realm boundary between SciREPL's own UI
code and user-authored notebook code**.

Consequence: any preload API exposed to the main world is reachable by a
notebook cell. A capability cannot be given to the app but withheld from
notebooks, because a filter would have to tell them apart and cannot.

The shell therefore **withholds capability rather than filtering it**.

### Configuration **[verified, platform-independent]**

| Setting | Value | Asserted from the live window |
| --- | --- | --- |
| `nodeIntegration` | `false` | ✔ (also workers, sub-frames) |
| `contextIsolation` | `true` | ✔ |
| `sandbox` | `true` | ✔ (OS sandbox on; suite records if relaxed) |
| `webSecurity` | enabled | ✔ |
| `webviewTag` | `false` | ✔ |
| `@electron/remote` | not installed | ✔ |

### Regression tests written from the attacker's position **[verified]**

Executed **through the real JavaScript kernel**, i.e. as a notebook cell:

- `require`, `process`, `Buffer`, `module`, `__dirname`, `global`, `electron`,
  `ipcRenderer` → all `ReferenceError`.
- `new Function('return process')()`, `top.require`, `parent.require` → all blocked.
- The exposed surface is exactly `['getAppInfo','getDistributionInfo']`, frozen.
- No `invoke`/`send`/`on`/`ipc`/`fs`/`shell`/`exec`/`readFile`/`writeFile` of any name.
- A cell setting `window.location.href = 'https://example.com/'` does not move the window.
- A cell calling `window.open('https://example.com/')` creates **no** second window.
- Renderer-supplied arguments to the platform API are inert.

### The exposed surface, and why it is only two calls

`getAppInfo()` and `getDistributionInfo()` are nullary and return static build
facts. They carry no authority and are safe when called by hostile notebook code
— which is the standard every future operation must meet.

Not exposed, deliberately: a generic `invoke`, any filesystem or shell
operation, and `openExternal`. External links are plain `target="_blank"`
anchors (`www/index.html:140,396,897`), so `setWindowOpenHandler` in the **main
process** handles them: `https:`/`mailto:` only, no credentials in the URL, and
the window is always denied. `file:`, `javascript:`, `data:`, `vbscript:`,
`ms-settings:` and `shell:` are all refused **[verified]**. This is parity with
a browser, where page JS can already open a tab — not an escalation.

`getDistributionInfo()` returns `store: null`. No entitlement system was
implemented, faked, or stubbed. The `StoreContext.GetAppLicenseAsync()` seam is
documented in `ipc.js` as a comment only; `artifact-boundary.test.mjs` fails the
build if it is ever implemented in shell source **[verified]**.

### CSP

Applied by the protocol handler to documents and scripts, so `www/index.html` is
**unchanged** and the PWA is unaffected. Restrictive about origins
(`object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`,
`base-uri 'self'`, no plaintext `http:`), with the remote allowlist derived from
`build-profiles.json` and `package_catalog.js` rather than guessed.

`'unsafe-eval'` and `'wasm-unsafe-eval'` are permitted and **cannot be removed** —
the JavaScript kernel, Scittle and Pyodide all require them. Unit tests assert
their presence so removing them is a conscious decision, and assert the origin
restrictions so they cannot be loosened silently. The CSP is defence in depth;
the boundary is `contextIsolation` + `sandbox` + the absent API.

---

## 5. Compatibility results

Every kernel enabled by the Free `full` profile, driven through the
application's own `kernelManager.ensureReady()` / `.execute()`. The **same probe
module** (`test/probes/kernels.mjs`) is run by the Electron runner and by a plain
Chromium runner against the repo's own `server.js`, so a difference in results is
a real platform difference rather than two divergent suites.

**[verified]** — Electron 43.3.0 vs Chromium baseline, Free `full` profile:

| Kernel | Source | Electron init / exec | Browser init / exec | Parity |
| --- | --- | --- | --- | --- |
| JavaScript (native) | — | 0 ms / 1 ms | 0 ms / 1 ms | ✅ |
| Bash / Brush (WASM) | bundled | 222 ms / 12 ms | 176 ms / 16 ms | ✅ |
| TypR (WASM + webR) | bundled + CDN | runs; output gap¹ | runs; output gap¹ | ✅ identical |
| Lua / Fengari | CDN | 133 ms / 2 ms | 144 ms / 6 ms | ✅ |
| ClojureScript / Scittle | bundled | 64 ms / 18 ms | 57 ms / 13 ms | ✅ |
| SWI-Prolog (WASM) | bundled | 1136 ms / 4 ms | 943 ms / 5 ms | ✅ |
| Python / Pyodide (WASM) | bundled | 8187 ms / 3 ms | 9614 ms / 6 ms | ✅ |
| R / webR (WASM) | CDN in Free | runs / 19 ms | runs / 20 ms | ✅ |

**No kernel behaves differently under the packaged origin.**

¹ TypR initialises and executes without error, but `cat()` output does not reach
`execute()`'s stdout. This reproduces **identically** in the browser baseline,
and the repository's own `test_typr_kernel.mjs` already tolerates empty output
here — so it is a pre-existing application gap, not something Electron
introduced. It is reported as a known gap rather than silently relaxed, and the
parity check still fails if Electron ever diverges.

### Other features **[verified]**

| Feature | Result |
| --- | --- |
| Startup + reload | app boots and reloads at the same origin; no uncaught page errors |
| Workers | Pyodide/webR worker-backed kernels run under `app://` |
| Cross-kernel SharedVFS | write via `sharedVFS` → readable from the Python kernel |
| SharedVFS → IndexedDB | persisted; DBs created: `scirepl_vfs`, `emscripten_filesystem` |
| IndexedDB across restart | marker survives a real process restart |
| localStorage across restart | survives |
| Shutdown during active writes | graceful close, no SIGKILL needed |
| Export delivery | `FileIO._downloadBlob` → blob URL → download reaches main process, bytes intact on disk |
| Import primitives | `File`/`FileReader` work under `app://` |
| Blob URLs | creatable and readable under `app://` |
| External links | `https:`/`mailto:` to the OS; everything else refused; no child window |
| Offline (network cut) | app starts and reloads; JS, Bash, ClojureScript, Prolog, Python all run; Lua fails cleanly with a clear error; app stays responsive; a bundled kernel still runs afterwards |

### Known divergence from the PWA: the service worker cache is inert

**[verified]** The service worker registers under `app://` (the scheme is
`secure` and `allowServiceWorkers`), but its caching does not work:

```
sw.js:97  Uncaught (in promise) TypeError:
          Failed to execute 'addAll' on 'Cache': Request scheme 'app' is unsupported
```

The Cache API only accepts `http`/`https` requests, so `www/sw.js`'s app-shell
precache (`CACHE_VERSION` / `APP_CACHE`) and its CDN runtime cache
(`CDN_CACHE`) are both non-functional in the shell.

Impact is smaller than it looks, and the measured results already reflect it:

- **App shell** — unaffected in practice. Every local asset is served by the
  `app://` protocol handler straight off disk, so the precache was redundant
  here. The offline suite confirms the app starts, reloads and runs its bundled
  kernels with the network cut **[verified]**.
- **CDN kernels** — this is the real cost. In the PWA, `CDN_CACHE` is what lets
  Lua and R work offline after one online use. In the shell they cannot be
  cached at all, so they need the network every session. That is consistent
  with, and part of the explanation for, the offline result already reported
  above (Lua fails cleanly offline).

It also means the "cached" branch of the download-consent check in
`kernel_manager.js:190-202` never sees a hit under `app://`, so the consent
modal reappears for CDN kernels every session.

Not a blocker, and deliberately not worked around in Phase 0. The proper fix is
a platform-appropriate one: a packaged desktop app should bundle its runtimes
rather than cache CDN downloads — i.e. Windows builds should use a profile that
bundles Lua and R offline, which is exactly what the existing `pro` profile
already does for R. Recorded for Phase 2 profile selection (§11).

### Known divergence from the PWA: the Ko-fi support widget

`www/index.html:407` loads the Ko-fi support widget as a third-party script from
`https://storage.ko-fi.com`. That origin is **deliberately absent** from the
shell's CSP allowlist, so the widget is blocked and the support button does not
render in the Electron build **[verified]**:

```
securitypolicyviolation  script-src-elem  https://storage.ko-fi.com/cdn/widget/Widget_2.js
typeof window.kofiwidget2 === "undefined"
```

The widget is already guarded by `if (typeof kofiwidget2 !== 'undefined')`, so
blocking it **degrades silently** — nothing throws, and the rest of the Help
panel is intact **[verified]**.

It is excluded rather than allowed because adding a third-party host to
`script-src` grants it arbitrary script execution in the same realm that runs
user notebooks and holds all IndexedDB state (§4). That supply-chain exposure is
out of proportion to a donate button, and the CSP's entire value here is being
restrictive about origins.

**This is a divergence, not a fix.** The right resolution is a *shared* change:
replace the widget with a plain `target="_blank"` link to the Ko-fi page, which
behaves identically in the PWA, on Android and in the shell, and needs no CSP
exception anywhere. That touches `www/`, which this spike deliberately does not
modify, so it is proposed as a Phase 1 follow-up (§11).

Until then the exclusion is pinned by tests — `policy.unit.test.mjs` asserts the
origin is absent from the allowlist and from the CSP, and `security.test.mjs`
asserts the live block and its silent degradation — so allowing the origin, or
dropping the documented exclusion, fails the build and forces the choice to be
re-made rather than drifting.

### One behaviour worth calling out for product review

`KernelManager` gates CDN runtime downloads behind a confirmation modal unless
`localStorage['scirepl_auto_download'] === '1'`
(`www/js/kernel_manager.js:202`). This is correct for the PWA. In a **packaged
desktop app** it means a first-run user who clicks the Lua or R kernel gets a
download-consent dialog, which reads differently from an installed application.

This is a product decision for Phase 2, not a blocker. Noting it because it also
cost real debugging time here: the first matrix run showed Lua, R and TypR
"timing out" for 240 s each. That was the harness failing to grant consent, not
an Electron incompatibility — the kind of false negative this report is meant to
avoid publishing.

---

## 6. Measurements

**[verified on Linux/WSL2 x64 — Windows figures must be re-measured, §9]**

### Size

| Item | Size |
| --- | --- |
| Prepared `www/` (Free `full`) | **108.3 MB** (`vendor/` 96.1 MB) |
| — `vendor/pyodide` | 72.4 MB |
| — `vendor/swipl` | 11.0 MB |
| — `vendor/brush` | 6.5 MB |
| — `vendor/typr` | 2.6 MB |
| — `vendor/katex` + `plotly` + `scittle` + rest | 3.6 MB |
| Electron runtime (`dist/`, Linux x64) | **327.4 MB** unpacked |
| Shell source | 126.3 kB |

An installed Windows Free build is therefore roughly **`www/` + the Windows
Electron runtime**, before any installer compression. The Electron runtime is
the dominant cost and is exactly what the proposal's Phase 4 Tauri question is
about. Note the Pro profile adds webR offline (~50 MB more) on top.

### Startup

| Measure | Value |
| --- | --- |
| Process launch → first window | 1339 ms |
| Process launch → app ready (`kernelManager` present) | 1398 ms |
| In-page DOMContentLoaded | 263–451 ms across runs |

### Memory (`app.getAppMetrics()`, 4 processes)

| State | Total | Breakdown |
| --- | --- | --- |
| Idle, app loaded | 668.3 MB | Browser 197, GPU 202.7, Utility 90.7, Tab 177.9 |
| After Pyodide loaded | 936.0 MB | Browser 240.3, GPU 228, Utility 90.7, Tab 376.9 |

**Treat these as indicative only.** `workingSetSize` counts shared pages against
every process, so the total overstates real consumption, and the GPU figure is
inflated by WSLg's software rendering path. The *shape* — Pyodide adding ~200 MB
to the renderer — is the reliable signal. Absolute numbers need Windows.

---

## 7. Android / PWA regression status

**No shared runtime file was modified.** Complete diff against `main`:

| Change | Nature |
| --- | --- |
| `desktop/**` (new) | Windows-only, referenced by nothing else |
| `.github/workflows/windows-electron-spike.yml` (new) | additive workflow |
| `package.json` | **+4 scripts only** (`windows:install`, `dev:windows`, `test:windows`, `test:windows:unit`) |
| `.gitignore` | +4 ignore rules for Electron output |
| `docs/WINDOWS_ELECTRON_SPIKE.md` (new) | this file |

Untouched: `www/**`, `android/**`, `capacitor.config.json`, `build-profiles.json`,
`scripts/**`, `server.js`, `sw.js`, root `package-lock.json`, every existing
`npm` script and both existing workflows. No Android application ID, version,
Gradle setting, runtime version or bundled artifact changed. No production
dependency was added to the web application.

### Existing browser tests re-run unchanged **[verified]**

| Test | Result |
| --- | --- |
| `test_js_kernel.mjs` | 13/13 passed |
| `test_lua_kernel.mjs` | ALL TESTS PASSED |
| `test_sharedvfs_sync.mjs` | passed |
| `test_notebook_vfs.mjs` | ALL TESTS PASSED |

Android build **[pending Windows/Android toolchain]** — not run here (no Android
SDK in this environment). The argument that it is unaffected is structural: no
file the Android build reads was changed. `npm run build:play` and
`build-release.yml` are byte-identical to `main`.

---

## 8. The shell's own test suite

`npm run test:windows` — **verified, 199 assertions, 0 failures**:

| Suite | Result | Needs Electron? |
| --- | --- | --- |
| `policy-unit` | 52 passed | no |
| `shell-launch` | 18 passed | yes |
| `security` | 34 passed | yes |
| `artifact-boundary` | 14 passed | yes |
| `download` | 9 passed | yes |
| `persistence` | 9 passed | yes |
| `kernels` | 46 passed, 2 known-gap skips | yes |
| `offline` | 17 passed | yes |

Export *correctness* is deliberately **not** re-tested — the existing browser
tests already cover which bytes each format produces, and that logic is
platform-independent. Only the delivery step, which Electron genuinely changes,
is tested here. This is the "reuse rather than clone" rule in practice.

### CI

`.github/workflows/windows-electron-spike.yml`, additive, not a required check
for anything:

- **`shell-policy`** (ubuntu, on PRs touching `desktop/electron/**`) — the 52
  unit assertions. Needs no display and no Electron download.
  **[verified]** by reproducing the job's exact environment: a tree with only
  `desktop/electron` deps installed via `--ignore-scripts`, no Electron binary,
  no Playwright → 52/52 passed.
- **`windows-shell`** (windows-latest) — **`workflow_dispatch` only, on purpose.**
  It has never been observed to pass on a Windows runner. Making an unproven,
  ~330 MB-downloading GUI job an automatic gate would block PRs. Promote it to
  `pull_request` after §9 is done.

  This job runs with `SCIREPL_COMPARE_BASELINE=1` and an explicit
  `npx playwright install chromium` step. Playwright is the shared test driver —
  `_electron.launch()` drives the shell, `chromium.launch()` drives the browser
  baseline — and `npm install` provisions the Playwright *package* but not its
  browser binaries. The two settings go together deliberately: without the
  baseline flag the suite never calls `chromium.launch()` and the download would
  be dead weight; with it, the job re-measures the Electron-vs-browser kernel
  parity of §5 on real Windows rather than inheriting the Linux result.

  **A GitHub constraint affects the merge order.** `workflow_dispatch` is only
  offered for workflows that already exist on the **default branch**, so a
  brand-new workflow file cannot be dispatched against its own PR head. Getting
  a green Windows run *before* merge therefore needs one of: a temporary
  branch-scoped `push` trigger (what this branch does — clearly marked, and to be
  removed in the merge commit), merging the workflow file to `main` on its own
  first, or running §9 by hand on a Windows machine. Without one of those, "run
  it on the PR, then merge" is not achievable as stated.

---

## 9. Remaining Windows-only manual verification

None of these were executed. Run on a Windows 10/11 x64 machine:

```powershell
npm install
npm run configure
npm run fetch:bundles
npm run windows:install
npm run test:windows          # expect the §8 table
node desktop/electron/test/measure.mjs --with-python
```

Then confirm by hand:

1. **The whole suite passes on Windows.** `policy-unit` already does (§2.1); the
   seven Electron-dependent suites have not yet completed a Windows run.
2. **Windows path containment** — that `app://scirepl/..%5C..%5Cpackage.json`
   (backslash) is refused. `policy.unit.test.mjs` now covers drive-letter and
   backslash cases **on Windows**, but this specific encoded form should be
   confirmed against the live protocol handler.
3. **Startup, size and memory re-measured on Windows** — §6 is Linux-only.
   The GPU figure in particular will differ with real hardware acceleration.
4. **Native Save dialog.** The shell installs no `will-download` handler, so
   Electron shows its default Save dialog. Confirm each export format
   (HTML, Markdown, LaTeX, DOCX, PDF, `.srwb`, `.ipynb`) reaches disk with a
   correct default filename and extension.
5. **PDF export** — the browser `window.print()` path; the Capacitor
   `PdfGenerator` plugin is absent here.
6. **External links** open in the default Windows browser and focus it.
7. **Display scaling** (125/150/200%), high contrast, keyboard-only navigation,
   and a screen reader (Narrator/NVDA).
8. **Sleep/resume** with a kernel loaded; **shutdown while a kernel is running**.
9. **Long paths / non-ASCII usernames** — `userData` under a profile such as
   `C:\Users\Ünïcode\AppData\Roaming\SciREPL-Free-Electron`.
10. **Second-instance behaviour** — the single-instance lock focuses the existing
    window rather than opening a second renderer on the same IndexedDB.
11. **arm64**, if offered.

Explicitly **not** attempted, per the brief: MSIX packaging, Store submission,
`StoreContext.GetAppLicenseAsync()`, and anything Pro.

---

## 10. Blockers and risks

**Blockers: none.** Nothing was found that would prevent SciREPL running as a
standalone Electron application.

Risks, in the order they should be addressed:

| # | Risk | Severity | Assessment |
| --- | --- | --- | --- |
| 1 | **Notebook code shares the renderer realm with UI code.** Any future native operation exposed to the main world is callable by a notebook cell. | **High — architectural** | Contained today (nothing exposed carries authority). Becomes the central constraint the moment `saveFile`/`openFile` are added. See §11. |
| 2 | **Electron runtime size** — 327 MB unpacked on Linux, plus 108 MB of `www/`. | Medium | Known, and exactly the Phase 4 Tauri trigger. Not a Phase 0 blocker. |
| 3 | **Windows entirely unverified.** | Medium | Structural argument is strong (Chromium-level behaviour), but §9 must be done before Phase 2. |
| 4 | **Memory footprint** — ~0.9 GB with Pyodide loaded, on inflated Linux metrics. | Medium | Needs honest Windows numbers before any Store claim about system requirements. |
| 5 | **`'unsafe-eval'` is mandatory.** | Low-Medium | Unavoidable — the product is a REPL. Documented and asserted. Compensate by restricting origins and keeping Chromium current. |
| 6 | **Electron/Chromium upgrade treadmill.** | Low-Medium | Pinned to 43.3.0. Needs a standing update policy, not a one-off. |
| 7 | **CDN download-consent modal on a packaged app.** | Low | Product decision (§5). |
| 8 | **TypR output gap.** | Low | Pre-existing, reproduces in browser, unrelated to Windows. |
| 9 | **Ko-fi widget blocked in the shell** (§5). | Low | Deliberate; degrades silently; pinned by tests. Resolve with a shared plain-link change (§11.5), not a CSP exception. |
| 10 | **Service worker cache inert under `app://`** (§5) — CDN kernels cannot be cached for offline use. | Medium | Fix by bundling runtimes in the Windows profile rather than relying on web caches, which is the right shape for a packaged app anyway. |

---

## 11. Proposed Phase 1 plan

Scoped to what this spike **actually observed**, not to the full interface
sketched in the proposal.

### The central observation

Phase 0 needed **zero** changes to `www/` — because every existing
`window.Capacitor` call site already has a working browser fallback, and Electron
takes it:

| Site | Capacitor path | Browser fallback (what Electron uses) |
| --- | --- | --- |
| `file_io.js:80` | `Browser.open` | button hidden when absent |
| `file_io.js:749` | `Filesystem` + `Share` | blob URL + `<a download>` |
| `file_io.js:1330` | `Filesystem` + `Share` | blob URL download |
| `export.js:1143` | `PdfGenerator` | `window.print()` |
| `export.js:1905` | `Filesystem` + `Share` | blob URL download |
| `package_catalog.js:654` | native HTTP | `fetch()` |

**So Phase 1 should not be a general "abstract Capacitor away" refactor.** The
proposal's full six-operation interface is not yet justified by evidence — the
browser fallbacks work. Introducing an abstraction over six operations to
replace six working conditionals would be motion, not progress.

### What Phase 1 should actually do

**1. Fix the realm boundary first (risk #1).** This is the only finding that
blocks a *safe* native operation, so it precedes any platform interface. Either:

- run notebook JavaScript in a Worker or sandboxed iframe so it no longer shares
  `window` with UI code — the durable fix, and it also benefits Android and the
  PWA; **or**
- accept the shared realm permanently and require **every** native operation to
  be user-confirmed through an OS dialog, so hostile notebook code can at worst
  cause a dialog the user must accept.

Decide this explicitly. Do not add `saveFile` before it is decided.

**2. Introduce the platform interface for exactly two operations**, the two where
the browser fallback is genuinely worse on desktop:

- `saveFile(name, bytes, mediaType)` → native Save As. Must show the OS dialog,
  so the *user* chooses the path, which also satisfies option (b) above.
- `openFile(filters)` → native Open, plus drag-and-drop import.

Three adapters (browser, Capacitor, Electron), contract tests per adapter.
Everything else keeps its working browser path until evidence says otherwise.

**3. Add a `will-download` handler** to the shell so exports get a proper Save As
with a correct default filename, rather than Electron's default dialog behaviour
(§9 item 4).

**4. Migrate `export.js:1143` (`PdfGenerator`) last.** It is the one call site
with a materially different desktop implementation, and it needs the Windows
print verification from §9 first.

**5. Replace the Ko-fi widget with a plain external link** (§5). A one-line
change in `www/index.html`: swap the third-party `<script>` for a
`target="_blank"` anchor to the Ko-fi page. It restores the support button in
the shell, removes a third-party script from the PWA and Android builds too, and
needs no CSP exception on any platform. Listed here rather than done in this PR
because it touches shared `www/` code, which the spike deliberately leaves alone.

**6. Choose a Windows build profile that bundles its runtimes.** The service
worker cache is inert under `app://` (§5), so a Windows build cannot rely on
caching CDN downloads for offline use. A packaged desktop application should
bundle what it needs anyway: define a `windows-free` profile that additionally
bundles Lua (and, for Pro, R) rather than leaving them on a CDN. This is a
`build-profiles.json` change, not application code.

**7. Keep the artifact boundary test in CI.** It already fails the build if Pro
content, a hardcoded `isPro`, a Store licence call, or commerce code appears in
the shell.

### Explicitly deferred

`shareFile`, `openExternal` as an exposed op (the window-open handler covers it),
`getDistributionInfo` growing entitlement meaning, MSIX, Store licensing, Pro
anything. None is justified by a Phase 0 observation.

---

## 12. Decision gates from the proposal

| Gate | Status |
| --- | --- |
| All important WASM kernels work in the packaged origin | ✅ **[verified]** 8/8, at parity with the browser |
| Notebook code cannot cross the native bridge | ✅ **[verified]** — and there is almost no bridge to cross |
| IndexedDB and SharedVFS survive | ✅ **[verified]** across a real restart; across an *MSIX update* is **[pending Windows]** |
| The same web bundle still runs under Capacitor without a fork | ✅ `www/` unchanged; existing browser tests pass |
| Offline assets fit practical Store limits | ⚠️ measured (108 MB + runtime) but Windows/MSIX figures **[pending Windows]** |
| Expected Windows demand justifies the cost | ❌ out of scope — a product judgement, not a spike output |

**Recommendation: proceed to Phase 1**, starting with the realm-boundary decision
(§11.1) rather than with a broad platform-interface refactor. Do not proceed to
MSIX, Store submission or Pro work until §9 has been executed on real Windows.
