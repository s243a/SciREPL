# Running the MSIX pilot with scripts

This is the local MSIX pilot from [WINDOWS_MSIX_PILOT.md](WINDOWS_MSIX_PILOT.md),
with each step as a script in the repository instead of a block pasted into
PowerShell. The steps, the order, and the checks that stop a run are the same.

**Status: not yet run end to end.** Pilot run 1 (November 20–21, 2026) used
the pasted blocks, and that guide stays the tested reference. These scripts
carry the same gates, plus checks that each install and the cleanup actually
took effect. Until a run has used them, treat a surprise here as a script bug
and compare with the block guide. If a script stops, fix the script, not the
gate.

## Before you start

- **Windows 10 or 11 x64**, with the **Windows SDK** (MakeAppx, signtool) and
  the **App Certification Kit**.
- **PowerShell 7**: `winget install Microsoft.PowerShell`. The scripts declare
  `#Requires -Version 7` and refuse to run in Windows PowerShell 5.1.
- **Node 22** and **Git for Windows** on `PATH` in PowerShell (`git --version`
  should show `.windows.`; Cygwin's Git can't read Windows paths).
- **A clone on a Windows drive**, on current `main`, with no local changes.
  Not a `\\wsl.localhost\…` path: PowerShell treats those as remote and its
  default policy refuses unsigned scripts there. A clone made by Git is local,
  so `RemoteSigned`, PowerShell 7's default, runs the scripts unchanged.
- **A new run folder for each run**, for example `C:\scirepl-store-pilot\run-2`.
  It keeps everything the run produces.

Steps 3, 5 and cleanup change the machine or need an elevated session: run
them in PowerShell 7 **opened as administrator from your own account**. Run
everything else in a normal PowerShell 7 window. All commands run from the
repository root.

```powershell
$run = 'C:\scirepl-store-pilot\run-2'
$pilot = '.\desktop\electron\packaging\pilot'
```

Set those two in each window you open.

## 1–2. Build packages A and B

```powershell
npm run pilot:packages -- --run $run
```

This builds and collects both packages, about 1 GB of downloads and a few
minutes:

- **A** is this checkout at `HEAD`: `npm ci`, `configure`, `fetch:bundles`, then
  `package:windows:msix-pilot`.
- **B** is a second clone in `$run\upgrade-src`, checked out at A's commit
  with Unix line endings, built the same way after `npm version patch` and
  `licenses:generate`. B records the same commit as A.
- Both lockfiles must stay unchanged by the setup, and the Electron lockfile
  by the build.
- Each package must be channel `store`, built from the expected commit, with
  the bundled DOCX library, and B must be newer than A. The MSIX and its
  `build-info.json` are copied into `$run\A` and `$run\B`.

Add `--dry-run` to print the plan without building. The packaged app opens
and closes during the build: that is the packaged tests.

## 3. Sign (administrator)

```powershell
& "$pilot\Step3-Sign.ps1" -Run $run
```

Creates a self-signed certificate `CN=SciREPL Local Test`, trusts it in
`LocalMachine\TrustedPeople` (never Trusted Root), signs both packages, and
requires `signtool verify /pa` and the signer's thumbprint to match. The
thumbprint goes in `$run\thumbprint.txt` and the hashes in
`signed-packages.csv`.

## 4. Portable baseline (normal window)

First run a portable build once: the released portable zip, or this
checkout's `desktop\electron\out\SciREPL-win32-x64\SciREPL.exe`, which is
unpackaged and so uses the portable profile. Save a notebook named
`portable-canary` and close the app completely. Don't start the portable app
again until step 9.

```powershell
& "$pilot\Step4-Baseline.ps1" -Run $run
```

## 5. WACK on package A (administrator)

```powershell
& "$pilot\Step5-Wack.ps1" -Run $run
```

Checks first that the baseline belongs to this account and that nothing has
changed, then runs WACK and requires an overall `PASS`. It lists any failed
optional tests: record them. Pilot run 1 had one, **Blocked executables**,
from strings inside Electron's own binaries. WACK may run static checks only
("Running tests without application deployment"); record that too.

## 6. Install A (normal window)

```powershell
& "$pilot\Step6-InstallA.ps1" -Run $run
```

