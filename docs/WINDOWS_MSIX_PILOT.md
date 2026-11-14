# Free MSIX package for the Microsoft Store pilot

Status, November 14, 2026: a Free x64 MSIX builds locally from the tested
portable tree. No Partner Center account, reserved name, signing identity or
submission exists. The broader sequence is in
[WINDOWS_STORE_PILOT.md](WINDOWS_STORE_PILOT.md) (on PR #134).

## Build

On Windows, from the repository root, with Node 22 and the Windows SDK
(MakeAppx.exe; found under `C:\Program Files (x86)\Windows Kits\10\bin`, or set
`SCIREPL_MAKEAPPX`):

```bat
npm install
npm run windows:install
npm run package:windows
node desktop\electron\test\run-all.mjs packaged
npm run package:windows:msix
```

`package:windows:msix` packs `desktop/electron/out/SciREPL-win32-x64` unchanged,
plus `AppxManifest.xml` and three logos rendered from `www/icons/icon-512.png`.
The packaged tests above therefore cover the same files the MSIX contains.
Output: `desktop/electron/out/SciREPL-<version>.0-x64[-local-test].msix`
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

### Manifest decisions

- Version is `Major.Minor.Patch.0` from `package.json`. The Store reserves the
  fourth part; pre-release suffixes are refused rather than dropped.
- Full-trust desktop entry point (`Windows.FullTrustApplication`), one
  capability: `runFullTrust`. Network access needs no capability for a
  full-trust process.
- `Windows.Desktop`, minimum 10.0.17763.0 (Windows 10 1809), x64 only.
- Resource language `en-us` only for now. Manifest languages become the Store
  listing languages; adding the UI's other languages is a listing decision,
  each needing a reviewed Store description.
- No auto-updater: the Store delivers updates.
- Unit tests: `desktop/electron/test/msix-manifest.unit.test.mjs`
  (`npm run test:windows:unit`).

## Data location when packaged

The shell stores everything under Electron `userData`, set to
`%APPDATA%\SciREPL-Free-Electron` (`desktop/electron/main.js`). Under MSIX,
writes to `%APPDATA%` are redirected to the package's private copy:

```
%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\SciREPL-Free-Electron
```

Consequences to verify on the installed package and state in the listing:

- Notebooks, settings, IndexedDB/SharedVFS and the runtime cache live there.
  The app is unaware of the redirection; it should need no code change.
- A portable-preview profile in the real `%APPDATA%` is not visible to the
  MSIX app. It is not imported silently; preview users export and re-import.
- **Uninstalling removes that folder and the notebooks in it.** Users need
  to export notebooks first. Updates keep it.
- Free and Pro must keep separate userData names and package identities.

## Local install test (owner's machine; each step needs the owner's OK)

These change the Windows machine's certificate store and installed apps, so
they are run by the owner, not by an agent. Run PowerShell **as
administrator** for steps 3 and 5.

1. Create a test certificate whose subject equals the placeholder publisher:

   ```powershell
   $cert = New-SelfSignedCertificate -Type Custom -Subject "CN=SciREPL Local Test" `
     -KeyUsage DigitalSignature -FriendlyName "SciREPL MSIX local test" `
     -CertStoreLocation Cert:\CurrentUser\My `
     -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
   ```

2. Sign the package (signtool is next to makeappx in the Windows SDK):

   ```powershell
   & "C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64\signtool.exe" sign `
     /fd SHA256 /sha1 $cert.Thumbprint `
     C:\scirepl-store-pilot\repo\desktop\electron\out\SciREPL-1.5.0.0-x64-local-test.msix
   ```

3. Trust it for installs (admin):

   ```powershell
   Export-Certificate -Cert $cert -FilePath $env:TEMP\scirepl-test.cer
   Import-Certificate -FilePath $env:TEMP\scirepl-test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
   ```

4. Install: `Add-AppxPackage C:\scirepl-store-pilot\repo\desktop\electron\out\SciREPL-1.5.0.0-x64-local-test.msix`

5. Windows App Certification Kit (admin):

   ```powershell
   & "C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe" test `
     -appxpackagepath C:\scirepl-store-pilot\repo\desktop\electron\out\SciREPL-1.5.0.0-x64-local-test.msix `
     -reportoutputpath C:\scirepl-store-pilot\wack-report.xml
   ```

6. Cleanup when finished: `Get-AppxPackage SciREPL.FreePilot.LocalTest | Remove-AppxPackage`,
   then delete the certificate from `Cert:\CurrentUser\My` and
   `Cert:\LocalMachine\TrustedPeople`.

### Manual checks on the installed package

- Start menu entry and icon; cold launch online and offline.
- Python, Prolog, Bash and ClojureScript run offline (bundled).
- Lua or R: decline the runtime download, then allow it; confirm it works
  offline after the cache fills.
- Network privacy consent, then one Python package install.
- Notebook open, save and export; restart keeps notebooks.
- Confirm the data folder is under `LocalCache\Roaming` as above.
- Build 1.5.0.0 and a later version, install over it, and confirm notebooks
  and settings survive; then uninstall and confirm the folder is removed.
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
- Private-audience tester list for the first certified submission.
- Listing: screenshots, privacy and support URLs, descriptions, reviewer
  notes. A draft of the download explanation is in the pilot plan; the
  runtime-download inventory backs it.
