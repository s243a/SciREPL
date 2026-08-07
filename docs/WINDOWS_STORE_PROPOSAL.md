# Proposal: SciREPL Free and Pro for the Microsoft Store

## Recommendation

Keep **Capacitor for Android** and the existing **Free PWA**, and add **Electron as a Windows-only shell** around the existing web application. Package the Windows desktop applications for the Microsoft Store, preferably as MSIX. The Pro application must never be published as a hosted PWA.

Do not rewrite SciREPL in React Native Windows. Consider Tauri only after an Electron prototype establishes the required browser and WASM behavior and application size becomes an important problem.

This design preserves one SciREPL application core:

```text
Shared HTML/CSS/JavaScript, kernels, workbooks, formats and tests
                 |
        shared platform interface
          /                    \
Capacitor adapter          Electron adapter
Android Free/Pro           Windows Free/Pro
```

Capacitor and Electron are complementary here. Capacitor remains the Android container; it does not need to become the Windows framework.

## Why Electron fits SciREPL

SciREPL is already a substantial browser application. It relies on:

- HTML and direct DOM rendering;
- web workers and several WebAssembly runtimes;
- IndexedDB and service-worker/cache behavior;
- browser printing and downloads;
- dynamically loaded language kernels;
- a shared virtual filesystem implemented in JavaScript.

Electron embeds Chromium, so it is the least disruptive desktop target and gives the application a predictable browser engine. It also supplies the desktop capabilities SciREPL needs: native open/save dialogs, local file access, external-link handling, window management, and a route to Windows installers and Store packaging.

Its costs are a relatively large download, an additional Chromium runtime to update, and a security boundary that must be designed carefully. Those costs are preferable to maintaining a second UI implementation.

## Alternatives considered

### Existing Free PWA

SciREPL Free already ships as a PWA through GitHub Releases. It is therefore the existing low-cost way to test Windows and browser demand; it is not a new deliverable proposed here. Microsoft also supports publishing a PWA in the Store if that later offers useful discovery.

It is appropriate for the **Free edition**, but must not be used for Pro:

- it remains coupled to a hosted origin and browser storage rules;
- local file integration is weaker and less predictable;
- very large offline runtimes are awkward to manage through web caches;
- hosting the Pro application would make its application bundle trivially retrievable and redistributable;
- browser or PWA lifecycle changes are outside the application's control.

The Free PWA should remain on the shared browser adapter. Windows Pro should be built only as the packaged desktop application. A future Windows Free package may reuse the same Electron shell, but it is optional unless native file integration or Store discovery justifies it.

### Tauri

Tauri would produce a much smaller application by using Windows WebView2 instead of bundling Chromium. It is technically plausible because Edge/WebView2 is Chromium-based.

It is not the first recommendation because SciREPL pushes browser behavior unusually hard: multiple WASM runtimes, workers, large caches, downloadable kernels, print/export, and custom virtual filesystems. Tauri would also introduce Rust and a different plugin/security ecosystem. A short Tauri spike can be performed later against the same acceptance suite if Electron's package size proves unacceptable.

### React Native Windows

React Native Windows renders native controls rather than hosting an existing DOM application. Adopting it would require rewriting most of SciREPL's interface and replacing browser-specific behavior. Existing Capacitor plugins would not carry over, and the result would have two UI implementations with independent bugs and accessibility behavior.

React Native Windows would be reasonable for a new native-first product, not for this application.

### A custom WinUI/WebView2 shell

A small WinUI 3 application hosting WebView2 could be lean and integrate deeply with Windows. It would also make the project responsible for a bespoke C#/C++ bridge, navigation policy, packaging, and WebView lifecycle. That is more platform code than the project currently needs. It remains a future optimization if Electron becomes limiting.

## Proposed repository architecture

### Preserve a platform-neutral application core

Move platform calls behind a narrow asynchronous interface, for example:

- `saveFile(name, bytes, mediaType)`;
- `openFile(filters)`;
- `shareFile(file)`;
- `openExternal(url)`;
- `printOrExportPdf(options)`;
- `getAppInfo()`;
- `getDistributionInfo()`;
- optional durable-directory and cache-management operations.

Provide three adapters:

- browser/PWA using standard web APIs and downloads;
- Android using Capacitor plugins;
- Windows using an Electron preload bridge.

Application and kernel code must depend on this interface, never on Electron or Capacitor directly. Existing direct `window.Capacitor` checks should migrate incrementally to the interface.

