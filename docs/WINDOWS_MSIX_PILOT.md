# Free MSIX package for the Microsoft Store pilot

Status, November 14, 2026: a Free x64 MSIX builds from the tested Store-channel
tree. It has **not** yet been installed, upgraded or run through WACK. No
Partner Center account, reserved name, signing identity or submission exists.
The broader proposal is in [WINDOWS_STORE_PROPOSAL.md](WINDOWS_STORE_PROPOSAL.md);
the pilot sequence is planned in draft PR #134.

## Build

On Windows, from the repository root, with Node 22 and the Windows SDK
(MakeAppx.exe; found under `C:\Program Files (x86)\Windows Kits\10\bin`, or set
`SCIREPL_MAKEAPPX`):

Once per checkout (these change the checkout and download about 1 GB):

```bat
npm install
npm run configure
npm run fetch:bundles
```

Then, for each build:

```bat
npm run package:windows:msix-pilot
```

`package:windows:msix-pilot` (`desktop/electron/packaging/build-msix-pilot.mjs`)
runs these steps in order and stops at the first failure, naming the step:

```bat
npm run verify:bundles
npm run windows:install
npm run package:windows -- --channel store
node desktop\electron\test\run-all.mjs packaged
npm run package:windows:msix
```

Add `-- --dry-run` to list the steps without running them. The steps can also
be run one by one. Don't paste them into a `.bat` file as they are: `npm` is
itself a batch file, so a `.bat` stops after the first `npm` line unless each
one starts with `call`, and it carries on after a failure.

`fetch:bundles` is required: `verify:bundles` and the portable builder stop if
the bundled Pyodide, SWI-Prolog or Scittle runtimes are missing.

`--channel store` builds the same tree as the portable preview with Store
metadata: `build-info.json` channel `store` and an executable description
without "unsigned preview". The packaged tests run on that tree, and
`package:windows:msix` copies it as built, adding only `AppxManifest.xml` and
three logos rendered from `www/icons/icon-512.png`. Before packing it repeats
the Free-boundary checks (no `www/pro`, no `vendor/webr`, non-Pro profile),
requires channel `store`, and refuses a tree built from a different commit than
`HEAD`. With the real Partner Center identity it also requires a git checkout
with a recorded commit and no uncommitted changes to tracked files; a copy
without `.git` is accepted only for a `-local-test` package, with a warning. Output: `desktop/electron/out/SciREPL-<version>.0-x64[-local-test].msix`
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

This tests a clean install and an upgrade of a test-signed package. It
changes the machine's certificate store and installed apps, so the owner runs
it. It needs the Windows SDK with the App Certification Kit.

**How to run the blocks.** Each PowerShell block below is one gated step.
Paste a whole block at once: it runs as a single unit (`. { … }`) and stops
at the first failure, including a native tool's non-zero exit code. Don't
paste lines one at a time, or a failed line won't stop the next. Every block
starts by setting `$pilot`. Use the same new folder for every block in one
run, and a new folder for each run. That folder keeps everything the run
produces: both packages, their build metadata and hashes, the certification
report and the profile snapshot.

**Use fresh packages only.** Never install an MSIX built before the commit
under test, for example one left in another copy of the repository. The steps
below collect both packages from builds that recorded the current commit.

### 1. Package A: the current version

