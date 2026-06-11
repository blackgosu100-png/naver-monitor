$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$extensionSource = Join-Path $root 'chrome_extension'
$helperSource = Join-Path $root 'tools\coupang_stock_helper.js'
$dist = Join-Path $root 'dist'
$packageRoot = Join-Path $dist 'naver-monitor-extension'
$packageExtension = Join-Path $packageRoot 'chrome_extension'
$packageTools = Join-Path $packageExtension 'tools'
$zipPath = Join-Path $dist 'naver-monitor-extension.zip'

if (!(Test-Path $extensionSource)) {
  throw "chrome_extension folder was not found: $extensionSource"
}
if (!(Test-Path $helperSource)) {
  throw "Coupang helper was not found: $helperSource"
}

if (Test-Path $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $packageExtension | Out-Null

Get-ChildItem -LiteralPath $extensionSource -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $packageExtension -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $packageTools | Out-Null
Copy-Item -LiteralPath $helperSource -Destination (Join-Path $packageTools 'coupang_stock_helper.js') -Force

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -Force

Write-Host ''
Write-Host 'Created package:'
Write-Host "  $zipPath"
Write-Host ''
Write-Host 'Send this zip to users. They should unzip it, load the chrome_extension folder in Chrome,'
Write-Host 'and run chrome_extension\run_coupang_stock_helper.bat before fast Coupang stock lookup.'
