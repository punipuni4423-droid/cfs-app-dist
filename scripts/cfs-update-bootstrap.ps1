[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [ValidateRange(1,65535)][int]$Port = 3014,
  [ValidateSet('127.0.0.1','0.0.0.0')][string]$HostName = '127.0.0.1',
  [ValidatePattern('^$|^[a-fA-F0-9]{40}$')][string]$ExpectedHead = '',
  [string]$StartedAt = '',
  [string]$AttemptId = '',
  [switch]$RepairBuild,
  [switch]$ApiHandshake
)

# Bootstrap protocol v1 is self-contained. Keep its entry contract compatible:
# installed copies are retained while the actual worker is fetched each time.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules') + ';' + [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\Modules')
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$script:acknowledged = $false
$script:bootstrapLock = $null
$script:bootstrapStatus = $null
$script:bootstrapRoot = $null
$script:targetCommit = ''
$script:installedHead = ''
$script:workerInvoked = $false

function Get-CfsUpdateSource {
  # No environment/CLI override. Tests may replace only this function in an
  # explicitly isolated copy; production CMD and API always use this source.
  return [pscustomobject]@{ url = 'https://github.com/punipuni4423-droid/cfs-app-dist.git'; branch = 'master' }
}

function Assert-BootstrapPlainPath {
  param([string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update paths must not contain reparse points.' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

function ConvertTo-BootstrapArgument {
  param([string]$Value)
  return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

function Invoke-BootstrapGit {
  param([string]$Git, [string[]]$Arguments, [int]$TimeoutMs = 180000)
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Git
  $info.Arguments = (@('--no-replace-objects') + $Arguments | ForEach-Object { ConvertTo-BootstrapArgument $_ }) -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false, $true)
  $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
  foreach ($name in @($info.EnvironmentVariables.Keys)) {
    if ($name -match '^GIT_CONFIG' -or $name -in @('GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_REPLACE_REF_BASE','GIT_NO_REPLACE_OBJECTS')) { $info.EnvironmentVariables.Remove($name) }
  }
  # The distribution is public. Do not inherit user/system URL rewriting or
  # config injection when obtaining executable recovery code.
  $info.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
  $info.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = 'NUL'
  $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $info.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
  $process = [Diagnostics.Process]::Start($info)
  try {
    $output = $process.StandardOutput.ReadToEndAsync()
    $errorText = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMs)) {
      try { $process.Kill() } catch { }
      throw 'Git update timed out. Check network and Git availability, then use the same update entry again.'
    }
    $null = $errorText.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw ('Git update check or transfer failed (exit ' + $process.ExitCode + '). Check repository, network and file permissions.') }
    return $output.GetAwaiter().GetResult().Trim()
  } finally { $process.Dispose() }
}

function Resolve-BootstrapGit {
  param([string]$Root)
  $candidates = @()
  $runtime = Assert-BootstrapPlainPath (Join-Path $Root '.cfs-runtime')
  if (Test-Path -LiteralPath $runtime) {
    foreach ($runtimeHome in @(Get-ChildItem -LiteralPath $runtime -Directory -ErrorAction Stop)) {
      foreach ($relative in @('cmd\git.exe','bin\git.exe','mingw64\bin\git.exe')) {
        $candidate = Join-Path $runtimeHome.FullName $relative
        if (Test-Path -LiteralPath $candidate) { $candidates += $candidate }
      }
    }
  }
  $onPath = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  foreach ($candidate in $candidates) {
    $null = Assert-BootstrapPlainPath $candidate
    try { $null = Invoke-BootstrapGit $candidate @('--version') 10000; return $candidate } catch { }
  }
  throw 'Git could not run. Restore bundled PortableGit or install Git for Windows, then use UPDATE_CFS_APP.cmd again.'
}

function Send-BootstrapAck {
  param([string]$State, [string]$Message)
  if ($script:acknowledged) { return }
  $script:acknowledged = $true
  if ($ApiHandshake) {
    Write-Output ('CFS_UPDATE_ACK:' + (@{state=$State;message=$Message} | ConvertTo-Json -Compress))
  } else { Write-Host $Message }
}

