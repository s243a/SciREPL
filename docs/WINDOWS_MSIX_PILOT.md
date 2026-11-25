# Free MSIX package for the Microsoft Store pilot

Status, November 23, 2026: a Free x64 MSIX builds from the tested Store-channel
tree. Three local pilot runs (see **Pilot run 1** and **Pilot runs 2 and 3**
below) signed it with a test certificate, installed it, and upgraded it with
the notebook and settings kept. WACK reported an overall `PASS` on package A
in static-only mode (it did not deploy the app), with one optional test
failing. Offline DOCX export was confirmed on both A and B. Runs 2 and 3 used
the repository scripts. No
Partner Center account, reserved name, signing identity or submission exists.
The broader proposal is in [WINDOWS_STORE_PROPOSAL.md](WINDOWS_STORE_PROPOSAL.md);
the pilot sequence is planned in draft PR #134.

## Build

On Windows, from the repository root, with Node 22 and the Windows SDK
(MakeAppx.exe; found under `C:\Program Files (x86)\Windows Kits\10\bin`, or set
`SCIREPL_MAKEAPPX`):

Once per checkout (these change the checkout and download about 1 GB):

```bat
npm ci
npm run configure
npm run fetch:bundles
```

Use `npm ci`, not `npm install`: it installs exactly what `package-lock.json`
lists and never rewrites it. `npm install` reformats the committed lockfile
(4-space indentation) to match `package.json` (2 spaces), which leaves the
checkout modified.

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

