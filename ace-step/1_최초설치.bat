@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo   ACE-Step music server - first-time setup (run once)
echo ============================================================
echo.
rem ACE-Step needs Python 3.11/3.12 (NOT 3.13 - spacy 3.8.4 has no 3.13 wheel).
rem Use an existing conda env's Python as the base.
set "PYBASE="
if exist "D:\miniconda3\envs\bgm\python.exe" set "PYBASE=D:\miniconda3\envs\bgm\python.exe"
if not defined PYBASE if exist "D:\miniconda3\envs\Qwen3TTS\python.exe" set "PYBASE=D:\miniconda3\envs\Qwen3TTS\python.exe"
if not defined PYBASE if exist "D:\miniconda3\envs\audiobook\python.exe" set "PYBASE=D:\miniconda3\envs\audiobook\python.exe"
if not defined PYBASE set "PYBASE=python"
echo Base Python:
"%PYBASE%" --version
echo.
echo [1/5] Creating virtual env (venv)  (removing any old 3.13 venv first)...
if exist "venv" rmdir /s /q venv
"%PYBASE%" -m venv venv
if errorlevel 1 goto err
echo [2/5] Upgrading pip...
call "venv\Scripts\python.exe" -m pip install --upgrade pip
echo [3/5] Installing PyTorch (CUDA 12.6)  ~2.5GB, a few minutes...
call "venv\Scripts\pip.exe" install torch torchaudio --index-url https://download.pytorch.org/whl/cu126
if errorlevel 1 goto err
echo [4/5] Installing ACE-Step from GitHub (music model code)...
call "venv\Scripts\pip.exe" install "git+https://github.com/ace-step/ACE-Step.git"
if errorlevel 1 goto err
echo (re-pin CUDA torch in case a dependency replaced it with a CPU build)
call "venv\Scripts\pip.exe" install torch torchaudio --index-url https://download.pytorch.org/whl/cu126
echo [5/5] Checking CUDA (GPU) is available...
call "venv\Scripts\python.exe" -c "import torch; print('   torch', torch.__version__); print('   CUDA available:', torch.cuda.is_available())"
echo.
echo ============================================================
echo   DONE. If "CUDA available: True" above, the GPU is ready.
echo   The music model (~14GB) auto-downloads on first generation.
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
