param([Alias('AppRoot')][string]$CheckRoot, [switch]$Check, [switch]$RunStartup, [switch]$VerifyStartupParent, [switch]$CheckBundledRuntime)

# A PS5 child may inherit PS7-only module paths. Use OS module locations in
# this process so CIM, networking and hashing remain available offline.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules') + ';' + [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\Modules')

# Protocol v1: this path is shared by the bootstrap, worker and launcher.
function Assert-CfsUpdatePlainPath {
  param([string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Update paths must not contain reparse points.'
      }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

function Get-CfsUpdateLockPath {
  param([string]$Root)
  return (Assert-CfsUpdatePlainPath (Join-Path $Root '.cfs-updater\maintenance.lock'))
}

function Enter-CfsUpdateMaintenance {
  param([string]$Root)
  $lockPath = Get-CfsUpdateLockPath $Root
  $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($lockPath))
  return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}

function Assert-CfsUpdateMaintenanceHandle {
  param([string]$Root, [IO.FileStream]$Handle)
  if (-not $Handle -or -not $Handle.CanWrite -or
      -not [string]::Equals($Handle.Name, (Get-CfsUpdateLockPath $Root), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The update maintenance handle does not belong to this installation.'
  }
}

function Test-CfsUpdateMaintenanceActive {
  param([string]$Root)
  $lockPath = Get-CfsUpdateLockPath $Root
  if (-not [IO.File]::Exists($lockPath)) { return $false }
  try {
    $handle = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $handle.Dispose()
    return $false
  } catch [IO.IOException] { return $true }
}

function Assert-CfsUpdatePowerShellIdle {
  param([string]$Root)
  $normalRoot = [IO.Path]::GetFullPath($Root).Replace('/', '\').TrimEnd('\')
  $rootPattern = '(?i)' + [regex]::Escape($normalRoot) + '(?=[\\''";)]|$)|' + [regex]::Escape($normalRoot) + '(?=\s+-[A-Za-z])'
  $entryPattern = '(?:update-cfs-app|cfs-update-bootstrap|bootstrap-v1)\.ps1'
  # Recognize actual script invocations, including quoted relative paths.
  $scriptArgument = '(?:"([^"]*' + $entryPattern + ')"|''([^'']*' + $entryPattern + ')''|([^\s"'';]*' + $entryPattern + '))(?=[\s;"'']|$)'
  $invocationPattern = '(?i)(?:\s-(?:File|f)\s+|(?:^|[;{]\s*|\s)&\s+)' + $scriptArgument
  $pending = @{}
  for ($observation = 1; $observation -le 3; $observation++) {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -OperationTimeoutSec 2 -ErrorAction Stop)
    foreach ($process in $processes) {
      $processId = [int]$process.ProcessId
      if ($processId -eq $PID) { continue }
      if ($processId -le 0) { throw 'A PowerShell process has no usable process number. Update was refused.' }
      $created = if ($process.CreationDate -is [datetime]) { $process.CreationDate.ToUniversalTime().ToString('o') } else { 'unknown' }
      $command = [string]$process.CommandLine
      if ([string]::IsNullOrWhiteSpace($command) -or $created -eq 'unknown') {
        $pending[$processId] = $created
        continue
      }
      # A complete row, including a replacement with a reused PID, is
      # classified by its own command. It is never accepted by PID alone.
      if ($pending.ContainsKey($processId)) {
        $previous = $pending[$processId]
        if ($previous -ne 'unknown' -and $previous -cne $created) {
          Write-Verbose "PowerShell process number reused. [pid=$processId; created=$created; reason=reidentified]"
        }
        $pending.Remove($processId)
      }
      $decoded = ''
      $startup = ($command -split '(?i)\s+-(?:Command|File|c|f)(?:\s|$)',2)[0]
      if ($startup -match '(?i)(?:^|\s)-(?:EncodedCommand|enc|ec|e)(?:\s|$)') {
        try {
          $encoded = [regex]::Match($startup, '(?i)(?:^|\s)-(?:EncodedCommand|enc|ec|e)\s+["'']?([A-Za-z0-9+/=]+)(?=["''\s]|$)')
          if (-not $encoded.Success) { throw 'Missing encoded command.' }
          $decoded = [Text.UnicodeEncoding]::new($false,$false,$true).GetString([Convert]::FromBase64String($encoded.Groups[1].Value))
          $command += ' ' + $decoded
        }
        catch { throw "An encoded PowerShell process cannot be identified. Update was refused. [pid=$processId; created=$created; reason=invalid-encoded-command]" }
      }
      $normalCommand = $command.Replace('/', '\').Replace("''", "'")
      if ($command -notmatch $entryPattern) { continue }
      $invocation = [regex]::Match($normalCommand, $invocationPattern)
      if (-not $invocation.Success) {
        $commandBody = if ($decoded) { $decoded } else { ($command -split '(?i)\s+-(?:Command|c)\s+',2 | Select-Object -Skip 1) }
        if ($commandBody) {
          $commandBody = $commandBody.Replace([char]47, [char]92).TrimStart().TrimStart('"')
          $invocation = [regex]::Match($commandBody, '(?i)^' + $scriptArgument)
        }
      }
      # The verified launchers invoke captured script text rather than a path.
      $capturedEntry = $normalCommand -match '(?i)&\s+\$entry\s+-AppDir|&\s+\(\[scriptblock\]::Create\(\$scriptText'
      if (-not $invocation.Success -and -not $capturedEntry) { continue }
      if ($normalCommand -match $rootPattern) {
        throw "A previous update process still exists for this installation. Wait for it to finish. [pid=$processId; created=$created; reason=same-installation]"
      }
      if ($invocation.Success) {
        $argument = @($invocation.Groups | Select-Object -Skip 1 | Where-Object Success)[0].Value
        if ($argument -notmatch '^(?:[A-Z]:\\|\\\\)') {
          throw "A PowerShell update process has no identifiable installation. Update was refused. [pid=$processId; created=$created; reason=unknown-installation]"
        }
      }
    }

    foreach ($processId in @($pending.Keys)) {
      try {
        $process = Get-Process -Id $processId -ErrorAction Stop
        if ($process -is [IDisposable]) { $process.Dispose() }
      } catch {
        if ($_.FullyQualifiedErrorId -ne 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand' -or
            $_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) {
          throw "A PowerShell process cannot be identified. Update was refused. [pid=$processId; created=$($pending[$processId]); reason=process-query-failed]"
        }
        $pending.Remove($processId)
      }
    }
    if ($pending.Count -eq 0) { return }
    if ($observation -lt 3) { Start-Sleep -Milliseconds 100 }
  }
  $processId = @($pending.Keys | Sort-Object)[0]
  throw "A PowerShell process cannot be identified. Update was refused. [pid=$processId; created=$($pending[$processId]); reason=incomplete-identity]"
}

function Initialize-CfsUpdateNode {
  param([string]$Root)
  $candidates = @()
  $runtime = Assert-CfsUpdatePlainPath (Join-Path $Root '.cfs-runtime')
  if (Test-Path -LiteralPath $runtime) {
    $candidates += @(Get-ChildItem -LiteralPath $runtime -Filter node.exe -File -Recurse -ErrorAction Stop | ForEach-Object { $_.FullName })
  }
  $onPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  foreach ($candidate in $candidates) {
    $null = Assert-CfsUpdatePlainPath $candidate
    $npm = Join-Path ([IO.Path]::GetDirectoryName($candidate)) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { continue }
    try {
      $version = & $candidate --version 2>$null
      if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { continue }
      $env:PATH = [IO.Path]::GetDirectoryName($candidate) + ';' + $env:PATH
      $npmVersion = & $npm --version 2>$null
      if ($LASTEXITCODE -eq 0 -and $npmVersion -match '^\d+\.') { return $candidate }
    } catch { }
  }
  throw 'Node.js 20+ with npm could not run. Restore the bundled .cfs-runtime or install a supported Node.js runtime, then use UPDATE_CFS_APP.cmd again.'
}

function Test-CfsBundledRuntimeAllowed {
  param([string]$Root)
  # A pristine package retains its initial bundled-runtime path. After an
  # update attempt, require the fallback runtime to match the installed HEAD.
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'artifacts\self-update\status.json')) -and
      -not (Test-Path -LiteralPath (Join-Path $Root '.cfs-updater\bootstrap-v1.ps1'))) { return $true }
  try {
    $metadataPath = Assert-CfsUpdatePlainPath (Join-Path $Root 'runtime\.cfs-build-info.json')
    $metadata = [IO.File]::ReadAllText($metadataPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $installedCommit = Get-CfsInstalledCommit $Root
    if ($installedCommit -notmatch '^[a-fA-F0-9]{40}$') { return $false }
    return $metadata.gitSha -eq ([string]$installedCommit).Trim()
  } catch { return $false }
}

function Get-CfsInstalledCommit {
  param([string]$Root)
  $savedEnvironment = @{}
  $previousConsoleEncoding = [Console]::OutputEncoding
  $names = @('GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_REPLACE_REF_BASE','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL')
  $names += @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -match '^GIT_CONFIG' })
  $names = @($names | Select-Object -Unique)
  foreach ($name in $names) {
    $savedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name)
    Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
  }
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $env:GIT_CONFIG_NOSYSTEM='1'; $env:GIT_CONFIG_GLOBAL='NUL'
    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $resolvedRoot = & $gitCommand.Source --no-replace-objects -C $Root rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not [string]::Equals([IO.Path]::GetFullPath(([string]$resolvedRoot).Trim()),[IO.Path]::GetFullPath($Root),[StringComparison]::OrdinalIgnoreCase)) { throw 'Cannot verify the installed Git root.' }
    $installedCommit = & $gitCommand.Source --no-replace-objects -C $Root rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the installed Git commit.' }
    return ([string]$installedCommit).Trim()
  } finally {
    [Console]::OutputEncoding = $previousConsoleEncoding
    foreach ($name in $names) {
      if ($null -eq $savedEnvironment[$name]) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name]) }
    }
  }
}

