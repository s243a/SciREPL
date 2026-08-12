# SciREPL on Windows — preview builds

Two ways to run the Free application on Windows. Neither is a release, and
neither is a Microsoft Store package.

| | You need | Best for |
| --- | --- | --- |
| [Portable preview](#1-portable-preview-no-tools-needed) | nothing | trying the app, sharing it with a tester |
| [Developer launch](#2-developer-launch) | Node.js 22+, Git | changing the code |

---

## 1. Portable preview (no tools needed)

A ZIP with a `SciREPL.exe` you can double-click. No Node, no Git, no web server,
no installer, nothing written to the registry.

The `win32-x64` build has been run on native Windows 11 and passes the full
packaged suite (56 assertions): it launches, serves `app://scirepl/index.html`
from its own bundled `resources\www`, keeps notebook code away from Node,
runs the bundled kernels, and keeps notebook/SharedVFS state across a restart.

### Get it

1. Open the repository's **Actions** tab.
2. Choose the **Windows portable preview** workflow.
3. **Run workflow** → pick the branch → **Run workflow**. It takes roughly
   15–25 minutes (it downloads Electron and ~104 MB of kernel runtimes).
4. When it finishes, download the artifact named
   `SciREPL-windows-x64-preview-<commit>` from the run summary.

### Run it

1. Extract the ZIP to a **local** folder — `C:\Users\<you>\SciREPL-preview` is
   fine. Do not run it from inside the ZIP viewer, from a network share, or from
   a `\\wsl.localhost\…` path.
2. Run **`SciREPL.exe`**.

### The SmartScreen warning is expected

The preview is **unsigned**, so on first run Windows shows:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.

Choose **More info → Run anyway**.

This happens to every unsigned application and says nothing about whether the
build is sound — SmartScreen is reporting the absence of a code-signing
certificate and reputation history, not a detected problem. Signing is
deliberately out of scope for a preview; it belongs with Store packaging.

Only run a build you produced yourself, or one whose commit you can verify from
the workflow run that made it.

### What works, and what doesn't

Bundled and fully offline:

- **JavaScript**, **Bash/Brush**, **ClojureScript/Scittle**, **SWI-Prolog**,
  **Python/Pyodide** (with numpy, pandas, sympy)

Needs a network connection the **first** time, then works offline:

- **Lua/Fengari** and **R/webR** are downloaded from a CDN on first use and then
  kept in the application's own data directory
  (`%APPDATA%\SciREPL-Free-Electron\runtime-cache`). After that they work with
  no network at all, and they survive restarts. R is ~23 MB cached; Lua ~0.2 MB.

If you would rather not be asked before each runtime download, turn on
**Settings → Runtime Downloads → "Auto-download runtimes (skip confirmation)"**.
The choice is saved, and it works the same here as on Android and the PWA.

Leave it off and the shell will ask each session, even when the files then load
instantly from cache — it decides whether to ask by checking the service-worker
cache, which is empty here. That one checkbox is the whole difference; see
[`WINDOWS_ELECTRON_SPIKE.md`](WINDOWS_ELECTRON_SPIKE.md) §5.

The privacy notice is separate and is shown **once** — accepting it is
remembered, and it can be revoked from Settings.

The Ko-fi support entry in Help is a plain external HTTPS link. It loads no
third-party script in the app and opens in the system browser under the same
external-navigation policy as documentation links.

Not present at all: any Pro content, Microsoft Store integration, licence or
entitlement checking, or in-app purchase.

### Where your data goes

`%APPDATA%\SciREPL-Free-Electron` — notebooks and settings in `localStorage`,
SharedVFS contents in IndexedDB. Deleting that folder resets the application.
Uninstalling is deleting the extracted folder; nothing else is installed.

The shell requests **persistent storage** for its origin, so Chromium will not
discard your notebooks to reclaim disk space. (Android already gets this by
having a private app data directory; a browser PWA does not, which is one of the
few durable advantages the desktop build has.)

---

## 2. Developer launch

For changing the shell or the application.

### Prerequisites

- **Node.js 22 or newer** for **Windows** — <https://nodejs.org/>. After
  installing, close and reopen your terminal so `PATH` is picked up.
- **Git for Windows**, or download the repository as a ZIP.
- The repository on a **local** path such as
  `C:\Users\<you>\Projects\SciREPL`. Not `\\wsl.localhost\…`: Windows Node
  tooling and Electron do not handle UNC paths reliably, and the setup script
  stops with an explanation if it finds one.
- An ordinary, **non-administrator** PowerShell window. Nothing here needs
  elevation, and nothing is installed system-wide.

### One command

```powershell
cd C:\Users\<you>\Projects\SciREPL
npm install
npm run dev:windows
```

`dev:windows` does the whole first-run sequence and then launches the shell:

1. checks Node ≥ 22 and reports the platform;
2. configures the Free build profile;
3. fetches the bundled runtimes (~100 MB, first run only);
4. installs the isolated Electron dependencies under `desktop/electron/`;
5. downloads the Electron binary (~220 MB, first run only);
6. launches SciREPL.

Steps already done are detected and skipped, so re-running it is cheap — it
doubles as "just start the app". Close the window, or press `Ctrl+C`, to stop.

```powershell
npm run setup:windows   # same, but stop before launching
npm run dev:windows -- --force   # redo every step
```

### Building a portable preview locally

```powershell
npm run package:windows
```

Output lands in `desktop/electron/out/SciREPL-win32-x64/`. Verify it with:

```powershell
node desktop/electron/test/run-all.mjs packaged
```

### When it will not start

```powershell
node desktop/electron/test/smoke.mjs
```

This launches the shell directly, without Playwright, and prints the main
process's own output — Playwright reports a failed launch as a bare timeout with
nothing useful in it. If the default launch fails it retries once with GPU and
sandbox flags, which distinguishes a broken build from a host that needs them.

---

## Building a preview from WSL

You do not need Windows Node to *produce* a preview — `@electron/packager`
cross-builds, so a Windows package can be built from WSL and then run natively:

```bash
cd ~/Projects/SciREPL          # a checkout with the branch
nvm use 22
npm install
npm run windows:install
npm run package:windows        # produces desktop/electron/out/SciREPL-win32-x64/

cp -r desktop/electron/out/SciREPL-win32-x64 /mnt/c/Users/<you>/SciREPL-preview
```

Then run `C:\Users\<you>\SciREPL-preview\SciREPL.exe` from Windows. Copy it
to a real Windows path first — running from `\\wsl.localhost\…` is unreliable.

This is a genuine native Windows build, unlike the WSLg launch below.

## Running through WSL

If you are in WSL with WSLg, `npm run dev:windows` will run and a window will
appear. Useful for a quick look at the interface.

It is **not** a Windows test: you are launching the Linux Electron build
displayed on a Windows desktop, not `SciREPL.exe`. Windows-specific behaviour —
native dialogs, SmartScreen, display scaling, path handling, accessibility — is
not exercised. The setup script prints this warning when it detects a non-Windows
platform. For anything that matters, use the portable preview or a native
developer launch.
