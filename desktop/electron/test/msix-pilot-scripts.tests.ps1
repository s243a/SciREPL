#Requires -Version 7
# Checks for the MSIX pilot scripts that need PowerShell but not Windows:
# every script parses, and the pure decision functions behave. Prints one JSON
# object per check ({ name, passed, detail }) for msix-pilot-scripts.unit.test.mjs.
param([Parameter(Mandatory)][string]$PilotDir, [Parameter(Mandatory)][string]$Fixture)
$ErrorActionPreference = 'Stop'
function Out-Check([string]$Name, [bool]$Passed, [string]$Detail = '') {
  [pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail } | ConvertTo-Json -Compress
}

foreach ($f in Get-ChildItem $PilotDir -Include '*.ps1', '*.psm1' -Recurse) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  Out-Check "parses: $($f.Name)" ($errors.Count -eq 0) (($errors | ForEach-Object Message) -join '; ')
}

Import-Module (Join-Path $PilotDir 'PilotCommon.psm1') -Force
Out-Check 'importing PilotCommon runs nothing Windows-specific' $true

$up      = [pscustomobject]@{ ifIndex = 1; ConnectionState = 'Connected' }
$down    = [pscustomobject]@{ ifIndex = 2; ConnectionState = 'Disconnected' }
$hostOnly = [pscustomobject]@{ ifIndex = 3; ConnectionState = 'Connected' }
$route1  = [pscustomobject]@{ DestinationPrefix = '0.0.0.0/0'; ifIndex = 1; InterfaceAlias = 'Ethernet' }
$route2  = [pscustomobject]@{ DestinationPrefix = '::/0'; ifIndex = 2; InterfaceAlias = 'Wi-Fi' }
$local   = [pscustomobject]@{ DestinationPrefix = '172.20.0.0/20'; ifIndex = 3; InterfaceAlias = 'vEthernet (WSL)' }

$p = Get-OfflineProblem -Interfaces $down, $hostOnly -Routes $route2, $local
Out-Check 'offline: a host-only switch without a default route passes' ($p.Count -eq 0) ($p -join '; ')
$p = Get-OfflineProblem -Interfaces $up, $down -Routes $route1
Out-Check 'offline: a default route on a connected interface is flagged' ($p.Count -eq 1 -and $p[0] -match 'default route 0.0.0.0/0 via Ethernet') ($p -join '; ')
$p = Get-OfflineProblem -Interfaces $down -Profiles ([pscustomobject]@{ InterfaceAlias = 'Wi-Fi'; IPv4Connectivity = 4; IPv6Connectivity = 1 })
Out-Check 'offline: a connection profile with internet access is flagged' ($p.Count -eq 1) ($p -join '; ')
$p = Get-OfflineProblem -Interfaces $down -Profiles ([pscustomobject]@{ InterfaceAlias = 'vEthernet (WSL)'; IPv4Connectivity = 1; IPv6Connectivity = 1 })
Out-Check 'offline: a no-traffic profile passes' ($p.Count -eq 0) ($p -join '; ')
$p = Get-OfflineProblem -Interfaces $down -Physical ([pscustomobject]@{ Name = 'Ethernet'; Status = 'Up' }), ([pscustomobject]@{ Name = 'Wi-Fi'; Status = 'Disconnected' })
Out-Check 'offline: only physical adapters that are up are flagged' ($p.Count -eq 1 -and $p[0] -eq 'physical adapter up: Ethernet') ($p -join '; ')
$p = Get-OfflineProblem -Interfaces $down -Vpns ([pscustomobject]@{ Name = 'Work'; ConnectionStatus = 'Connected' }), ([pscustomobject]@{ Name = 'Old'; ConnectionStatus = 'Disconnected' })
Out-Check 'offline: a Windows VPN that is not disconnected is flagged' ($p.Count -eq 1 -and $p[0] -match 'Work') ($p -join '; ')
$p = Get-OfflineProblem -Interfaces $down -Tunnels ([pscustomobject]@{ Name = 'wg0'; Status = 'Up'; InterfaceDescription = 'WireGuard Tunnel' }), ([pscustomobject]@{ Name = 'vEthernet (WSL)'; Status = 'Up'; InterfaceDescription = 'Hyper-V Virtual Ethernet Adapter' })
Out-Check 'offline: a VPN or tunnel adapter that is up is flagged; a Hyper-V switch is not' ($p.Count -eq 1 -and $p[0] -match 'wg0') ($p -join '; ')
$threw = $false; try { Get-OfflineProblem -Interfaces @() | Out-Null } catch { $threw = $true }
Out-Check 'offline: no interfaces at all is an error, not a pass' $threw

$s = Get-WackSummary ([xml](Get-Content $Fixture -Raw))
Out-Check 'WACK: the overall result is read from the REPORT attribute' ($s.Overall -eq 'PASS') $s.Overall
Out-Check 'WACK: failed optional tests are listed' (@($s.FailedOptional).Count -eq 1 -and $s.FailedOptional[0] -eq 'Blocked executables') (@($s.FailedOptional) -join ', ')
$s = Get-WackSummary ([xml]'<REPORT><REQUIREMENTS /></REPORT>')
Out-Check 'WACK: a report without OVERALL_RESULT gives an empty result (the gate fails closed)' ($s.Overall -eq '') $s.Overall


