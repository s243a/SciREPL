# Phase 0: Windows Electron feasibility spike — results

Companion to [`WINDOWS_STORE_PROPOSAL.md`](WINDOWS_STORE_PROPOSAL.md), which
proposed Electron as a Windows-only shell around the existing web application.
This document records what was **actually built and measured**, using the Free
edition only.

**Recommendation: proceed to Phase 1.** No incompatibility was found that stops
SciREPL running as a packaged Electron application. Every enabled kernel behaves
identically to the browser baseline, and notebook/SharedVFS state survives a
real restart — both now measured on Windows as well as Linux.

Three findings change the *shape* of the Phase 1 plan rather than blocking it:
the renderer realm boundary (§4), the service worker cache being inert under a
custom scheme (§5), and the Ko-fi widget divergence (§5). All three are
described below and reflected in §11.

---

## 1. Read this first: what "verified" means here

**The full automated suite now passes on Windows.** The `windows-shell` CI job
on `windows-latest` (Windows Server 2025) runs all eight suites — **199
assertions, 0 failures** — including the Playwright Chromium baseline, so the
kernel-parity result below is measured on Windows and not inherited from Linux.

Development and the measurements in §6 were done on Linux (WSL2, kernel 6.18,
x64) with Electron 43.3.0 / Chromium 150. Both platforms produce the same suite
result.

What that does **not** cover is everything a human has to look at: display
scaling, native dialogs, accessibility, sleep/resume, non-ASCII profile paths.
Those are still untested and are listed in §9.

Claims are tagged throughout:

| Tag | Meaning |
| --- | --- |
| **[verified]** | An automated test in `desktop/electron/test/` executed and passed **on both Linux and Windows CI**. |
| **[verified, Linux only]** | Executed on Linux; the Windows figure has not been captured. Used for the §6 measurements. |
| **[pending Windows, manual]** | Requires a human at a Windows desktop. Listed in §9. |

Nothing in this document claims an unexecuted check passed.

### 1.1 How the Windows job got there

Worth recording, because both failures were in the **test harness**, not the
shell — and both are the kind of thing only a real Windows runner surfaces.

