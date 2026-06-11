@echo off
cd /d "%~dp0"
if exist "tools\coupang_stock_helper.js" (
  echo Coupang stock helper restarting...
  echo Starting helper from this extension package.
  echo Keep this window open while testing Coupang stock lookup.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:8765/shutdown' -Method POST -TimeoutSec 1 | Out-Null; Start-Sleep -Milliseconds 800 } catch {}"
  node tools\coupang_stock_helper.js
  pause
  exit /b %ERRORLEVEL%
)
if exist "..\tools\coupang_stock_helper.js" (
  cd /d "%~dp0.."
  call run_coupang_stock_helper.bat
  exit /b %ERRORLEVEL%
)
echo ERROR: Cannot find tools\coupang_stock_helper.js.
echo Use the full naver-monitor-extension package, not the chrome_extension files alone.
echo Current folder: %CD%
pause
exit /b 1
