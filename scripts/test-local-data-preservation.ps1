param([Parameter(Mandatory = $true)][string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'cfs-local-data-preservation.ps1')
if (Test-Path -LiteralPath $ScratchRoot) { throw 'Use a new empty scratch path.' }
New-Item -ItemType Directory -Path $ScratchRoot -Force | Out-Null
$results = @()
function Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Fixture([string]$Name) {
  $root = Join-Path $ScratchRoot $Name
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  return $root
}
function Seed([string]$Directory) {
  New-Item -ItemType Directory -Path (Join-Path $Directory 'trash'), (Join-Path $Directory 'empty'), (Join-Path $Directory 'auth') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $Directory 'projects.json'), '[{"id":"synthetic","unknown":{"text":"\u4fdd\u5b58\u539f\u6587"}}]')
  [IO.File]::WriteAllText((Join-Path $Directory 'trash\trash.json'), '{"projects":[],"roomTypes":[]}')
  [IO.File]::WriteAllText((Join-Path $Directory 'project-trash.transaction.json'), '{"version":1,"projects":[],"trash":{"projects":[]}}')
  [IO.File]::WriteAllText((Join-Path $Directory 'collaboration.json'), '{"users":[],"locks":[]}')
  [IO.File]::WriteAllText((Join-Path $Directory 'auth\access.json'), '{"secret":"synthetic-secret-never-in-manifest"}')
  [IO.File]::WriteAllBytes((Join-Path $Directory 'unknown.bin'), [byte[]](0, 255, 3, 4))
}
function Run([string]$Name, [scriptblock]$Body) {
  & $Body
  $script:results += [pscustomobject]@{ name = $Name; pass = $true }
  Write-Output "PASS $Name"
}
function Refuses([scriptblock]$Body, [string]$Pattern) {
  $caught = $false
  try { & $Body | Out-Null } catch { $caught = $true; Check ($_.Exception.Message -match $Pattern) $_.Exception.Message }
  Check $caught 'Expected refusal'
}
try {
  Run 'root-only full backup preserves unknown bytes, journal, empty dirs, and secret hashes' {
    $app = Fixture 'root-only'; $data = Join-Path $app 'data'; Seed $data
    $before = Get-CfsInventorySignature @(Get-CfsDataInventory $data)
    $backup = Backup-CfsDataTrees $app @{ canonical = $data }
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory (Join-Path $backup 'canonical')))) 'Backup differs'
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory $data))) 'Original differs'
    Check ((Get-Content (Join-Path $backup 'manifest.json') -Raw) -notmatch 'synthetic-secret-never-in-manifest') 'Secret in manifest'
  }
  Run 'legacy only migrates exact bytes and repeated migration is no-op' {
    $app = Fixture 'legacy-only'; $legacy = Join-Path $app '.next\standalone\data'; Seed $legacy
    $before = Get-CfsInventorySignature @(Get-CfsDataInventory $legacy)
    $null = Invoke-CfsLegacyDataCopy $app $legacy
    $null = Invoke-CfsLegacyDataCopy $app $legacy
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory (Join-Path $app 'data')))) 'Canonical differs'
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory $legacy))) 'Legacy original differs'
  }
  Run 'different and partial stores refuse after preserving both originals' {
    $app = Fixture 'conflict'; $legacy = Join-Path $app 'runtime\data'; Seed $legacy
    $canonical = Join-Path $app 'data'; Seed $canonical
    [IO.File]::WriteAllText((Join-Path $canonical 'projects.json'), '[]')
    $before = Get-CfsInventorySignature @(Get-CfsDataInventory $canonical)
    Refuses { Invoke-CfsLegacyDataCopy $app $legacy } 'stores differ'
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory $canonical))) 'Conflict overwrote root'
    Check (@(Get-ChildItem (Join-Path $app 'artifacts\data-recovery') -Directory).Count -eq 1) 'Missing conflict backup'
    $app2 = Fixture 'partial'; $legacy2 = Join-Path $app2 'runtime\data'; Seed $legacy2
    $canonical2 = Join-Path $app2 'data'; New-Item -ItemType Directory $canonical2 | Out-Null
    Copy-Item (Join-Path $legacy2 'projects.json') $canonical2
    Refuses { Invoke-CfsLegacyDataCopy $app2 $legacy2 } 'stores differ'
  }
  Run 'invalid JSON refuses with backup and no canonical writes' {
    $app = Fixture 'invalid'; $legacy = Join-Path $app 'runtime\data'; Seed $legacy
    [IO.File]::WriteAllText((Join-Path $legacy 'projects.json'), '{broken')
    Refuses { Invoke-CfsLegacyDataCopy $app $legacy } 'Invalid JSON'
    Check (-not (Test-Path (Join-Path $app 'data'))) 'Malformed data migrated'
    Check (@(Get-ChildItem (Join-Path $app 'artifacts\data-recovery') -Directory).Count -eq 1) 'Malformed original not backed up'
  }
  Run 'invalid transaction shape refuses with original journal preserved' {
    $index = 0
    foreach ($journal in @('{"version":2,"projects":[],"trash":{}}', '{"version":"1","projects":[],"trash":{}}', '{"version":true,"projects":[],"trash":{}}', '[{"version":1,"projects":[{"id":"a"},{"id":"b"}],"trash":{}}]', '{"version":1,"projects":{},"trash":{}}', '{"version":1,"projects":[],"trash":null}')) {
      $app = Fixture ("invalid-journal-$index"); $legacy = Join-Path $app 'runtime\data'; Seed $legacy
      [IO.File]::WriteAllText((Join-Path $legacy 'project-trash.transaction.json'), $journal)
      $before = Get-CfsInventorySignature @(Get-CfsDataInventory $legacy)
      Refuses { Invoke-CfsLegacyDataCopy $app $legacy } 'Invalid transaction journal'
      Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory $legacy))) 'Invalid journal changed'
      Check (-not (Test-Path (Join-Path $app 'data'))) 'Invalid journal migrated'
      $index++
    }
  }
  Run 'numeric journal version 1.0 remains compatible with app recovery' {
    $app = Fixture 'decimal-journal'; $data = Join-Path $app 'data'; Seed $data
    [IO.File]::WriteAllText((Join-Path $data 'project-trash.transaction.json'), '{"version":1.0,"projects":[],"trash":{}}')
    $before = Get-CfsInventorySignature @(Get-CfsDataInventory $data)
    $backup = Backup-CfsDataTrees $app @{ canonical = $data }
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory (Join-Path $backup 'canonical')))) 'Numeric journal changed'
  }
  Run 'live lock refuses but dead-owner lock and journal remain byte exact' {
    $app = Fixture 'lock'; $data = Join-Path $app 'data'; Seed $data
    $lock = Join-Path $data 'project-store.lock'; New-Item -ItemType Directory $lock | Out-Null
    [IO.File]::WriteAllText((Join-Path $lock "owner-$PID-abcdef"), '')
    Refuses { Backup-CfsDataTrees $app @{ canonical = $data } } 'Active or unverifiable'
    Check (Test-Path -LiteralPath $lock) 'Live lock removed'
    $app2 = Fixture 'dead-lock'; $data2 = Join-Path $app2 'data'; Seed $data2
    $lock2 = Join-Path $data2 'project-store.lock'; New-Item -ItemType Directory $lock2 | Out-Null
    [IO.File]::WriteAllText((Join-Path $lock2 'owner-2147483646-abcdef'), '')
    $backup = Backup-CfsDataTrees $app2 @{ canonical = $data2 }
    Check ((Get-CfsInventorySignature @(Get-CfsDataInventory $data2)) -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory (Join-Path $backup 'canonical')))) 'Dead lock not preserved'
  }
  Run 'outside and nested destinations refuse' {
    $app = Fixture 'paths'; $data = Join-Path $app 'data'; Seed $data
    Refuses { Assert-CfsChildPath $app (Join-Path $ScratchRoot 'outside') } 'outside'
    Refuses { Copy-CfsDataSnapshot $data (Join-Path $data 'backup') } 'outside the source'
    Refuses { Copy-CfsDataSnapshot $data $data } 'outside the source'
  }
  Run 'junction source refuses without traversing or deleting its target' {
    $app = Fixture 'junction'; $outside = Fixture 'junction-target'; Seed $outside
    $junction = Join-Path $app 'data'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    $before = Get-CfsInventorySignature @(Get-CfsDataInventory $outside)
    Refuses { Backup-CfsDataTrees $app @{ canonical = $junction } } 'Reparse'
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory $outside))) 'Junction target changed'
  }
  Run 'mid-copy failure keeps source and partial snapshot' {
    $app = Fixture 'copy-failure'; $data = Join-Path $app 'data'; Seed $data
    $target = Join-Path $app 'snapshot'
    $before = Get-CfsInventorySignature @(Get-CfsDataInventory $data)
    $inventoryImplementation = (Get-Command Get-CfsDataInventory).ScriptBlock
    # Inject one disappearing-file entry after the real snapshot. Earlier files
    # copy successfully before File.Copy fails; production IO is not replaced.
    function Get-CfsDataInventory {
      param([string]$Directory)
      & $inventoryImplementation $Directory
      if ($Directory -eq $data) { [pscustomobject]@{ path = 'zz-disappeared-file.bin'; kind = 'file'; bytes = 1; sha256 = 'synthetic' } }
    }
    Refuses { Copy-CfsDataSnapshot $data $target } '.*'
    Check (Test-Path -LiteralPath (Join-Path $target 'projects.json')) 'No partial copy was exercised'
    Remove-Item Function:Get-CfsDataInventory
    . (Join-Path $PSScriptRoot 'cfs-local-data-preservation.ps1')
    Check ($before -ceq (Get-CfsInventorySignature @(Get-CfsDataInventory $data))) 'Failed copy changed source'
  }
  Run 'owned multi-port writers stop; unrelated port and PID reuse refuse without stopping' {
    $app = Fixture 'writers'; $other = Fixture 'other-writer'
    $node = (Get-Command node.exe).Source
    $writerCode = "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],String(s.address().port)));"
    [IO.File]::WriteAllText((Join-Path $app 'writer.js'), $writerCode)
    [IO.File]::WriteAllText((Join-Path $other 'writer.js'), $writerCode)
    $owned = @()
    try {
      foreach ($item in @(@{root=$app;name='first'}, @{root=$app;name='second'}, @{root=$other;name='other'})) {
        $portFile = Join-Path $item.root ($item.name + '.port')
        $child = Start-Process -FilePath $node -ArgumentList @(('"' + (Join-Path $item.root 'writer.js') + '"'), ('"' + $portFile + '"')) -WorkingDirectory $item.root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $item.root ($item.name + '.out.log')) -RedirectStandardError (Join-Path $item.root ($item.name + '.err.log'))
        $null = $child.Handle
        $owned += $child
        $deadline = (Get-Date).AddSeconds(10)
        while (-not (Test-Path -LiteralPath $portFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
        Check (Test-Path -LiteralPath $portFile) 'Synthetic listener did not start'
      }
      $firstPort = [int](Get-Content (Join-Path $app 'first.port'))
      $otherPort = [int](Get-Content (Join-Path $other 'other.port'))
      Refuses { Stop-CfsDataWriters $app $otherPort } 'unverified process'
      Check (-not $owned[2].HasExited -and -not $owned[0].HasExited) 'Unrelated port refusal stopped a process'
      # Alter only the saved identity; the actual live PID belongs to the dummy.
      $actualWriters = @(Get-CfsAppWriters $app | Select-Object ProcessId, CreationDate, CommandLine)
      $actualWriters[0].CreationDate = $actualWriters[0].CreationDate.AddMinutes(-1)
      function Get-CfsAppWriters { param([string]$AppRoot) return $actualWriters }
      Refuses { Stop-CfsDataWriters $app $firstPort } 'identity changed'
      Check (-not $owned[0].HasExited -and -not $owned[1].HasExited) 'PID identity refusal stopped a process'
      Remove-Item Function:Get-CfsAppWriters
      . (Join-Path $PSScriptRoot 'cfs-local-data-preservation.ps1')
      Stop-CfsDataWriters $app $firstPort
      Check ($owned[0].HasExited -and $owned[1].HasExited) 'Not all app writers stopped'
      Check (-not $owned[2].HasExited) 'Other app writer stopped'
    } finally {
      foreach ($child in $owned) { if (-not $child.HasExited) { Stop-Process -InputObject $child -Force; $null = $child.WaitForExit(10000) } }
    }
  }
  Run 'CIM and process access failures fail closed before stop or snapshot' {
    $app = Fixture 'access-denied'
    function Get-CimInstance { throw 'Synthetic CIM access denied' }
    Refuses { Stop-CfsDataWriters $app 39999 } 'Synthetic CIM access denied'
    Remove-Item Function:Get-CimInstance
    function Get-CimInstance { [pscustomobject]@{ ProcessId = 123; CommandLine = $null; CreationDate = (Get-Date) } }
    Refuses { Assert-CfsWritersStopped $app 39999 } 'cannot be identified'
    Refuses { Stop-CfsDataWriters $app 39999 } 'cannot be identified'
    Remove-Item Function:Get-CimInstance
    function Get-CimInstance { [pscustomobject]@{ ProcessId = 123; CommandLine = 'node.exe some-other-app.js'; CreationDate = $null } }
    Refuses { Stop-CfsDataWriters $app 39999 } 'cannot be identified'
    Remove-Item Function:Get-CimInstance
    function Get-NetTCPConnection { throw 'Synthetic listener access denied' }
    Refuses { Assert-CfsWritersStopped $app 39999 } 'Synthetic listener access denied'
    Refuses { Stop-CfsDataWriters $app 39999 } 'Synthetic listener access denied'
    Remove-Item Function:Get-NetTCPConnection
    function Get-Process { throw 'Synthetic process access denied' }
    Refuses { Get-CfsProcessById 2147483646 } 'Synthetic process access denied'
    Remove-Item Function:Get-Process
    Check (-not (Test-Path (Join-Path $app 'artifacts'))) 'Snapshot ran despite access failure'
  }
  Run 'updater requires verified build and refuses protected output and junction deletion' {
    . (Join-Path $PSScriptRoot 'cfs-update-maintenance.ps1')
    $source = Get-Content (Join-Path $PSScriptRoot 'update-cfs-app.ps1') -Raw
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
    foreach ($name in @('Get-NextDistPath', 'Assert-CfsNoLegacyData', 'Clear-NextBuildOutput')) {
      $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
      Invoke-Expression $definition.Extent.Text
    }
    function Write-Log { param([string]$Message) }
    $app = Fixture 'output-guard'
    $previousDist = $env:NEXT_DIST_DIR
    try {
      foreach ($output in @('data', 'data\nested', 'artifacts', 'runtime', '.cfs-runtime', '.cfs-updater', '.git', '.git\nested', '..\outside')) {
        $env:NEXT_DIST_DIR = $output
        Refuses { Clear-NextBuildOutput $app } 'Refusing'
      }
      $env:NEXT_DIST_DIR = '.next'
      $target = Fixture 'output-junction-target'
      New-Item -ItemType Junction -Path (Join-Path $app '.next') -Target $target | Out-Null
      Refuses { Clear-NextBuildOutput $app } 'Reparse'
      Check (Test-Path -LiteralPath $target) 'Output junction target deleted'
    } finally { $env:NEXT_DIST_DIR = $previousDist }
    Check (-not $source.Contains('Docs-only update applied.')) 'Docs-only bypass must not mask a failed build'
    Check ($source.IndexOf('Wait-CfsUpdatedServer -Commit $afterSha') -lt $source.IndexOf('Write-UpdateStatus -State "completed"')) 'Completion precedes verified health'
    Check (-not ($source -match 'Stop-AppListeners -TargetPort')) 'Unverified post-backup port kill remains'
    Check ($source.IndexOf('Backup-CfsDataTrees -AppRoot') -lt $source.IndexOf('Invoke-NpmDependencyInstall -WorkingDirectory $appPath')) 'Snapshot is after dependency mutation'
  }
  Run 'scripts parse on Windows PowerShell and packaging includes both helpers' {
    foreach ($name in @('update-cfs-app.ps1', 'cfs-local-data-preservation.ps1', 'migrate-cfs-legacy-local-data.ps1')) {
      $tokens = $null; $parseErrors = $null
      $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$parseErrors)
      Check ($parseErrors.Count -eq 0) "Parse failed: $name"
    }
    $pack = Get-Content (Join-Path $PSScriptRoot 'build-cfs-share-package.ps1') -Raw
    Check ($pack.Contains('"cfs-local-data-preservation.ps1"') -and $pack.Contains('"migrate-cfs-legacy-local-data.ps1"')) 'Package helper missing'
    Check ($pack.Contains('"docs\LOCAL_DATA_UPDATE_GUIDE_JA.md"') -and $pack.Contains('"LOCAL_DATA_UPDATE_GUIDE_JA.md"')) 'Package guide missing'
    Check ((Get-Content (Join-Path $PSScriptRoot '..\SHARE_README_JA.md') -Raw -Encoding UTF8).Contains('Manual/LOCAL_DATA_UPDATE_GUIDE_JA.md')) 'README guide link missing'
  }
} finally {
  $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $ScratchRoot 'results.json') -Encoding UTF8
}
