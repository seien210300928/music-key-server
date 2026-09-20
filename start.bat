@echo off
cd /d "%~dp0"
echo ========================================
echo   MusicKey Server
echo ========================================
echo.
"node\node.exe" server.js
pause
