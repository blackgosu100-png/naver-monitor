@echo off
setlocal
cd /d "%~dp0"

echo Coupang stock helper autostart is no longer installed by this app.
echo.
echo New workflow:
echo 1. Open the dashboard.
echo 2. Go to Coupang stock lookup.
echo 3. Click "도우미 폴더 열기".
echo 4. Run run_coupang_stock_helper.bat only when you need Coupang stock lookup.
echo.
echo Opening this folder now...
start "" "%~dp0"
pause
