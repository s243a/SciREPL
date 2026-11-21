#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 9: the portable profile is untouched, and the Store profile is in
  the installed package's redirected AppData.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run

Assert-PortableUnchanged $pilot 'The portable profile changed.'
Assert-NoRealStoreProfile 'Store data was written to the real %APPDATA%.'

$pkg = @(Get-AppxPackage (Get-PilotPackageName))
if ($pkg.Count -ne 1) { throw "Expected one installed pilot package; found $($pkg.Count)." }
$pkgData = Join-Path $env:LOCALAPPDATA "Packages\$($pkg[0].PackageFamilyName)"
$expected = Join-Path $pkgData 'LocalCache\Roaming\SciREPL-Free-Store'
$found = @(Get-ChildItem $pkgData -Recurse -Directory -Filter 'SciREPL-Free-Store' | Select-Object -ExpandProperty FullName)
if ($found.Count -ne 1 -or $found[0] -ne $expected) {
  throw "Expected exactly one Store profile at $expected; found [$($found -join ', ')]."
}
if (-not (Get-ChildItem $expected -Recurse -File | Select-Object -First 1)) { throw "$expected is empty." }
"Portable profile unchanged. Store profile: $expected"