The same steps also exist as scripts in the repository, described in
[WINDOWS_MSIX_PILOT_SCRIPTS.md](WINDOWS_MSIX_PILOT_SCRIPTS.md). Pilot run 1
used the blocks below; pilot runs 2 and 3 used the scripts.

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
  git diff --quiet -- package-lock.json desktop/electron/package-lock.json
  if ($LASTEXITCODE -ne 0) { throw 'A lockfile differs from the commit: restore it, run npm ci, and rebuild.' }
  $msix = Get-Item "desktop\electron\out\SciREPL-$($info.appVersion).0-x64-local-test.msix"
  if ($msix.LastWriteTime -lt (Get-Item "$res\build-info.json").LastWriteTime) { throw "$msix is older than the tree." }
  New-Item -ItemType Directory "$pilot\A" | Out-Null
  Copy-Item $msix.FullName, "$res\build-info.json" "$pilot\A\"
  "A: $($info.appVersion) from $head"
}
```

### 2. Package B: the upgrade, from the same commit

The upgrade package comes from a second clone, checked out at A's commit,
with only the patch version raised and the licence notices regenerated
(they name the app version). These changes stay uncommitted, so B records the
same commit as A. The local-test identity allows that; a Partner Center
build does not. Same window, same folder (the setup downloads about 1 GB
again):

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $infoA = Get-Content "$pilot\A\build-info.json" -Raw | ConvertFrom-Json
  $src = "$pilot\upgrade-src"
  # LF checkout, like A's: Git for Windows defaults to core.autocrlf=true.
  git clone --quiet -c core.autocrlf=false . $src
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
  git -C $src checkout --quiet --detach $infoA.commit
  if ($LASTEXITCODE -ne 0) { throw "checkout of $($infoA.commit) failed" }
  Push-Location $src
  try {
    # npm.cmd, not npm: PowerShell 7 runs npm.ps1, which rebuilds its arguments
    # from the typed line and so misreads '& npm @step' as the command 'pm'.
    foreach ($step in @('ci'), @('run', 'configure'), @('run', 'fetch:bundles')) {
      & npm.cmd @step
      if ($LASTEXITCODE -ne 0) { throw "npm $($step -join ' ') failed (exit $LASTEXITCODE)" }
    }
    git diff --quiet -- package-lock.json desktop/electron/package-lock.json
    if ($LASTEXITCODE -ne 0) { throw 'The setup changed a lockfile.' }
    # The version raise rewrites package.json and package-lock.json on purpose,
    # and the licence notices name the app version, so regenerate them.
    foreach ($step in @('version', 'patch', '--no-git-tag-version'), @('run', 'licenses:generate'),
                      @('run', 'package:windows:msix-pilot')) {
      & npm.cmd @step
      if ($LASTEXITCODE -ne 0) { throw "npm $($step -join ' ') failed (exit $LASTEXITCODE)" }
    }
    git diff --quiet -- desktop/electron/package-lock.json
    if ($LASTEXITCODE -ne 0) { throw 'The build changed desktop/electron/package-lock.json.' }
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

### 4. Portable baseline, before WACK

WACK may install and launch the package (in pilot run 1 it reported
"Running tests without application deployment" and only ran static checks),
so the portable profile and the profile override are checked before it runs. Run a portable preview build
once (for example the released portable zip, outside the repository), save a
notebook named `portable-canary`, and close it. Don't run the portable app
again until step 9. Then, in a normal PowerShell window:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  # PowerShell 7 can't load the Appx module natively; use the Windows PowerShell one.
  if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue }
  $pilot = 'C:\scirepl-store-pilot\run-1'
  foreach ($scope in 'Process', 'User', 'Machine') {
    if ([Environment]::GetEnvironmentVariable('SCIREPL_USER_DATA', $scope)) { throw "SCIREPL_USER_DATA is set ($scope); it overrides both profiles." }
  }
  if (Get-AppxPackage SciREPL.FreePilot.LocalTest) { throw 'The pilot package is already installed: uninstall it first.' }
  $leftover = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'SciREPL.FreePilot.LocalTest_*' -ErrorAction Stop)
  if ($leftover.Count) { throw "Data from an earlier install is still present: $($leftover.FullName -join ', ')" }
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw 'The real %APPDATA% already has a SciREPL-Free-Store folder.' }
  $portable = "$env:APPDATA\SciREPL-Free-Electron"
  if (-not (Test-Path $portable)) { throw 'No portable profile: run the portable build once and save a notebook first.' }
  if ((Test-Path "$pilot\portable-before.csv") -or (Test-Path "$pilot\baseline-account.json")) { throw 'This run already has a baseline.' }
  # The account the baseline belongs to; the elevated WACK window must match it.
  [pscustomobject]@{
    Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    AppData = $env:APPDATA
    LocalAppData = $env:LOCALAPPDATA
  } | ConvertTo-Json | Set-Content "$pilot\baseline-account.json"
  Get-ChildItem $portable -Recurse -File | Get-FileHash | Select-Object Hash, Path |
    Export-Csv "$pilot\portable-before.csv" -NoTypeInformation
  'Portable snapshot taken: ' + @(Import-Csv "$pilot\portable-before.csv").Count + ' files.'
}
```

A locked file means the portable app is still running: close it, delete
`portable-before.csv` and `baseline-account.json` if they were written, and
rerun the block.

### 5. Windows App Certification Kit on package A