Repeats the clean-install checks, installs A, and checks that exactly A's
version is installed. It records the install in `$run\install-record.json`:
the package family and when its data folder was created. Each run starts
from a clean install, so that identifies this run's install. Then by hand, with the network on:

1. Start SciREPL from the Start menu. `portable-canary` must **not** appear.
2. Create a notebook named `store-canary` with a Python cell that prints
   something and a Markdown cell with `$e^{i\pi}+1=0$`. Run both.
3. Change a setting you'll recognise, such as the theme, and close the app.

## 7. Offline DOCX export (normal window)

Taking the machine offline also disconnects any assistant helping you from
the same machine, so have the remaining steps to hand first.

Take the machine physically offline: unplug network cables and turn Wi-Fi off
or airplane mode on. Disconnect VPNs. Note how you did it.

```powershell
& "$pilot\Step7-CheckOffline.ps1" -Run $run
```

It must print `… passed: …`, which is appended to `$run\offline-check.txt`.
If it lists anything, disconnect that and rerun; don't skip it. It checks
common active network paths, not proof of isolation. Then start SciREPL,
export `store-canary` as DOCX (no download or network prompt), open the file,
check the output and the formula, and close the app.

## 8. Upgrade to B, still offline (normal window)

```powershell
& "$pilot\Step8-UpgradeB.ps1" -Run $run
& "$pilot\Step7-CheckOffline.ps1" -Run $run
```

The upgrade installs B from its file, so it needs no network, and must
install exactly B's version. It checks the install record before and after:
the installed A must be this run's, and the upgrade must keep its data folder. Then start SciREPL: `store-canary` must still be
there with its output, and the setting kept. Export DOCX again and check it.

## 9. Profiles (normal window, network back on)

```powershell
& "$pilot\Step9-VerifyProfiles.ps1" -Run $run
```

The portable profile must match the step 4 snapshot, and the Store profile
must be at
`%LOCALAPPDATA%\Packages\<package family>\LocalCache\Roaming\SciREPL-Free-Store`.

Do any of the optional checks in the block guide's **Other checks before
inviting testers** now: cleanup uninstalls the app.

## Cleanup (administrator)

```powershell
& "$pilot\Cleanup.ps1" -Run $run
```

Removes the package (and with it `store-canary`) and this run's certificate,
then checks that the package, its data folder and both certificate entries
are gone. It removes the package only if it matches this run's install record.
A package from another run, or one with no record, is left installed and the
script fails after removing this run's certificate: cleanup of an old run
can't uninstall a later pilot and its test notebook. If you have checked
that the installed pilot is yours to remove, remove it by hand with the
block guide's cleanup.

The record relies on Windows creating the package's data folder under
`%LOCALAPPDATA%\Packages` at install time. That is untested until a run uses
these scripts: if step 6 stops with "No data folder", A is installed with no
record, so remove it with the block guide's cleanup, report it, and don't
loosen the check. Keep `$run` as the record; `$run\upgrade-src` can be deleted.

## Recording the run

Add a **Pilot run N** section to [WINDOWS_MSIX_PILOT.md](WINDOWS_MSIX_PILOT.md)
in the same form as run 1: the machine and tools, each step's result, failed
optional WACK tests, how the machine went offline, both DOCX results, the
Store profile path, the signed package hashes, and anything that stopped a
script and how it was fixed.

## What differs from the pasted blocks

- One run folder is passed as `-Run`; the blocks hard-coded `$pilot`.
- Steps 1 and 2 are one Node command. It runs `npm ci`, `configure` and
  `fetch:bundles` for A too; the block guide had them run by hand first.
  npm in B's clone runs without the parent's `npm_package_*` and
  `npm_config_local_prefix` variables, so it reads the clone's own
  `package.json`.
- Step 6 and step 8 check the installed version after `Add-AppxPackage`, and
  cleanup checks the package, its data and both certificates are gone. Run 1
  confirmed those by hand; errors from the Appx commands pass through the
  Windows PowerShell compatibility session, so the scripts check the result.
- Step 5 lists failed optional WACK tests. The gate is still the overall
  result.
- Cleanup removes the package only when it is this run's install; the block
  guide's cleanup removes any installed pilot package.
- Cleanup skips a certificate entry that is already gone, so it can be rerun.