In a clean clone of current `main`, do the one-time setup from **Build**,
then run `npm run package:windows:msix-pilot`. Then, in a normal PowerShell
window at the repository root:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  if (Test-Path $pilot) { throw "$pilot already exists: use a new folder for each run" }
  $res  = 'desktop\electron\out\SciREPL-win32-x64\resources'
  $info = Get-Content "$res\build-info.json" -Raw | ConvertFrom-Json
  $head = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed: run this from the clone' }
  if ($info.channel -ne 'store' -or $info.commit -ne $head) {
    throw "The tree is channel '$($info.channel)', commit '$($info.commit)'; HEAD is $head. Rebuild."
  }
  if (-not (Test-Path "$res\www\vendor\docx\docx.iife.js")) { throw 'The tree has no bundled DOCX library.' }
  $msix = Get-Item "desktop\electron\out\SciREPL-$($info.appVersion).0-x64-local-test.msix"
  if ($msix.LastWriteTime -lt (Get-Item "$res\build-info.json").LastWriteTime) { throw "$msix is older than the tree." }
  New-Item -ItemType Directory "$pilot\A" | Out-Null
  Copy-Item $msix.FullName, "$res\build-info.json" "$pilot\A\"
  "A: $($info.appVersion) from $head"
}
```

### 2. Package B: the upgrade, from the same commit

The upgrade package comes from a second clone, checked out at A's commit,
with only the patch version raised. The raise stays uncommitted, so B records
the same commit as A. The local-test identity allows that; a Partner Center
build does not. Same window, same folder (the setup downloads about 1 GB
again):

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $infoA = Get-Content "$pilot\A\build-info.json" -Raw | ConvertFrom-Json
  $src = "$pilot\upgrade-src"
  git clone --quiet . $src
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
  git -C $src checkout --quiet --detach $infoA.commit
  if ($LASTEXITCODE -ne 0) { throw "checkout of $($infoA.commit) failed" }
  Push-Location $src
  try {
    foreach ($step in @('install'), @('run', 'configure'), @('run', 'fetch:bundles'),
                      @('version', 'patch', '--no-git-tag-version'), @('run', 'package:windows:msix-pilot')) {
      & npm @step
      if ($LASTEXITCODE -ne 0) { throw "npm $($step -join ' ') failed (exit $LASTEXITCODE)" }
    }
  } finally { Pop-Location }
  $res   = "$src\desktop\electron\out\SciREPL-win32-x64\resources"
  $infoB = Get-Content "$res\build-info.json" -Raw | ConvertFrom-Json
  if ($infoB.commit -ne $infoA.commit) { throw "B was built from '$($infoB.commit)', A from '$($infoA.commit)'." }
  if ([version]$infoB.appVersion -le [version]$infoA.appVersion) { throw "B ($($infoB.appVersion)) is not newer than A ($($infoA.appVersion))." }
  if ($infoB.channel -ne 'store') { throw "B is channel '$($infoB.channel)'." }
  if (-not (Test-Path "$res\www\vendor\docx\docx.iife.js")) { throw 'B has no bundled DOCX library.' }
  New-Item -ItemType Directory "$pilot\B" | Out-Null
  Copy-Item "$src\desktop\electron\out\SciREPL-$($infoB.appVersion).0-x64-local-test.msix", "$res\build-info.json" "$pilot\B\"
  "B: $($infoB.appVersion) from $($infoB.commit)"
}
```

### 3. Test certificate, signing and signature check

In a PowerShell window **opened as administrator**:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\signtool.exe' -ErrorAction SilentlyContinue |
              Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { throw 'signtool.exe not found: install the Windows SDK.' }
  if (Test-Path "$pilot\thumbprint.txt") { throw 'This run already has a test certificate.' }
  $packages = @(Get-ChildItem "$pilot\A\*.msix") + @(Get-ChildItem "$pilot\B\*.msix")
  if ($packages.Count -ne 2) { throw "Expected one package in A and one in B; found $($packages.Count)." }

  # Subject must equal the placeholder publisher.
  $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=SciREPL Local Test' `
    -KeyUsage DigitalSignature -FriendlyName 'SciREPL MSIX local test' `
    -CertStoreLocation Cert:\CurrentUser\My `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $thumb = $cert.Thumbprint
  Set-Content "$pilot\thumbprint.txt" $thumb   # cleanup removes only this certificate
  Export-Certificate -Cert $cert -FilePath "$pilot\scirepl-test.cer" | Out-Null
  Import-Certificate -FilePath "$pilot\scirepl-test.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null

  foreach ($m in $packages) {
    & $signtool.FullName sign /fd SHA256 /sha1 $thumb $m.FullName
    if ($LASTEXITCODE -ne 0) { throw "Signing $($m.Name) failed (exit $LASTEXITCODE)." }
    & $signtool.FullName verify /pa $m.FullName
    if ($LASTEXITCODE -ne 0) { throw "The signature on $($m.Name) did not verify under the test trust setup (exit $LASTEXITCODE)." }
    $signer = (Get-AuthenticodeSignature $m.FullName).SignerCertificate
    if (-not $signer -or $signer.Thumbprint -ne $thumb) { throw "$($m.Name) is signed by '$($signer.Thumbprint)', not the test certificate $thumb." }
    Get-FileHash $m.FullName -Algorithm SHA256 | Select-Object Hash, Path |
      Export-Csv "$pilot\signed-packages.csv" -Append -NoTypeInformation
  }
  "Both packages signed and verified with $thumb"
}
```

If `signtool verify` stops with an untrusted-root error, stop the run and
record it. Don't work around it by importing the test certificate into
Trusted Root: Microsoft advises against trusting self-signed certificates
there, and that is the owner's decision.

### 4. Windows App Certification Kit on package A

Same administrator window. Each run writes a new report and requires an
overall result of `PASS`:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $appcert = 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe'
  if (-not (Test-Path $appcert)) { throw 'appcert.exe not found: install the App Certification Kit.' }
  $a = @(Get-ChildItem "$pilot\A\*.msix")
  if ($a.Count -ne 1) { throw 'Expected one package in A.' }
  $report = Join-Path $pilot ('wack-A-{0:yyyyMMdd-HHmmss}.xml' -f (Get-Date))
  if (Test-Path $report) { throw "$report already exists." }
  & $appcert reset
  if ($LASTEXITCODE -ne 0) { throw "appcert reset failed (exit $LASTEXITCODE)." }
  & $appcert test -appxpackagepath $a[0].FullName -reportoutputpath $report
  if ($LASTEXITCODE -ne 0) { throw "appcert test failed (exit $LASTEXITCODE)." }
  if (-not (Test-Path $report)) { throw 'WACK wrote no report.' }
  $result = ([xml](Get-Content $report -Raw)).REPORT.OVERALL_RESULT
  if ($result -ne 'PASS') { throw "WACK overall result is '$result', not PASS. Read $report." }
  "WACK: PASS ($report)"
}
```

