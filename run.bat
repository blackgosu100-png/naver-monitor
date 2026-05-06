@echo off
cd /d "%~dp0"
echo ====================================================
echo   네이버 경쟁사 모니터링 시작
echo   http://localhost:5000
echo   초기 계정: admin / 1234
echo ====================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [오류] Python이 설치되어 있지 않습니다.
    pause
    exit /b
)

python -c "import flask, cryptography" >nul 2>&1
if errorlevel 1 (
    echo 필요한 패키지를 설치합니다...
    pip install -r requirements.txt
    echo.
)

python app.py
pause
