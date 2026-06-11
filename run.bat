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

REM Supabase 키 등 시크릿은 .env.bat에서 불러옵니다 (.env.bat은 git에 커밋되지 않음)
if not exist ".env.bat" (
    echo [오류] .env.bat 파일이 없습니다.
    echo .env.bat.example 파일을 복사해서 .env.bat 을 만들고
    echo Supabase 대시보드의 키 값을 채워 넣으세요.
    pause
    exit /b
)
call .env.bat

echo 쿠팡 재고조회 도우미는 자동으로 시작하지 않습니다.
echo 대시보드의 쿠팡 재고조회 화면에서 도우미 폴더 열기 버튼을 눌러 필요할 때 실행하세요.

start "" "chrome.exe" "http://localhost:5001"
set PORT=5001
python app.py
pause
