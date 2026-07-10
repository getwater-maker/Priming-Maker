@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
echo Starting ACE-Step music server (port 9894).
echo First run downloads the model (~14GB) - can take a long time.
echo Wait for: "model loaded - ready".  Close this window to stop.
echo.
if not exist "venv\Scripts\python.exe" (
  echo [ERROR] Not installed yet. Run the step-1 setup .bat first.
  pause
  exit /b 1
)
call "venv\Scripts\python.exe" ace_step_server.py --port 9894 --cpu-offload
pause