if ($CheckBundledRuntime) {
  if (Test-CfsBundledRuntimeAllowed $CheckRoot) { exit 0 }
  exit 1
}

if ($VerifyStartupParent) {
  try {
    $self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    $batch = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $self.ParentProcessId) -ErrorAction Stop
    $owner = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $batch.ParentProcessId) -ErrorAction Stop
    $expectedHelper = [IO.Path]::GetFullPath((Join-Path $CheckRoot 'scripts\cfs-update-maintenance.ps1'))
    if ($batch.Name -ine 'cmd.exe' -or $owner.Name -ine 'powershell.exe' -or
        ([string]$owner.CommandLine).IndexOf(('"' + $expectedHelper + '"'), [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $owner.CommandLine -notmatch '(?i)\s-RunStartup(?:\s|$)' -or
        -not (Test-CfsUpdateMaintenanceActive $CheckRoot)) { exit 1 }
    exit 0
  } catch { exit 1 }
}

if ($RunStartup) {
  $startupHandle = $null
  try {
    $startupHandle = Enter-CfsUpdateMaintenance $CheckRoot
    $batchPath = Assert-CfsUpdatePlainPath (Join-Path $CheckRoot 'START_CFS_APP.bat')
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $startInfo.Arguments = '/d /s /c ""' + $batchPath + '" --locked-worker --no-browser"'
    $startInfo.WorkingDirectory = $CheckRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startupProcess = [Diagnostics.Process]::Start($startInfo)
    try { $startupProcess.WaitForExit(); exit $startupProcess.ExitCode }
    finally { $startupProcess.Dispose() }
  } catch {
    Write-Host 'CFS startup is blocked by maintenance or a startup error. Wait for the current operation to finish and check the startup log.'
    exit 1
  } finally { if ($startupHandle) { $startupHandle.Dispose() } }
}

if ($Check) {
  try {
    if (Test-CfsUpdateMaintenanceActive $CheckRoot) { exit 1 }
    exit 0
  } catch { exit 1 }
}