1. **`policy-unit` passed on Windows from the first run** (52/52), which is
   worth more than the Linux pass: it exercised path containment against real
   `D:\` drive-letter paths and backslash separators, including the
   percent-encoded traversal cases.
2. **Run 1 — Electron would not launch.** The executable path was hardcoded as
   `dist/electron`; on Windows it is `dist/electron.exe`. Playwright surfaced
   this only as `Error: Process failed to launch!`. Fixed by asking the
   `electron` package for its own platform-specific path.
3. **Run 2 — the process launched but `app` never became ready.** Two causes.
   `electron@43.3.0` ships **no `postinstall`**; it downloads lazily on first
   `require()`, so the install step provisioned nothing and the download fired
   mid-test. And `main.js` called `app.quit()` on a failed single-instance lock
   and then carried on to register `whenReady` anyway — a process that is
   quitting but still waiting for `ready` never becomes ready and never exits.
4. **Run 3 — green.**

The lasting fix is `test/smoke.mjs`: it launches the shell directly, without
Playwright, and prints the main process's own stdout/stderr, because Playwright
reports any launch failure as a bare timeout with no output. It runs before the
suite so its output survives a suite failure. That diagnostic is also what
surfaced the service-worker limitation in §5.

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

Measured under the shell **[verified]** (Linux and Windows CI):

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

### Configuration **[verified]** (Linux and Windows CI)

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

**[verified, Linux only — Windows figures must be re-measured on real hardware, §9]**

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

Android build — **not executed** (no Android SDK in this environment). The
argument that it is unaffected is structural rather than empirical: no
file the Android build reads was changed. `npm run build:play` and
`build-release.yml` are byte-identical to `main`.

---

## 8. The shell's own test suite

`npm run test:windows` — **verified, 0 failures**:

| Suite | Result | Needs Electron? |
| --- | --- | --- |
| `policy-unit` | 59 passed | no |
| `shell-launch` | 18 passed | yes |
| `security` | 22 passed | yes |
| `artifact-boundary` | 14 passed | yes |
| `download` | 9 passed | yes |
| `persistence` | 9 passed | yes |
| `kernels` | 46 passed, 2 known-gap skips (23 without the browser baseline) | yes |
| `offline` | 17 passed | yes |
| `packaged` | 56 passed | yes, **and a built package** — opt-in, see §13 |

Counts shifted in Phase 0.5 and the totals are not comparable to the Phase 0
figure of 199. `security` fell from 34 to 22 because its checks moved into
`probes/security.mjs`, where related assertions are graded as a group rather
than one per Node global — the same ground is covered, by one definition now
shared with the packaged suite. `policy-unit` rose with the packaged-layout
path tests.

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
- **`windows-shell`** (windows-latest, on PRs touching `desktop/electron/**`,
  plus `workflow_dispatch`) — **verified green:** all eight suites, 199
  assertions, 0 failures, all eight kernels at browser parity.

  It runs with `SCIREPL_COMPARE_BASELINE=1` and an explicit
  `npx playwright install chromium` step. Playwright is the shared test driver —
  `_electron.launch()` drives the shell, `chromium.launch()` drives the browser
  baseline — and `npm install` provisions the Playwright *package* but not its
  browser binaries. The two settings go together deliberately: without the
  baseline flag the suite never calls `chromium.launch()` and the download would
  be dead weight; with it, the job measures Electron-vs-browser kernel parity on
  real Windows rather than inheriting the Linux result.

  A `smoke.mjs` step runs first and prints the main process's own
  stdout/stderr, because Playwright reports any launch failure as a bare
  timeout. Keep it: it is what made the two Windows-only harness bugs in §1.1
  diagnosable, and it surfaced the service-worker finding in §5.

  It reaches CDN hosts for the baseline comparison, so it carries some network
  flakiness risk. If that becomes noise, drop it back to `workflow_dispatch`
  rather than tolerating a habitually red job.

  **A note for anyone adding a workflow like this in future.**
  `workflow_dispatch` is only offered for workflows that already exist on the
  **default branch**, so a brand-new workflow file cannot be dispatched against
  its own PR head — "run it on the PR, then merge" is not achievable as stated.
  This branch used a temporary branch-scoped `push` trigger to get a green run
  before merge; it has been removed now that the job runs on `pull_request`.

---

## 9. Remaining Windows verification

The automated suite is covered — it passes on `windows-latest` in CI (§1). What
remains needs a human at a Windows desktop, or a physical machine rather than a
CI VM. **None of the following has been executed.**

To reproduce the automated run locally on Windows 10/11 x64:

```powershell
npm install
npm run configure
npm run fetch:bundles
npm run windows:install
node desktop/electron/test/smoke.mjs   # direct launch + raw main-process output
npm run test:windows                   # expect the §8 table
node desktop/electron/test/measure.mjs --with-python
```

Then confirm by hand:

1. **Windows path containment against the live handler** — that
   `app://scirepl/..%5C..%5Cpackage.json` (encoded backslash) is refused.
   `policy.unit.test.mjs` covers drive-letter and backslash cases on Windows,
   but this specific encoded form is only asserted against `resolveRequestPath`,
   not the running protocol handler.
2. **Startup, size and memory re-measured on Windows** — §6 is Linux-only, and
   the GPU figure in particular will differ with real hardware acceleration.
   A CI VM is not a fair sample either; use a real machine.
3. **Native Save dialog.** The shell installs no `will-download` handler, so
   Electron shows its default Save dialog. Confirm each export format
   (HTML, Markdown, LaTeX, DOCX, PDF, `.srwb`, `.ipynb`) reaches disk with a
   correct default filename and extension.
4. **PDF export** — the browser `window.print()` path; the Capacitor
   `PdfGenerator` plugin is absent here.
5. **External links** open in the default Windows browser and focus it.
6. **Display scaling** (125/150/200%), high contrast, keyboard-only navigation,
   and a screen reader (Narrator/NVDA).
7. **Sleep/resume** with a kernel loaded; **shutdown while a kernel is running**.
8. **Long paths / non-ASCII usernames** — `userData` under a profile such as
   `C:\Users\Ünïcode\AppData\Roaming\SciREPL-Free-Electron`.
9. **Second-instance behaviour — the focus half.** That a losing instance exits
   promptly rather than hanging is verified (§1.1); that it *focuses the
   existing window* is not, and needs a visible desktop.
10. **arm64**, if offered.

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
| 3 | **No human has used it on Windows.** The automated suite passes on windows-latest, but display scaling, native dialogs, accessibility and sleep/resume are untested. | Medium | §9 must be done before Phase 2. |
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
| IndexedDB and SharedVFS survive | ✅ **[verified]** across a real restart, on Linux and Windows CI; across an *MSIX update* is untested |
| The same web bundle still runs under Capacitor without a fork | ✅ `www/` unchanged; existing browser tests pass |
| Offline assets fit practical Store limits | ⚠️ measured on Linux (108 MB + runtime); Windows/MSIX figures still to be captured (§9) |
| Expected Windows demand justifies the cost | ❌ out of scope — a product judgement, not a spike output |

**Recommendation: proceed to Phase 1**, starting with the realm-boundary decision
(§11.1) rather than with a broad platform-interface refactor. Do not proceed to
MSIX, Store submission or Pro work until §9 has been executed on real Windows.

---

## 13. Phase 0.5: portable Windows preview

Phase 0 proved the shell works. Phase 0.5 makes it possible to *look at it* on
Windows without a toolchain — the gap between "CI says it passes" and "someone
can actually try it".

Two deliverables, both Free-only, neither a release. Running instructions:
[`WINDOWS_PREVIEW.md`](WINDOWS_PREVIEW.md).

### One-command developer launch

`npm run dev:windows` (`desktop/electron/scripts/dev-windows.mjs`) checks Node
(>= 22) and the platform, configures the Free profile, fetches the bundled
runtimes, installs the isolated Electron dependencies, provisions the Electron
binary, and launches. Completed steps are detected and skipped, so it doubles as
the everyday start command. It installs nothing system-wide and needs no
elevation.

Two failure modes it reports rather than stumbles into: a Node older than 22,
and a checkout on a UNC path (`\\wsl.localhost\…`), which Windows Node tooling
and Electron handle unreliably. On a non-Windows host it warns instead of
failing — running under WSLg is a useful look at the UI, but it launches the
*Linux* Electron build and cannot substitute for Windows verification.

### Unsigned portable preview

`npm run package:windows` (`packaging/build-portable.mjs`, `@electron/packager`
pinned to `20.2.0`) produces a directory containing a directly launchable
`SciREPL.exe`. The `Windows portable preview` workflow — `workflow_dispatch`
only — builds it on `windows-latest`, verifies it, and uploads it as
`SciREPL-windows-x64-preview-<sha>`. The artifact GitHub produces *is* the
distributable ZIP: download, extract, run. Measured: **~472 MB unpacked**
(win32-x64).

**The build is unsigned, so SmartScreen warns on first run.** That is expected
for an unsigned binary and is documented for testers rather than papered over.
Signing belongs with Store packaging and is out of scope.

#### Packaged layout, and why it needed a code change

Phase 0's `main.js` derived everything from `__dirname`:

```js
const REPO_ROOT = path.resolve(__dirname, '..', '..');   // wrong once packaged
const WWW_ROOT  = path.join(REPO_ROOT, 'www');
```

In a packaged app `__dirname` is inside `resources/app.asar` and there is no
repository above it, so both `www/` and the version lookup would have broken —
silently, as a window that opens and 404s everything. `paths.js` now resolves
both layouts as pure functions, unit-tested rather than only discoverable by
launching a build:

```
SciREPL-win32-x64/
  SciREPL.exe
  resources/
    app.asar          the shell (main, protocol, security, preload, ipc, paths)
    www/              the application tree — deliberately OUTSIDE the asar
    build-info.json   version, profile, commit, timestamp
```

`www/` stays outside the asar because protocol.js serves it with
`net.fetch(file://…)`, which reads real files and does not go through Electron's
asar layer. Version and profile come from `build-info.json`, so both survive the
packaged layout — asserted by the `packaged` suite, not assumed.

### A finding the packaged tests caught

The first build shipped **`www/pro/`** inside the artifact: the Pro landing
page, its privacy and testing pages, and ~800 kB of Pro branding (app icon and
Play Store feature graphic). Those files are in the repository so GitHub Pages
can serve them — nothing in `www/js` links to them and the shell never navigates
there — but a Free preview must not carry Pro assets to a tester.

They are now filtered out of the staged copy at package time and their absence
is asserted twice: once by the build script, once by `packaged.test.mjs`.

**The website is unaffected.** `www/pro/**` remains tracked in git and
`deploy-pages.yml` is unchanged, so the Pro landing page still publishes exactly
as before. The filter applies only to the copy staged into the `.exe`.

### Packaged verification **[verified]**

`packaged.test.mjs` — 56 assertions, 0 failures — drives the real packaged
binary with `SCIREPL_WWW` deliberately unset, so the app must find its own
bundled tree or fail:

| Check | Result |
| --- | --- |
| loads `app://scirepl/index.html` from its own resources | ✅ |
| version and build profile resolve in the packaged layout | ✅ |
| Node unreachable from a notebook cell (same `probes/security.mjs` as the dev shell) | ✅ |
| `nodeIntegration` off, `contextIsolation`/`sandbox` on, no escape hatch | ✅ |
| off-origin navigation and `window.open` refused | ✅ |
| bundled kernels run — JavaScript, Bash, ClojureScript, SWI-Prolog, Python | ✅ |
| SharedVFS + localStorage survive a packaged-app restart | ✅ |
| no Pro material, no bundled R, no build machinery in the artifact | ✅ |

Reuse is the point: the boundary is defined once in `probes/security.mjs` and
applied to both the development shell and the package. A packaged build that
quietly regained Node access while a separate copy of the assertions kept
passing is the failure this arrangement is designed to prevent.

Verified on Linux (`SciREPL-linux-x64`) locally and on `windows-latest` in the
preview workflow. The Windows executable cannot be executed from this
development environment, so the win32 build is verified by CI, not by hand here.

### Still out of scope

MSIX, Store submission, code signing, auto-update, entitlement or licence
checking, Pro anything. Unchanged from §9: the manual Windows checks — display
scaling, native dialogs, accessibility, sleep/resume, non-ASCII profile paths —
are exactly what the portable preview now makes it practical for a human to do.
