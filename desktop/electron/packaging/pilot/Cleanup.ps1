#Requires -Version 7
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Remove this run's pilot package (and with it the Store profile, including
  store-canary) and this run's test certificate, then confirm both are gone.
  A pilot package from another run is left installed, and the script fails.
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

# Remove the package only if it is this run's install: cleanup of an older run
# must not uninstall a later run's package and its store-canary.
$installed = @(Get-AppxPackage (Get-PilotPackageName))
$leftAlone = $null
if ($installed.Count -gt 1) { throw "Found $($installed.Count) installed pilot packages; remove them by hand." }
if ($installed.Count -eq 1) {
  $recordFile = Join-Path $pilot 'install-record.json'
  $record = if (Test-Path -LiteralPath $recordFile) { Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json } else { $null }
  $data = Get-PilotDataFolder $installed[0].PackageFamilyName
  $problem = Get-InstallOwnershipProblem -Record $record -FamilyName $installed[0].PackageFamilyName -DataCreatedTicks $(if ($data) { $data.CreationTimeUtc.Ticks } else { $null })
  if ($problem) {
    $leftAlone = "Left $($installed[0].PackageFullName) installed: it isn't shown to be this run's install ($problem)."
  } else {
    Remove-AppxPackage -Package $installed[0].PackageFullName
  }
}
# Only the certificate created for this run.
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople') {
  if (Test-Path "$store\$thumb") { Remove-Item "$store\$thumb" }
}

# Confirm the result rather than trusting error propagation.
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople') {
  if (Test-Path "$store\$thumb") { throw "The test certificate is still in $store." }
}
if ($leftAlone) { throw "Removed certificate $thumb. $leftAlone" }
if (Get-AppxPackage (Get-PilotPackageName)) { throw 'The pilot package is still installed.' }
$data = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter "$(Get-PilotPackageName)_*")
if ($data.Count) { throw "Package data is still present: $($data.FullName -join ', ')" }
"Removed the pilot package and certificate $thumb."
