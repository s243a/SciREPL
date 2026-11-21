#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 8: upgrade the installed package A to package B, offline.
.DESCRIPTION
  Afterwards run Step7-CheckOffline.ps1 again, then check by hand that
  store-canary and the changed setting survived, and export DOCX again.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run

$a = "$((Get-PilotBuildInfo $pilot A).appVersion).0"
$expected = "$((Get-PilotBuildInfo $pilot B).appVersion).0"
$before = "$((Assert-PilotOwnsInstall $pilot).Version)"
if ($before -ne $a) { throw "Version $before is installed; the upgrade starts from this run's A ($a)." }
Add-AppxPackage (Get-PilotPackage $pilot B).FullName
$after = Assert-PilotOwnsInstall $pilot   # same marker: the upgrade kept the data folder
if ("$($after.Version)" -ne $expected) { throw "The installed version is $($after.Version); expected $expected." }
"Upgraded $before -> $($after.Version)"
