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

# Which run an install belongs to. Step 6 gives each run a random RunId, kept
# in the run folder (install-record.json) and, once the package's data folder
# exists, in a marker file inside it. The marker survives the A -> B upgrade
# and goes with the uninstall. Only an install whose marker carries this run's
# RunId may be upgraded or removed by this run's scripts.
$script:MarkerName = 'scirepl-pilot-run.json'

function Get-PilotDataFolder {
  param([Parameter(Mandatory)][string]$FamilyName)
  $dir = Join-Path (Join-Path $env:LOCALAPPDATA 'Packages') $FamilyName
  if (Test-Path -LiteralPath $dir -PathType Container) { (Get-Item -LiteralPath $dir).FullName } else { $null }
}

# The marker's folder: LocalState, which Windows creates with the data folder.
function Get-PilotMarkerPath {
  param([Parameter(Mandatory)][string]$FamilyName)
  $data = Get-PilotDataFolder $FamilyName
  if (-not $data) { return $null }
  $state = Join-Path $data 'LocalState'
  if (-not (Test-Path -LiteralPath $state -PathType Container)) { return $null }
  Join-Path $state $script:MarkerName
}

function Read-PilotJson {
  param([string]$Path)
  if ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf)) { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } else { $null }
}

function Get-PilotInstallRecord {
  param([Parameter(Mandatory)][string]$RunPath)
  Read-PilotJson (Join-Path $RunPath 'install-record.json')
}

# Pure: why the installed package can't be shown to be this run's install, or
# $null when it can. Inputs: the run's install record, the installed
# package's family name, and the marker read from its data folder.
function Get-InstallOwnershipProblem {
  param([object]$Record, [string]$FamilyName, [object]$Marker)
  if (-not $Record) { return 'this run has no install-record.json (Step6-InstallA.ps1 writes it)' }
  if (-not $Record.RunId) { return 'the install record has no RunId' }
  if ("$($Record.FamilyName)" -ne $FamilyName) { return "family $FamilyName, recorded $($Record.FamilyName)" }
  if ($Record.Marked -ne $true) { return 'this run never marked its install (Step6-MarkInstall.ps1)' }
  if (-not $Marker) { return 'its data folder has no pilot marker' }
  if ("$($Marker.RunId)" -ne "$($Record.RunId)") { return "it is marked by another run ($($Marker.Run), RunId $($Marker.RunId))" }
  $null
}

# The one installed pilot package, checked to be this run's.
function Assert-PilotOwnsInstall {
  param([Parameter(Mandatory)][string]$RunPath)
  $installed = @(Get-AppxPackage $script:PackageName)
  if ($installed.Count -ne 1) { throw "Expected one installed pilot package; found $($installed.Count)." }
  $marker = Read-PilotJson (Get-PilotMarkerPath $installed[0].PackageFamilyName)
  $problem = Get-InstallOwnershipProblem -Record (Get-PilotInstallRecord $RunPath) -FamilyName $installed[0].PackageFamilyName -Marker $marker
  if ($problem) { throw "The installed pilot package is not shown to be this run's: $problem" }
  $installed[0]
}

# Step 6, straight after a clean install of A: a new RunId, recorded unmarked.
function New-PilotInstallRecord {
  param([Parameter(Mandatory)][string]$RunPath, [Parameter(Mandatory)][string]$Version)
  $installed = @(Get-AppxPackage $script:PackageName)
  if ($installed.Count -ne 1) { throw "Expected one installed pilot package; found $($installed.Count)." }
  [pscustomobject]@{
    RunId = [guid]::NewGuid().ToString()
    Run = $RunPath
    FamilyName = $installed[0].PackageFamilyName
    Version = $Version
    Marked = $false
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunPath 'install-record.json')
}

# Pure: why an unmarked install can't be marked as this run's, or $null.
function Get-MarkProblem {
  param([object]$Record, [object[]]$Installed, [string]$MarkerPath, [object]$ExistingMarker)
  if (-not $Record) { return 'this run has no install-record.json: run Step6-InstallA.ps1' }
  if ($Record.Marked -eq $true) { return 'this run already marked its install' }
  if (@($Installed).Count -ne 1) { return "expected one installed pilot package; found $(@($Installed).Count)" }
  if ("$($Installed[0].PackageFamilyName)" -ne "$($Record.FamilyName)") { return "family $($Installed[0].PackageFamilyName), recorded $($Record.FamilyName)" }
  if ("$($Installed[0].Version)" -ne "$($Record.Version)") { return "version $($Installed[0].Version) is installed; this run installed $($Record.Version)" }
  if (-not $MarkerPath) { return 'its data folder does not exist yet' }
  if ($ExistingMarker) { return "it is already marked by another run ($($ExistingMarker.Run))" }
  $null
}

# Write the marker into the installed package's data folder and mark the
# record. Returns $true when marked, $false when the data folder doesn't exist
# yet (start the app once, then Step6-MarkInstall.ps1); throws otherwise.
function Set-PilotInstallMarker {
  param([Parameter(Mandatory)][string]$RunPath)
  $record = Get-PilotInstallRecord $RunPath
  $installed = @(Get-AppxPackage $script:PackageName)
  $markerPath = if ($installed.Count -eq 1) { Get-PilotMarkerPath $installed[0].PackageFamilyName } else { $null }
  $problem = Get-MarkProblem -Record $record -Installed $installed -MarkerPath $markerPath -ExistingMarker (Read-PilotJson $markerPath)
  if ($problem -eq 'its data folder does not exist yet') { return $false }
  if ($problem) { throw "Can't mark the install as this run's: $problem" }
  [pscustomobject]@{ RunId = $record.RunId; Run = $RunPath } | ConvertTo-Json | Set-Content -LiteralPath $markerPath
  $record.Marked = $true
  $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunPath 'install-record.json')
  $true
}

# Cleanup: remove the pilot package only if it is this run's install. Returns
# $null when nothing is installed or it was removed, or why it was left alone.
function Remove-PilotRunPackage {
  param([Parameter(Mandatory)][string]$RunPath)
  $installed = @(Get-AppxPackage $script:PackageName)
  if ($installed.Count -eq 0) { return $null }
  if ($installed.Count -gt 1) { return "found $($installed.Count) installed pilot packages" }
  $marker = Read-PilotJson (Get-PilotMarkerPath $installed[0].PackageFamilyName)
  $problem = Get-InstallOwnershipProblem -Record (Get-PilotInstallRecord $RunPath) -FamilyName $installed[0].PackageFamilyName -Marker $marker
  if ($problem) { return "left $($installed[0].PackageFullName) installed: $problem" }
  Remove-AppxPackage -Package $installed[0].PackageFullName
  $null
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
