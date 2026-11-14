# Free MSIX package for the Microsoft Store pilot

Status, November 14, 2026: a Free x64 MSIX builds from the tested Store-channel
tree. It has **not** yet been installed, upgraded or run through WACK. No
Partner Center account, reserved name, signing identity or submission exists.
The broader sequence is in WINDOWS_STORE_PILOT.md (PR #134).

## Build

On Windows, from the repository root, with Node 22 and the Windows SDK
(MakeAppx.exe; found under `C:\Program Files (x86)\Windows Kits\10\bin`, or set
`SCIREPL_MAKEAPPX`):

```bat
npm install
npm run configure
npm run fetch:bundles
npm run verify:bundles
npm run windows:install
npm run package:windows -- --channel store
node desktop\electron\test\run-all.mjs packaged
npm run package:windows:msix
```

`fetch:bundles` is required: the portable builder stops if the bundled Pyodide,
SWI-Prolog or Scittle runtimes are missing.

`--channel store` builds the same tree as the portable preview with Store
metadata: `build-info.json` channel `store` and an executable description
without "unsigned preview". The packaged tests run on that tree, and
`package:windows:msix` copies it as built, adding only `AppxManifest.xml` and
three logos rendered from `www/icons/icon-512.png`. Before packing it repeats
the Free-boundary checks (no `www/pro`, no `vendor/webr`, non-Pro profile),
requires channel `store`, and refuses a tree built from a different commit than
`HEAD`. Output: `desktop/electron/out/SciREPL-<version>.0-x64[-local-test].msix`
(about 200 MB for 1.5.0).

### Identity

| Variable | Partner Center source |
| --- | --- |
| `SCIREPL_MSIX_IDENTITY_NAME` | Product identity → Package/Identity/Name |
| `SCIREPL_MSIX_PUBLISHER` | Product identity → Package/Identity/Publisher (`CN=…`) |
| `SCIREPL_MSIX_PUBLISHER_DISPLAY_NAME` | Product identity → Package/Properties/PublisherDisplayName |

Set all three or none. With none, the package uses the placeholder
`SciREPL.FreePilot.LocalTest` / `CN=SciREPL Local Test` and the file name ends
`-local-test`: it is for a test-signed install on a developer machine only.
The manifest `DisplayName` is fixed as "SciREPL"; confirm it matches the name
reserved in Partner Center.

### Manifest decisions

- Version is `Major.Minor.Patch.0` from `package.json`. The Store reserves the
  fourth part and rejects major version 0; pre-release suffixes are refused.
- Full-trust desktop entry point (`Windows.FullTrustApplication`), one
  capability: `runFullTrust`. It is a restricted capability: the submission
  must explain why it is needed (a packaged Electron/Win32 app cannot start
  without it). Network access needs no capability for a full-trust process.
- `Windows.Desktop`, minimum **10.0.18362.0 (Windows 10 1903)**, x64 only.
  1903 is where AppData virtualization took its current form (below);
  requiring it leaves one behaviour to test.
- Resource language `en-us` only for now. Manifest languages become the Store
  listing languages; each added one needs a reviewed Store description.
- Logos are the documented minimum (StoreLogo 50, Square44x44, Square150x150
  at 100% scale). Without `targetsize-*_altform-unplated` variants, which need
  a `resources.pri` from MakePri, Windows shows the icon small on a backplate
  in the taskbar and Start. Follow-up, along with a Windows `.ico` for the
  executable (it still has the default Electron icon).
- No auto-updater: the Store delivers updates.
- Unit tests: `desktop/electron/test/msix-manifest.unit.test.mjs`
  (`npm run test:windows:unit`).

## Data location when packaged

On Windows 10 1903 and later, MSIX
[file-system virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)
redirects **new** files and folders in `%APPDATA%` to the package's private
location, but files that **already exist** in the real `%APPDATA%` are read and
modified in place.

The portable preview keeps its profile in `%APPDATA%\SciREPL-Free-Electron`.
If the Store build used the same name, it would open a preview user's existing
profile, write new files to a separate private copy (a split profile), and
uninstalling would leave the preview's notebooks behind. So the Store build
(`process.windowsStore`) uses its own folder, `SciREPL-Free-Store`
(`desktop/electron/paths.js`, `resolveUserDataDir`). That name never exists in
the real `%APPDATA%`, so it is created new and is private to the package:
notebooks, settings, IndexedDB/SharedVFS and the runtime cache all live there.
The exact on-disk location (expected under
`%LOCALAPPDATA%\Packages\<PackageFamilyName>\`) is to be confirmed on an
installed package.

Consequences:

- The Store build does not see a portable-preview profile. Preview users move
  notebooks by export and import; nothing is imported silently.
- **Uninstalling removes the Store build's data, including notebooks.** Users
  need to export first. Updates keep it.
- Pro needs the same isolation, with its own folder and package identity. A
  private profile and the ACL-protected install folder make Pro harder to copy
  casually, but Electron app files remain inspectable, so this is not DRM.

## Local install test (owner's machine; each step needs the owner's OK)

These change the machine's certificate store and installed apps, so the owner
runs them. Run **all steps in one PowerShell window opened as administrator**,
so `$cert` and the paths carry between steps.

```powershell
$msix = 'C:\scirepl-store-pilot\repo\desktop\electron\out\SciREPL-1.5.0.0-x64-local-test.msix'
$sdk  = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\signtool.exe' |
        Sort-Object FullName -Descending | Select-Object -First 1

# 1. Test certificate whose subject equals the placeholder publisher.
$cert = New-SelfSignedCertificate -Type Custom -Subject "CN=SciREPL Local Test" `
  -KeyUsage DigitalSignature -FriendlyName "SciREPL MSIX local test" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")

# 2. Sign the package.
& $sdk.FullName sign /fd SHA256 /sha1 $cert.Thumbprint $msix

# 3. Trust the certificate for installs.
Export-Certificate -Cert $cert -FilePath "$env:TEMP\scirepl-test.cer"
Import-Certificate -FilePath "$env:TEMP\scirepl-test.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople

# 4. Windows App Certification Kit, on the package before installing it.
$appcert = 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe'
& $appcert reset
& $appcert test -appxpackagepath $msix -reportoutputpath C:\scirepl-store-pilot\wack-report.xml

# 5. Install.
Add-AppxPackage $msix
```

Cleanup when finished:

```powershell
Get-AppxPackage SciREPL.FreePilot.LocalTest | Remove-AppxPackage
Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\TrustedPeople |
  Where-Object Subject -eq 'CN=SciREPL Local Test' | Remove-Item
```

### Checks on the installed package

- **Profile isolation:** before installing, make a disposable portable-preview
  profile containing a notebook (run the portable build once and save one).
  After installing, confirm the Store build does **not** show that notebook,
  and that the portable profile is unchanged afterwards.
- Start menu entry and icon; taskbar grouping and pinning (the Store build
  does not override its package-assigned AppUserModelID).
- Cold launch online and offline. Python, Prolog, Bash and ClojureScript run
  offline (bundled).
- Lua or R: decline the runtime download, then allow it; confirm it works
  offline after the cache fills.
- Network privacy consent, then one Python package install
  (`%pip install matplotlib`, then a plot).
- Notebook open, save and export; restart keeps notebooks.
- **Open app data** (app menu) opens the folder that actually holds the data.
  It passes the virtualized path to Explorer, which may not resolve; if it
  doesn't, that's a fix before submission.
- Find the data folder under `%LOCALAPPDATA%\Packages\` and record the path.
- **Upgrade:** build a later version under the same identity, install it over
  the first, and confirm notebooks and settings survive.
- **Uninstall:** confirm the Store build's data folder is removed and the
  portable profile is untouched.
- Keyboard-only use, 150–200% display scaling.

## What the packaged Free app downloads

Checked against the 1.5.0 MSIX payload and `www/js` on `main` (9021909).
Bundled in the package (`resources/www/vendor`): Pyodide, SWI-Prolog,
Scittle, Brush, TypR, plus Plotly, KaTeX, Marked, highlight.js, JSZip and pako.

| Download | Trigger | Consent | Integrity | Code? |
| --- | --- | --- | --- | --- |
| Lua (fengari, jsdelivr/unpkg) | first Lua run | privacy consent + download confirm | none | yes |
| R (webR, webr.r-wasm.org / jsdelivr) | first R run | privacy consent + download confirm | none | yes |
| R packages (repo.r-wasm.org) | user `install.packages()` | only the R first-load consent | none | yes |
| Python packages (Pyodide CDN, PyPI) | user import / `%pip` | per-request network consent guard | lockfile hashes for Pyodide wheels | yes (user-chosen) |
| CDN fallback for bundled kernels | bundled copy missing/failing, or a non-bundled version chosen | privacy consent + confirm | none | yes |
| **DOCX library (docx 9.6.0, jsdelivr/unpkg)** | **DOCX export** | **none** | **none** | **yes: app functionality** |
| Latest-version metadata (data.jsdelivr.com) | Languages dialog | privacy consent | n/a | no (JSON) |
| Workbook catalogue (s243a.github.io, GitHub) | user refresh/import | catalogue consent | sha256 + size limits | no (notebook data) |

Custom kernel-source URLs are rejected in Electron (no allowlist exposed by
`preload.js`). There is no update check; Help links open in the system browser.

**Before submission:**
- **Bundle the DOCX library** in the desktop build (or gate it behind
  consent). It is app functionality fetched as remote script without consent,
  which is the case Store policy 10.2.2 and the privacy policy both care about.
- Decide whether R package installs need their own consent prompt or whether
  the R first-load disclosure covers them, and say so in the reviewer notes.
- Reviewer notes: list bundled kernels as the offline example; Lua/R and
  Python packages as optional, user-initiated downloads behind a prompt.

## Owner inputs still needed

- Partner Center account (individual registration is free), publisher display
  name, reserved product name, and the three identity values above.
- A written justification for the `runFullTrust` restricted capability.
- Private-audience tester list for the first certified submission.
- Listing: screenshots, privacy and support URLs, descriptions, reviewer
  notes (offline bundled kernels; optional downloads behind prompts; data
  removed on uninstall).