In the administrator window from step 3. WACK may install and launch the
package itself, so this block first checks, in this elevated session, that
the baseline from step 4 exists and belongs to this same Windows account,
and repeats the clean-state checks. `Get-AppxPackage` and `%APPDATA%` are
per-user, so an administrator window opened as a different account would
check the wrong profile. Each run writes a new report and requires an
overall result of `PASS`:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  # PowerShell 7 can't load the Appx module natively; use the Windows PowerShell one.
  if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue }
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $appcert = 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe'
  if (-not (Test-Path $appcert)) { throw 'appcert.exe not found: install the App Certification Kit.' }

  # Preflight in this elevated session, immediately before WACK.
  if (-not (Test-Path "$pilot\baseline-account.json") -or -not (Test-Path "$pilot\portable-before.csv")) { throw 'No baseline: run step 4 first.' }
  $account = Get-Content "$pilot\baseline-account.json" -Raw | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($account.Sid -ne $sid -or $account.AppData -ne $env:APPDATA -or $account.LocalAppData -ne $env:LOCALAPPDATA) {
    throw "This window runs as $sid ($env:APPDATA); the baseline belongs to $($account.Sid) ($($account.AppData)). Open the administrator window from the same account."
  }
  $before = @(Import-Csv "$pilot\portable-before.csv")
  if (-not $before.Count) { throw 'The portable snapshot is empty: redo step 4 in a new run folder.' }
  foreach ($scope in 'Process', 'User', 'Machine') {
    if ([Environment]::GetEnvironmentVariable('SCIREPL_USER_DATA', $scope)) { throw "SCIREPL_USER_DATA is set ($scope); it overrides both profiles." }
  }
  if (Get-AppxPackage SciREPL.FreePilot.LocalTest) { throw 'The pilot package is installed: uninstall it first.' }
  $leftover = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'SciREPL.FreePilot.LocalTest_*' -ErrorAction Stop)
  if ($leftover.Count) { throw "Data from an earlier install is still present: $($leftover.FullName -join ', ')" }
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw 'The real %APPDATA% has a SciREPL-Free-Store folder.' }
  $now = Get-ChildItem "$env:APPDATA\SciREPL-Free-Electron" -Recurse -File | Get-FileHash | Select-Object Hash, Path
  if (Compare-Object $before $now -Property Hash, Path) { throw 'The portable profile changed since step 4.' }

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

The gate reads only the overall result. Optional tests can fail under an
overall `PASS`; list them from the report (each `<TEST>` with
`OPTIONAL="TRUE"` and a `FAIL` result) in the run record.

### 6. Clean install of A

