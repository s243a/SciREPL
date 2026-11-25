#Requires -Version 7
<#
.SYNOPSIS
  Pilot step 4: snapshot the portable profile before WACK and the install.
.DESCRIPTION
  Run in a normal (not administrator) window, after running a portable build
  once and saving a notebook named portable-canary. Writes
  <Run>\baseline-account.json and <Run>\portable-before.csv.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
Initialize-PilotAppx
$pilot = Resolve-PilotRun $Run

Assert-NoProfileOverride
Assert-PilotNotInstalled
Assert-NoLeftoverData
Assert-NoRealStoreProfile
if (-not (Test-Path "$env:APPDATA\SciREPL-Free-Electron")) { throw 'No portable profile: run the portable build once and save a notebook first.' }
if ((Test-Path "$pilot\portable-before.csv") -or (Test-Path "$pilot\baseline-account.json")) { throw 'This run already has a baseline.' }
# The account the baseline belongs to; the elevated WACK window must match it.
[pscustomobject]@{
  Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  AppData = $env:APPDATA
  LocalAppData = $env:LOCALAPPDATA
} | ConvertTo-Json | Set-Content "$pilot\baseline-account.json"
Get-PortableSnapshot | Export-Csv "$pilot\portable-before.csv" -NoTypeInformation
'Portable snapshot taken: ' + @(Import-Csv "$pilot\portable-before.csv").Count + ' files.'
