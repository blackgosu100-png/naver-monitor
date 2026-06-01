@echo off
setlocal

set TASK_NAME=NaverMonitorCoupangStockHelper

schtasks /Delete /TN "%TASK_NAME%" /F
if errorlevel 1 (
    echo [WARN] Startup task was not found or could not be removed.
) else (
    echo Coupang stock helper autostart is disabled.
)

echo.
echo If the helper is currently running, close its command window or restart Windows.
pause
