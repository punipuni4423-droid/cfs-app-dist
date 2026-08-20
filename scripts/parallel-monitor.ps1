# Parallel Work Monitor (background watcher)
# 30 sec interval. Watches .coordination/ and writes events.jsonl + latest-report.md.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$coord = Join-Path $root '.coordination'
$eventsFile = Join-Path $coord 'events.jsonl'
$reportFile = Join-Path $coord 'latest-report.md'
$watchedDirs = @(
  (Join-Path $root 'app'),
  (Join-Path $root 'src')
)
$intervalSec = 30
$conflictWindowSec = 300

if (-not (Test-Path $coord)) {
  Write-Error "Coordination directory not found: $coord"
  exit 1
}

function Get-NowIso { return (Get-Date).ToString('o') }

function Read-Claim {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try {
    $raw = Get-Content -Raw -Path $Path -ErrorAction Stop
    return $raw | ConvertFrom-Json
  } catch { return $null }
}

function Get-ActiveClaim {
  param($Claim)
  if ($null -eq $Claim) { return $null }
  if ([string]::IsNullOrWhiteSpace($Claim.task)) { return $null }
  if ($null -eq $Claim.files -or $Claim.files.Count -eq 0) { return $null }
  if ([string]::IsNullOrWhiteSpace($Claim.started_at)) { return $Claim }
  try {
    $started = [datetime]::Parse($Claim.started_at)
    $ttl = [int]$Claim.ttl_minutes
    if ($ttl -gt 0) {
      $expires = $started.AddMinutes($ttl)
      if ((Get-Date) -gt $expires) { return $null }
    }
    return $Claim
  } catch { return $Claim }
}

function Get-RecentChanges {
  param([string[]]$Dirs, [int]$Seconds)
  $cutoff = (Get-Date).AddSeconds(-$Seconds)
  $files = @()
  foreach ($d in $Dirs) {
    if (-not (Test-Path $d)) { continue }
    $files += Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
      $_.LastWriteTime -gt $cutoff -and
      $_.FullName -notmatch '\\node_modules\\' -and
      $_.FullName -notmatch '\\\.next\\' -and
      $_.FullName -notmatch '\\\.coordination\\'
    }
  }
  return $files | Sort-Object LastWriteTime -Descending
}

function Append-Event {
  param([string]$Level, [string[]]$Files, [string]$Action, [string]$Note)
  $obj = [pscustomobject]@{
    ts     = Get-NowIso
    level  = $Level
    files  = $Files
    action = $Action
    note   = $Note
  }
  $line = ($obj | ConvertTo-Json -Compress)
  Add-Content -Path $eventsFile -Value $line -Encoding utf8
}

function Set-StopFlag {
  param([string]$Label, [string]$Reason)
  $flag = Join-Path $coord ("STOP-$Label.flag")
  $body = @{ label = $Label; reason = $Reason; created = Get-NowIso } | ConvertTo-Json
  Set-Content -Path $flag -Value $body -Encoding utf8
}

function Clear-StopFlag {
  param([string]$Label)
  $flag = Join-Path $coord ("STOP-$Label.flag")
  if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue }
}

function Write-Report {
  param([string]$Status, [string]$Body)
  $header = "# Parallel Work Monitor - Latest Report`n`n**Generated:** $(Get-NowIso)`n**Status:** $Status`n`n"
  Set-Content -Path $reportFile -Value ($header + $Body) -Encoding utf8
}

Write-Output "[parallel-monitor] starting. Interval=${intervalSec}s"
Append-Event -Level 'INFO' -Files @() -Action 'monitor_started' -Note "pid=$PID interval=$intervalSec"

