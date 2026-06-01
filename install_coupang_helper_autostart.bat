@echo off
setlocal
cd /d "%~dp0"

set TASK_NAME=NaverMonitorCoupangStockHelper
set SCRIPT=%~dp0run_coupang_stock_helper.bat

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not available in PATH.
    echo Install Node.js first, then run this file again.
    pause
    exit /b 1
)

schtasks /Create /TN "%TASK_NAME%" /TR "\"%SCRIPT%\"" /SC ONLOGON /RL LIMITED /F
if errorlevel 1 (
    echo [ERROR] Failed to create the startup task.
    pause
    exit /b 1
)

echo.
echo Coupang stock helper autostart is enabled.
echo It will start automatically when you log in to Windows.
echo.
echo Starting it now...
start "Coupang Stock Helper" /min cmd /c ""%SCRIPT%""
pause