### Add a thin Windows shell

Suggested structure:

```text
desktop/
  electron/
    main.js
    preload.js
    protocol.js
    packaging/
      free/
      pro/
www/
  ...shared application...
scripts/
  configure-build.mjs
```

The shell should serve bundled assets through a stable secure application protocol rather than treating the application as arbitrary `file://` content. A stable origin matters for workers, IndexedDB, cache identity, and relative resource resolution.

### Use build profiles, not divergent application forks

Define explicit profiles such as:

- `windows-free`;
- `windows-pro`;
- existing Android Free and Pro profiles.

Profiles may select bundled runtimes, branding, product identifiers, entitlement behavior, and optional features. They should not contain independent copies of the application code.

Ideally, Free and Pro release from the same tested source revision. If separate repositories remain necessary, generate or synchronize the shared tree and fail CI when the common files drift.

## Free and Pro Store identities

Create two distinct Microsoft Store products with separate package identities, names, icons, descriptions, and upgrade policy:

- **SciREPL** — free edition;
- **SciREPL Pro** — paid or otherwise commercially distributed edition.

Decide before reserving names whether both may be installed side by side. Side-by-side installation is simplest when each has its own package identity and data directory. If Pro is meant to replace Free, design an explicit import/migration flow rather than sharing undocumented storage locations.

Do not assume Store packaging hides Pro source. Electron application assets can be inspected even when stored in an archive, and a determined purchaser can copy or modify a desktop application. Packaging is still substantially less casual to share than a public PWA URL, but it is not DRM by itself.

Pro should use the Microsoft Store's application license as its entitlement boundary. A small native Windows bridge can query `StoreContext.GetAppLicenseAsync()` and expose only a narrow result to the Electron main process. Microsoft documents that the returned license includes whether it is active and that an offline call uses a cached license. The application should define a reasonable offline grace/failure policy and test purchase, reinstall, refund/revocation, account change, and offline startup.

Keep entitlement checking outside the web renderer and do not ship a bypass such as a build-time `isPro: true` value as the sole gate. Even so, the goal should be to deter casual redistribution and enforce normal Store licensing—not to claim unbreakable copy protection.

For a first release, separate Store products with one-time pricing are simpler than introducing in-app purchases or subscriptions. Entitlement restoration and offline behavior must be tested before relying on Store commerce APIs.

## Windows-specific product behavior

The first Windows version should feel like a desktop application without redesigning the core:

- use native Open and Save As dialogs;
- support drag-and-drop import;
- associate supported workbook formats only after import/export behavior is stable;
- open external URLs in the system browser;
- provide normal keyboard shortcuts and window close/recovery behavior;
- preserve notebooks and SharedVFS data across application updates;
- provide an explicit data export and reset path;
- test display scaling, high contrast, keyboard-only use, and screen readers;
- handle sleep/resume and application shutdown while a kernel is active.

Windows should initially keep the same sandboxed browser/WASM kernels. Do not expose arbitrary native shell execution simply because Electron has Node.js available.

## Security requirements

Electron must be configured as a constrained host:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- renderer sandbox enabled;
- a minimal, typed preload API;
- explicit IPC method and argument allowlists;
- a restrictive Content Security Policy;
- deny unexpected navigation and new windows;
- open approved external links through the operating system;
- validate paths, extensions, sizes, and URLs in the main process;
- never expose raw filesystem or process APIs to notebook code;
- keep Electron and Chromium on a supported release line.

The threat model must distinguish SciREPL's own UI code from user-authored notebook code and downloaded packages. User code must not be able to reach Electron IPC or Node capabilities.

## Packaging and Microsoft Store path

Microsoft currently recommends MSIX for Store submission. It provides Store-managed signing, hosting, updates, staged rollout, and clean uninstall. The work requires a Windows build environment, Partner Center account, reserved product names, package identities, privacy/support URLs, screenshots, age/content declarations, and certification testing.

Recommended pipeline:

1. Produce signed-off Free and Pro web bundles from explicit profiles.
2. Package each in its Electron shell on a Windows CI runner.
3. Create MSIX/MSIXBundle artifacts with the Store-assigned identities.
4. Run unit, browser, Electron integration, install/update, and Windows App Certification tests.
5. Upload first to private flighting/test audiences.
6. Verify clean install, upgrade, rollback expectations, persistence, offline startup, and uninstall.
7. Submit Free first, then Pro after the shared shell has survived certification and real use.

