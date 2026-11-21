#Requires -Version 7
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Pilot step 5: Windows App Certification Kit on package A.
.DESCRIPTION
  WACK may install and launch the package (in pilot run 1 it ran static checks
  only), so this first checks, in this elevated session, that the step 4
  baseline belongs to this same account and that the clean state still holds.
  Each run writes a new report and requires an overall result of PASS. Failed
  optional tests are listed but do not stop the run; record them.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run
$appcert = 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe'
if (-not (Test-Path $appcert)) { throw 'appcert.exe not found: install the App Certification Kit.' }

# Preflight in this elevated session, immediately before WACK.
Assert-BaselineAccount $pilot
Assert-NoProfileOverride
Assert-PilotNotInstalled 'The pilot package is installed: uninstall it first.'
Assert-NoLeftoverData
Assert-NoRealStoreProfile 'The real %APPDATA% has a SciREPL-Free-Store folder.'
Assert-PortableUnchanged $pilot 'The portable profile changed since step 4.'

$a = Get-PilotPackage $pilot A
$report = Join-Path $pilot ('wack-A-{0:yyyyMMdd-HHmmss}.xml' -f (Get-Date))
if (Test-Path $report) { throw "$report already exists." }
& $appcert reset
if ($LASTEXITCODE -ne 0) { throw "appcert reset failed (exit $LASTEXITCODE)." }
& $appcert test -appxpackagepath $a.FullName -reportoutputpath $report
if ($LASTEXITCODE -ne 0) { throw "appcert test failed (exit $LASTEXITCODE)." }
if (-not (Test-Path $report)) { throw 'WACK wrote no report.' }
$summary = Get-WackSummary ([xml](Get-Content $report -Raw))
foreach ($name in $summary.FailedOptional) { Write-Host "Optional test failed (record it): $name" }
if ($summary.Overall -ne 'PASS') { throw "WACK overall result is '$($summary.Overall)', not PASS. Read $report." }
"WACK: PASS ($report)"
