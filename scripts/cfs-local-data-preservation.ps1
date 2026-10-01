# Shared by the updater and the explicit legacy-local maintenance tool.
# Dot-sourcing defines functions only; it never copies data or stops a process.
function Assert-CfsPlainPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Reparse points are not supported for data preservation: $cursor"
      }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

function Assert-CfsChildPath {
  param([string]$Root, [string]$Path)
  $rootFull = Assert-CfsPlainPath -Path $Root
  $full = Assert-CfsPlainPath -Path $Path
  $prefix = $rootFull.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the intended folder: $full"
  }
  return $full
}

function Get-CfsDataInventory {
  param([string]$Directory)
  $root = Assert-CfsPlainPath -Path $Directory
  if (-not (Test-Path -LiteralPath $root)) { return }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Expected directory: $root" }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $current -Force) {
      $null = Assert-CfsChildPath -Root $root -Path $item.FullName
      $relative = $item.FullName.Substring($root.TrimEnd('\', '/').Length + 1)
      if ($item.PSIsContainer) {
        [pscustomobject]@{ path = $relative; kind = 'directory'; bytes = 0; sha256 = '' }
        $pending.Push($item.FullName)
      } else {
        [pscustomobject]@{ path = $relative; kind = 'file'; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
      }
    }
  }
}

function Assert-CfsPlainTree {
  param([string]$Directory)
  $root = Assert-CfsPlainPath -Path $Directory
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      $null = Assert-CfsChildPath -Root $root -Path $item.FullName
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Get-CfsInventorySignature {
  param([object[]]$Inventory)
  return ConvertTo-Json -InputObject @($Inventory | Sort-Object path) -Depth 5 -Compress
}

function Copy-CfsDataSnapshot {
  param([string]$Source, [string]$Destination)
  $sourceFull = Assert-CfsPlainPath -Path $Source
  $destinationFull = Assert-CfsPlainPath -Path $Destination
  if ($destinationFull.Equals($sourceFull, [StringComparison]::OrdinalIgnoreCase) -or
      $destinationFull.StartsWith($sourceFull.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup destination must be outside the source data tree.'
  }
  if (Test-Path -LiteralPath $destinationFull) { throw "Snapshot destination already exists: $destinationFull" }
  $before = @(Get-CfsDataInventory -Directory $sourceFull)
  New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null
  foreach ($entry in $before | Sort-Object { $_.path.Length }) {
    $target = Assert-CfsChildPath -Root $destinationFull -Path (Join-Path $destinationFull $entry.path)
    if ($entry.kind -eq 'directory') {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
      [IO.File]::Copy((Join-Path $sourceFull $entry.path), $target, $false)
    }
  }
  $after = @(Get-CfsDataInventory -Directory $sourceFull)
  $copied = @(Get-CfsDataInventory -Directory $destinationFull)
  $signature = Get-CfsInventorySignature -Inventory $before
  if ($signature -cne (Get-CfsInventorySignature -Inventory $after) -or
      $signature -cne (Get-CfsInventorySignature -Inventory $copied)) {
    throw "Data changed during backup or copy verification failed: $sourceFull. Partial backup retained: $destinationFull"
  }
  return ,$before
}

function Backup-CfsDataTrees {
  param([string]$AppRoot, [hashtable]$Trees)
  $backupRoot = Assert-CfsChildPath -Root $AppRoot -Path (Join-Path $AppRoot 'artifacts\data-recovery')
  $generation = Join-Path $backupRoot ('local-data-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $generation -Force | Out-Null
  $records = @()
  foreach ($label in $Trees.Keys | Sort-Object) {
    if ($label -notmatch '^[a-z-]+$') { throw 'Invalid backup tree label.' }
    $source = Assert-CfsChildPath -Root $AppRoot -Path $Trees[$label]
    $snapshot = Join-Path $generation $label
    $inventory = Copy-CfsDataSnapshot -Source $source -Destination $snapshot
    $records += [pscustomobject]@{ label = $label; source = $source; existed = (Test-Path -LiteralPath $source); inventory = @($inventory) }
  }
  $records | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $generation 'manifest.json') -Encoding UTF8
  foreach ($source in $Trees.Values) {
    try {
      Assert-CfsDataLocksStopped -Directory $source
      Assert-CfsTransactionJournal -Directory $source
    }
    catch { throw ($_.Exception.Message + " Original snapshot retained: $generation") }
  }
  return $generation
}

function Assert-CfsTransactionJournal {
  param([string]$Directory)
  $journal = Join-Path $Directory 'project-trash.transaction.json'
  if (-not (Test-Path -LiteralPath $journal)) { return }
  try {
    $raw = Get-Content -LiteralPath $journal -Raw -Encoding UTF8
    # PS5 pipelines unwrap top-level arrays; the app requires an object record.
    if (-not $raw.TrimStart().StartsWith('{')) { throw 'Expected object' }
    $record = $raw | ConvertFrom-Json -ErrorAction Stop
    if (($record.version -isnot [int] -and $record.version -isnot [long] -and $record.version -isnot [double] -and $record.version -isnot [decimal]) -or $record.version -ne 1 -or
        $record.projects -isnot [array] -or $null -eq $record.trash -or
        ($record.trash -isnot [pscustomobject] -and $record.trash -isnot [array])) {
      throw 'Invalid transaction record'
    }
  } catch { throw "Invalid transaction journal retained: $journal" }
}

function Assert-CfsDataLocksStopped {
  param([string]$Directory)
  foreach ($name in @('project-store.lock', 'collaboration.json.lock')) {
    $lockPath = Join-Path $Directory $name
    if (-not (Test-Path -LiteralPath $lockPath)) { continue }
    $ownerId = 0
    if ($name -eq 'project-store.lock') {
      $owners = @(Get-ChildItem -LiteralPath $lockPath -Force)
      if ($owners.Count -eq 1 -and $owners[0].Name -match '^owner-(\d+)-[\da-f-]+$') { $ownerId = [int]$Matches[1] }
    } else {
      try { $ownerId = [int](Get-Content -LiteralPath (Join-Path $lockPath 'owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json).pid }
      catch { throw "Unverifiable collaboration lock: $lockPath" }
    }
    if ($ownerId -le 0 -or (Get-CfsProcessById -ProcessId $ownerId)) {
      throw "Active or unverifiable data lock: $lockPath"
    }
  }
}

function Get-CfsProcessById {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($null -eq $process) { throw 'Process lookup returned no identity without a verified absence error.' }
    return $process
  }
  catch {
    if ($_.FullyQualifiedErrorId -eq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand' -and
        $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
    throw
  }
}

function Get-CfsPortListeners {
  param([int]$Port)
  # Query failure is not an empty port. Filtering locally avoids the normal
  # no-match exception raised by Get-NetTCPConnection's -LocalPort filter.
  return @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq $Port })
}

function Add-CfsWriterInventoryDiagnostic {
  param([hashtable]$Record)
  # Only caller-selected scalar identity fields, never command lines or arbitrary
  # exception messages. Diagnostic I/O must not decide whether a writer is safe.
  try {
    $Record['observedAt'] = [DateTime]::UtcNow.ToString('o')
    $diagnostic = [pscustomobject]$Record
    $previous = Get-Variable -Name CfsWriterInventoryDiagnostics -Scope Script -ErrorAction SilentlyContinue
    $items = if ($previous) { @($previous.Value) } else { @() }
    $script:CfsWriterInventoryDiagnostics = @($items | Select-Object -Last 31) + @($diagnostic)
    if (Get-Command Write-Log -CommandType Function -ErrorAction SilentlyContinue) {
      Write-Log ('Writer inventory: ' + ($diagnostic | ConvertTo-Json -Depth 3 -Compress))
    }
  } catch { } # The original safety check/exception is authoritative.
}

function Get-CfsWriterObservation {
  param([object]$Candidate)
  $processNumber = 0; $parentNumber = 0
  $idProperty = $Candidate.PSObject.Properties['ProcessId']
  $parentProperty = $Candidate.PSObject.Properties['ParentProcessId']
  $commandProperty = $Candidate.PSObject.Properties['CommandLine']
  $creationProperty = $Candidate.PSObject.Properties['CreationDate']
  if ($idProperty) { $null = [int]::TryParse([string]$idProperty.Value, [ref]$processNumber) }
  if ($parentProperty) { $null = [int]::TryParse([string]$parentProperty.Value, [ref]$parentNumber) }
  $missing = @()
  if ($processNumber -le 0) { $missing += 'ProcessId' }
  if (-not $commandProperty -or [string]::IsNullOrWhiteSpace([string]$commandProperty.Value)) { $missing += 'CommandLine' }
  $created = $null
  if ($creationProperty -and $creationProperty.Value -is [datetime]) { $created = $creationProperty.Value.ToUniversalTime().ToString('o') }
  else { $missing += 'CreationDate' }
  return [pscustomobject]@{ pid = $processNumber; parentPid = $parentNumber; creationDate = $created; missingFields = ($missing -join ',') }
}

function Get-CfsAppWriters {
  param([string]$AppRoot)
  $root = (Assert-CfsPlainPath -Path $AppRoot).TrimEnd('\', '/')
  # Match the exact app path boundary (both slash styles), never just its name.
  $patterns = @([regex]::Escape($root + '\'), [regex]::Escape($root.Replace('\', '/') + '/'))
  $pending = @{}
  $lastUnknown = $null
  $script:CfsWriterInventoryDiagnostics = @()
  # At most three complete queries including the first, and two 100ms waits.
  # OperationTimeoutSec bounds each CIM operation, not a hard wall-clock SLA.
  for ($observation = 1; $observation -le 3; $observation++) {
    try {
      $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -OperationTimeoutSec 2 -ErrorAction Stop)
    } catch {
      Add-CfsWriterInventoryDiagnostic @{ phase = 'enumerate'; observation = $observation; result = 'query-error'; exceptionType = $_.Exception.GetType().FullName; hResult = $_.Exception.HResult; errorCode = 'CimQueryFailed'; category = [string]$_.CategoryInfo.Category }
      throw
    }
    $incomplete = $false
    foreach ($candidate in $candidates) {
      $identity = Get-CfsWriterObservation $candidate
      if ($identity.missingFields) {
        $incomplete = $true; $lastUnknown = $identity
        Add-CfsWriterInventoryDiagnostic @{ phase = 'enumerate'; observation = $observation; pid = $identity.pid; parentPid = $identity.parentPid; creationDate = $identity.creationDate; missingFields = $identity.missingFields; result = 'incomplete' }
        if ($identity.pid -le 0) { throw 'A Node process cannot be identified. Writer inventory has no usable PID; maintenance was refused.' }
        if (-not $pending.ContainsKey($identity.pid)) { $pending[$identity.pid] = $identity }
      } elseif ($pending.ContainsKey($identity.pid)) {
        $previous = $pending[$identity.pid]
        $result = if (-not $previous.creationDate) { 'complete-identity-established' } elseif ($previous.creationDate -ceq $identity.creationDate) { 'complete-same-identity' } else { 'complete-new-identity' }
        Add-CfsWriterInventoryDiagnostic @{ phase = 'enumerate'; observation = $observation; pid = $identity.pid; parentPid = $identity.parentPid; creationDate = $identity.creationDate; missingFields = ''; result = $result }
        # A reused PID is represented only by this new, complete snapshot row.
        # Stop-CfsDataWriters still binds a handle and rechecks before stopping.
        $pending.Remove($identity.pid)
      }
    }
    foreach ($processNumber in @($pending.Keys)) {
      $identity = $pending[$processNumber]
      try { $process = Get-CfsProcessById -ProcessId $processNumber }
      catch {
        Add-CfsWriterInventoryDiagnostic @{ phase = 'process-probe'; observation = $observation; pid = $identity.pid; parentPid = $identity.parentPid; missingFields = $identity.missingFields; result = 'query-error'; exceptionType = $_.Exception.GetType().FullName; hResult = $_.Exception.HResult; errorCode = 'ProcessProbeFailed'; category = [string]$_.CategoryInfo.Category }
        throw
      }
      if ($null -eq $process) {
        Add-CfsWriterInventoryDiagnostic @{ phase = 'process-probe'; observation = $observation; pid = $identity.pid; parentPid = $identity.parentPid; missingFields = $identity.missingFields; result = 'NoProcessFoundForGivenId' }
        $pending.Remove($processNumber)
      } else {
        Add-CfsWriterInventoryDiagnostic @{ phase = 'process-probe'; observation = $observation; pid = $identity.pid; parentPid = $identity.parentPid; missingFields = $identity.missingFields; result = 'alive-unresolved' }
        if ($process -is [IDisposable]) { $process.Dispose() }
      }
    }
    # Missing from a later snapshot is insufficient: every past unknown must
    # be fully reidentified or positively absent. Never return a partial query.
    if (-not $incomplete -and $pending.Count -eq 0) {
      return @($candidates | Where-Object { $_.CommandLine -match $patterns[0] -or $_.CommandLine -match $patterns[1] })
    }
    if ($observation -lt 3) { Start-Sleep -Milliseconds 100 }
  }
  $unresolved = if ($pending.Count -gt 0) { @($pending.Values | Sort-Object pid)[0] } else { $lastUnknown }
  $reason = if ($pending.Count -gt 0) { 'unresolved' } else { 'final-inventory-incomplete' }
  Add-CfsWriterInventoryDiagnostic @{ phase = 'final'; observation = 3; pid = $unresolved.pid; parentPid = $unresolved.parentPid; missingFields = $unresolved.missingFields; result = $reason }
  throw ("A Node process cannot be identified. Writer inventory is incomplete; maintenance was refused. [pid={0}; parentPid={1}; missingFields={2}; observations=3; phase=enumerate; result={3}; observedAt={4}]" -f $unresolved.pid, $unresolved.parentPid, $unresolved.missingFields, $reason, [DateTime]::UtcNow.ToString('o'))
}

function Assert-CfsWritersStopped {
  param([string]$AppRoot, [int]$Port)
  if (@(Get-CfsAppWriters -AppRoot $AppRoot).Count -gt 0 -or
      @(Get-CfsPortListeners -Port $Port).Count -gt 0) {
    throw 'A CFS writer is still running. Data preservation requires all app processes to stay stopped.'
  }
}

function Stop-CfsDataWriters {
  param([string]$AppRoot, [int]$Port)
  $writers = @(Get-CfsAppWriters -AppRoot $AppRoot)
  $writerIds = @($writers | ForEach-Object { [int]$_.ProcessId })
  foreach ($listener in @(Get-CfsPortListeners -Port $Port)) {
    if ($writerIds -notcontains [int]$listener.OwningProcess) {
      throw "Port $Port belongs to an unverified process; stop the intended app using its launcher first."
    }
  }
  foreach ($writer in $writers) {
    $process = Get-CfsProcessById -ProcessId $writer.ProcessId
    if ($process) {
      # Bind a process handle before rechecking identity. Never stop a new
      # process merely because Windows reused a PID from the earlier inventory.
      $null = $process.Handle
      $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$writer.ProcessId) -ErrorAction Stop
      if (-not $current -or $current.CreationDate -ne $writer.CreationDate -or $current.CommandLine -cne $writer.CommandLine) {
        throw 'CFS process identity changed; refusing to stop a reused PID.'
      }
      Stop-Process -InputObject $process -Force -ErrorAction Stop
      if (-not $process.WaitForExit(10000)) { throw 'CFS process did not exit.' }
    }
  }
  Assert-CfsWritersStopped -AppRoot $AppRoot -Port $Port
}

function Invoke-CfsLegacyDataCopy {
  param([string]$AppRoot, [string]$LegacyDirectory)
  $canonical = Assert-CfsChildPath -Root $AppRoot -Path (Join-Path $AppRoot 'data')
  $legacy = Assert-CfsChildPath -Root $AppRoot -Path $LegacyDirectory
  $canonicalInventory = @(Get-CfsDataInventory -Directory $canonical)
  $legacyInventory = @(Get-CfsDataInventory -Directory $legacy)
  # Preserve both originals before validation. Invalid JSON and journals are
  # evidence, never repaired, removed or rewritten by this tool.
  $backup = Backup-CfsDataTrees -AppRoot $AppRoot -Trees @{ canonical = $canonical; legacy = $legacy }
  foreach ($directory in @($canonical, $legacy)) {
    foreach ($entry in @(Get-CfsDataInventory -Directory $directory)) {
      if ($entry.kind -eq 'file' -and $entry.path -match '\.json$') {
        try {
          $raw = Get-Content -LiteralPath (Join-Path $directory $entry.path) -Raw -Encoding UTF8
          if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Empty JSON' }
          $null = $raw | ConvertFrom-Json -ErrorAction Stop
        }
        catch { throw "Invalid JSON retained in $directory. Backup: $backup" }
      }
    }
  }
  if ($legacyInventory.Count -eq 0) { return $backup }
  if ($canonicalInventory.Count -gt 0) {
    if ((Get-CfsInventorySignature $canonicalInventory) -cne (Get-CfsInventorySignature $legacyInventory)) {
      throw "Canonical and legacy stores differ. No merge or overwrite performed. Both backups: $backup"
    }
    return $backup
  }
  # Copy into an absent canonical tree. An empty existing directory can be used
  # without deleting it; each file copy still refuses overwrite.
  if (-not (Test-Path -LiteralPath $canonical)) {
    $null = Copy-CfsDataSnapshot -Source $legacy -Destination $canonical
  } else {
    foreach ($entry in $legacyInventory | Sort-Object { $_.path.Length }) {
      $target = Assert-CfsChildPath -Root $canonical -Path (Join-Path $canonical $entry.path)
      if ($entry.kind -eq 'directory') { New-Item -ItemType Directory -Path $target -Force | Out-Null }
      else { [IO.File]::Copy((Join-Path $legacy $entry.path), $target, $false) }
    }
  }
  if ((Get-CfsInventorySignature @(Get-CfsDataInventory $canonical)) -cne (Get-CfsInventorySignature $legacyInventory) -or
      (Get-CfsInventorySignature @(Get-CfsDataInventory $legacy)) -cne (Get-CfsInventorySignature $legacyInventory)) {
    throw "Migration copy verification failed. Both originals and backup retained: $backup"
  }
  return $backup
}
