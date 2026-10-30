@echo off
setlocal
set "MC=%APPDATA%\.minecraft"
set "FAIL=0"
if not exist "%MC%" (
  echo Minecraft folder not found: %MC%
  pause
  exit /b 1
)

for /d %%V in ("%MC%\versions\*") do (
  for %%D in (logs saves crash-reports downloads mods config resourcepacks screenshots shaderpacks) do (
    if not exist "%%~fV\%%D" (
      mkdir "%%~fV\%%D" >nul 2>nul
      if not exist "%%~fV\%%D" set "FAIL=1"
    )
  )
)

for %%D in (logs saves crash-reports downloads mods config resourcepacks screenshots shaderpacks) do (
  if not exist "%MC%\%%D" (
    mkdir "%MC%\%%D" >nul 2>nul
    if not exist "%MC%\%%D" set "FAIL=1"
  )
)

if "%FAIL%"=="1" (
  echo [ERROR] Some folders could not be created.
  echo Windows security policy or permissions are blocking this folder.
  echo Try adding MinePilot and your Java to the antivirus trust list, or use another game folder.
) else (
  echo Done. All game folders are ready.
)
echo You can close this window.
pause