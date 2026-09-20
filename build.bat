@echo off
cd /d "%~dp0"
echo Building music-key-server.exe ...
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
call npx pkg . --target node18-win-x64 --output dist\music-key-server.exe
echo.
echo Done! Output: dist\music-key-server.exe
pause
