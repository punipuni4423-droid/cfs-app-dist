@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
echo If an update is running, wait for it to finish. Do not close its window.
echo Save unsaved CFS edits and close other launcher windows before updating.
echo The update stops CFS, preserves local data, and rebuilds the app.
echo Keep this window open until the result is displayed.
set "APP_ROOT=%~dp0."
set "BOOTSTRAP=%~dp0.cfs-updater\bootstrap-v1.ps1"
if not exist "%BOOTSTRAP%" set "BOOTSTRAP=%~dp0scripts\cfs-update-bootstrap.ps1"
if not exist "%BOOTSTRAP%" (
  echo CFS update bootstrap was not found. Obtain the official recovery tool.
  pause
  exit /b 1
)
set "CFS_UPDATE_ROOT=%APP_ROOT%"
set "CFS_UPDATE_BOOTSTRAP=%BOOTSTRAP%"
if not defined PORT set "PORT=3014"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $cursor=$env:CFS_UPDATE_BOOTSTRAP; while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Update path is a reparse point.'}}; $cursor=[IO.Path]::GetDirectoryName($cursor)}; & $env:CFS_UPDATE_BOOTSTRAP -AppDir $env:CFS_UPDATE_ROOT -Port $env:PORT -RepairBuild; exit $LASTEXITCODE"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Update did not complete. Read artifacts\self-update and run this same command after resolving the cause.
pause
exit /b %RESULT%
