#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 6: repeat the clean-install checks, then install package A.
.DESCRIPTION
  Run in a normal (not administrator) window. Afterwards, by hand: start
  SciREPL from the Start menu (portable-canary must not appear), create the
  store-canary notebook and change one setting.

  Gives the run a random RunId, kept in install-record.json and in a marker
  in the package's data folder; step 8 and cleanup act only on an install
  that carries it. If Windows creates the data folder only at first launch,
  the script asks you to start SciREPL and waits for it before marking.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run

Assert-NoProfileOverride
Assert-PilotNotInstalled 'The pilot package is still installed after WACK: uninstall it first.'
Assert-NoLeftoverData
Assert-NoRealStoreProfile 'A SciREPL-Free-Store folder appeared in the real %APPDATA%.'
Assert-PortableUnchanged $pilot 'The portable profile changed before install (during WACK?).'

$expected = "$((Get-PilotBuildInfo $pilot A).appVersion).0"
Add-AppxPackage (Get-PilotPackage $pilot A).FullName
# Check the result rather than trusting error propagation through the
# Windows PowerShell compatibility session.
$installed = @(Get-AppxPackage (Get-PilotPackageName))
if ($installed.Count -ne 1 -or "$($installed[0].Version)" -ne $expected) {
  throw "Expected $expected installed; found [$(($installed | ForEach-Object { "$($_.Version)" }) -join ', ')]."
}
# Mark this install as the run's, so only this run's scripts upgrade or remove it.
Complete-PilotInstall $pilot $expected -OnWaiting {
  Write-Host "Windows hasn't created the package's data folder yet. Start SciREPL from the Start menu now (that is step 1 below); this waits up to 10 minutes."
}
"Installed $expected and marked it as this run's install."
