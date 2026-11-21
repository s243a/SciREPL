#Requires -Version 7
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Remove the pilot package (and with it the Store profile, including
  store-canary) and this run's test certificate, then confirm both are gone.
.DESCRIPTION
  Keeps the run folder with the packages, hashes and reports; its upgrade-src
  folder can be deleted. Turn the network back on first.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run
$thumb = (Get-Content "$pilot\thumbprint.txt").Trim()
if ($thumb -notmatch '^[0-9A-F]{40}$') { throw "thumbprint.txt does not hold a certificate thumbprint: '$thumb'." }

Get-AppxPackage (Get-PilotPackageName) | ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName }
# Only the certificate created for this run.
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople') {
  if (Test-Path "$store\$thumb") { Remove-Item "$store\$thumb" }
}

# Confirm the result rather than trusting error propagation.
if (Get-AppxPackage (Get-PilotPackageName)) { throw 'The pilot package is still installed.' }
$data = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter "$(Get-PilotPackageName)_*")
if ($data.Count) { throw "Package data is still present: $($data.FullName -join ', ')" }
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople') {
  if (Test-Path "$store\$thumb") { throw "The test certificate is still in $store." }
}
"Removed the pilot package and certificate $thumb."
