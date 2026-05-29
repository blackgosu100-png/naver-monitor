@echo off
cd /d "%~dp0"
echo Coupang stock helper starting...
echo Keep this window open while testing Coupang stock lookup.
node tools\coupang_stock_helper.js
pause