`WARNING`, `FAIL` or an empty result stops the run. Keep the report: a
warning may still be acceptable for submission, but that's decided from the
report, not by carrying on. An empty result can also mean the report's layout
differs from what this block reads; record that too. A non-zero exit code
stops the run even if a report was written.

### 5. Portable baseline and clean install of A

Before this step, run a portable preview build once (for example the
released portable zip, outside the repository), save a notebook named
`portable-canary`, and close it. Don't run the portable app again until
step 8. Then, in a normal PowerShell window:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  foreach ($scope in 'Process', 'User', 'Machine') {
    if ([Environment]::GetEnvironmentVariable('SCIREPL_USER_DATA', $scope)) { throw "SCIREPL_USER_DATA is set ($scope); it overrides both profiles." }
  }
  # Clean-install preconditions; WACK installs and removes the package itself.
  if (Get-AppxPackage SciREPL.FreePilot.LocalTest) { throw 'The pilot package is already installed: uninstall it first.' }
  if (Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'SciREPL.FreePilot.LocalTest_*' -ErrorAction SilentlyContinue) {
    throw 'A data folder from an earlier install of the pilot package still exists.'
  }
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw 'The real %APPDATA% already has a SciREPL-Free-Store folder.' }
  $portable = "$env:APPDATA\SciREPL-Free-Electron"
  if (-not (Test-Path $portable)) { throw 'No portable profile: run the portable build once and save a notebook first.' }
  if (Test-Path "$pilot\portable-before.csv") { throw 'This run already has a portable snapshot.' }
  Get-ChildItem $portable -Recurse -File | Get-FileHash | Select-Object Hash, Path |
    Export-Csv "$pilot\portable-before.csv" -NoTypeInformation
  Add-AppxPackage (Get-ChildItem "$pilot\A\*.msix").FullName
  'Installed ' + (Get-AppxPackage SciREPL.FreePilot.LocalTest).Version
}
```

A locked file in the snapshot means the portable app is still running: close
it, delete `portable-before.csv` if it was written, and rerun the block.

Then, by hand, with the network still on:

1. Start SciREPL from the Start menu. The `portable-canary` notebook must
   **not** appear.
2. Create a notebook named `store-canary` with a Python cell that prints
   something and a Markdown cell with a formula, for example `$e^{i\pi}+1=0$`.
   Run it, change one setting you can recognise later (for example the
   theme), save, and close the app.

### 6. DOCX export offline in the installed app

Turn Wi-Fi off, or airplane mode on, and unplug any network cable. Confirm
there is no active connection:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $up = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up')
  $internet = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4Connectivity -eq 'Internet' -or $_.IPv6Connectivity -eq 'Internet' })
  if ($up.Count -or $internet.Count) {
    throw "Still connected: adapters up [$($up.Name -join ', ')], internet profiles [$($internet.InterfaceAlias -join ', ')]."
  }
  'Offline: no physical adapter is up and no connection has internet access.'
}
```

Then start SciREPL, open `store-canary`, and export it as DOCX. There must be
no download or network prompt. Open the file and check that the printed output
and the formula are in it. Close the app.