An MSI/EXE Store listing is also possible, but it requires publisher signing and leaves more update responsibility with the project. MSIX is the better default.

## Testing strategy

Retain the current browser tests as the shared behavioral suite. Add:

- tests for every platform-interface adapter;
- Electron launch and preload-boundary tests;
- one representative execution test for every bundled kernel;
- online, offline, first-download, and corrupt-cache cases;
- import/export tests using actual Windows dialogs where feasible;
- persistence tests across an MSIX update;
- Free/Pro artifact-content assertions;
- security tests proving notebook content cannot access Node or Electron IPC;
- x64 and arm64 validation if both architectures are offered.

The release gate should compare Android and Windows behavior for shared formats and kernels, while allowing deliberate platform differences in file dialogs, sharing, and printing.

## Maintainability impact

With the shared interface and a thin shell, ongoing maintenance should be **moderate rather than multiplicative**.

Shared work:

- notebook UI and formats;
- kernel implementations and WASM assets;
- package catalog and workbooks;
- most tests, privacy inventory, and build profiles.

Platform-specific work:

- Capacitor and Android SDK upgrades;
- Electron/Chromium upgrades and Windows packaging;
- file/share/PDF adapters;
- Store metadata, signing identity, and certification;
- a small number of OS-specific lifecycle tests.

The largest maintainability risk is not having two shells. It is allowing platform checks and Free/Pro conditionals to spread throughout the core. The platform interface and profile-generated configuration should be enforced early.

## Suggested phases

### Phase 0: Windows Pro feasibility spike

- Treat the existing Free PWA as the baseline browser implementation; do not create or deploy a Pro PWA.
- Build a minimal local Electron Pro shell with no native privileges exposed and no public hosted Pro bundle.
- Exercise every kernel, worker, WASM runtime, persistence, import/export path, and offline mode.
- Measure startup time, memory, package size, and Pro bundled-runtime size.
- Prototype Store-license retrieval behind the native bridge using Store test/flight mechanisms.
- Stop if a required runtime cannot operate safely under the packaged origin.

### Phase 1: Shared platform boundary

- Introduce the platform interface and browser/Capacitor adapters.
- Remove direct Capacitor references from application features.
- Add cross-adapter contract tests.

This work improves the Android codebase even if Windows packaging is later deferred.

### Phase 2: Windows shell preview using Free content

- Implement the Electron adapter and Windows CI.
- Add native file dialogs, secure external links, persistence, and packaging.
- Distribute privately or through Store flighting; do not publish a Pro web build.
- Use Free content in the shell to discover certification and compatibility problems without exposing Pro assets.

### Phase 3: Windows Pro

- Add the Pro profile, branding, product identity, bundled runtimes, and Store-license enforcement.
- Test Free-to-Pro data migration or side-by-side import.
- Submit only after the shared Windows shell is stable.

### Phase 4: Optimization

- Consider Tauri/WebView2 only if Electron's measured size or memory cost materially harms adoption.
- Add arm64 when the dependency and runtime matrix is verified.
- Keep Pro Store-only unless a separate licensed direct-download system is deliberately designed; do not distribute Pro through a public PWA or WinGet package.

## Decision gates

Proceed beyond the feasibility spike only if:

- all important WASM kernels work in the packaged Windows origin;
- offline Pro assets fit practical Store/package limits and update behavior;
- notebook code cannot cross the native bridge;
- IndexedDB and SharedVFS survive application updates;
- the same web bundle can still run under Android Capacitor without platform forks;
- expected Windows demand justifies maintaining Electron and Store certification.

## Bottom line

The Windows edition does not require abandoning Capacitor or rewriting SciREPL. Keep Capacitor for Android and the existing PWA for Free; use Electron plus MSIX and Store entitlement for Windows Pro. Validate the shell with Free content before placing Pro assets inside it. Never deploy Pro as a hosted PWA, and treat a native React rewrite as out of scope.

## Current references

- [Microsoft Store: get started](https://learn.microsoft.com/en-us/windows/apps/publish/get-started)
- [Microsoft: choose a Windows distribution path](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path)
- [Microsoft: packaging overview](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/packaging/)
- [Microsoft: retrieve application and add-on license information](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-license-info-for-apps-and-add-ons)
- [Electron documentation](https://www.electronjs.org/docs/latest/)
- [Electron distribution overview](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
- [React Native Windows: getting started](https://microsoft.github.io/react-native-windows/docs/getting-started/)
- [Capacitor documentation](https://capacitorjs.com/docs)
