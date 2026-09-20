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

set "NODE=%~dp0node"

if not exist node_modules (
    echo Installing dependencies...
    "%NODE%\node.exe" "%NODE%\node_modules\npm\bin\npm-cli.js" install
)

echo Building music-key-server.exe ...
"%NODE%\node.exe" "%NODE%\node_modules\npm\bin\npx-cli.js" pkg . --target node18-win-x64 --output dist\music-key-server.exe

echo.
echo Done! Output: dist\music-key-server.exe
pause
