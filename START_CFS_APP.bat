@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Direct execution hands off to the silent launcher. The worker mode below is
rem invoked by LAUNCH_CFS_APP.cmd / LAUNCH_CFS_APP.vbs and keeps long-running
rem commands out of the launcher window.
if /I not "%~1"=="--worker" (
  if exist "%~dp0LAUNCH_CFS_APP.cmd" (
    start "" "%~dp0LAUNCH_CFS_APP.cmd"
  ) else if exist "%~dp0LAUNCH_CFS_APP.vbs" (
    start "" /b wscript.exe "%~dp0LAUNCH_CFS_APP.vbs"
  )
  exit /b 0
)

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"
cd /d "%APP_ROOT%"

set "OPEN_BROWSER=1"
if /I "%~2"=="--no-browser" set "OPEN_BROWSER=0"
if /I "%CFS_OPEN_BROWSER%"=="0" set "OPEN_BROWSER=0"

set "PORT_STRICT=0"
if defined PORT set "PORT_STRICT=1"
if /I "%CFS_ALLOW_PORT_FALLBACK%"=="1" set "PORT_STRICT=0"
if not defined PORT set "PORT=3014"
if not defined CFS_AUTH_REDIRECT_PORT set "CFS_AUTH_REDIRECT_PORT=3000"
if not defined NODE_OPTIONS set "NODE_OPTIONS=--max-old-space-size=4096"

call :load_public_env

set "LOG_DIR=%APP_ROOT%\artifacts\startup"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "AUTH_REDIRECT_TARGET_FILE=%LOG_DIR%\auth-redirect-target.json"

for /f %%i in ('powershell.exe -NoProfile -NonInteractive -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "RUN_LOG=%LOG_DIR%\start-%STAMP%.log"
set "STATUS_FILE=%LOG_DIR%\latest-status.txt"

call :main > "%RUN_LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%

:main
call :set_status "Preparing CFS startup."

call :prefer_bundled_node
call :prefer_bundled_git
call :has_supported_node
if not errorlevel 1 goto :node_ready

call :set_status "Preparing the app-local Node.js runtime."
set "CFS_NODE_HOME="
for /f "usebackq delims=" %%i in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\ensure-node-runtime.ps1" -AppRoot "%APP_ROOT%"`) do set "CFS_NODE_HOME=%%i"
if not defined CFS_NODE_HOME (
  call :set_status "Failed to prepare the app-local Node.js runtime. See the start log."
  exit /b 1
)
set "PATH=%CFS_NODE_HOME%;%PATH%"
call :has_supported_node
if errorlevel 1 (
  call :set_status "The prepared Node.js runtime is not usable. See the start log."
  exit /b 1
)

:node_ready
set "STANDALONE_SERVER=%APP_ROOT%\runtime\server.js"
if exist "%STANDALONE_SERVER%" (
  call :set_status "Using bundled CFS runtime."
  goto :runtime_ready
)

call :has_supported_node_with_npm
if errorlevel 1 (
  call :set_status "npm is not available. Use the latest ZIP with bundled runtime, or install Node.js 20+."
  exit /b 1
)

if not exist node_modules (
  call :set_status "Installing CFS dependencies. This runs only on the first launch."
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    call :set_status "Dependency installation failed. See the start log."
    exit /b 1
  )
)

if not exist .next\BUILD_ID (
  call :set_status "Building CFS for the first launch."
  call npm.cmd run build
  if errorlevel 1 (
    call :set_status "CFS build failed. See the start log."
    exit /b 1
  )
)

:runtime_ready
call :is_cfs_running
if not errorlevel 1 goto :open_browser

call :is_port_in_use
if not errorlevel 1 (
  if "%PORT_STRICT%"=="1" (
    call :set_status "Port %PORT% is already in use by a different app or older CFS. Close it, or use another port."
    exit /b 1
  )
  call :set_status "Port %PORT% is busy. Looking for another local port."
  call :choose_available_port
  if errorlevel 1 (
    call :set_status "No available local port was found between 3014 and 3035."
    exit /b 1
  )
  call :is_cfs_running
  if not errorlevel 1 goto :open_browser
)

set "SERVER_LOG=%LOG_DIR%\server-%STAMP%.log"
set "SERVER_ERR_LOG=%LOG_DIR%\server-%STAMP%.err.log"
if exist "%STANDALONE_SERVER%" (
  call :set_status "Starting CFS bundled runtime in the background."
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\start-cfs-background-server.ps1" -AppRoot "%APP_ROOT%" -Port %PORT% -Mode Standalone -ServerPath "%STANDALONE_SERVER%" -StdoutPath "%SERVER_LOG%" -StderrPath "%SERVER_ERR_LOG%"
) else (
  call :set_status "Starting CFS in the background."
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\start-cfs-background-server.ps1" -AppRoot "%APP_ROOT%" -Port %PORT% -Mode Npm -StdoutPath "%SERVER_LOG%" -StderrPath "%SERVER_ERR_LOG%"
)
if errorlevel 1 (
  call :set_status "CFS server process could not be started. See the start log and server error log."
  exit /b 1
)
call :wait_for_cfs
if errorlevel 1 (
  call :set_status "CFS did not become ready. See the server log and server error log."
  exit /b 1
)

:open_browser
call :write_auth_redirect_target
call :start_auth_redirect_helper
call :set_status "CFS is ready at http://localhost:%PORT%"
if "%OPEN_BROWSER%"=="0" exit /b 0
start "" "http://localhost:%PORT%"
exit /b 0