WACK may have installed, launched and removed the package, so the
clean-install conditions are checked again. Any error while scanning for leftover data
stops the block. In a normal PowerShell window:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  # PowerShell 7 can't load the Appx module natively; use the Windows PowerShell one.
  if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue }
  $pilot = 'C:\scirepl-store-pilot\run-1'
  foreach ($scope in 'Process', 'User', 'Machine') {
    if ([Environment]::GetEnvironmentVariable('SCIREPL_USER_DATA', $scope)) { throw "SCIREPL_USER_DATA is set ($scope); it overrides both profiles." }
  }
  if (Get-AppxPackage SciREPL.FreePilot.LocalTest) { throw 'The pilot package is still installed after WACK: uninstall it first.' }
  $leftover = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'SciREPL.FreePilot.LocalTest_*' -ErrorAction Stop)
  if ($leftover.Count) { throw "Data from an earlier install is still present: $($leftover.FullName -join ', ')" }
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw 'A SciREPL-Free-Store folder appeared in the real %APPDATA%.' }
  $before = Import-Csv "$pilot\portable-before.csv"
  $now = Get-ChildItem "$env:APPDATA\SciREPL-Free-Electron" -Recurse -File | Get-FileHash | Select-Object Hash, Path
  $diff = Compare-Object $before $now -Property Hash, Path
  if ($diff) { $diff | Format-Table -AutoSize | Out-String | Write-Host; throw 'The portable profile changed before install (during WACK?).' }
  Add-AppxPackage (Get-ChildItem "$pilot\A\*.msix").FullName
  'Installed ' + (Get-AppxPackage SciREPL.FreePilot.LocalTest).Version
}
```

Then, by hand, with the network still on:

1. Start SciREPL from the Start menu. The `portable-canary` notebook must
   **not** appear.
2. Create a notebook named `store-canary` with a Python cell that prints
   something and a Markdown cell with a formula, for example `$e^{i\pi}+1=0$`.
   Run it, change one setting you can recognise later (for example the
   theme), save, and close the app.

### 7. DOCX export offline in the installed app

Take the machine offline physically: unplug any network cable and turn Wi-Fi
off, or airplane mode on. If the test runs in a VM, disconnect the VM's
network adapter from the host side. Disconnect any VPN client explicitly too
(in its own app, and in Settings → Network & internet → VPN).

Then run the check below. It looks for the common active network paths:
- an active Windows VPN, or a recognisable VPN or tunnel adapter that is up;
- a default route through a connected interface;
- a connection with internet access;
- a physical adapter that is up.

It is a preflight, not proof of isolation: it can't rule out every route over
a virtual adapter. Any query error stops it. Host-only switches (WSL, the
Hyper-V Default Switch, VirtualBox host-only) may stay up; they pass if they
have no default route. A passing run is appended to `offline-check.txt` in the
run folder. Count the DOCX result only after that passing record, made with
the machine physically offline or the VM's network disconnected.

```powershell
. {
  $ErrorActionPreference = 'Stop'
  $pilot = 'C:\scirepl-store-pilot\run-1'
  # Any query error stops the block: offline status must be shown, not assumed.
  $ifaces   = @(Get-NetIPInterface -ErrorAction Stop)
  $routes   = @(Get-NetRoute -ErrorAction Stop | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0', '::/0' })
  $profiles = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetConnectionProfile -ErrorAction Stop)
  $physical = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object Status -eq 'Up')
  $vpns     = @(@(Get-VpnConnection -ErrorAction Stop) + @(Get-VpnConnection -AllUserConnection -ErrorAction Stop) |
                Where-Object ConnectionStatus -ne 'Disconnected')
  $tunnels  = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object {
                $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'VPN|TAP|TUN|WireGuard|Wintun|OpenVPN|Tunnel|PPP' })
  if (-not $ifaces.Count) { throw 'No IP interfaces were reported; offline status cannot be established.' }

  $problems = @()
  foreach ($r in $routes) {
    $state = @($ifaces | Where-Object { $_.ifIndex -eq $r.ifIndex } | Select-Object -ExpandProperty ConnectionState -Unique)
    if ($state.Count -ne 1 -or $state[0] -ne 'Disconnected') {
      $problems += "default route $($r.DestinationPrefix) via $($r.InterfaceAlias) (state: $($state -join '/'))"
    }
  }
  foreach ($p in $profiles) {
    if ($p.IPv4Connectivity -eq 4 -or $p.IPv6Connectivity -eq 4) {   # 4 = Internet
      $problems += "connection profile on $($p.InterfaceAlias) (IPv4 $($p.IPv4Connectivity), IPv6 $($p.IPv6Connectivity))"
    }
  }
  foreach ($a in $physical) { $problems += "physical adapter up: $($a.Name)" }
  foreach ($v in $vpns)     { $problems += "Windows VPN not disconnected: $($v.Name) ($($v.ConnectionStatus))" }
  foreach ($t in $tunnels)  { $problems += "VPN or tunnel adapter up: $($t.Name) ($($t.InterfaceDescription))" }
  if ($problems.Count) { throw "Not offline:`n  " + ($problems -join "`n  ") }
  $line = "$(Get-Date -Format s) passed: no VPN or tunnel up, no default route on a connected interface, no connection with internet access, no physical adapter up."
  Add-Content "$pilot\offline-check.txt" $line
  $line
}
```

Anything the block lists has to be disconnected before carrying on. If it
can't be, record what it lists and stop: don't skip the check. Note in the
run record how the machine was taken offline (cable unplugged, Wi-Fi off,
airplane mode, or VM adapter disconnected).

Then start SciREPL, open `store-canary`, and export it as DOCX. There must be
no download or network prompt. Open the file and check that the printed output
and the formula are in it. Close the app.

### 8. Upgrade to B

Stay offline:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  # PowerShell 7 can't load the Appx module natively; use the Windows PowerShell one.
  if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue }
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $before = (Get-AppxPackage SciREPL.FreePilot.LocalTest).Version
  if (-not $before) { throw 'Package A is not installed.' }
  Add-AppxPackage (Get-ChildItem "$pilot\B\*.msix").FullName
  $after = (Get-AppxPackage SciREPL.FreePilot.LocalTest).Version
  if ([version]$after -le [version]$before) { throw "The installed version is $after; expected newer than $before." }
  "Upgraded $before -> $after"
}
```