### 7. Upgrade to B

Stay offline:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $before = (Get-AppxPackage SciREPL.FreePilot.LocalTest).Version
  if (-not $before) { throw 'Package A is not installed.' }
  Add-AppxPackage (Get-ChildItem "$pilot\B\*.msix").FullName
  $after = (Get-AppxPackage SciREPL.FreePilot.LocalTest).Version
  if ([version]$after -le [version]$before) { throw "The installed version is $after; expected newer than $before." }
  "Upgraded $before -> $after"
}
```

Rerun the offline check block from step 6, then start SciREPL. `store-canary`
must still be there with its output, and the setting from step 5 kept. Export
it as DOCX again and check the file. Close the app.

### 8. The portable profile is untouched

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $before = Import-Csv "$pilot\portable-before.csv"
  $after = Get-ChildItem "$env:APPDATA\SciREPL-Free-Electron" -Recurse -File | Get-FileHash | Select-Object Hash, Path
  $diff = Compare-Object $before $after -Property Hash, Path
  if ($diff) { $diff | Format-Table -AutoSize | Out-String | Write-Host; throw 'The portable profile changed.' }
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw 'Store data was written to the real %APPDATA%.' }
  Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'SciREPL.FreePilot.LocalTest_*' |
    Get-ChildItem -Recurse -Directory -Filter 'SciREPL-Free-Store' | Select-Object -ExpandProperty FullName
  'Portable profile unchanged; the Store profile is in the package folder above.'
}
```

Record the Store profile path it prints.

### Cleanup

Keep `$pilot` with the packages, hashes and report; `upgrade-src` inside it
can be deleted. Turn the network back on. In an administrator window:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $thumb = (Get-Content "$pilot\thumbprint.txt").Trim()
  Get-AppxPackage SciREPL.FreePilot.LocalTest | Remove-AppxPackage
  # Only the certificate created for this run.
  Remove-Item "Cert:\CurrentUser\My\$thumb", "Cert:\LocalMachine\TrustedPeople\$thumb"
}
```

Uninstalling removes the Store profile, including `store-canary`. Check that
its package folder under `%LOCALAPPDATA%\Packages` is gone.

### Other checks before inviting testers

Record each result. Merging the packaging source establishes none of them.

- Start menu entry and icon; taskbar grouping and pinning (the Store build
  does not override its package-assigned AppUserModelID).
- Cold launch online and offline. Python, Prolog, Bash and ClojureScript run
  offline (bundled).
- Lua or R: decline the runtime download, then allow it; confirm it works
  offline after the cache fills.
- Network privacy consent, then one Python package install
  (`%pip install matplotlib`, then a plot).
- **Open app data** (app menu) opens the folder that actually holds the data.
  It passes the virtualized path to Explorer, which may not resolve; if it
  doesn't, that's a fix before submission.
- Keyboard-only use, 150–200% display scaling.

## What the packaged Free app downloads

Checked against the 1.5.0 MSIX payload and `www/js` on `main` (9021909).
Bundled in the package (`resources/www/vendor`): Pyodide, SWI-Prolog,
Scittle, Brush, TypR, plus Plotly, KaTeX, Marked, highlight.js, JSZip, pako
and the DOCX export library (`docx@9.6.0`, bundled since this was first
checked; it was previously fetched from jsdelivr/unpkg without consent).

| Download | Trigger | Consent | Integrity | Code? |
| --- | --- | --- | --- | --- |
| Lua (fengari, jsdelivr/unpkg) | first Lua run | privacy consent + download confirm | none | yes |
| R (webR, webr.r-wasm.org / jsdelivr) | first R run | privacy consent + download confirm | none | yes |
| R packages (repo.r-wasm.org) | user `install.packages()` | only the R first-load consent | none | yes |
| Python packages (Pyodide CDN, PyPI) | user import / `%pip` | per-request network consent guard | lockfile hashes for Pyodide wheels | yes (user-chosen) |
| CDN fallback for bundled kernels | bundled copy missing/failing, or a non-bundled version chosen | privacy consent + confirm | none | yes |
| Latest-version metadata (data.jsdelivr.com) | Languages dialog | privacy consent | n/a | no (JSON) |
| Workbook catalogue (s243a.github.io, GitHub) | user refresh/import | catalogue consent | sha256 + size limits | no (notebook data) |

Custom kernel-source URLs are rejected in Electron (no allowlist exposed by
`preload.js`). There is no update check; Help links open in the system browser.

**Before submission:**
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