function Write-BootstrapStatus {
  param([string]$State, [string]$Step, [string]$Message)
  if (-not $script:bootstrapLock -or -not $script:bootstrapStatus) { return }
  $now = [DateTime]::UtcNow.ToString('o')
  $payload = [ordered]@{state=$State;currentStep=$Step;message=$Message;progress=1;startedAt=$StartedAt;updatedAt=$now;attemptId=$AttemptId;targetCommit=$script:targetCommit;expectedHead=$script:installedHead}
  if ($State -eq 'failed') { $payload['finishedAt']=$now; $payload['progress']=100 }
  $temporary = $script:bootstrapStatus + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $replacing = [IO.File]::Exists($script:bootstrapStatus)
      try {
        if ($replacing) { [IO.File]::Replace($temporary, $script:bootstrapStatus, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $script:bootstrapStatus) }
        return
      } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $nativeError = $failure.HResult -band 0xFFFF
        if ($attempt -eq 19 -or (-not ($nativeError -in @(32,33,1175)) -and -not (-not $replacing -and $nativeError -in @(80,183)))) { throw }
        Start-Sleep -Milliseconds 50
      }
    }
  } finally { if ([IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch { } } }
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

function Get-BootstrapSnapshot {
  param([string]$Git, [string]$Cache, [string]$Stage, [string]$Commit)
  $manifest = (Invoke-BootstrapGit $Git @('-C',$Cache,'show',($Commit + ':scripts/cfs-update-contract.json'))) | ConvertFrom-Json
  if ($manifest.protocolVersion -ne 1 -or $manifest.entrypoint -ne 'scripts/update-cfs-app.ps1') { throw 'The published updater requires a different bootstrap protocol. Obtain the official recovery bootstrap.' }
  $files = @($manifest.files)
  if ($files.Count -lt 4 -or $files.Count -gt 32 -or (@($files | Select-Object -Unique)).Count -ne $files.Count) { throw 'Invalid update snapshot file list.' }
  foreach ($required in @('scripts/update-cfs-app.ps1','scripts/cfs-local-data-preservation.ps1','scripts/cfs-update-maintenance.ps1','scripts/test-cfs-instance.ps1')) {
    if ($files -notcontains $required) { throw 'The update snapshot is missing a required helper.' }
  }
  $blobs = @{}
  foreach ($file in $files) {
    if ($file -notmatch '^scripts/[A-Za-z0-9_-]+\.(ps1|json|mjs)$') { throw 'Invalid update snapshot path.' }
    $entry = Invoke-BootstrapGit $Git @('-C',$Cache,'ls-tree',$Commit,'--',$file)
    if ($entry -notmatch '^100644 blob ([a-f0-9]{40})\t') { throw 'Update snapshot entries must be ordinary Git blobs.' }
    $blobs[$file] = $Matches[1]
    if ([long](Invoke-BootstrapGit $Git @('-C',$Cache,'cat-file','-s',$blobs[$file])) -gt 2097152) { throw 'Update snapshot file is too large.' }
  }
  $null = New-Item -ItemType Directory -Path $Stage
  $archive = Join-Path $Stage 'snapshot.zip'
  $null = Invoke-BootstrapGit $Git (@('-C',$Cache,'archive','--format=zip',('--output=' + $archive),$Commit,'--') + $files)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($file in $files) {
      $entry = $zip.GetEntry($file)
      if (-not $entry) { throw 'Snapshot archive is missing a required entry.' }
      $destination = Join-Path $Stage $file
      $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
      if ((Invoke-BootstrapGit $Git @('-C',$Cache,'hash-object','--no-filters',$destination)) -ne $blobs[$file]) { throw 'Update snapshot bytes do not match the selected commit.' }
    }
  } finally { $zip.Dispose() }
  return (Join-Path $Stage $manifest.entrypoint)
}

