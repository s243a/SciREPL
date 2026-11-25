#Requires -Version 7
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Pilot step 3: create a test certificate, trust it in LocalMachine\TrustedPeople,
  sign packages A and B, and verify both signatures.
.DESCRIPTION
  Changes the machine: adds a self-signed certificate to CurrentUser\My and
  LocalMachine\TrustedPeople (never Trusted Root). Its thumbprint is saved in
  <Run>\thumbprint.txt so Cleanup.ps1 removes exactly this certificate.
#>
param([Parameter(Mandatory)][string]$Run)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'PilotCommon.psm1') -Force
$pilot = Resolve-PilotRun $Run

$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\signtool.exe' -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found: install the Windows SDK.' }
if (Test-Path "$pilot\thumbprint.txt") { throw 'This run already has a test certificate.' }
$packages = @((Get-PilotPackage $pilot A), (Get-PilotPackage $pilot B))

# Subject must equal the placeholder publisher.
$cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=SciREPL Local Test' `
  -KeyUsage DigitalSignature -FriendlyName 'SciREPL MSIX local test' `
  -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$thumb = $cert.Thumbprint
Set-Content "$pilot\thumbprint.txt" $thumb   # Cleanup.ps1 removes only this certificate
Export-Certificate -Cert $cert -FilePath "$pilot\scirepl-test.cer" | Out-Null
Import-Certificate -FilePath "$pilot\scirepl-test.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null

foreach ($m in $packages) {
  & $signtool.FullName sign /fd SHA256 /sha1 $thumb $m.FullName
  if ($LASTEXITCODE -ne 0) { throw "Signing $($m.Name) failed (exit $LASTEXITCODE)." }
  & $signtool.FullName verify /pa $m.FullName
  if ($LASTEXITCODE -ne 0) { throw "The signature on $($m.Name) did not verify under the test trust setup (exit $LASTEXITCODE)." }
  $signer = (Get-AuthenticodeSignature $m.FullName).SignerCertificate
  if (-not $signer -or $signer.Thumbprint -ne $thumb) { throw "$($m.Name) is signed by '$($signer.Thumbprint)', not the test certificate $thumb." }
  Get-FileHash $m.FullName -Algorithm SHA256 | Select-Object Hash, Path |
    Export-Csv "$pilot\signed-packages.csv" -Append -NoTypeInformation
}
"Both packages signed and verified with $thumb"
