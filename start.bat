@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [MusicKey] 未找到 Python，请先安装 Python 3.10+。
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo [MusicKey] 首次运行，正在安装依赖...
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
.venv\Scripts\python.exe run.py web --open
pause
