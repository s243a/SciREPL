# PilotCommon.psm1: shared checks for the local MSIX pilot scripts
# (docs/WINDOWS_MSIX_PILOT_SCRIPTS.md). The checks are those of the pasted
# blocks in docs/WINDOWS_MSIX_PILOT.md that ran in pilot run 1.
#
# Importing this module runs nothing Windows-specific, so the pure functions
# (Get-OfflineProblem, Get-WackSummary) can be tested on any platform.

$ErrorActionPreference = 'Stop'

$script:PackageName = 'SciREPL.FreePilot.LocalTest'

function Get-PilotPackageName { $script:PackageName }

# PowerShell 7 can't load the Appx module natively; use the Windows PowerShell
# one. -Global so the commands are visible to the calling script.
function Initialize-PilotAppx {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    Import-Module Appx -UseWindowsPowerShell -Global -WarningAction SilentlyContinue
  }
}

function Resolve-PilotRun {
  param([Parameter(Mandatory)][string]$Run)
  if (-not (Test-Path -LiteralPath $Run -PathType Container)) {
    throw "Run folder $Run does not exist: build the packages first (npm run pilot:packages -- --run $Run)."
  }
  (Resolve-Path -LiteralPath $Run).Path
}

function Get-PilotPackage {
  param([Parameter(Mandatory)][string]$RunPath, [Parameter(Mandatory)][ValidateSet('A', 'B')][string]$Which)
  $m = @(Get-ChildItem (Join-Path $RunPath "$Which\*.msix"))
  if ($m.Count -ne 1) { throw "Expected one package in $Which; found $($m.Count)." }
  $m[0]
}

function Get-PilotBuildInfo {
  param([Parameter(Mandatory)][string]$RunPath, [Parameter(Mandatory)][ValidateSet('A', 'B')][string]$Which)
  Get-Content (Join-Path $RunPath "$Which\build-info.json") -Raw | ConvertFrom-Json
}

function Assert-NoProfileOverride {
  foreach ($scope in 'Process', 'User', 'Machine') {
    if ([Environment]::GetEnvironmentVariable('SCIREPL_USER_DATA', $scope)) { throw "SCIREPL_USER_DATA is set ($scope); it overrides both profiles." }
  }
}

function Assert-PilotNotInstalled {
  param([string]$Message = 'The pilot package is already installed: uninstall it first.')
  if (Get-AppxPackage $script:PackageName) { throw $Message }
}

# Any error while scanning stops the caller.
function Assert-NoLeftoverData {
  $leftover = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter "$($script:PackageName)_*" -ErrorAction Stop)
  if ($leftover.Count) { throw "Data from an earlier install is still present: $($leftover.FullName -join ', ')" }
}

function Assert-NoRealStoreProfile {
  param([string]$Message = 'The real %APPDATA% already has a SciREPL-Free-Store folder.')
  if (Test-Path "$env:APPDATA\SciREPL-Free-Store") { throw $Message }
}

function Get-PortableSnapshot {
  Get-ChildItem "$env:APPDATA\SciREPL-Free-Electron" -Recurse -File | Get-FileHash | Select-Object Hash, Path
}

function Assert-PortableUnchanged {
  param([Parameter(Mandatory)][string]$RunPath, [Parameter(Mandatory)][string]$Message)
  $before = @(Import-Csv (Join-Path $RunPath 'portable-before.csv'))
  if (-not $before.Count) { throw 'The portable snapshot is empty: redo the baseline in a new run folder.' }
  $diff = Compare-Object $before @(Get-PortableSnapshot) -Property Hash, Path
  if ($diff) { $diff | Format-Table -AutoSize | Out-String | Write-Host; throw $Message }
}