# Install ownership. Get-AppxPackage and Remove-AppxPackage are stand-ins
# defined here (the real ones exist only on Windows); %LOCALAPPDATA% points at
# a temporary folder.
$tmp = Join-Path ([IO.Path]::GetTempPath()) "pilot-test-$([guid]::NewGuid())"
$savedLocal = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path $tmp 'local'
$family = 'SciREPL.FreePilot.LocalTest_2xd92v2yysscm'
$global:pilotInstalled = @()
$global:pilotRemoved = @()
function global:Get-AppxPackage { param([string]$Name) $global:pilotInstalled }
function global:Remove-AppxPackage { param([string]$Package) $global:pilotRemoved += $Package; $global:pilotInstalled = @() }
function Install-Fake([string]$Version, [switch]$NoDataFolder) {
  $global:pilotInstalled = @([pscustomobject]@{ PackageFamilyName = $family; Version = $Version; PackageFullName = "SciREPL.FreePilot.LocalTest_$($Version)_x64__2xd92v2yysscm" })
  $data = Join-Path $env:LOCALAPPDATA "Packages\$family"
  if (Test-Path $data) { Remove-Item $data -Recurse -Force }
  if (-not $NoDataFolder) { New-Item -ItemType Directory -Force (Join-Path $data 'LocalState') | Out-Null }
}
function New-Run([string]$Name) { $d = Join-Path $tmp $Name; New-Item -ItemType Directory -Force $d | Out-Null; $d }
try {
  $run1 = New-Run 'run-1'; $run2 = New-Run 'run-2'

  Install-Fake '1.5.0.0'
  New-PilotInstallRecord $run1 '1.5.0.0'
  $marked = Set-PilotInstallMarker $run1
  Out-Check 'ownership: step 6 marks its own fresh install' ($marked -eq $true -and (Get-PilotInstallRecord $run1).Marked -eq $true)
  Out-Check "ownership: the run's own install passes the step 8 check" ("$((Assert-PilotOwnsInstall $run1).Version)" -eq '1.5.0.0')

  # Run 1 is cleaned up, then run 2 installs the same package version.
  $left = Remove-PilotRunPackage $run1
  Out-Check "cleanup: a run's own install is removed" ($null -eq $left -and $global:pilotRemoved.Count -eq 1) "$left"
  Install-Fake '1.5.0.0'
  New-PilotInstallRecord $run2 '1.5.0.0'
  [void](Set-PilotInstallMarker $run2)
  $global:pilotRemoved = @()
  $left = Remove-PilotRunPackage $run1
  Out-Check "cleanup: rerunning an old run's cleanup leaves a newer install of the same version alone" ($global:pilotRemoved.Count -eq 0 -and $left -match 'marked by another run') "$left"
  $threw = $false; try { Assert-PilotOwnsInstall $run1 | Out-Null } catch { $threw = $true }
  Out-Check "upgrade: an old run's step 8 refuses a newer run's install" $threw
  $threw = $false; try { [void](Set-PilotInstallMarker $run1) } catch { $threw = $true }
  Out-Check "mark: an old run can't re-mark a newer run's install" $threw
  $left = Remove-PilotRunPackage $run2
  Out-Check "cleanup: the newer run's own cleanup removes it" ($null -eq $left -and $global:pilotRemoved.Count -eq 1) "$left"

  # No data folder at install: unmarked until Step6-MarkInstall.
  $run3 = New-Run 'run-3'
  Install-Fake '1.5.0.0' -NoDataFolder
  New-PilotInstallRecord $run3 '1.5.0.0'
  $marked = Set-PilotInstallMarker $run3
  $global:pilotRemoved = @()
  $left = Remove-PilotRunPackage $run3
  Out-Check 'cleanup: an install not yet marked is left alone' ($marked -eq $false -and $global:pilotRemoved.Count -eq 0 -and $left -match 'never marked') "$left"
  New-Item -ItemType Directory -Force (Join-Path $env:LOCALAPPDATA "Packages\$family\LocalState") | Out-Null
  Out-Check 'mark: Step6-MarkInstall marks it once the data folder exists' ((Set-PilotInstallMarker $run3) -eq $true)
  $global:pilotInstalled[0].Version = '1.5.1.0'
  $run4 = New-Run 'run-4'
  New-PilotInstallRecord $run4 '1.5.0.0'
  $p = Get-MarkProblem -Record (Get-PilotInstallRecord $run4) -Installed $global:pilotInstalled -MarkerPath 'x' -ExistingMarker $null
  Out-Check 'mark: a different installed version is not marked' ($p -match 'version 1.5.1.0') "$p"
  $rec = [pscustomobject]@{ RunId = 'old'; FamilyName = $family; Version = '1.5.0.0'; Marked = $false }
  $one = @([pscustomobject]@{ PackageFamilyName = $family; Version = '1.5.0.0' })
  $p = Get-MarkProblem -Record $rec -Installed $one -MarkerPath 'x' -ExistingMarker ([pscustomobject]@{ RunId = 'new'; Run = 'C:\pilot\run-5' })
  Out-Check "mark: an old run's unmarked record can't take over a newer run's marked install" ($p -match 'already marked by another run') "$p"
  $global:pilotInstalled = @()
  Out-Check 'cleanup: nothing installed is not an error' ($null -eq (Remove-PilotRunPackage $run3))
  $p = Get-InstallOwnershipProblem -Record $null -FamilyName $family -Marker $null
  Out-Check 'cleanup: without an install record the package is left alone' ($p -match 'install-record.json') "$p"
} finally {
  $env:LOCALAPPDATA = $savedLocal
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
