# SciREPL — Windows/Electron shell

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

**Status: Free edition only.** Phase 0 established feasibility
([`docs/WINDOWS_ELECTRON_SPIKE.md`](../../docs/WINDOWS_ELECTRON_SPIKE.md));
Phase 0.5 added a one-command developer launch and an unsigned **portable
preview** so the app can be evaluated on Windows without a toolchain.

There is still no Microsoft Store integration, no MSIX, no entitlement logic and
no signing — deliberately. The preview is not a release. To run it, see
[`docs/WINDOWS_PREVIEW.md`](../../docs/WINDOWS_PREVIEW.md).

## Commands

Run from the repository root:

```bash
npm run dev:windows        # one command: check, configure, fetch, install, launch
npm run setup:windows      # the same, without launching
npm run package:windows    # build the unsigned portable preview
npm run test:windows       # all shell tests (needs Electron + a display)
npm run test:windows:unit  # policy unit tests only (no display, no Electron binary)
npm run windows:install    # just the Electron install step
```

`dev:windows` is the entry point for a fresh checkout. It verifies Node (>= 22),
reports the platform, configures the Free profile, fetches the bundled runtimes,
installs the isolated Electron dependencies, provisions the Electron binary, and
launches — skipping whatever is already done, so it is also the everyday "start
the app" command. It installs nothing system-wide and needs no elevation.

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
| `SCIREPL_RUNTIME_CACHE=0` | disable the on-disk runtime cache and fall back to Chromium's own heuristic HTTP cache |
| `SCIREPL_RUNTIME_CACHE_DEBUG=1` | log every cache decision to `userData/runtime-cache-debug.log` |
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

The official `https://s243a.github.io/SciREPL-Catalog/` release channel is a
data-only exception: its origin appears in `connect-src`, but not in
`script-src`, `style-src`, `img-src`, or `font-src`. Free Electron v1 does not
grant arbitrary HTTPS mirrors the same capability. A custom mirror works only
after its exact origin is reviewed, added to `CONNECT_ONLY_ORIGINS`, and shipped
in a new build; see
[`docs/CATALOG_SOURCES.md`](../../docs/CATALOG_SOURCES.md).

### External support link

Help uses an ordinary `target="_blank"` HTTPS link to Ko-fi. No Ko-fi script is
loaded in the renderer and no Ko-fi origin is added to the CSP or runtime
allowlist. The Electron navigation policy opens the link in the user's system
browser, matching the other external documentation links.

## Files

| File | Role |
| --- | --- |
| `main.js` | lifecycle, window creation, single-instance lock, storage flush on quit |
| `protocol.js` | the `app://` scheme, MIME types, path containment, CSP |
| `security.js` | navigation / window-open / permission policy |
| `preload.js` | the entire renderer-visible surface (two read-only calls plus a bundled-locale selector) |
| `ipc.js` | the canonical IPC allowlist, owned by the main process |
| `native-i18n.js` | host-side plain-text catalogue allowlist, English fallback, placeholder and RTL handling |
| `menu.js` | localized native menu plus runtime-cache and About dialogs |
| `runtime-cache.js` | persistent on-disk cache for CDN runtimes, in `userData` — replaces the service worker's `CDN_CACHE`, which cannot work under `app://` |
| `paths.js` | resolves `www/` and build metadata in **both** layouts (development and packaged) |
| `scripts/dev-windows.mjs` | the one-command setup + launch |
| `packaging/build-portable.mjs` | builds the unsigned portable preview |
| `test/` | see below |

## Tests

| Suite | Needs Electron? | Covers |
| --- | --- | --- |
| `policy.unit.test.mjs` | no | path containment, external-URL policy, IPC allowlist, CSP shape |
| `native-i18n.test.mjs` | no | native catalogue completeness/safety, menu/dialog localization, RTL literals |
| `shell-launch.test.mjs` | yes | origin, secure context, relative assets, WASM MIME + streaming, reload |
| `security.test.mjs` | yes | Node unreachable from notebook code, preload surface, navigation policy, webPreferences |
| `artifact-boundary.test.mjs` | yes | Free-only content; no bundled R, no entitlement code |
| `download.test.mjs` | yes | blob URLs and the `<a download>` path under `app://` |
| `persistence.test.mjs` | yes | IndexedDB / SharedVFS / localStorage across a real restart |
| `kernels.test.mjs` | yes | one execution per kernel + SharedVFS; optional browser A/B |
| `offline.test.mjs` | yes | bundled kernels with the network cut; CDN kernels fail cleanly |
| `packaged.test.mjs` | yes, **and a built package** | the packaged app: own `www/`, security boundary, kernels, restart persistence, no Pro material |
| `runtime-cache.test.mjs` | yes, **and network** | Lua and R still run offline after a restart; a cold profile still fails |

`packaged.test.mjs` is opt-in — it needs an artifact most runs do not have:

```bash
npm run package:windows
node desktop/electron/test/run-all.mjs packaged   # or: run-all.mjs --packaged
```

Two tools sit alongside the suites and are run explicitly, not by `run-all`:

```bash
node desktop/electron/test/smoke.mjs            # launch diagnostic
node desktop/electron/test/measure.mjs --with-python   # startup/size/memory
```

`smoke.mjs` launches the shell **directly, without Playwright**, and prints the
main process's own stdout/stderr — Playwright reports any launch failure as a
bare timeout with no output, which is close to undiagnosable on a CI machine.
On failure it retries once with `--disable-gpu --no-sandbox
--disable-software-rasterizer`, so one run distinguishes a broken shell from a
host that needs GPU flags. Reach for it first whenever the shell will not start.

The probes under `test/probes/` are the reason these suites do not drift apart:

- `probes/kernels.mjs` is driven by the Electron runner, the Chromium baseline
  runner **and** the packaged suite, so a difference in results is a real
  platform difference rather than two divergent test suites.
- `probes/security.mjs` holds the renderer/native boundary checks and is applied
  identically to the development shell and the packaged build. That is
  deliberate: a packaged app quietly regaining Node access while a separate copy
  of the assertions kept passing is exactly the failure worth designing out.

Export *correctness* is not re-tested here — the existing browser tests in the
repository root already cover it and that logic is platform-independent.
