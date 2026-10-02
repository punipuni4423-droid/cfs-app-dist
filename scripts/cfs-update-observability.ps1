# Safe structured telemetry. Free-form command output belongs only to the local log.
$script:CfsObservation = $null
$script:CfsCleanupUncertain = $false
$script:CfsHeldJob = $null
$script:CfsDependencyStarted = $null

function Get-CfsAwakeMs { return [CfsUpdate.NativeJob]::AwakeMs() }

function Add-CfsExceptionEvidence {
  param([Exception]$Exception,[ValidateSet('spawn','command-observation','command-cleanup','worker','held-cleanup','monitor-launch','output-read')][string]$Source)
  if(-not $script:CfsObservation -or -not $Exception){return}
  try{
    $record=[ordered]@{source=$Source;stage='unknown';exceptionType='unknown';hResult=$null;win32Code=$null}
    $types=@('System.InvalidOperationException','System.IO.IOException','System.UnauthorizedAccessException','System.ComponentModel.Win32Exception','System.ArgumentException','System.ArgumentOutOfRangeException','System.ObjectDisposedException','System.OutOfMemoryException','System.Management.Automation.CommandNotFoundException','System.Management.Automation.RuntimeException','Microsoft.Management.Infrastructure.CimException')
    $stages=@('awake_clock','create_job','limit_job','stdout_pipe','stdout_private','stderr_pipe','stderr_private','stdin_pipe','stdin_private','initialize_attributes','job_list','handle_list','create_owned_process','verify_job','constructor_cleanup','job_accounting','process_exit','terminate_owned_job','stdout_read','stderr_read')
    $cause=$Exception
    for($i=0;$cause -and $i -lt 12;$i++){
      $name=$cause.GetType().FullName;$record.exceptionType=if($name -cin $types){$name}else{'unknown'};$record.hResult=$cause.HResult
      if($cause -is [ComponentModel.Win32Exception]){$record.win32Code=$cause.NativeErrorCode}
      if($cause.Data['CfsNativeStage'] -cin $stages){$record.stage=$cause.Data['CfsNativeStage']}
      if($cause.Data['CfsWin32Code'] -is [int] -and $cause.Data['CfsWin32Code'] -ge 0){$record.win32Code=$cause.Data['CfsWin32Code']}
      $cause=$cause.InnerException
    }
    $key=$record|ConvertTo-Json -Compress
    $prior=@($script:CfsObservation.safeFailures)
    if(-not @($prior|Where-Object{($_|ConvertTo-Json -Compress) -ceq $key}).Count){$script:CfsObservation.safeFailures=@($prior|Select-Object -Last 7)+@($record)}
  }catch{} # Diagnostic extraction must not change the original safety outcome.
}

function Initialize-CfsObservation {
  param([string]$ArtifactRoot,[string]$RunId)
  if ($RunId -notmatch '^[a-zA-Z0-9-]{1,80}$') { $RunId = [Guid]::NewGuid().ToString('N') }
  $directory = Join-Path $ArtifactRoot ('observability/' + $RunId)
  $null = Assert-CfsUpdatePlainPath $directory
  if (Test-Path -LiteralPath $directory) { throw 'Observation attempt already exists.' }
  $null = New-Item -ItemType Directory -Path $directory -Force
  $awake = Get-CfsAwakeMs
  $self = [Diagnostics.Process]::GetCurrentProcess()
  $script:CfsObservation = @{
    schemaVersion=1; attemptId=$RunId; coverageStart='worker-entry'; state='running'; phase='start'; operation='start'; sequence=0;
    workerPid=$PID; workerStartTicks=$self.StartTime.ToUniversalTime().Ticks.ToString();
    startedUtc=[DateTime]::UtcNow.ToString('o'); workerHeartbeatUtc=[DateTime]::UtcNow.ToString('o');
    workerAwakeStarted=$awake; elapsedAwakeMs=0; elapsedWallMs=0; lastActivityUtc=$null; activityKinds=@();
    lastOutputUtc=$null; lastSampleUtc=$null; observationQuality='unavailable'; currentCommand=$null;
    cpuMs=0; ioReadBytes=0; ioWriteBytes=0; outputBytes=0; droppedBytes=0; activeProcesses=$null;
    commandExitCode=$null; failureCode=$null; safeFailures=@(); pipeReadFailed=$false; cleanupState='not_needed'; cleanupInProgress=$false; maxGapMs=0; eventDrops=0;
    directory=$directory; phaseStartedUtc=[DateTime]::UtcNow.ToString('o'); operationId=[Guid]::NewGuid().ToString('N');
    lastPublishAwake=0; terminal=$false; operationActive=$false
  }
  Write-CfsObservationEvent 'worker-start'
  Publish-CfsObservation -Force
}

