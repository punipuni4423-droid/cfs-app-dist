param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [int]$Port = 3014,
  [string]$HostName = "0.0.0.0"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$appPath = (Resolve-Path -LiteralPath $AppDir).Path
$artifactDir = Join-Path $appPath "artifacts\self-update"
$dataBackupDir = Join-Path $appPath "artifacts\data-recovery"
$statusPath = Join-Path $artifactDir "status.json"
$logPath = Join-Path $artifactDir ("update-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
New-Item -ItemType Directory -Force -Path $artifactDir, $dataBackupDir | Out-Null
if (-not $env:NODE_OPTIONS) {
  $env:NODE_OPTIONS = "--max-old-space-size=4096"
}

function Write-UpdateStatus {
  param(
    [string]$State,
    [string]$Step,
    [string]$Message,
    [int]$Progress = -1,
    [string]$BackupPath = ""
  )
  $payload = [ordered]@{
    state = $State
    currentStep = $Step
    message = $Message
    logPath = $logPath
    backupPath = $BackupPath
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  if ($Progress -ge 0) { $payload["progress"] = $Progress }
  if ($script:StartedAt) { $payload["startedAt"] = $script:StartedAt }
  if ($State -eq "completed" -or $State -eq "failed") {
    $payload["finishedAt"] = (Get-Date).ToUniversalTime().ToString("o")
  }
  $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

function Write-Log {
  param([string]$Message)
  $line = ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Invoke-LoggedCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )
  Write-Log ("> " + $FilePath + " " + ($Arguments -join " "))
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($line in $output) { Write-Log ([string]$line) }
  if ($exitCode -ne 0) {
    throw "$FilePath exited with code $exitCode"
  }
}

function Invoke-NpmDependencyInstall {
  param(
    [string]$WorkingDirectory
  )
  try {
    Invoke-LoggedCommand -FilePath "npm.cmd" -Arguments @("ci", "--include=dev", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
  } catch {
    Write-Log ("npm ci failed; retrying with npm install to recover from Windows file locks: " + $_.Exception.Message)
    Start-Sleep -Seconds 2
    Invoke-LoggedCommand -FilePath "npm.cmd" -Arguments @("install", "--include=dev", "--no-audit", "--no-fund") -WorkingDirectory $WorkingDirectory
  }
}

function Test-NpmDependenciesReady {
  param(
    [string]$WorkingDirectory
  )

  return (
    (Test-Path -LiteralPath (Join-Path $WorkingDirectory "node_modules\.bin\next.cmd")) -or
    (Test-Path -LiteralPath (Join-Path $WorkingDirectory "node_modules\.bin\next"))
  )
}

function Invoke-WithProductionNodeEnv {
  param(
    [scriptblock]$ScriptBlock
  )
  $previousNodeEnv = $env:NODE_ENV
  $env:NODE_ENV = "production"
  try {
    & $ScriptBlock
  } finally {
    if ($null -eq $previousNodeEnv) {
      Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
    } else {
      $env:NODE_ENV = $previousNodeEnv
    }
  }
}

function Start-CfsAppServer {
  # Starts the app on $Port. Prefers the freshly built .next standalone output;
  # falls back to the shipped runtime\server.js (packaged installs keep it even
  # after a failed rebuild) so the browser can always reconnect and read the
  # update status - including a failure.
  $outLog = Join-Path $appPath ("start-" + $Port + ".out.log")
  $errLog = Join-Path $appPath ("start-" + $Port + ".err.log")
  $standaloneServer = Join-Path $appPath ".next\standalone\server.js"
  $bundledRuntimeServer = Join-Path $appPath "runtime\server.js"
  $serverEntry = $null
  if (Test-Path -LiteralPath $standaloneServer) {
    $serverEntry = $standaloneServer
    Write-Log "Using Next standalone runtime for restart."
  } elseif (Test-NpmDependenciesReady -WorkingDirectory $appPath) {
    # Prefer `npm start` (serves the freshly built .next) over the shipped
    # runtime\server.js, which is frozen at package build time and would keep
    # serving the old version after a successful update.
    $serverEntry = $null
  } elseif (Test-Path -LiteralPath $bundledRuntimeServer) {
    # Last resort (e.g. failed dependency install): bring the packaged runtime
    # back so the app is reachable and the failure is visible.
    $serverEntry = $bundledRuntimeServer
    Write-Log "Using bundled runtime\server.js for restart."
  }
  if ($serverEntry) {
    $bundledNodeHome = $null
    $runtimeDir = Join-Path $appPath ".cfs-runtime"
    if (Test-Path -LiteralPath $runtimeDir) {
      $bundledNodeExe = Get-ChildItem -LiteralPath $runtimeDir -Filter "node.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($bundledNodeExe) {
        $bundledNodeHome = $bundledNodeExe.Directory.FullName
      }
    }
    $pathPrefix = if ($bundledNodeHome) { "set `"PATH=$bundledNodeHome;%PATH%`" && " } else { "" }
    $startCommand = $pathPrefix + "set `"PORT=$Port`" && set `"HOSTNAME=$HostName`" && set `"NODE_ENV=production`" && set `"CFS_APP_DIR=$appPath`" && node.exe `"$serverEntry`""
    Start-Process -FilePath $env:ComSpec `
      -ArgumentList @("/d", "/s", "/c", $startCommand) `
      -WorkingDirectory $appPath `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -WindowStyle Hidden | Out-Null
    return
  }
  Write-Log "Using NODE_ENV=production for Next start."
  Invoke-WithProductionNodeEnv {
    Start-Process -FilePath "npm.cmd" `
      -ArgumentList @("run", "start", "--", "-p", [string]$Port, "-H", $HostName) `
      -WorkingDirectory $appPath `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -WindowStyle Hidden | Out-Null
  }
}

function Clear-NextRuntimeEnvironmentForBuild {
  $runtimeEnvNames = @(
    "__NEXT_PRIVATE_STANDALONE_CONFIG",
    "NEXT_MANUAL_SIG_HANDLE",
    "NEXT_RUNTIME"
  )
  foreach ($name in $runtimeEnvNames) {
    $envPath = "Env:$name"
    if (Test-Path -LiteralPath $envPath) {
      Remove-Item -LiteralPath $envPath -ErrorAction SilentlyContinue
      Write-Log "Cleared inherited Next runtime environment variable for build: $name"
    }
  }
}

function Get-GitExeFromHome {
  param([Parameter(Mandatory = $true)][string]$HomePath)

  foreach ($relative in @("cmd\git.exe", "bin\git.exe", "mingw64\bin\git.exe", "mingw32\bin\git.exe")) {
    $candidate = Join-Path $HomePath $relative
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Resolve-GitExecutable {
  param([Parameter(Mandatory = $true)][string]$RootPath)

  $configured = $env:CFS_GIT_EXE
  if (-not [string]::IsNullOrWhiteSpace($configured) -and (Test-Path -LiteralPath $configured)) {
    return (Resolve-Path -LiteralPath $configured).Path
  }

  $runtimeRoot = Join-Path $RootPath ".cfs-runtime"
  foreach ($gitHome in @((Join-Path $runtimeRoot "git"))) {
    $gitExe = Get-GitExeFromHome -HomePath $gitHome
    if ($gitExe) {
      return $gitExe
    }
  }

  if (Test-Path -LiteralPath $runtimeRoot) {
    $runtimeHomes = Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "PortableGit*" -or $_.Name -like "git-*" }
    foreach ($gitHome in $runtimeHomes) {
      $gitExe = Get-GitExeFromHome -HomePath $gitHome.FullName
      if ($gitExe) {
        return $gitExe
      }
    }
  }

  $pathGit = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($pathGit -and $pathGit.Source) {
    return $pathGit.Source
  }

  $ensureGitScript = Join-Path $RootPath "scripts\ensure-git-runtime.ps1"
  if (Test-Path -LiteralPath $ensureGitScript) {
    $preparedGit = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensureGitScript -AppRoot $RootPath | Select-Object -Last 1)
    if (-not [string]::IsNullOrWhiteSpace([string]$preparedGit) -and (Test-Path -LiteralPath ([string]$preparedGit).Trim())) {
      return (Resolve-Path -LiteralPath ([string]$preparedGit).Trim()).Path
    }
  }

  throw "Git was not found. Use the latest CFS Git-managed ZIP with bundled PortableGit, or install Git for Windows and restart CFS."
}

function Stop-AppListeners {
  param(
    [int]$TargetPort
  )
  $listeners = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $listeners) {
    try {
      Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Log "Stopped process $($conn.OwningProcess) on port $TargetPort."
    } catch {
      Write-Log "Failed to stop process $($conn.OwningProcess): $($_.Exception.Message)"
    }
  }
}

function Get-NextDistPath {
  param(
    [string]$RootPath
  )
  $distDir = if ([string]::IsNullOrWhiteSpace($env:NEXT_DIST_DIR)) { ".next" } else { $env:NEXT_DIST_DIR.Trim() }
  $rootFullPath = [System.IO.Path]::GetFullPath($RootPath)
  $distPath = if ([System.IO.Path]::IsPathRooted($distDir)) {
    [System.IO.Path]::GetFullPath($distDir)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $rootFullPath $distDir))
  }
  $expectedPrefix = $rootFullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $distPath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear Next build output outside the app folder: $distPath"
  }
  return $distPath
}

