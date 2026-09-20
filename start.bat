@echo off
cd /d "%~dp0"
chcp 65001 >nul

if not exist "node\node.exe" (
    echo Node.js not found, downloading...
    if exist node rmdir /s /q node
    curl -L -o node.zip "https://nodejs.org/dist/v18.20.4/node-v18.20.4-win-x64.zip"
    tar -xf node.zip
    ren node-v18.20.4-win-x64 node
    del node.zip
    echo.
)

echo ========================================
echo   MusicKey Server
echo ========================================
echo.
"%~dp0node\node.exe" server.js
pause