function Get-CfsObservationSnapshot {
  if (-not $script:CfsObservation) { return $null }
  $safe = [ordered]@{}
  foreach ($key in @('schemaVersion','attemptId','coverageStart','state','phase','operation','sequence','workerPid','workerStartTicks','startedUtc','workerHeartbeatUtc','elapsedAwakeMs','elapsedWallMs','lastActivityUtc','activityKinds','lastOutputUtc','lastSampleUtc','observationQuality','currentCommand','cpuMs','ioReadBytes','ioWriteBytes','outputBytes','droppedBytes','activeProcesses','commandExitCode','failureCode','safeFailures','pipeReadFailed','cleanupState','cleanupInProgress','maxGapMs','eventDrops','phaseStartedUtc','operationId')) { $safe[$key]=$script:CfsObservation[$key] }
  return $safe
}

function Write-CfsObservationEvent {
  param([string]$Kind,[ValidateSet('completed','failed')][string]$OperationOutcome)
  if (-not $script:CfsObservation) { return }
  $o=$script:CfsObservation
  try {
    $awake=Get-CfsAwakeMs;$now=[DateTime]::UtcNow
    $o.elapsedAwakeMs=[math]::Max(0,$awake-$o.workerAwakeStarted)
    $o.elapsedWallMs=[math]::Max(0,($now-[DateTimeOffset]::Parse($o.startedUtc).UtcDateTime).TotalMilliseconds)
    $gap=($now-[DateTimeOffset]::Parse($o.workerHeartbeatUtc).UtcDateTime).TotalMilliseconds
    if($gap -gt 30000){$o.maxGapMs=[math]::Max($o.maxGapMs,$gap);$o.observationQuality='partial'}
    $file=Join-Path $o.directory 'events.jsonl'
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -ge 4MB) { $o.eventDrops++; return }
    $o.sequence++
    $record=[ordered]@{schemaVersion=1;sequence=$o.sequence;utc=[DateTime]::UtcNow.ToString('o');kind=$Kind;phase=$o.phase;operation=$o.operation;operationId=$o.operationId;elapsedAwakeMs=$o.elapsedAwakeMs;elapsedWallMs=$o.elapsedWallMs;failureCode=$o.failureCode;exitCode=$o.commandExitCode}
    if($OperationOutcome){$record.operationOutcome=$OperationOutcome}
    $bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress)+[Environment]::NewLine)
    $stream=[IO.File]::Open($file,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
    try {$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}
  } catch { $o.eventDrops++ }
}

