@echo off
rem Starts Chronicle-Gaia from the last build (dist) without rebuilding.
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo No build found - run build-and-start.cmd first.
  pause
  exit /b 1
)
start "" "node_modules\.bin\electron.cmd" .
