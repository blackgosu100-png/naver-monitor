@echo off
cd /d "%~dp0"
echo ====================================================
echo   네이버 경쟁사 모니터링 시작
echo   http://localhost:5001
echo   Supabase Auth 계정으로 로그인
echo ====================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [오류] Python이 설치되어 있지 않습니다.
    pause
    exit /b
)

python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo 필요한 패키지를 설치합니다...
    pip install -r requirements.txt
    echo.
)

python -c "from playwright.sync_api import sync_playwright; sync_playwright().__enter__().chromium.executable_path" >nul 2>&1
if errorlevel 1 (
    echo Playwright 브라우저를 설치합니다...
    python -m playwright install chromium
    echo.
)

set SUPABASE_URL=https://itarmufbqvkmdkxhrkfy.supabase.co
set SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml0YXJtdWZicXZrbWRreGhya2Z5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODE2NDgwOCwiZXhwIjoyMDkzNzQwODA4fQ.kvvCisVSHV7j1CSJzvwHxWEXfqjZqjK1hJZjobb7BCk
REM Supabase Project Settings > API > anon public key
set SUPABASE_ANON_KEY=

start "" "chrome.exe" "http://localhost:5001"
set PORT=5001
python app.py
pause
