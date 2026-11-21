#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 7 (and step 8's recheck): check that common active network paths
  are down, and record a pass in <Run>\offline-check.txt.
.DESCRIPTION
  A preflight, not proof of isolation. Take the machine physically offline
  first (cable unplugged, Wi-Fi off or airplane mode on, VPNs disconnected).
  Any query error stops it. Count a DOCX export only after a recorded pass.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
$pilot = Resolve-PilotRun $Run

$state = Get-OfflineState
$problems = Get-OfflineProblem @state
if ($problems.Count) { throw "Not offline:`n  " + ($problems -join "`n  ") }
$line = "$(Get-Date -Format s) passed: no VPN or tunnel up, no default route on a connected interface, no connection with internet access, no physical adapter up."
Add-Content "$pilot\offline-check.txt" $line
$line
