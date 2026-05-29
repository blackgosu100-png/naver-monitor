@echo off
cd /d "%~dp0"
echo Coupang stock helper restarting...
echo Closing any old helper on port 8765 first.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:8765/shutdown' -Method POST -TimeoutSec 1 | Out-Null; Start-Sleep -Milliseconds 800 } catch {}"
echo Starting fresh helper. Keep this window open while testing Coupang stock lookup.
node tools\coupang_stock_helper.js
pause
