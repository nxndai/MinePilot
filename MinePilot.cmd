@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0runtime\electron\electron.exe" "%~dp0" --no-sandbox