Rerun the offline check block from step 7, then start SciREPL. `store-canary`
must still be there with its output, and the setting from step 6 kept. Export
it as DOCX again and check the file. Close the app.

### 9. The portable profile is untouched; the Store profile is in the package

```powershell
. {
  $ErrorActionPreference = 'Stop'
  # PowerShell 7 can't load the Appx module natively; use the Windows PowerShell one.
  if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue }
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $before = Import-Csv "$pilot\portable-before.csv"
  $after = Get-ChildItem "$env:APPDATA\SciREPL-Free-Electron" -Recurse -File | Get-FileHash | Select-Object Hash, Path
  $diff = Compare-Object $before $after -Property Hash, Path
  if ($diff) { $diff | Format-Table -AutoSize | Out-String | Write-Host; throw 'The portable profile changed.' }
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw 'Store data was written to the real %APPDATA%.' }

  # The Store profile must be in the installed package's redirected AppData.
  $pkg = @(Get-AppxPackage SciREPL.FreePilot.LocalTest)
  if ($pkg.Count -ne 1) { throw "Expected one installed pilot package; found $($pkg.Count)." }
  $pkgData = Join-Path $env:LOCALAPPDATA "Packages\$($pkg[0].PackageFamilyName)"
  $expected = Join-Path $pkgData 'LocalCache\Roaming\SciREPL-Free-Store'
  $found = @(Get-ChildItem $pkgData -Recurse -Directory -Filter 'SciREPL-Free-Store' | Select-Object -ExpandProperty FullName)
  if ($found.Count -ne 1 -or $found[0] -ne $expected) {
    throw "Expected exactly one Store profile at $expected; found [$($found -join ', ')]."
  }
  if (-not (Get-ChildItem $expected -Recurse -File | Select-Object -First 1)) { throw "$expected is empty." }
  "Portable profile unchanged. Store profile: $expected"
}
```

Record the Store profile path it prints. If the profile is somewhere else in
the package folder, the block stops and lists it: record that path, because
the doc's data-location section then needs correcting.

### Cleanup

Keep `$pilot` with the packages, hashes and report; `upgrade-src` inside it
can be deleted. Turn the network back on. In an administrator window:

```powershell
. {
  $ErrorActionPreference = 'Stop'
  # PowerShell 7 can't load the Appx module natively; use the Windows PowerShell one.
  if ($PSVersionTable.PSEdition -eq 'Core') { Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue }
  $pilot = 'C:\scirepl-store-pilot\run-1'
  $thumb = (Get-Content "$pilot\thumbprint.txt").Trim()
  Get-AppxPackage SciREPL.FreePilot.LocalTest | ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName }
  # Only the certificate created for this run.
  Remove-Item "Cert:\CurrentUser\My\$thumb", "Cert:\LocalMachine\TrustedPeople\$thumb"
}
```

Uninstalling removes the Store profile, including `store-canary`. Check that
its package folder under `%LOCALAPPDATA%\Packages` is gone.

### Pilot run 1 (November 20–21, 2026)

Owner's Windows 10 Pro (build 19045) machine, PowerShell 7.6.10, Node
22.20.0, Git for Windows 2.47 for the blocks, Windows SDK 10.0.19041
(MakeAppx, signtool, App Certification Kit). Run folder
`C:\scirepl-store-pilot\run-1`, kept.

