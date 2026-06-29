$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$appDir = Join-Path $dist 'CoupangStockApp'
$setupPayload = Join-Path $dist 'coupang_stock_setup_payload'
$zipPath = Join-Path $setupPayload 'coupang-stock-app.zip'
$setupExe = Join-Path $dist 'CoupangStockLookupSetup.exe'
$launcherSource = Join-Path $root 'tools\windows_launcher\CoupangStockLauncher.cs'
$installerSource = Join-Path $root 'tools\windows_launcher\CoupangStockInstaller.cs'
$launcherExe = Join-Path $appDir 'CoupangStockLauncher.exe'

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$csc) {
  throw 'C# compiler was not found. Expected .NET Framework csc.exe.'
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

$itemsToCopy = @(
  'tools\coupang_stock_helper.js'
)

foreach ($item in $itemsToCopy) {
  $src = Join-Path $root $item
  if (!(Test-Path $src)) { continue }
  $dest = Join-Path $appDir $item
  $destParent = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  Copy-Item -LiteralPath $src -Destination $destParent -Recurse -Force
}

& $csc /nologo /target:winexe /out:$launcherExe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll $launcherSource
if (!(Test-Path $launcherExe)) { throw 'Launcher build failed.' }

if (Test-Path $setupPayload) { Remove-Item -LiteralPath $setupPayload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $setupPayload | Out-Null
Compress-Archive -Path (Join-Path $appDir '*') -DestinationPath $zipPath -Force

if (Test-Path $setupExe) { Remove-Item -LiteralPath $setupExe -Force }
& $csc /nologo /target:winexe /out:$setupExe /r:System.Windows.Forms.dll /resource:$zipPath,coupang-stock-app.zip $installerSource
if (!(Test-Path $setupExe)) {
  throw 'Setup executable build failed.'
}

Write-Host ''
Write-Host 'Built Coupang stock app:'
Write-Host "  $launcherExe"
Write-Host "  $setupExe"
Write-Host ''
