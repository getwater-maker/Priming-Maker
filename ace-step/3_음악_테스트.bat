@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo Server health:
curl -s http://127.0.0.1:9894/health
echo.
echo.
echo Generating a 20s lofi test from _test_request.json ... (music gen takes a while)
curl -s -X POST http://127.0.0.1:9894/generate -H "Content-Type: application/json" --data-binary "@_test_request.json" --output test.wav
if exist test.wav (
  echo Done. Playing test.wav
  start "" test.wav
) else (
  echo [ERROR] test.wav not created. Check the server window log.
)
echo.
pause
