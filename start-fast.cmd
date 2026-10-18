@echo off
rem Starts Chronicle-Gaia from the last build (dist) without rebuilding.
rem Use start.cmd when the sources changed and a rebuild is needed.
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo No build found - run start.cmd first.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