function Assert-BaselineAccount {
  param([Parameter(Mandatory)][string]$RunPath)
  $file = Join-Path $RunPath 'baseline-account.json'
  if (-not (Test-Path $file) -or -not (Test-Path (Join-Path $RunPath 'portable-before.csv'))) { throw 'No baseline: run Step4-Baseline.ps1 first.' }
  $account = Get-Content $file -Raw | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($account.Sid -ne $sid -or $account.AppData -ne $env:APPDATA -or $account.LocalAppData -ne $env:LOCALAPPDATA) {
    throw "This window runs as $sid ($env:APPDATA); the baseline belongs to $($account.Sid) ($($account.AppData)). Open the administrator window from the same account."
  }
}

# Pure: what in the given network state counts as "not offline". Each input is
# the output of the matching query in Get-OfflineState.
function Get-OfflineProblem {
  param(
    [object[]]$Interfaces = @(), [object[]]$Routes = @(), [object[]]$Profiles = @(),
    [object[]]$Physical = @(), [object[]]$Vpns = @(), [object[]]$Tunnels = @()
  )
  if (-not $Interfaces.Count) { throw 'No IP interfaces were reported; offline status cannot be established.' }
  $problems = @()
  foreach ($r in @($Routes | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0', '::/0' })) {
    $state = @($Interfaces | Where-Object { $_.ifIndex -eq $r.ifIndex } | Select-Object -ExpandProperty ConnectionState -Unique)
    if ($state.Count -ne 1 -or "$($state[0])" -ne 'Disconnected') {
      $problems += "default route $($r.DestinationPrefix) via $($r.InterfaceAlias) (state: $($state -join '/'))"
    }
  }
  foreach ($p in $Profiles) {
    if ("$($p.IPv4Connectivity)" -in '4', 'Internet' -or "$($p.IPv6Connectivity)" -in '4', 'Internet') {   # 4 = Internet
      $problems += "connection profile on $($p.InterfaceAlias) (IPv4 $($p.IPv4Connectivity), IPv6 $($p.IPv6Connectivity))"
    }
  }
  foreach ($a in @($Physical | Where-Object { "$($_.Status)" -eq 'Up' })) { $problems += "physical adapter up: $($a.Name)" }
  foreach ($v in @($Vpns | Where-Object { "$($_.ConnectionStatus)" -ne 'Disconnected' })) { $problems += "Windows VPN not disconnected: $($v.Name) ($($v.ConnectionStatus))" }
  foreach ($t in @($Tunnels | Where-Object { "$($_.Status)" -eq 'Up' -and $_.InterfaceDescription -match 'VPN|TAP|TUN|WireGuard|Wintun|OpenVPN|Tunnel|PPP' })) {
    $problems += "VPN or tunnel adapter up: $($t.Name) ($($t.InterfaceDescription))"
  }
  , $problems
}

# Any query error stops the caller: offline status must be shown, not assumed.
function Get-OfflineState {
  @{
    Interfaces = @(Get-NetIPInterface -ErrorAction Stop)
    Routes     = @(Get-NetRoute -ErrorAction Stop)
    Profiles   = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetConnectionProfile -ErrorAction Stop)
    Physical   = @(Get-NetAdapter -Physical -ErrorAction Stop)
    Vpns       = @(@(Get-VpnConnection -ErrorAction Stop) + @(Get-VpnConnection -AllUserConnection -ErrorAction Stop))
    Tunnels    = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
  }
}

# Pure: the overall result and any failed optional tests in a WACK report.
function Get-WackSummary {
  param([Parameter(Mandatory)][xml]$Report)
  $failedOptional = @(foreach ($t in @($Report.SelectNodes('//TEST'))) {
    $result = $t.SelectSingleNode('RESULT')
    if ($t.GetAttribute('OPTIONAL') -eq 'TRUE' -and $result -and $result.InnerText.Trim() -eq 'FAIL') { $t.GetAttribute('NAME') }
  })
  $root = $Report.SelectSingleNode('/REPORT')
  [pscustomobject]@{ Overall = if ($root) { $root.GetAttribute('OVERALL_RESULT') } else { '' }; FailedOptional = $failedOptional }
}

Export-ModuleMember -Function *
