@echo off
rem Starts Chronicle-Gaia: builds with vite, then launches Electron detached
rem so this console window can close once the app is up.
cd /d "%~dp0"

echo Chronicle-Gaia bouwen...
call "node_modules\.bin\vite.cmd" build
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)

rem Electron los van deze console starten; het venster sluit daarna direct.
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