function Publish-CfsObservation {
  param([switch]$Force)
  if (-not $script:CfsObservation) { return }
  $o=$script:CfsObservation
  try {
    $awake=Get-CfsAwakeMs
    if (-not $Force -and $awake-$o.lastPublishAwake -lt 5000) { return }
    $o.elapsedAwakeMs=[math]::Max(0,$awake-$o.workerAwakeStarted)
    $o.elapsedWallMs=[math]::Max(0,([DateTime]::UtcNow-[DateTimeOffset]::Parse($o.startedUtc).UtcDateTime).TotalMilliseconds)
    $o.workerHeartbeatUtc=[DateTime]::UtcNow.ToString('o');$o.lastPublishAwake=$awake
    $target=Join-Path $o.directory 'health.json';$temp=$target+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try {
      [IO.File]::WriteAllText($temp,((Get-CfsObservationSnapshot)|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
      if ([IO.File]::Exists($target)) {[IO.File]::Replace($temp,$target,[NullString]::Value)} else {[IO.File]::Move($temp,$target)}
    } finally {if ([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
  } catch { $o.eventDrops++ }
}

function Set-CfsObservationPhase {
  param([string]$State,[string]$Phase)
  if (-not $script:CfsObservation -or $script:CfsObservation.terminal) { return }
  $o=$script:CfsObservation
  if ($State -in @('completed','failed') -and $o.operationActive) {
    Write-CfsObservationEvent 'operation-end' -OperationOutcome $State
    $o.operationActive=$false
  }
  if ($o.phase -ne $Phase) {
    Write-CfsObservationEvent 'phase-end';$o.phase=$Phase;$o.phaseStartedUtc=[DateTime]::UtcNow.ToString('o');Write-CfsObservationEvent 'phase-start'
  }
  $o.state=$State
  if ($State -in @('completed','failed')) {$o.terminal=$true;Write-CfsObservationEvent 'worker-terminal'}
  Publish-CfsObservation -Force
}

function Set-CfsObservationOperation {
  param([string]$Name,[switch]$End,[ValidateSet('completed','failed')][string]$Outcome='completed')
  if (-not $script:CfsObservation) { return }
  $o=$script:CfsObservation
  if ($End) {if($o.operationActive){Write-CfsObservationEvent 'operation-end' -OperationOutcome $Outcome;$o.operationActive=$false}}
  else {
    # Cooperative deadline: never interrupt a synchronous data/CIM operation.
    if ((Get-CfsAwakeMs)-$o.workerAwakeStarted -ge 3600000) { Throw-CfsCommandFailure 'attempt_deadline' 'Update active time exceeded 60 minutes at a safe boundary.' }
    if($o.operationActive){Write-CfsObservationEvent 'operation-end' -OperationOutcome 'completed'}
    $o.operation=$Name;$o.operationId=[Guid]::NewGuid().ToString('N');$o.operationActive=$true;Write-CfsObservationEvent 'operation-start'
  }
  Publish-CfsObservation -Force
}

function Throw-CfsCommandFailure {
  param([string]$Reason,[string]$Message)
  if ($script:CfsObservation) {$script:CfsObservation.failureCode=$Reason;Publish-CfsObservation -Force}
  $exception=New-Object InvalidOperationException($Message)
  $exception.Data['CfsReason']=$Reason
  throw $exception
}

function Invoke-CfsObservedCommand {
  param([string]$FilePath,[string[]]$Arguments,[string]$WorkingDirectory,[double]$TimeoutSeconds=0)
  $kind='git';$limit=180.0
  if ([IO.Path]::GetFileName($FilePath) -like 'npm*') {
    if ($Arguments -contains 'build') {$kind='build';$limit=1200.0}
    else {$kind=if($Arguments -contains 'ci'){'npm-ci'}else{'npm-install'};$limit=1200.0;if ($null -eq $script:CfsDependencyStarted){$script:CfsDependencyStarted=Get-CfsAwakeMs}}
  }
  if ($TimeoutSeconds -gt 0) {$limit=$TimeoutSeconds} # Explicit test parameter, never an inherited env override.
  Set-CfsObservationOperation ('command-'+$kind)
  $o=$script:CfsObservation
  if ($o) {$o.currentCommand=$kind;$o.commandExitCode=$null;$o.cleanupState='pending';$o.cleanupInProgress=$false}
  $job=$null;$finished=$false;$code=$null;$failure=$null
  $started=Get-CfsAwakeMs;$lastAwake=$started;$lastWall=[DateTime]::UtcNow;$previous=$null;$nextDeadlineCheck=$started;$emptySince=$null
  try {
    try {$job=New-CfsOwnedCommand $FilePath $Arguments $WorkingDirectory}
    catch {
      Add-CfsExceptionEvidence $_.Exception 'spawn'
      $cause=$_.Exception
      while($cause){if($cause.Data['CfsCleanupUncertain']){$script:CfsCleanupUncertain=$true};if($cause.Data['CfsOwnedJob']){$script:CfsHeldJob=$cause.Data['CfsOwnedJob']};$cause=$cause.InnerException}
      Throw-CfsCommandFailure 'spawn_failed' 'The owned update command could not start.'
    }
    while ($true) {
      # Re-read exit/accounting and drain before considering a post-gap deadline.
      $sample=$job.Sample()
      if($sample.RootExited){$code=$sample.ExitCode}
      if($sample.PipeFailure){Add-CfsExceptionEvidence $sample.PipeFailure 'output-read'}
      foreach ($chunk in $job.Drain()) {Write-Log ($chunk.Stream+': '+$chunk.Text);if($o){$o.lastOutputUtc=$chunk.Utc}}
      $now=Get-CfsAwakeMs;$wall=[DateTime]::UtcNow
      $gap=[math]::Max($now-$lastAwake,($wall-$lastWall).TotalMilliseconds)
      if ($gap -gt 30000) {$nextDeadlineCheck=$now+200;if($o){$o.maxGapMs=[math]::Max($o.maxGapMs,$gap);$o.observationQuality='partial';Write-CfsObservationEvent 'observation-gap'}}
      $lastAwake=$now;$lastWall=$wall
      if ($o) {
        $activity=@()
        if ($previous) {
          if($sample.CpuMs -gt $previous.CpuMs){$activity+='cpu'}
          if($sample.ReadBytes -gt $previous.ReadBytes -or $sample.WriteBytes -gt $previous.WriteBytes){$activity+='io'}
          if($sample.OutputBytes -gt $previous.OutputBytes){$activity+='output'}
          if($sample.Active -ne $previous.Active){$activity+='process-count'}
        }
        if($activity.Count){$o.lastActivityUtc=$wall.ToString('o');$o.activityKinds=$activity}
        $o.cpuMs=$sample.CpuMs;$o.ioReadBytes=$sample.ReadBytes;$o.ioWriteBytes=$sample.WriteBytes;$o.outputBytes=$sample.OutputBytes;$o.droppedBytes=$sample.DroppedBytes;$o.activeProcesses=$sample.Active;$o.lastSampleUtc=$wall.ToString('o')
        $o.pipeReadFailed=$sample.PipeReadFailed
        if($gap -le 30000){$o.observationQuality=if($sample.PipeReadFailed){'partial'}else{'complete'}}
      }
      $previous=$sample
      if ($sample.RootExited -and $sample.Empty -and $sample.PipesClosed) {
        do {$tail=@($job.Drain());foreach($chunk in $tail){Write-Log ($chunk.Stream+': '+$chunk.Text)}} while($tail.Count)
        if($sample.PipeReadFailed){$script:CfsLogWriteWarning='Command output could not be read completely. The actual process exit code was preserved.'}
        $finished=$true;$code=$sample.ExitCode;break
      }
      if ($sample.Empty -and $sample.RootExited) {
        if($null -eq $emptySince){$emptySince=$now}
        if($now-$emptySince -gt 5000){Throw-CfsCommandFailure 'output_drain_unavailable' 'The command exited but output completion could not be verified.'}
      }
      $elapsed=$now-$started
      if($kind -like 'npm-*' -and $TimeoutSeconds -le 0){$elapsed=$now-$script:CfsDependencyStarted}
      if($now -ge $nextDeadlineCheck -and $elapsed -ge $limit*1000){Throw-CfsCommandFailure 'deadline_exceeded' 'The update command exceeded its active-time limit.'}
      Publish-CfsObservation
      Start-Sleep -Milliseconds 100
    }
  } catch { $failure=$_;Add-CfsExceptionEvidence $_.Exception 'command-observation' }
  finally {
    if($job){
      if(-not $finished){
        if($o){$o.cleanupInProgress=$true;Publish-CfsObservation -Force}
        try {
          $job.Terminate()
          $stopped=$false
          for($i=0;$i -lt 50;$i++){$s=$job.Sample();if($s.RootExited){$code=$s.ExitCode};if($s.Empty -and $s.RootExited){$stopped=$true;break};Start-Sleep -Milliseconds 100}
          if(-not $stopped){throw 'owned cleanup not verified'}
        } catch {Add-CfsExceptionEvidence $_.Exception 'command-cleanup';$script:CfsCleanupUncertain=$true}
      }
      if($script:CfsCleanupUncertain){$script:CfsHeldJob=$job}else{$job.Dispose()}
    }
    if($o){$o.cleanupState=if($script:CfsCleanupUncertain){'unverifiable'}else{'verified'};$o.cleanupInProgress=$script:CfsCleanupUncertain;$o.commandExitCode=$code;$o.currentCommand=$null;$outcome=if($failure -or $script:CfsCleanupUncertain -or $code -ne 0){'failed'}else{'completed'};Set-CfsObservationOperation '' -End -Outcome $outcome;Publish-CfsObservation -Force}
  }
  if($script:CfsCleanupUncertain){Throw-CfsCommandFailure 'cleanup_unverifiable' 'Owned command cleanup could not be verified. Do not retry the update.'}
  if($failure){
    if(-not $failure.Exception.Data['CfsReason']){Throw-CfsCommandFailure 'monitor_unavailable' 'Update command observation failed. The owned command was stopped.'}
    throw $failure
  }
  if($code -ne 0){Throw-CfsCommandFailure 'native_nonzero' ($FilePath+' exited with code '+$code)}
}

function Wait-CfsOwnedCleanup {
  # This safety controller retains the bootstrap's maintenance handle and the
  # exact owned job. No process is selected or killed by name or recycled PID.
  while ($script:CfsCleanupUncertain) {
    try {
      if($script:CfsHeldJob){
        $sample=$script:CfsHeldJob.Sample()
        if($sample.RootExited -and $script:CfsObservation){$script:CfsObservation.commandExitCode=$sample.ExitCode}
        if($sample.Empty -and $sample.RootExited){
          $script:CfsHeldJob.Dispose();$script:CfsHeldJob=$null;$script:CfsCleanupUncertain=$false
          if($script:CfsObservation){$script:CfsObservation.cleanupState='verified';$script:CfsObservation.cleanupInProgress=$false;Write-CfsObservationEvent 'cleanup-verified';Publish-CfsObservation -Force}
          return
        }
      }
    } catch {Add-CfsExceptionEvidence $_.Exception 'held-cleanup'} # Unavailable is not an empty job; preserve lock and handles.
    Publish-CfsObservation
    Start-Sleep -Seconds 1
  }
}

function Start-CfsUpdateMonitor {
  if (-not $script:CfsObservation) { return }
  try {
    $scriptFile=Join-Path $PSScriptRoot 'cfs-update-monitor.ps1'
    $args=@('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',(ConvertTo-CfsNativeArgument $scriptFile),'-ObservationDirectory',(ConvertTo-CfsNativeArgument $script:CfsObservation.directory),'-ExpectedWorkerPid',[string]$PID,'-ExpectedWorkerStartTicks',$script:CfsObservation.workerStartTicks)
    $monitor=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList $args -WindowStyle Hidden -PassThru
    try{[IO.File]::WriteAllText((Join-Path $script:CfsObservation.directory 'monitor.json'),(@{pid=$monitor.Id;startTicks=$monitor.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))}finally{$monitor.Dispose()}
  } catch {Add-CfsExceptionEvidence $_.Exception 'monitor-launch';Write-CfsObservationEvent 'monitor-launch-unavailable'}
}
