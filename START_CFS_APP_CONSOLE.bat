@echo off
setlocal EnableExtensions

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

echo Starting CFS App...
echo This fallback launcher does not use Windows Script Host.
echo.

call "%APP_ROOT%\START_CFS_APP.bat" --worker
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo CFS could not be started.
  echo Check artifacts\startup\latest-status.txt and the newest start/server logs.
  echo.
  pause
)
exit /b %EXIT_CODE%
