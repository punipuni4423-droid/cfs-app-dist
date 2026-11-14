@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
echo If an update is running, wait for it to finish. Do not close its window.
echo Save unsaved CFS edits and close other launcher windows before updating.
echo The update stops CFS, preserves local data, and rebuilds the app.
echo Keep this window open until the result is displayed.
set "APP_ROOT=%~dp0."
set "BOOTSTRAP=%~dp0scripts\cfs-update-bootstrap.ps1"
if not exist "%BOOTSTRAP%" (
  echo CFS update bootstrap was not found. Obtain the official recovery tool.
  pause
  exit /b 1
)
set "CFS_UPDATE_ROOT=%APP_ROOT%"
set "CFS_UPDATE_BOOTSTRAP=%BOOTSTRAP%"
if not defined PORT set "PORT=3014"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $file=[IO.Path]::GetFullPath($env:CFS_UPDATE_BOOTSTRAP); $root=[IO.Path]::GetFullPath($env:CFS_UPDATE_ROOT); $cursor=$file; while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Update path is a reparse point.'}}; $cursor=[IO.Path]::GetDirectoryName($cursor)}; $utf8=[Text.UTF8Encoding]::new($false,$true); $scriptText=$utf8.GetString([IO.File]::ReadAllBytes($file)); $bytes=$utf8.GetBytes($scriptText.Replace([string][char]13+[char]10,[string][char]10)); $hash=[Security.Cryptography.SHA256]::Create(); try {$actual=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','')}finally{$hash.Dispose()}; if($actual -ine 'f9d586ffbd64827c980165f670681538d095bf96057aa178664efef4c3fb0ded'){throw 'The installed update entry does not match this release. Obtain the official recovery tool.'}; & ([scriptblock]::Create($scriptText.TrimStart([char]0xFEFF))) -AppDir $root -Port $env:PORT -RepairBuild; exit $LASTEXITCODE"
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Update did not complete. Read artifacts\self-update and run this same command after resolving the cause.
pause
exit /b %RESULT%
