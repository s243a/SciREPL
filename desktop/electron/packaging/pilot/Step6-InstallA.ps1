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
  that carries it. If the data folder doesn't exist yet, run
  Step6-MarkInstall.ps1 after starting SciREPL once.
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
New-PilotInstallRecord $pilot $expected
if (Set-PilotInstallMarker $pilot) {
  "Installed $expected and marked it as this run's install."
} else {
  "Installed $expected. Its data folder doesn't exist yet, so it isn't marked: after starting SciREPL once, run Step6-MarkInstall.ps1. Until then step 8 and cleanup won't touch it."
}
