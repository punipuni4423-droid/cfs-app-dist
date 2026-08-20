@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

set "LAUNCHER=%APP_ROOT%\scripts\launch-cfs-app.ps1"
set "SILENT_LAUNCHER=%APP_ROOT%\LAUNCH_CFS_APP.vbs"
if /I "%~1"=="--vbs" if exist "%SILENT_LAUNCHER%" (
  wscript.exe "%SILENT_LAUNCHER%"
  exit /b !ERRORLEVEL!
)

if not exist "%LAUNCHER%" (
  echo CFS launcher was not found:
  echo %LAUNCHER%
  echo.
  echo Use START_CFS_APP_CONSOLE.bat as a fallback.
  pause
  exit /b 1
)

set "PORT_ARGS="
if defined PORT set "PORT_ARGS=-Port %PORT%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" %PORT_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo CFS could not be started. Check artifacts\startup\latest-status.txt and the newest start log.
  echo.
  pause
)
exit /b %EXIT_CODE%
