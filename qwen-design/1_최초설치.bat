@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo   Qwen3-TTS Voice Design - first-time setup (run once)
echo ============================================================
echo.
set "PYBASE=D:\miniconda3\python.exe"
if not exist "%PYBASE%" set "PYBASE=python"
echo [1/5] Creating virtual env (venv)...
"%PYBASE%" -m venv venv
if errorlevel 1 goto err
echo [2/5] Upgrading pip...
call "venv\Scripts\python.exe" -m pip install --upgrade pip
echo [3/5] Installing PyTorch (CUDA 12.6)  ~2.5GB, a few minutes...
call "venv\Scripts\pip.exe" install torch --index-url https://download.pytorch.org/whl/cu126
if errorlevel 1 goto err
echo [4/5] Installing Qwen3-TTS + soundfile...
call "venv\Scripts\pip.exe" install -U qwen-tts soundfile
if errorlevel 1 goto err
echo (re-pin CUDA torch in case qwen-tts replaced it with a CPU build)
call "venv\Scripts\pip.exe" install torch --index-url https://download.pytorch.org/whl/cu126
echo [5/5] Checking CUDA (GPU) is available...
call "venv\Scripts\python.exe" -c "import torch; print('   torch', torch.__version__); print('   CUDA available:', torch.cuda.is_available())"
echo.
echo ============================================================
echo   DONE. If "CUDA available: True" above, the GPU is ready.
echo   The voice model (~4.5GB) downloads on first use.
echo ============================================================
echo.
pause
exit /b 0
:err
echo.
echo [ERROR] Setup failed. Copy this whole window and show the developer.
echo.
pause
exit /b 1