| Step | Result |
| --- | --- |
| 1. Package A | 1.5.0, channel `store`, commit `e4a296b` (#139 merge); 5/5 pilot build steps, 60/60 packaged tests |
| 2. Package B | 1.5.1 from the same commit, separate LF clone; 5/5 steps, 60/60 tests |
| 3. Signing | Test certificate in `LocalMachine\TrustedPeople` only; `signtool verify /pa` passed for both; signer thumbprint matched |
| 4. Baseline | 194 files in the portable profile, with a `portable-canary` notebook |
| 5. WACK on A | Overall `PASS` (kit 10.0.19041.5609), static checks only: no deployment. One optional test failed: **Blocked executables**, on strings such as `cmd`, `reg` and `bash` inside Electron/Chromium binaries (`SciREPL.exe`, `d3dcompiler_47.dll`, `dxcompiler.dll`, `.pak` files) and a `CreateProcessW` reference |
| 6. Install A | Installed 1.5.0.0; `portable-canary` absent; `store-canary` (Python print, KaTeX formula) ran; theme set to light |
| 7. Offline | Airplane mode plus Ethernet unplugged; check passed at 23:31:04. DOCX export from A was not separately confirmed |
| 8. Upgrade | 1.5.0.0 → 1.5.1.0 offline; check passed again at 23:39:26; `store-canary` and light theme kept; DOCX export from B had the output and formula, with no network prompt |
| 9. Profiles | Portable profile unchanged; Store profile at `%LOCALAPPDATA%\Packages\SciREPL.FreePilot.LocalTest_2xd92v2yysscm\LocalCache\Roaming\SciREPL-Free-Store` |
| Cleanup | Package and its data folder removed; test certificate removed by thumbprint |

Signed package SHA-256: A `5D16F53A…FAE8F8`, B `D90B4E5E…D90B262C` (full
values in the run folder's `signed-packages.csv`).

Fixed in this guide during the run, without changing what any gate requires:
`npm ci` instead of `npm install` (npm reindents the committed lockfile), an
LF clone for B, `npm.cmd` instead of `npm` (PowerShell 7's `npm.ps1` misreads
splatted arguments), regenerating the licence notices after the version
raise, and loading the Appx module through Windows PowerShell under
PowerShell 7. Results of the optional checks below were not recorded.

### Pilot runs 2 and 3 (November 21–23, 2026), with the scripts

Same machine and tools as run 1, using the scripts in
[WINDOWS_MSIX_PILOT_SCRIPTS.md](WINDOWS_MSIX_PILOT_SCRIPTS.md) from the
owner's Windows-drive clone at `90e5066` (#142 merge). Run folders
`C:\scirepl-store-pilot\run-2` and `run-3`, kept.

Run 2 skipped step 9 by mistake before cleanup, so run 3 rebuilt both
packages and repeated steps 3, 4, 6, 8 and 9 and cleanup, online, without
WACK or the offline checks, which run 2 had passed.

| Step | Run 2 | Run 3 |
| --- | --- | --- |
| 1–2. Packages | A 1.5.0, B 1.5.1, both from `90e5066`; 60/60 packaged tests each | Same |
| 3. Signing | Both verified; certificate `70AD95EE…F0E47594` | Both verified; certificate `A42BF199…02C65331` |
| 4. Baseline | 194 portable files | 194 portable files |
| 5. WACK on A | Overall `PASS` (kit 10.0.19041.5609), static checks only; optional **Blocked executables** failed, as in run 1 | Not run |
| 6. Install A | Installed and marked 1.5.0.0; `portable-canary` absent; `store-canary` ran; a setting changed | Installed and marked 1.5.0.0; a notebook created and saved |
| 7. Offline | Airplane mode plus Ethernet unplugged; check passed at 16:35:55. **DOCX export from A** had the output and formula, with no network prompt | Not run |
| 8. Upgrade | 1.5.0.0 → 1.5.1.0 offline; check passed again at 16:40:42; `store-canary` and the setting kept; DOCX export from B correct | 1.5.0.0 → 1.5.1.0 online; the notebook kept |
| 9. Profiles | Not run (see above) | Portable profile unchanged; Store profile at `%LOCALAPPDATA%\Packages\SciREPL.FreePilot.LocalTest_2xd92v2yysscm\LocalCache\Roaming\SciREPL-Free-Store` |
| Cleanup | Package, data folder and certificate removed (marker matched) | Same |

Signed package SHA-256: run 2 A `9C41C7DC…AF5E2577`, B `12002E8D…3D2B0B5D`;
run 3 A `772B846D…4973453E`, B `52C2CE16…712EDE53` (full values in each run
folder's `signed-packages.csv`).

Findings:

- Windows created the package's data folder at install, not at first launch,
  so step 6 marked the install straight away without waiting.
- No script needed a fix. The stops were operator slips, each caught before
  any change: a `$pilot` left over from run 1, re-running step 3 on a run that
  already had a certificate, and step 3 in a window that wasn't elevated.
- Results of the optional checks below were still not recorded.

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
| R packages (repo.r-wasm.org) | user `install.packages()` / `%install` / `library()` of a missing package; opt-in ggplot2/dplyr pre-install | current privacy-policy revision (same check as Python packages) | none | yes (user-chosen) |
| Python packages (Pyodide CDN, PyPI) | user import / `%pip` | per-request network consent guard | lockfile hashes for Pyodide wheels | yes (user-chosen) |
| CDN fallback for bundled kernels | bundled copy missing/failing, or a non-bundled version chosen | privacy consent + confirm | none | yes |
| Latest-version metadata (data.jsdelivr.com) | Languages dialog | privacy consent | n/a | no (JSON) |
| Workbook catalogue (s243a.github.io, GitHub) | user refresh/import | catalogue consent | sha256 + size limits | no (notebook data) |

Custom kernel-source URLs are rejected in Electron (no allowlist exposed by
`preload.js`). There is no update check; Help links open in the system browser.

**Before submission:**
- Decided: R package installs need no prompt of their own. `install.packages()`
  is an explicit user request, like `%pip install`, and R package downloads now
  require the current privacy-policy revision, as Python package downloads do.
  webR routes every package download (`install.packages()`, `%install`,
  `library()`/`require()` of a missing package and the opt-in ggplot2/dplyr
  pre-install) through `webr::install`, which SciREPL gates. A user who already
  accepted the current revision sees nothing new. After a policy revision
  change, `%install` and the pre-install show the policy and then continue; an
  in-R install fails the cell, shows the policy, and installs when the cell is
  run again after acceptance. Code that fetches URLs
  itself (`download.file()`, `url()`, `webr::mount()` of a URL) is not gated,
  the same as arbitrary network code in Python.

**Reviewer notes (draft):**

> SciREPL works offline. Python, SWI-Prolog, Bash and ClojureScript are
> bundled in the package. The first time the user asks for anything that needs
> the network, the app shows its privacy policy and waits for acceptance.
> Optional runtimes (Lua, R) are downloaded only when the user first runs code
> in those languages. The app shows the download size and asks before
> downloading. Users can turn this confirmation off in Settings. Python and R
> packages are downloaded only when the user requests them (`%pip install`,
> `install.packages()`, or loading a package that is not installed yet). After
> R loads, the app offers to pre-install two common R packages; they are
> downloaded only if the user accepts, and then again each time R starts
> (the user can turn this off in Settings). There is no update check and no
> telemetry. Uninstalling removes all app data.

## Owner inputs still needed

- Partner Center account (individual registration is free), publisher display
  name, reserved product name, and the three identity values above.
- A written justification for the `runFullTrust` restricted capability.
- Private-audience tester list for the first certified submission.
- Listing: screenshots, privacy and support URLs, descriptions, reviewer
  notes (offline bundled kernels; optional downloads behind prompts; data
  removed on uninstall).
