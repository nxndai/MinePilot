@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" "%~dp0server.js" --port %~1 >> "%~dp0server.log" 2>&1