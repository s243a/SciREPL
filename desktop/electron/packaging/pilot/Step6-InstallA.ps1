#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 6: repeat the clean-install checks, then install package A.
.DESCRIPTION
  Run in a normal (not administrator) window. Afterwards, by hand: start
  SciREPL from the Start menu (portable-canary must not appear), create the
  store-canary notebook and change one setting.
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
"Installed $expected"