function Clear-NextBuildOutput {
  param(
    [string]$RootPath
  )
  $distPath = Get-NextDistPath -RootPath $RootPath
  if (Test-Path -LiteralPath $distPath) {
    Remove-Item -LiteralPath $distPath -Recurse -Force
    Write-Log "Cleared Next build output: $distPath"
  } else {
    Write-Log "Next build output was already clean: $distPath"
  }
}

function Sync-StandaloneStaticAssets {
  param(
    [string]$RootPath
  )
  $standaloneServer = Join-Path $RootPath ".next\standalone\server.js"
  $staticSource = Join-Path $RootPath ".next\static"
  if (-not (Test-Path -LiteralPath $standaloneServer) -or -not (Test-Path -LiteralPath $staticSource)) {
    return
  }
  $standaloneNextDir = Join-Path $RootPath ".next\standalone\.next"
  $staticTarget = Join-Path $standaloneNextDir "static"
  New-Item -ItemType Directory -Force -Path $standaloneNextDir | Out-Null
  if (Test-Path -LiteralPath $staticTarget) {
    Remove-Item -LiteralPath $staticTarget -Recurse -Force
  }
  Copy-Item -LiteralPath $staticSource -Destination $standaloneNextDir -Recurse -Force
  Write-Log "Copied static assets for Next standalone runtime."
}

