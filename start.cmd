@echo off
rem Starts Chronicle-Gaia (vite build + electron).
cd /d "%~dp0"
call npm start
if errorlevel 1 (
  echo.
  echo Start failed.
  pause
  exit /b 1
)
