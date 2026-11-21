#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 6, only when Step6-InstallA.ps1 said the install isn't marked:
  mark package A's install as this run's.
.DESCRIPTION
  Run in a normal (not administrator) window after starting SciREPL once, so
  that Windows has created the package's data folder. It marks the install
  only if this run's record is unmarked, exactly this run's A is installed,
  and no other run has marked it.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run

if (-not (Set-PilotInstallMarker $pilot)) {
  throw "The package's data folder still doesn't exist: start SciREPL from the Start menu, close it, and rerun."
}
'Marked the install as this run''s.'