$script:StartedAt = (Get-Date).ToUniversalTime().ToString("o")
Write-UpdateStatus -State "running" -Step "start" -Message "Preparing self update." -Progress 5
Write-Log "CFS self update started. AppDir=$appPath Port=$Port HostName=$HostName"
Clear-NextRuntimeEnvironmentForBuild

try {
  Write-UpdateStatus -State "running" -Step "git-check" -Message "Checking Git repository." -Progress 10
  $gitExe = Resolve-GitExecutable -RootPath $appPath
  $env:CFS_GIT_EXE = $gitExe
  Write-Log "Using Git executable: $gitExe"
  $repoRoot = (& $gitExe -C $appPath rev-parse --show-toplevel 2>&1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$repoRoot)) {
    throw "Git repository was not found."
  }
  $repoRoot = ([string]$repoRoot).Trim()
  $trackedPackage = (& $gitExe -C $appPath ls-files --error-unmatch -- "package.json" 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$trackedPackage)) {
    throw "CFS app folder is not tracked by Git."
  }
  $upstream = (& $gitExe -C $repoRoot rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$upstream)) {
    throw "Current branch does not have an upstream remote."
  }
  # A full disk makes git/npm truncate files to zero bytes mid-write; fail
  # cleanly up front instead of corrupting the working tree.
  $appDriveRoot = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $appPath).Path)
  $appDriveName = $appDriveRoot.TrimEnd(':', '\')
  $freeBytes = (Get-PSDrive -Name $appDriveName -ErrorAction SilentlyContinue).Free
  if ($null -ne $freeBytes -and $freeBytes -lt 3GB) {
    $freeGb = [math]::Round($freeBytes / 1GB, 2)
    throw "Not enough free disk space on ${appDriveRoot} (${freeGb} GB free, 3 GB required). Free up disk space and run the update again."
  }

  $dirty = @(& $gitExe -C $repoRoot status --porcelain --untracked-files=no)
  if (@($dirty).Count -gt 0) {
    # An update interrupted by a full disk leaves tracked files truncated to
    # zero bytes. That signature is safe to heal automatically by restoring
    # the files from the current commit.
    $allZeroByte = $true
    foreach ($line in @($dirty)) {
      $relPath = ([string]$line).Substring(3).Trim('"')
      if ($relPath -match "\s->\s") { $relPath = ($relPath -split "\s->\s")[-1].Trim('"') }
      $fullPath = Join-Path $repoRoot $relPath
      if (-not (Test-Path -LiteralPath $fullPath)) { continue }
      if ((Get-Item -LiteralPath $fullPath).Length -gt 0) { $allZeroByte = $false; break }
    }
    if ($allZeroByte) {
      Write-Log "Restoring zero-byte tracked files left by an interrupted update."
      Invoke-LoggedCommand -FilePath $gitExe -Arguments @("-C", $repoRoot, "checkout", "--force", "--", ".") -WorkingDirectory $repoRoot
      $dirty = @(& $gitExe -C $repoRoot status --porcelain --untracked-files=no)
    }
  }
  if (@($dirty).Count -gt 0) {
    throw "Local tracked files have changes. Commit or discard them before updating."
  }
  $beforeSha = ([string](& $gitExe -C $repoRoot rev-parse HEAD)).Trim()

  $projectDataPath = Join-Path $appPath "data\projects.json"
  $backupPath = ""
  if (Test-Path -LiteralPath $projectDataPath) {
    $backupPath = Join-Path $dataBackupDir ("projects-before-self-update-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
    Copy-Item -LiteralPath $projectDataPath -Destination $backupPath -Force
    Write-Log "Project data backup: $backupPath"
  }

  Write-UpdateStatus -State "running" -Step "git-fetch" -Message "Fetching updates." -Progress 25 -BackupPath $backupPath
  Invoke-LoggedCommand -FilePath $gitExe -Arguments @("-C", $repoRoot, "fetch", "--prune") -WorkingDirectory $repoRoot

  $countsText = (& $gitExe -C $repoRoot rev-list --left-right --count "HEAD...@{u}" 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not compare local and upstream Git history."
  }
  $countParts = ([string]$countsText).Trim() -split "\s+"
  $ahead = if ($countParts.Count -ge 1) { [int]$countParts[0] } else { 0 }
  $behind = if ($countParts.Count -ge 2) { [int]$countParts[1] } else { 0 }
  if ($ahead -gt 0 -and $behind -gt 0) {
    throw "Local and upstream Git history have diverged. Manual Git review is required before automatic update."
  }

  Write-UpdateStatus -State "running" -Step "git-pull" -Message "Applying Git update." -Progress 40 -BackupPath $backupPath
  if ($behind -gt 0) {
    # An interrupted update can leave files the incoming commits ADD sitting
    # untracked in the working tree, which aborts "pull --ff-only". Move such
    # files aside (kept under artifacts\self-update) instead of failing.
    $incomingAdded = @(& $gitExe -C $repoRoot diff --name-only --diff-filter=A "HEAD..@{u}" 2>$null)
    if (@($incomingAdded).Count -gt 0) {
      $untrackedFiles = @(& $gitExe -C $repoRoot ls-files --others --exclude-standard)
      $conflicting = @($incomingAdded | Where-Object { $untrackedFiles -contains $_ })
      if (@($conflicting).Count -gt 0) {
        $untrackedBackupDir = Join-Path $artifactDir ("untracked-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
        foreach ($relPath in @($conflicting)) {
          $sourcePath = Join-Path $repoRoot $relPath
          if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
          $targetPath = Join-Path $untrackedBackupDir $relPath
          $targetParent = Split-Path -Parent $targetPath
          if (-not (Test-Path -LiteralPath $targetParent)) {
            New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
          }
          Move-Item -LiteralPath $sourcePath -Destination $targetPath -Force
          Write-Log "Moved untracked file blocking the update: $relPath -> $untrackedBackupDir"
        }
      }
    }
    Invoke-LoggedCommand -FilePath $gitExe -Arguments @("-C", $repoRoot, "pull", "--ff-only") -WorkingDirectory $repoRoot
  } else {
    Write-Log "No upstream commits to pull."
  }
  $afterSha = ([string](& $gitExe -C $repoRoot rev-parse HEAD)).Trim()
  $dependencyChanges = @()
  if ($beforeSha -ne $afterSha) {
    $dependencyChanges = @(& $gitExe -C $repoRoot diff --name-only $beforeSha $afterSha -- package.json package-lock.json npm-shrinkwrap.json)
  }
  $dependenciesChanged = @($dependencyChanges | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0

  # Fast path: when every pulled change is documentation-only, the existing
  # build stays valid. Skip install/build/restart and just stamp the new SHA
  # into the shipped build info so the status check reports "current".
  if ($beforeSha -ne $afterSha -and -not $dependenciesChanged) {
    # Wrap the whole pipeline in @(): a single-item pipeline result is a scalar
    # whose .Count access fails under StrictMode.
    $changedFiles = @(@(& $gitExe -C $repoRoot diff --name-only $beforeSha $afterSha) |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $docsOnlyPattern = '^(docs/|Manual/)|^[^/]+\.md$'
    $nonDocChanges = @($changedFiles | Where-Object { [string]$_ -notmatch $docsOnlyPattern })
    if (@($changedFiles).Count -gt 0 -and @($nonDocChanges).Count -eq 0) {
      Write-Log ("Docs-only update ({0} file(s)); skipping install, build, and restart." -f $changedFiles.Count)
      foreach ($buildInfoRelative in @(".cfs-build-info.json", "runtime\.cfs-build-info.json")) {
        $buildInfoPath = Join-Path $appPath $buildInfoRelative
        if (Test-Path -LiteralPath $buildInfoPath) {
          $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
          $buildInfo.gitSha = $afterSha
          $buildInfo | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8
        }
      }
      Write-UpdateStatus -State "completed" -Step "done" -Message "Docs-only update applied. No rebuild was needed." -Progress 100 -BackupPath $backupPath
      Write-Log "CFS self update completed (docs-only fast path)."
      exit 0
    }
  }
  $dependenciesReady = Test-NpmDependenciesReady -WorkingDirectory $appPath
  $needsNpmInstall = $dependenciesChanged -or -not $dependenciesReady

  if ($needsNpmInstall) {
    $installMessage = if ($dependenciesChanged) { "Installing changed dependencies." } else { "Installing missing dependencies." }
    Write-UpdateStatus -State "running" -Step "npm-install" -Message $installMessage -Progress 58 -BackupPath $backupPath
    Stop-AppListeners -TargetPort $Port
    Start-Sleep -Seconds 1
    Invoke-NpmDependencyInstall -WorkingDirectory $appPath
  } else {
    Write-UpdateStatus -State "running" -Step "npm-install" -Message "Dependencies unchanged. Skipping install." -Progress 58 -BackupPath $backupPath
    Write-Log "Dependencies unchanged; skipped npm install."
  }

  Write-UpdateStatus -State "running" -Step "build" -Message "Building updated app." -Progress 78 -BackupPath $backupPath
  Stop-AppListeners -TargetPort $Port
  Start-Sleep -Seconds 1
  Clear-NextBuildOutput -RootPath $appPath
  Write-Log "Using NODE_ENV=production for Next build."
  Invoke-WithProductionNodeEnv {
    Invoke-LoggedCommand -FilePath "npm.cmd" -Arguments @("run", "build") -WorkingDirectory $appPath
  }
  Sync-StandaloneStaticAssets -RootPath $appPath

  Write-UpdateStatus -State "running" -Step "restart" -Message "Restarting app." -Progress 94 -BackupPath $backupPath
  Stop-AppListeners -TargetPort $Port
  Start-Sleep -Seconds 1
  Start-CfsAppServer

  Write-UpdateStatus -State "completed" -Step "done" -Message "Update completed. Reload the browser." -Progress 100 -BackupPath $backupPath
  Write-Log "CFS self update completed."
} catch {
  Write-Log ("FAILED: " + $_.Exception.Message)
  Write-UpdateStatus -State "failed" -Step "failed" -Message $_.Exception.Message -Progress 100
  # The listeners may already be stopped (install/build steps stop them). Bring
  # the previous app back up so the waiting browser page can reconnect and show
  # this failure instead of sitting on "reconnecting" forever.
  try {
    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $stillListening) {
      Write-Log "Restarting app after failed update so the UI can reconnect."
      Start-CfsAppServer
    }
  } catch {
    Write-Log ("Could not restart app after failure: " + $_.Exception.Message)
  }
  exit 1
}
