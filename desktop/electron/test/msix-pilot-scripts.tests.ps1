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
