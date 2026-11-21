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

$before = (Get-AppxPackage (Get-PilotPackageName)).Version
if (-not $before) { throw 'Package A is not installed.' }
$expected = "$((Get-PilotBuildInfo $pilot B).appVersion).0"
Add-AppxPackage (Get-PilotPackage $pilot B).FullName
$after = @(Get-AppxPackage (Get-PilotPackageName))
if ($after.Count -ne 1) { throw "Expected one installed pilot package; found $($after.Count)." }
if ([version]"$($after[0].Version)" -le [version]"$before") { throw "The installed version is $($after[0].Version); expected newer than $before." }
if ("$($after[0].Version)" -ne $expected) { throw "The installed version is $($after[0].Version); expected $expected." }
"Upgraded $before -> $($after[0].Version)"