:prefer_bundled_node
set "BUNDLED_NODE_HOME="
if not exist "%APP_ROOT%\.cfs-runtime" exit /b 0
for /f "delims=" %%i in ('dir /b /s /a-d "%APP_ROOT%\.cfs-runtime\node.exe" 2^>nul') do (
  set "BUNDLED_NODE_HOME=%%~dpi"
  if "!BUNDLED_NODE_HOME:~-1!"=="\" set "BUNDLED_NODE_HOME=!BUNDLED_NODE_HOME:~0,-1!"
  goto :bundled_node_found
)
:bundled_node_found
if defined BUNDLED_NODE_HOME set "PATH=!BUNDLED_NODE_HOME!;%PATH%"
exit /b 0

:prefer_bundled_git
set "BUNDLED_GIT_EXE="
if exist "%APP_ROOT%\.cfs-runtime\git\cmd\git.exe" set "BUNDLED_GIT_EXE=%APP_ROOT%\.cfs-runtime\git\cmd\git.exe"
if not defined BUNDLED_GIT_EXE if exist "%APP_ROOT%\.cfs-runtime\git\bin\git.exe" set "BUNDLED_GIT_EXE=%APP_ROOT%\.cfs-runtime\git\bin\git.exe"
if not defined BUNDLED_GIT_EXE if exist "%APP_ROOT%\.cfs-runtime\git\mingw64\bin\git.exe" set "BUNDLED_GIT_EXE=%APP_ROOT%\.cfs-runtime\git\mingw64\bin\git.exe"
if not defined BUNDLED_GIT_EXE for /f "delims=" %%i in ('dir /b /s /a-d "%APP_ROOT%\.cfs-runtime\PortableGit*\cmd\git.exe" 2^>nul') do (
  set "BUNDLED_GIT_EXE=%%i"
  goto :bundled_git_found
)
:bundled_git_found
if defined BUNDLED_GIT_EXE (
  set "CFS_GIT_EXE=!BUNDLED_GIT_EXE!"
  for %%g in ("!BUNDLED_GIT_EXE!") do set "PATH=%%~dpg;%PATH%"
)
exit /b 0

:has_supported_node
where node.exe >nul 2>nul
if errorlevel 1 exit /b 1
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('node.exe --version 2^>nul') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
if not defined NODE_MAJOR exit /b 1
if !NODE_MAJOR! LSS 20 exit /b 1
exit /b 0

:has_supported_node_with_npm
call :has_supported_node
if errorlevel 1 exit /b 1
where npm.cmd >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:is_cfs_running
if exist "%APP_ROOT%\scripts\test-cfs-instance.ps1" (
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%APP_ROOT%\scripts\test-cfs-instance.ps1" -Port %PORT% -AppRoot "%APP_ROOT%"
  exit /b !ERRORLEVEL!
)
exit /b 1

:is_port_in_use
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
exit /b !ERRORLEVEL!

:choose_available_port
for /l %%p in (3014,1,3035) do (
  set "PORT=%%p"
  call :is_cfs_running
  if not errorlevel 1 (
    call :set_status "Found running CFS at http://localhost:!PORT!."
    exit /b 0
  )
  call :is_port_in_use
  if errorlevel 1 (
    call :set_status "Using alternate port !PORT!."
    exit /b 0
  )
)
exit /b 1

:wait_for_cfs
for /l %%i in (1,1,90) do (
  call :is_cfs_running
  if not errorlevel 1 exit /b 0
  ping 127.0.0.1 -n 2 >nul
)
exit /b 1

:set_status
> "%STATUS_FILE%" echo [%date% %time%] %~1
echo %~1
exit /b 0

:write_auth_redirect_target
> "%AUTH_REDIRECT_TARGET_FILE%" echo {"targetOrigin":"http://localhost:%PORT%"}
exit /b 0

:start_auth_redirect_helper
if "%PORT%"=="%CFS_AUTH_REDIRECT_PORT%" exit /b 0
if not exist "%APP_ROOT%\scripts\auth-redirect-helper.mjs" exit /b 0
set "AUTH_REDIRECT_LOG=%LOG_DIR%\auth-redirect-helper.log"
start "" /b "%ComSpec%" /d /s /c "node.exe ""%APP_ROOT%\scripts\auth-redirect-helper.mjs"" --port %CFS_AUTH_REDIRECT_PORT% --target-file ""%AUTH_REDIRECT_TARGET_FILE%"" --target ""http://localhost:%PORT%"" >> ""%AUTH_REDIRECT_LOG%"" 2>&1"
exit /b 0

:load_public_env
set "PUBLIC_ENV=%APP_ROOT%\cfs-public-supabase.env"
if not exist "%PUBLIC_ENV%" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%PUBLIC_ENV%") do (
  set "CFG_KEY=%%A"
  set "CFG_VALUE=%%B"
  if /I "!CFG_KEY!"=="CFS_SHARING_MODE" if not defined CFS_SHARING_MODE set "CFS_SHARING_MODE=!CFG_VALUE!"
  if /I "!CFG_KEY!"=="SUPABASE_URL" if not defined SUPABASE_URL set "SUPABASE_URL=!CFG_VALUE!"
  if /I "!CFG_KEY!"=="SUPABASE_PUBLISHABLE_KEY" if not defined SUPABASE_PUBLISHABLE_KEY set "SUPABASE_PUBLISHABLE_KEY=!CFG_VALUE!"
  if /I "!CFG_KEY!"=="CFS_SUPABASE_FUNCTION_NAME" if not defined CFS_SUPABASE_FUNCTION_NAME set "CFS_SUPABASE_FUNCTION_NAME=!CFG_VALUE!"
)
exit /b 0
