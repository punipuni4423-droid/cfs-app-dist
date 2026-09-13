param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [int]$Port = 3014,
  [string]$HostName = "0.0.0.0",
  [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$ExpectedHead = '',
  [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$TargetCommit = '',
  [IO.FileStream]$MaintenanceLock,
  [string]$AttemptId = '',
  [string]$StartedAt = '',
  [switch]$RepairBuild,
  [switch]$ConsoleProgress
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Git for Windows emits UTF-8 paths. Windows PowerShell 5 otherwise decodes
# native stdout with the inherited console code page (often CP932), corrupting
# rev-parse --show-toplevel before that path is passed to the next Git command.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$appPath = (Resolve-Path -LiteralPath $AppDir).Path
. (Join-Path $PSScriptRoot 'cfs-local-data-preservation.ps1')
. (Join-Path $PSScriptRoot 'cfs-update-maintenance.ps1')
$null = Assert-CfsPlainPath -Path $appPath
$artifactDir = Join-Path $appPath "artifacts\self-update"
$dataBackupDir = Join-Path $appPath "artifacts\data-recovery"
$null = Assert-CfsChildPath -Root $appPath -Path $artifactDir
$null = Assert-CfsChildPath -Root $appPath -Path $dataBackupDir
$statusPath = Join-Path $artifactDir "status.json"
$logPath = Join-Path $artifactDir ("update-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
New-Item -ItemType Directory -Force -Path $artifactDir, $dataBackupDir | Out-Null
$backupPath = ""
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
  if ($AttemptId) { $payload['attemptId'] = $AttemptId }
  if ($TargetCommit) { $payload['targetCommit'] = $TargetCommit }
  if ($ExpectedHead) { $payload['expectedHead'] = $ExpectedHead }
  if ($State -eq "completed" -or $State -eq "failed") {
    $payload["finishedAt"] = (Get-Date).ToUniversalTime().ToString("o")
  }
  # Publish a complete document without truncating a file the status API reads.
  # Retry only this publication for transient sharing/lock violations: at most
  # 20 attempts and 950 ms of waiting, never a retry of the update itself.
  $temporaryStatusPath = $statusPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($temporaryStatusPath, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $replacing = [IO.File]::Exists($statusPath)
      try {
        if ($replacing) {
          [IO.File]::Replace($temporaryStatusPath, $statusPath, [NullString]::Value)
        } else {
          [IO.File]::Move($temporaryStatusPath, $statusPath)
        }
        if ($ConsoleProgress) { Write-Host ("[{0}%] {1}" -f $Progress, $Message) }
        return
      } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $nativeError = $failure.HResult -band 0xFFFF
        # ReplaceFile can also report 1175 when it cannot remove the destination;
        # Windows leaves both original names intact, so the same publish can retry.
        $transient = ($nativeError -in @(32, 33, 1175)) -or (-not $replacing -and $nativeError -in @(80, 183))
        if (-not $transient -or $attempt -eq 19) { throw }
        Start-Sleep -Milliseconds 50
      }
    }
  } finally {
    # This invocation owns only its unique temporary file, never status.json.
    if ([IO.File]::Exists($temporaryStatusPath)) {
      try { [IO.File]::Delete($temporaryStatusPath) } catch { Write-Warning 'Could not remove a temporary update status file.' }
    }
  }
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

function Import-PublicSupabaseEnv {
  $publicEnvPath = Join-Path $appPath "cfs-public-supabase.env"
  if (-not (Test-Path -LiteralPath $publicEnvPath)) {
    return
  }

  $allowedKeys = @(
    "CFS_SHARING_MODE",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "CFS_SUPABASE_FUNCTION_NAME"
  )
  $loadedKeys = @()

  foreach ($line in Get-Content -LiteralPath $publicEnvPath) {
    if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
    $key, $value = $line.Split("=", 2)
    $key = $key.Trim()
    if ($allowedKeys -notcontains $key) { continue }
    if (Test-Path -LiteralPath "Env:$key") { continue }
    Set-Item -Path "Env:$key" -Value $value.Trim()
    $loadedKeys += $key
  }

  if (@($loadedKeys).Count -gt 0) {
    Write-Log ("Loaded public Supabase sharing environment keys: " + ($loadedKeys -join ", "))
  }
}

function Test-CfsVerifiedBuild {
  param([string]$Commit)
  try {
    $dist = Get-NextDistPath $appPath
    $rootInfo = Get-Content -LiteralPath (Join-Path $appPath '.cfs-build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $distInfo = Get-Content -LiteralPath (Join-Path $dist 'cfs-build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($rootInfo.gitSha -ne $Commit -or $distInfo.gitSha -ne $Commit -or $rootInfo.builtAt -ne $distInfo.builtAt) { return $false }
    if ($script:BuildStartedAt -and ([DateTime]::Parse($rootInfo.builtAt).ToUniversalTime() -lt $script:BuildStartedAt.AddSeconds(-1))) { return $false }
    foreach ($relative in @('standalone/server.js','BUILD_ID')) {
      if ((Get-Item -LiteralPath (Join-Path $dist $relative)).Length -le 0) { return $false }
    }
    return (Test-Path -LiteralPath (Join-Path $dist 'standalone/.next/static') -PathType Container)
  } catch { return $false }
}

function Start-CfsAppServer {
  param([switch]$RequireFreshBuild)
  Import-PublicSupabaseEnv
  $entry = $null
  if (Test-CfsVerifiedBuild $TargetCommit) {
    $entry = Join-Path (Get-NextDistPath $appPath) 'standalone/server.js'
  }
  if (-not $entry) { throw 'No verified updated build is available. The older bundled runtime was preserved but will not be started automatically. Use UPDATE_CFS_APP.cmd after the cause is fixed.' }
  $node = Initialize-CfsUpdateNode $appPath
  $env:PORT = [string]$Port
  $env:HOSTNAME = $HostName
  $env:CFS_APP_DIR = $appPath
  $env:NODE_ENV = 'production'
  $script:RestartedProcess = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $appPath -RedirectStandardOutput (Join-Path $appPath ("start-" + $Port + ".out.log")) -RedirectStandardError (Join-Path $appPath ("start-" + $Port + ".err.log")) -WindowStyle Hidden -PassThru
}

function Wait-CfsUpdatedServer {
  param([string]$Commit)
  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  $probe = Join-Path $PSScriptRoot 'test-cfs-instance.ps1'
  $powerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not $script:RestartedProcess -or $script:RestartedProcess.HasExited) { throw 'The updated server exited before readiness was verified.' }
    & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probe -AppRoot $appPath -Port $Port
    if ($LASTEXITCODE -eq 0 -and (Test-CfsVerifiedBuild $Commit)) {
      $listeners = @(Get-CfsPortListeners -Port $Port)
      if ($listeners.Count -gt 0 -and @($listeners | Where-Object { $_.OwningProcess -ne $script:RestartedProcess.Id }).Count -eq 0) { return }
    }
    Start-Sleep -Seconds 1
  }
  throw 'The updated build did not become healthy. Check update/server logs and use UPDATE_CFS_APP.cmd after the cause is fixed.'
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
  foreach ($protected in @('data', 'artifacts', 'runtime', '.cfs-runtime', '.cfs-updater', '.git')) {
    $protectedPath = Join-Path $rootFullPath $protected
    if ($distPath.Equals($protectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        $distPath.StartsWith($protectedPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clear protected data/runtime output: $distPath"
    }
  }
  return $distPath
}

function Clear-NextBuildOutput {
  param(
    [string]$RootPath
  )
  $distPath = Get-NextDistPath -RootPath $RootPath
  Assert-CfsNoLegacyData -RootPath $RootPath
  if (Test-Path -LiteralPath $distPath) {
    Assert-CfsPlainTree -Directory $distPath
    Remove-Item -LiteralPath $distPath -Recurse -Force
    Write-Log "Cleared Next build output: $distPath"
  } else {
    Write-Log "Next build output was already clean: $distPath"
  }
}

function Assert-CfsNoLegacyData {
  param([string]$RootPath)
  $legacyPaths = @((Join-Path (Get-NextDistPath -RootPath $RootPath) 'standalone\data'), (Join-Path $RootPath '.next\standalone\data'), (Join-Path $RootPath 'runtime\data'))
  foreach ($legacyPath in $legacyPaths) {
    $null = Assert-CfsUpdatePlainPath $legacyPath
    if (Test-Path -LiteralPath $legacyPath) {
      if (-not (Test-Path -LiteralPath $legacyPath -PathType Container) -or @(Get-ChildItem -LiteralPath $legacyPath -Force -ErrorAction Stop).Count -gt 0) {
        throw 'Legacy or multiple local data stores were found. No build output will be cleared. Preserve these folders and follow docs/LOCAL_DATA_UPDATE_GUIDE_JA.md before updating.'
      }
    }
  }
}

function Sync-StandaloneStaticAssets {
  param(
    [string]$RootPath
  )
  $distPath = Get-NextDistPath -RootPath $RootPath
  $standaloneServer = Join-Path $distPath "standalone\server.js"
  $staticSource = Join-Path $distPath "static"
  if (-not (Test-Path -LiteralPath $standaloneServer) -or -not (Test-Path -LiteralPath $staticSource)) {
    return
  }
  $standaloneNextDir = Join-Path $distPath "standalone\.next"
  $staticTarget = Join-Path $standaloneNextDir "static"
  New-Item -ItemType Directory -Force -Path $standaloneNextDir | Out-Null
  if (Test-Path -LiteralPath $staticTarget) {
    Remove-Item -LiteralPath $staticTarget -Recurse -Force
  }
  Copy-Item -LiteralPath $staticSource -Destination $standaloneNextDir -Recurse -Force
  Write-Log "Copied static assets for Next standalone runtime."
}

$ownedMaintenanceLock = $false
if (-not $MaintenanceLock) {
  $MaintenanceLock = Enter-CfsUpdateMaintenance $appPath
  $ownedMaintenanceLock = $true
}
Assert-CfsUpdateMaintenanceHandle $appPath $MaintenanceLock
$script:BuildStartedAt = $null
$script:RestartedProcess = $null
$script:StoppedAppWriters = $false
try {
Assert-CfsNoLegacyUpdateWorker $appPath
if (-not $StartedAt) { $StartedAt = (Get-Date).ToUniversalTime().ToString("o") }
$script:StartedAt = $StartedAt
Write-UpdateStatus -State "running" -Step "start" -Message "Preparing self update." -Progress 5
Write-Log "CFS self update started. AppDir=$appPath Port=$Port HostName=$HostName"
Clear-NextRuntimeEnvironmentForBuild

try {
  Assert-CfsNoLegacyData -RootPath $appPath
  Write-UpdateStatus -State "running" -Step "git-check" -Message "Checking Git repository." -Progress 10
  $gitExe = Resolve-GitExecutable -RootPath $appPath
  $env:CFS_GIT_EXE = $gitExe
  Write-Log "Using Git executable: $gitExe"
  $repoRoot = (& $gitExe -C $appPath rev-parse --show-toplevel 2>&1)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$repoRoot)) {
    throw "Git repository was not found."
  }
  $repoRoot = ([string]$repoRoot).Trim()
  if (-not [string]::Equals([IO.Path]::GetFullPath($repoRoot), [IO.Path]::GetFullPath($appPath), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Git resolved a different repository root. No update will be applied.'
  }
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
    throw "Local tracked files have changes. Commit or discard them before updating."
  }
  $beforeSha = ([string](& $gitExe -C $repoRoot rev-parse HEAD)).Trim()
  if ($ExpectedHead -and $beforeSha -ne $ExpectedHead) { throw 'The installed commit changed before the worker started.' }

  Write-UpdateStatus -State "running" -Step "git-fetch" -Message "Fetching updates." -Progress 25 -BackupPath $backupPath
  if (-not $TargetCommit) {
    Invoke-LoggedCommand -FilePath $gitExe -Arguments @("-C", $repoRoot, "fetch", "--prune") -WorkingDirectory $repoRoot
    $TargetCommit = ([string](& $gitExe -C $repoRoot rev-parse '@{u}')).Trim()
  }
  if ($TargetCommit -notmatch '^[a-fA-F0-9]{40}$') { throw 'A fixed update commit is required.' }

  $countsText = (& $gitExe -C $repoRoot rev-list --left-right --count "HEAD...$TargetCommit" 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not compare local and upstream Git history."
  }
  $countParts = ([string]$countsText).Trim() -split "\s+"
  $ahead = if ($countParts.Count -ge 1) { [int]$countParts[0] } else { 0 }
  $behind = if ($countParts.Count -ge 2) { [int]$countParts[1] } else { 0 }
  if ($ahead -gt 0) {
    throw "The installed history is ahead of or diverged from the selected update. Review it before updating."
  }
  # Fast-forward may precede the stopped-writer snapshot only while both trees
  # exclude local business data. Refuse a remote that starts tracking that tree.
  foreach ($revision in @('HEAD', $TargetCommit)) {
    $trackedData = @(& $gitExe -C $repoRoot ls-tree -r --name-only $revision -- data .cfs-updater)
    if ($LASTEXITCODE -ne 0 -or $trackedData.Count -gt 0) {
      throw 'Local data must remain untracked in both installed and incoming versions.'
    }
  }

  Write-UpdateStatus -State "running" -Step "git-pull" -Message "Applying Git update." -Progress 40 -BackupPath $backupPath
  if ($behind -gt 0) {
    # An interrupted update can leave files the incoming commits ADD sitting
    # untracked in the working tree, which aborts the fast-forward update. Move such
    # files aside (kept under artifacts\self-update) instead of failing.
    $incomingAdded = @(& $gitExe -C $repoRoot diff --name-only --diff-filter=A "HEAD..$TargetCommit" 2>$null)
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
    if (([string](& $gitExe -C $repoRoot rev-parse HEAD)).Trim() -ne $beforeSha -or @(& $gitExe -C $repoRoot status --porcelain --untracked-files=no).Count -gt 0) { throw 'Installed files changed before fast-forward.' }
    Invoke-LoggedCommand -FilePath $gitExe -Arguments @("-C", $repoRoot, "merge", "--ff-only", $TargetCommit) -WorkingDirectory $repoRoot
  } else {
    Write-Log "No upstream commits to pull."
  }
  $afterSha = ([string](& $gitExe -C $repoRoot rev-parse HEAD)).Trim()
  if ($afterSha -ne $TargetCommit) { throw 'The applied commit is not the selected update.' }
  $dependencyChanges = @()
  if ($beforeSha -ne $afterSha) {
    $dependencyChanges = @(& $gitExe -C $repoRoot diff --name-only $beforeSha $afterSha -- package.json package-lock.json npm-shrinkwrap.json)
  }
  $dependenciesChanged = @($dependencyChanges | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0

  # Every update must prove the selected build and its running process. A
  # documentation-only change must not mask an earlier failed build.
  $dependenciesReady = Test-NpmDependenciesReady -WorkingDirectory $appPath
  $script:CfsUpdateNode = Initialize-CfsUpdateNode $appPath
  $env:PATH = [IO.Path]::GetDirectoryName($gitExe) + ';' + $env:PATH
  $needsNpmInstall = $dependenciesChanged -or -not $dependenciesReady

  # The docs-only path above must remain restart-free. Code updates stop every
  # identifiable app writer before snapshotting the complete transaction store.
  Write-UpdateStatus -State "running" -Step "backup-data" -Message "Stopping app and verifying local data backup." -Progress 50
  Stop-CfsDataWriters -AppRoot $appPath -Port $Port
  $script:StoppedAppWriters = $true
  $backupPath = Backup-CfsDataTrees -AppRoot $appPath -Trees @{ canonical = (Join-Path $appPath 'data') }
  Assert-CfsWritersStopped -AppRoot $appPath -Port $Port
  Write-Log "Verified complete local data backup: $backupPath"

  if ($needsNpmInstall) {
    $installMessage = if ($dependenciesChanged) { "Installing changed dependencies." } else { "Installing missing dependencies." }
    Write-UpdateStatus -State "running" -Step "npm-install" -Message $installMessage -Progress 58 -BackupPath $backupPath
    Assert-CfsWritersStopped -AppRoot $appPath -Port $Port
    Start-Sleep -Seconds 1
    Assert-CfsWritersStopped -AppRoot $appPath -Port $Port
    Invoke-NpmDependencyInstall -WorkingDirectory $appPath
  } else {
    Write-UpdateStatus -State "running" -Step "npm-install" -Message "Dependencies unchanged. Skipping install." -Progress 58 -BackupPath $backupPath
    Write-Log "Dependencies unchanged; skipped npm install."
  }

  Write-UpdateStatus -State "running" -Step "build" -Message "Building updated app." -Progress 78 -BackupPath $backupPath
  Assert-CfsWritersStopped -AppRoot $appPath -Port $Port
  Start-Sleep -Seconds 1
  Assert-CfsWritersStopped -AppRoot $appPath -Port $Port
  Clear-NextBuildOutput -RootPath $appPath
  $script:BuildStartedAt = [DateTime]::UtcNow
  Write-Log "Using NODE_ENV=production for Next build."
  Invoke-WithProductionNodeEnv {
    Invoke-LoggedCommand -FilePath "npm.cmd" -Arguments @("run", "build") -WorkingDirectory $appPath
  }
  Sync-StandaloneStaticAssets -RootPath $appPath
  if (-not (Test-CfsVerifiedBuild $TargetCommit)) { throw 'The build command did not produce a complete build for the selected commit.' }

  Write-UpdateStatus -State "running" -Step "restart" -Message "Restarting app." -Progress 94 -BackupPath $backupPath
  Assert-CfsWritersStopped -AppRoot $appPath -Port $Port
  Start-Sleep -Seconds 1
  Start-CfsAppServer -RequireFreshBuild
  Wait-CfsUpdatedServer -Commit $TargetCommit

  Write-UpdateStatus -State "completed" -Step "done" -Message "Update completed. Reload the browser." -Progress 100 -BackupPath $backupPath
  Write-Log "CFS self update completed."
} catch {
  $updateFailureMessage = $_.Exception.Message
  Write-Log ("FAILED: " + $updateFailureMessage)
  try {
    Write-UpdateStatus -State "failed" -Step "failed" -Message $updateFailureMessage -Progress 100 -BackupPath $backupPath
  } catch {
    Write-Log "Could not publish failed update status; continuing app recovery."
  }
  # The listeners may already be stopped (install/build steps stop them). Bring
  # the previous app back up so the waiting browser page can reconnect and show
  # this failure instead of sitting on "reconnecting" forever.
  try {
    $stillListening = @(Get-CfsPortListeners -Port $Port)
    if ($script:StoppedAppWriters -and -not $stillListening) {
      Write-Log "Restarting app after failed update so the UI can reconnect."
      Start-CfsAppServer
    }
  } catch {
    Write-Log ("Could not restart app after failure: " + $_.Exception.Message)
  }
  exit 1
}
} finally {
  if ($ownedMaintenanceLock -and $MaintenanceLock) { $MaintenanceLock.Dispose() }
}
