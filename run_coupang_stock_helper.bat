@echo off
cd /d "%~dp0"
echo Coupang stock helper restarting...
echo This launcher always runs the helper from the current app folder.
echo If the app is updated in this same folder, autostart does not need to be changed.
if not exist "tools\coupang_stock_helper.js" (
  if exist "..\tools\coupang_stock_helper.js" (
    cd /d "%~dp0.."
  )
)
if not exist "tools\coupang_stock_helper.js" (
  echo.
  echo ERROR: tools\coupang_stock_helper.js was not found.
  echo Run this file from the Naver monitor app root folder, not from chrome_extension only.
  echo Current folder: %CD%
  echo.
  pause
  exit /b 1
)
echo Closing any old helper on port 8765 first.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:8765/shutdown' -Method POST -TimeoutSec 1 | Out-Null; Start-Sleep -Milliseconds 800 } catch {}"
echo Starting fresh helper. Keep this window open while testing Coupang stock lookup.
node tools\coupang_stock_helper.js
pause
