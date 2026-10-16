@echo off
rem Builds Chronicle-Gaia (vite build) and starts it with Electron.
cd /d "%~dp0"
call npm start
if errorlevel 1 (
  echo.
  echo Build or start failed.
  pause
  exit /b 1
)
