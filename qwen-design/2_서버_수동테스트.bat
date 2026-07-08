@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
echo Starting Qwen3-TTS Voice Design server (port 9893).
echo Model loading takes 30-60s (first run downloads ~4.5GB).
echo Wait for: "model loaded - ready".  Close this window to stop.
echo.
if not exist "venv\Scripts\python.exe" (
  echo [ERROR] Not installed yet. Run the step-1 setup .bat first.
  pause
  exit /b 1
)
call "venv\Scripts\python.exe" qwen_design_server.py --port 9893
pause