while ($true) {
  try {
    $claimA = Get-ActiveClaim (Read-Claim (Join-Path $coord 'claim-A.json'))
    $claimB = Get-ActiveClaim (Read-Claim (Join-Path $coord 'claim-B.json'))

    $filesA = @()
    if ($claimA) { $filesA = @($claimA.files) }
    $filesB = @()
    if ($claimB) { $filesB = @($claimB.files) }

    $overlap = @($filesA | Where-Object { $filesB -contains $_ })

    $recent = Get-RecentChanges -Dirs $watchedDirs -Seconds $conflictWindowSec
    $recentRel = @($recent | ForEach-Object {
      $_.FullName.Substring($root.Length).TrimStart('\','/').Replace('\','/')
    })

    $bothTouchedRecent = @()
    foreach ($f in $filesA) {
      if ($filesB -contains $f -and $recentRel -contains $f) {
        $bothTouchedRecent += $f
      }
    }

    $level = 'CLEAR'
    $action = 'none'
    $reportBody = ''

    if ($bothTouchedRecent.Count -gt 0) {
      $level = 'CRITICAL'
      $reasonText = "both A and B modified: " + ($bothTouchedRecent -join ', ')
      Set-StopFlag -Label 'A' -Reason $reasonText
      Set-StopFlag -Label 'B' -Reason $reasonText
      $action = 'STOP-A and STOP-B created'
      $list = ($bothTouchedRecent | ForEach-Object { "- $_" }) -join "`n"
      $reportBody = "## CRITICAL: same file modified by both sessions recently`n`n" + $list + "`n`nBoth sessions stopped. User intervention required to merge.`n"
    }
    elseif ($overlap.Count -gt 0 -and $claimA -and $claimB) {
      $level = 'CONFLICT'
      $aTime = if ($claimA.started_at) { [datetime]::Parse($claimA.started_at) } else { Get-Date }
      $bTime = if ($claimB.started_at) { [datetime]::Parse($claimB.started_at) } else { Get-Date }
      $overlapText = $overlap -join ', '
      if ($bTime -ge $aTime) {
        Set-StopFlag -Label 'B' -Reason ("claim conflict on: $overlapText; A claimed first")
        Clear-StopFlag -Label 'A'
        $action = 'STOP-B created (B is later claimer)'
      } else {
        Set-StopFlag -Label 'A' -Reason ("claim conflict on: $overlapText; B claimed first")
        Clear-StopFlag -Label 'B'
        $action = 'STOP-A created (A is later claimer)'
      }
      $list = ($overlap | ForEach-Object { "- $_" }) -join "`n"
      $reportBody = "## CONFLICT: claim files overlap`n`n" + $list + "`n`n- A: $($claimA.task) (started $($claimA.started_at))`n- B: $($claimB.task) (started $($claimB.started_at))`n`nLater claimer is stopped. Resume after the earlier claimer finishes.`n"
    }
    elseif ($claimA -and $claimB) {
      $level = 'WATCH'
      Clear-StopFlag -Label 'A'
      Clear-StopFlag -Label 'B'
      $action = 'cleared stops'
      $reportBody = "## WATCH: both sessions active (no overlap)`n`n- A: $($claimA.task) - $($filesA -join ', ')`n- B: $($claimB.task) - $($filesB -join ', ')`n`nNo conflict at this time. Each session must update its claim before editing.`n"
    }
    else {
      Clear-StopFlag -Label 'A'
      Clear-StopFlag -Label 'B'
      $reportBody = "## CLEAR: no active claims`n`nclaim-A.json / claim-B.json are empty or expired.`n"
    }

    Write-Report -Status $level -Body $reportBody
    $combined = @($overlap + $bothTouchedRecent | Select-Object -Unique)
    $taskA = if ($claimA) { $claimA.task } else { 'idle' }
    $taskB = if ($claimB) { $claimB.task } else { 'idle' }
    Append-Event -Level $level -Files $combined -Action $action -Note "A=$taskA B=$taskB"
  }
  catch {
    Append-Event -Level 'ERROR' -Files @() -Action 'monitor_loop_error' -Note $_.Exception.Message
  }

  Start-Sleep -Seconds $intervalSec
}
