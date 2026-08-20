@echo off
setlocal EnableExtensions

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

echo CFS App clean reinstall helper
echo.
echo This helper uses the current extracted ZIP folder as the new CFS App.
echo It can stop old CFS server processes, recreate shortcuts, and optionally
echo rename an older shortcut target folder to *_old_yyyyMMdd-HHmmss.
echo It does not permanently delete project data.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\clean-reinstall-cfs-app.ps1" -AppRoot "%APP_ROOT%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Clean reinstall helper did not finish successfully.
  echo Check artifacts\startup\clean-reinstall-*.log if it was created.
  echo.
  pause
)
exit /b %EXIT_CODE%
