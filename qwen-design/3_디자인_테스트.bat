@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo Server health:
curl -s http://127.0.0.1:9893/health
echo.
echo.
echo Generating a voice from _test_request.json ... (a few seconds)
curl -s -X POST http://127.0.0.1:9893/design -H "Content-Type: application/json" --data-binary "@_test_request.json" --output test.wav
if exist test.wav (
  echo Done. Playing test.wav
  start "" test.wav
) else (
  echo [ERROR] test.wav not created. Check the server window log.
)
echo.
pause
