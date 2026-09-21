@echo off
cd /d "%~dp0"
chcp 65001 >nul
echo Cleaning project...
if exist node_modules rmdir /s /q node_modules
if exist node rmdir /s /q node
if exist node.zip del /q node.zip
if exist node_temp rmdir /s /q node_temp
if exist dist rmdir /s /q dist
if exist logs rmdir /s /q logs
if exist update rmdir /s /q update
if exist download rmdir /s /q download
if exist config.json del /q config.json
if exist port.json del /q port.json
if exist cleanup.bat del /q cleanup.bat
if exist cleanup.sh del /q cleanup.sh
echo Done.
pause