function Assert-BootstrapCache {
  param([string]$Git, [string]$Repository)
  $pending = New-Object 'Collections.Generic.Stack[string]'
  $pending.Push($Repository)
  while ($pending.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The updater cache contains a reparse point.' }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
  $config = Invoke-BootstrapGit $Git @('-C',$Repository,'config','--local','--no-includes','--list')
  foreach ($line in @($config -split "`n")) {
    $key = ($line -split '=',2)[0]
    if ($key -notin @('core.repositoryformatversion','core.filemode','core.bare','core.logallrefupdates','core.ignorecase','core.symlinks')) { throw 'The updater cache has unexpected Git configuration. Preserve it for review before retrying.' }
  }
  if ((Invoke-BootstrapGit $Git @('-C',$Repository,'rev-parse','--is-bare-repository')) -ne 'true') { throw 'The updater cache is not a bare repository.' }
  $actual = Invoke-BootstrapGit $Git @('-C',$Repository,'rev-parse','--absolute-git-dir')
  if (-not [string]::Equals([IO.Path]::GetFullPath($actual),[IO.Path]::GetFullPath($Repository),[StringComparison]::OrdinalIgnoreCase)) { throw 'The updater cache points at a different Git directory.' }
}

function Assert-BootstrapObjectSource {
  param([string]$Git, [string]$Repository, [string]$GitDirectory)
  foreach ($relative in @('info/grafts','objects/info/alternates','objects/info/http-alternates')) {
    $metadata = Assert-BootstrapPlainPath (Join-Path $GitDirectory $relative)
    if (Test-Path -LiteralPath $metadata) { throw 'Git grafts or alternate object sources are not supported for a verified update.' }
  }
  if (Invoke-BootstrapGit $Git @('-C',$Repository,'for-each-ref','--format=%(refname)','refs/replace/')) {
    throw 'Git replacement references are not supported for a verified update.'
  }
}

try {
  $script:bootstrapRoot = Assert-BootstrapPlainPath ((Resolve-Path -LiteralPath $AppDir).Path)
  $cacheRoot = Assert-BootstrapPlainPath (Join-Path $script:bootstrapRoot '.cfs-updater')
  $null = Assert-BootstrapPlainPath (Join-Path $script:bootstrapRoot '.git')
  if (-not (Test-Path -LiteralPath (Join-Path $script:bootstrapRoot '.git') -PathType Container)) { throw 'Use the root of a Git-managed CFS installation.' }
  $git = Resolve-BootstrapGit $script:bootstrapRoot
  Assert-BootstrapObjectSource $git $script:bootstrapRoot (Join-Path $script:bootstrapRoot '.git')
  $source = Get-CfsUpdateSource
  $script:installedHead = Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'rev-parse','HEAD')
  if ($ExpectedHead -and $ExpectedHead -ne $script:installedHead) { throw 'The installed commit changed. Check the installation before updating again.' }
  if (-not [string]::Equals((Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'rev-parse','--show-toplevel')).Replace('/','\').TrimEnd('\'),$script:bootstrapRoot.Replace('/','\').TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'The selected folder is not the repository root.' }
  if ((Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'branch','--show-current')) -ne $source.branch -or (Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'remote','get-url','--all','origin')) -ne $source.url -or (Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'rev-parse','--abbrev-ref','--symbolic-full-name','@{u}')) -ne ('origin/' + $source.branch)) { throw 'This installation is not tracking the official CFS distribution branch.' }
  if (Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'status','--porcelain','--untracked-files=no')) { throw 'Tracked files have local changes. Preserve and review them before updating.' }
  if (Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'ls-tree','-r','--name-only','HEAD','--','.cfs-updater')) { throw 'The maintenance folder must remain untracked.' }
  $null = New-Item -ItemType Directory -Force -Path $cacheRoot
  $lockPath = Assert-BootstrapPlainPath (Join-Path $cacheRoot 'maintenance.lock')
  try { $script:bootstrapLock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  catch [IO.IOException] { Send-BootstrapAck 'busy' 'An update or maintenance operation is already running.'; exit 2 }
  Assert-CfsUpdatePowerShellIdle $script:bootstrapRoot
  if (-not $StartedAt) { $StartedAt = [DateTime]::UtcNow.ToString('o') }
  $parsedStart = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($StartedAt,[ref]$parsedStart)) { throw 'Invalid update start timestamp.' }
  if (-not $AttemptId) { $AttemptId = [Guid]::NewGuid().ToString('D') }
  $parsedAttempt = [Guid]::Empty
  if (-not [Guid]::TryParse($AttemptId,[ref]$parsedAttempt)) { throw 'Invalid update attempt identifier.' }
  $statusDirectory = Assert-BootstrapPlainPath (Join-Path $script:bootstrapRoot 'artifacts\self-update')
  $null = New-Item -ItemType Directory -Force -Path $statusDirectory
  $script:bootstrapStatus = Assert-BootstrapPlainPath (Join-Path $statusDirectory 'status.json')
  # Keep the first shipped recovery entry as a historical fallback.
  # The installed entry is now preferred, so never seed the old slot with this revision.
  Write-BootstrapStatus 'running' 'queued' 'Fetching a fresh updater from the official distribution.'
  Send-BootstrapAck 'started' 'Update maintenance started. Keep this window open until the result is shown.'
  $repository = Assert-BootstrapPlainPath (Join-Path $cacheRoot 'repository.git')
  if (-not (Test-Path -LiteralPath $repository)) { $null = Invoke-BootstrapGit $git @('init','--bare',$repository) }
  Assert-BootstrapCache $git $repository
  Assert-BootstrapObjectSource $git $repository $repository
  $null = Invoke-BootstrapGit $git @('-C',$repository,'fetch','--no-tags',$source.url,('refs/heads/' + $source.branch))
  $script:targetCommit = Invoke-BootstrapGit $git @('-C',$repository,'rev-parse','FETCH_HEAD')
  if ($script:targetCommit -notmatch '^[a-f0-9]{40}$') { throw 'Invalid distribution commit.' }
  foreach ($protected in @('data','.cfs-updater')) {
    if (Invoke-BootstrapGit $git @('-C',$repository,'ls-tree','-r','--name-only',$script:targetCommit,'--',$protected)) { throw 'The distribution must not track local data or the maintenance folder.' }
  }
  $stageRoot = Assert-BootstrapPlainPath (Join-Path $cacheRoot 'stages')
  $null = New-Item -ItemType Directory -Force -Path $stageRoot
  $stage = Join-Path $stageRoot ([Guid]::NewGuid().ToString('N'))
  $worker = Get-BootstrapSnapshot $git $repository $stage $script:targetCommit
  if ((Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'rev-parse','HEAD')) -ne $script:installedHead -or (Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'status','--porcelain','--untracked-files=no'))) { throw 'Installed files changed while the updater was being fetched.' }
  # Transfer exactly the selected commit, not a moving branch. This changes Git
  # objects/tracking only; the fresh worker performs the guarded fast-forward.
  $null = Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'fetch','--no-tags',$repository,($script:targetCommit + ':refs/remotes/origin/' + $source.branch))
  $null = Invoke-BootstrapGit $git @('-C',$script:bootstrapRoot,'merge-base','--is-ancestor',$script:installedHead,$script:targetCommit)
  Write-BootstrapStatus 'running' 'queued' 'The fresh updater was verified. Preparing the selected application update.'
  $savedGitEnvironment = @{}
  $gitEnvironmentNames = @('CFS_GIT_EXE','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_REPLACE_REF_BASE','GIT_NO_REPLACE_OBJECTS','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_TERMINAL_PROMPT','GCM_INTERACTIVE')
  $gitEnvironmentNames += @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -match '^GIT_CONFIG' })
  $gitEnvironmentNames = @($gitEnvironmentNames | Select-Object -Unique)
  foreach ($gitEnvironmentName in $gitEnvironmentNames) {
    $savedGitEnvironment[$gitEnvironmentName] = [Environment]::GetEnvironmentVariable($gitEnvironmentName)
    Remove-Item -LiteralPath ('Env:' + $gitEnvironmentName) -ErrorAction SilentlyContinue
  }
  try {
    $env:CFS_GIT_EXE = $git
    $env:GIT_NO_REPLACE_OBJECTS = '1'
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_CONFIG_GLOBAL = 'NUL'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    $script:workerInvoked = $true
    & $worker -AppDir $script:bootstrapRoot -Port $Port -HostName $HostName -ExpectedHead $script:installedHead -TargetCommit $script:targetCommit -MaintenanceLock $script:bootstrapLock -AttemptId $AttemptId -StartedAt $StartedAt -RepairBuild:$RepairBuild -ConsoleProgress:(-not $ApiHandshake) | Out-Null
    $result = $LASTEXITCODE
  } finally {
    foreach ($gitEnvironmentName in $gitEnvironmentNames) {
      if ($null -eq $savedGitEnvironment[$gitEnvironmentName]) { Remove-Item -LiteralPath ('Env:' + $gitEnvironmentName) -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($gitEnvironmentName, $savedGitEnvironment[$gitEnvironmentName]) }
    }
  }
  if ($result -ne 0) { throw 'The update did not complete. Check artifacts/self-update and use the same update entry after resolving the cause.' }
  if (-not $ApiHandshake) { Write-Host 'CFS update completed and the running build was verified.' }
  exit 0
} catch {
  $message = $_.Exception.Message
  $workerFailurePublished = $false
  if ($script:workerInvoked -and $script:bootstrapStatus) {
    try {
      $lastStatus = [IO.File]::ReadAllText($script:bootstrapStatus, [Text.Encoding]::UTF8) | ConvertFrom-Json
      $workerFailurePublished = $lastStatus.attemptId -eq $AttemptId -and $lastStatus.state -eq 'failed'
    } catch { }
  }
  if (-not $workerFailurePublished) { try { Write-BootstrapStatus 'failed' 'bootstrap' $message } catch { } }
  Send-BootstrapAck 'failed' $message
  if (-not $ApiHandshake) { Write-Host $message }
  exit 1
} finally {
  if ($script:bootstrapLock) { $script:bootstrapLock.Dispose() }
}
