param([switch]$Run,[string]$AppDir,[string]$OutputPath)
# Standalone collector: no API, environment/config contents, business data or raw logs in exports.
function Assert-CfsDiagnosticPath {
  param([string]$Path)
  $full=[IO.Path]::GetFullPath($Path);$cursor=$full
  while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse paths are not supported.'}};$parent=[IO.Path]::GetDirectoryName($cursor);if($parent -eq $cursor){break};$cursor=$parent}
  return $full
}
function Read-CfsDiagnosticJson {
  param([string]$Path)
  $null=Assert-CfsDiagnosticPath $Path
  if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
  return ((Read-CfsDiagnosticText $Path 2MB)|ConvertFrom-Json)
}
function Read-CfsDiagnosticText {
  param([string]$Path,[int]$MaximumBytes)
  $null=Assert-CfsDiagnosticPath $Path
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{
    if($stream.Length -gt $MaximumBytes){throw 'Diagnostic size limit.'}
    $bytes=New-Object byte[] ($MaximumBytes+1);$count=0
    while($count -le $MaximumBytes){$n=$stream.Read($bytes,$count,$bytes.Length-$count);if($n -eq 0){break};$count+=$n}
    if($count -gt $MaximumBytes){throw 'Diagnostic size limit.'}
    return [Text.Encoding]::UTF8.GetString($bytes,0,$count).TrimStart([char]0xFEFF)
  }finally{$stream.Dispose()}
}
function Get-CfsSafeFailure {
  param($Value)
  $safe=[ordered]@{source='unknown';stage='unknown';exceptionType='unknown';hResult=$null;win32Code=$null}
  if(-not $Value){return $safe}
  $allowed=@{
    source=@('spawn','command-observation','command-cleanup','worker','held-cleanup','monitor-launch','output-read','writer-inventory');
    stage=@('awake_clock','create_job','limit_job','stdout_pipe','stdout_private','stderr_pipe','stderr_private','stdin_pipe','stdin_private','initialize_attributes','job_list','handle_list','create_owned_process','verify_job','constructor_cleanup','job_accounting','process_exit','terminate_owned_job','stdout_read','stderr_read');
    exceptionType=@('System.InvalidOperationException','System.IO.IOException','System.UnauthorizedAccessException','System.ComponentModel.Win32Exception','System.ArgumentException','System.ArgumentOutOfRangeException','System.ObjectDisposedException','System.OutOfMemoryException','System.Management.Automation.CommandNotFoundException','System.Management.Automation.RuntimeException','Microsoft.Management.Infrastructure.CimException');
    phase=@('enumerate','process-probe','final');result=@('query-error','incomplete','complete-identity-established','complete-same-identity','complete-new-identity','NoProcessFoundForGivenId','alive-unresolved','unresolved','final-inventory-incomplete');
    errorCode=@('CimQueryFailed','ProcessProbeFailed');category=@('NotSpecified','InvalidOperation','PermissionDenied','ResourceUnavailable','ObjectNotFound','OperationTimeout','OpenError','CloseError','ReadError','WriteError','InvalidData','AuthenticationError')
  }
  foreach($key in $allowed.Keys){$p=$Value.PSObject.Properties[$key];if($p -and $p.Value -is [string] -and $p.Value -cin $allowed[$key]){$safe[$key]=$p.Value}}
  foreach($key in @('hResult','win32Code','observation')){$p=$Value.PSObject.Properties[$key];if($p -and ($p.Value -is [int] -or $p.Value -is [long]) -and $p.Value -ge [int]::MinValue -and $p.Value -le [int]::MaxValue -and ($key -eq 'hResult' -or $p.Value -ge 0)){$safe[$key]=$p.Value}}
  return $safe
}
function Get-CfsSafeDiagnosticObject {
  param($Value)
  $safe=[ordered]@{}
  if(-not $Value){return $safe}
  $enums=@{
    state=@('queued','running','completed','failed','blocked');currentStep=@('queued','start','git-check','git-fetch','git-pull','backup-data','npm-install','build','restart','done','failed','bootstrap','launch');
    phase=@('queued','start','git-check','git-fetch','git-pull','backup-data','npm-install','build','restart','done','failed','bootstrap','launch');
    operation=@('start','legacy-worker-check','legacy-data-check','git-check','git-apply-check','runtime-check','stop-writers','backup-data','verify-writers','clear-build-output','sync-static-assets','restart','readiness','command-git','command-npm','command-npm-ci','command-npm-install','command-build');
    kind=@('worker-start','worker-terminal','phase-start','phase-end','operation-start','operation-end','observation-gap','monitor-launch-unavailable','cleanup-verified');
    operationOutcome=@('completed','failed');
    observationQuality=@('complete','partial','unavailable','stale');cleanupState=@('not_needed','pending','verified','unverifiable');
    currentCommand=@('git','npm','npm-ci','npm-install','build');coverageStart=@('worker-entry');
    failureCode=@('native_nonzero','deadline_exceeded','attempt_deadline','monitor_unavailable','spawn_failed','ownership_failed','cleanup_unverifiable','interrupted','output_drain_unavailable')
  }
  foreach($key in $enums.Keys){$p=$Value.PSObject.Properties[$key];if($p -and $p.Value -is [string] -and $p.Value -cin $enums[$key]){$safe[$key]=$p.Value}}
  foreach($key in @('startedAt','finishedAt','updatedAt','startedUtc','workerHeartbeatUtc','lastActivityUtc','lastOutputUtc','lastSampleUtc','phaseStartedUtc','utc')){
    $p=$Value.PSObject.Properties[$key]
    if($p -and $p.Value -is [string] -and $p.Value -match '^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$'){
      try{$safe[$key]=[DateTimeOffset]::Parse($p.Value,[Globalization.CultureInfo]::InvariantCulture).ToUniversalTime().ToString('o')}catch{}
    }
  }
  foreach($key in @('targetCommit','expectedHead','gitSha')){$p=$Value.PSObject.Properties[$key];if($p -and $p.Value -is [string] -and $p.Value -cmatch '^[a-f0-9]{40}$'){$safe[$key]=$p.Value}}
  foreach($key in @('schemaVersion','progress','sequence','elapsedAwakeMs','elapsedWallMs','cpuMs','ioReadBytes','ioWriteBytes','outputBytes','droppedBytes','activeProcesses','maxGapMs','eventDrops')){
    $p=$Value.PSObject.Properties[$key];if($p -and ($p.Value -is [int] -or $p.Value -is [long] -or $p.Value -is [double] -or $p.Value -is [decimal]) -and $p.Value -ge 0 -and $p.Value -le 1e15){$safe[$key]=$p.Value}
  }
  foreach($key in @('commandExitCode','exitCode')){$p=$Value.PSObject.Properties[$key];if($p -and ($p.Value -is [int] -or $p.Value -is [long]) -and $p.Value -ge [int]::MinValue -and $p.Value -le [int]::MaxValue){$safe[$key]=$p.Value}}
  $p=$Value.PSObject.Properties['pipeReadFailed'];if($p -and $p.Value -is [bool]){$safe['pipeReadFailed']=$p.Value}
  $p=$Value.PSObject.Properties['cleanupInProgress'];if($p -and $p.Value -is [bool]){$safe['cleanupInProgress']=$p.Value}
  $p=$Value.PSObject.Properties['activityKinds'];if($p){$safe['activityKinds']=@($p.Value|Where-Object{$_ -is [string] -and $_ -cin @('cpu','io','output','process-count')})}
  $p=$Value.PSObject.Properties['safeFailures'];if($p){$safe['safeFailures']=@($p.Value|Select-Object -First 8|ForEach-Object{Get-CfsSafeFailure $_})}
  $p=$Value.PSObject.Properties['failure'];if($p){$safe['failure']=Get-CfsSafeFailure $p.Value}
  $p=$Value.PSObject.Properties['writerInventoryDiagnostics'];if($p){$safe['writerInventoryDiagnostics']=@($p.Value|Select-Object -First 32|ForEach-Object{$record=Get-CfsSafeFailure $_;$record.source='writer-inventory';$record})}
  # Arbitrary IDs, usernames, paths, messages and exception text are deliberately omitted.
  return $safe
}
function Export-CfsUpdateDiagnostics {
  param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Destination,[string]$FixedAttempt='', [string]$FixedWorkerStartTicks='', [int]$FixedWorkerPid=0)
  $rootFull=Assert-CfsDiagnosticPath $Root;$destinationFull=Assert-CfsDiagnosticPath $Destination
  if(-not(Test-Path -LiteralPath $rootFull -PathType Container)){throw 'Select an existing CFS installation folder.'}
  if($destinationFull.StartsWith($rootFull.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Save diagnostics outside the installation folder.'}
  $artifact=Join-Path $rootFull 'artifacts/self-update';$notes=New-Object 'Collections.Generic.List[string]';$members=[ordered]@{}
  $status=$null
  try{$status=Read-CfsDiagnosticJson (Join-Path $artifact 'status.json')}catch{$notes.Add('status_unreadable')}
  $members['status.json']=Get-CfsSafeDiagnosticObject $status
  $classification='unknown'
  if($status -and $status.PSObject.Properties['message']){
    # Known legacy failures map to fixed enums, never copied free text.
    $m=[string]$status.message
    if($m -match 'Stream was not readable|stream.*read|\u30b9\u30c8\u30ea\u30fc\u30e0.*\u8aad'){$classification='legacy_stream_read_error'}
    elseif($m -match 'exited with code -?\d+'){$classification='native_nonzero'}
    elseif($m -match 'timed out|timeout'){$classification='legacy_timeout_reported'}
    elseif($m -match 'cannot be identified|identity changed|writer'){$classification='writer_verification_reported'}
  }
  $health=$null;$healthFile=$null;$format='legacy26.10.2';$binding='legacy-no-telemetry';$boundAttempt=''
  if($FixedAttempt){$boundAttempt=$FixedAttempt}
  elseif($status -and $status.PSObject.Properties['attemptId']){$boundAttempt=[string]$status.attemptId}
  $correlation=$null
  if($boundAttempt -match '^[a-zA-Z0-9-]{1,80}$'){
    $hash=[Security.Cryptography.SHA256]::Create();try{$correlation=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($boundAttempt)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
  }else{$boundAttempt=''}
  if($FixedAttempt -and $status -and (!$status.PSObject.Properties['attemptId'] -or $status.attemptId -cne $FixedAttempt)){$members['status.json']=[ordered]@{};$classification='unknown';$status=$null;$notes.Add('status_attempt_mismatch')}
  if(-not $FixedWorkerPid -and $status -and $status.PSObject.Properties['observability']){
    $identity=$status.observability
    if($identity -and $identity.workerPid -is [int] -and $identity.workerStartTicks -match '^\d{1,20}$'){$FixedWorkerPid=$identity.workerPid;$FixedWorkerStartTicks=$identity.workerStartTicks}
  }
  try{
    $obsRoot=Join-Path $artifact 'observability';$null=Assert-CfsDiagnosticPath $obsRoot
    if($boundAttempt -and (Test-Path -LiteralPath $obsRoot)){
      $healthFile=Join-Path (Join-Path $obsRoot $boundAttempt) 'health.json';$health=Read-CfsDiagnosticJson $healthFile
    }
    if($health){
      if(-not $health.PSObject.Properties['attemptId'] -or $health.attemptId -cne $boundAttempt){throw 'health_attempt_mismatch'}
      if(-not $FixedWorkerPid){throw 'worker_identity_unbound'}
      if($FixedWorkerPid -and ($health.workerPid -ne $FixedWorkerPid -or $health.workerStartTicks -cne $FixedWorkerStartTicks)){throw 'worker_identity_mismatch'}
      $members['health.json']=Get-CfsSafeDiagnosticObject $health;$format='newTelemetry';$binding='matched'
    }elseif($boundAttempt){
      $healthFile=$null;$binding='unavailable';$notes.Add('health_unavailable')
    }
  }catch{$notes.Add('health_unreadable_or_mismatched');$healthFile=$null;$health=$null;$binding='unavailable'}
  $events=New-Object 'Collections.Generic.List[object]'
  if($healthFile){
    try{
      $eventFile=Join-Path ([IO.Path]::GetDirectoryName($healthFile)) 'events.jsonl';$null=Assert-CfsDiagnosticPath $eventFile
      if(Test-Path -LiteralPath $eventFile){
        $text=Read-CfsDiagnosticText $eventFile 4MB;$lineCount=0
        foreach($line in ($text -split '\r?\n')){if(-not $line){continue};$lineCount++;if($lineCount -gt 2000){$notes.Add('events_count_limit');break};try{$events.Add((Get-CfsSafeDiagnosticObject ($line|ConvertFrom-Json)))}catch{if($notes.Count -lt 32){$notes.Add('event_unreadable')}}}
      }
    }catch{$notes.Add('events_unreadable')}
  }
  $members['events.json']=@($events.ToArray())
  $packageVersion=$null
  try{$build=Read-CfsDiagnosticJson (Join-Path $rootFull '.cfs-build-info.json');if($build -and $build.packageVersion -match '^\d{2}\.\d{1,2}\.\d{1,6}$'){$packageVersion=$build.packageVersion}}catch{$notes.Add('build_version_unavailable')}
  $members['summary.json']=[ordered]@{schemaVersion=1;collectedAt=[DateTime]::UtcNow.ToString('o');sourceFormat=$format;binding=$binding;attemptCorrelation=$correlation;legacyFailureClass=$classification;versions=@{os=[Environment]::OSVersion.Version.ToString();powershell=$PSVersionTable.PSVersion.ToString();package=$packageVersion;node=$null;nodeObservation='not-probed-read-only-collector'};unsupported=if($format -eq 'legacy26.10.2'){@('heartbeat','cpu','io','active-clock','last-real-activity')}else{@()};omitted=@('raw-logs','free-text','api-payload','environment','command-lines','business-data','authentication','paths','arbitrary-identifiers');notes=@($notes.ToArray()|Select-Object -First 32);snapshot='Sequential bounded reads; not an atomic snapshot of a running update.'}
  Add-Type -AssemblyName System.IO.Compression
  $content=[ordered]@{};$manifest=New-Object 'Collections.Generic.List[object]'
  foreach($name in $members.Keys){
    $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $members[$name] -Depth 8))
    $hash=[Security.Cryptography.SHA256]::Create();try{$hex=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    $content[$name]=$bytes;$manifest.Add(@{name=$name;bytes=$bytes.Length;sha256=$hex})
  }
  $content['manifest.json']=[Text.Encoding]::UTF8.GetBytes((@{schemaVersion=1;files=@($manifest.ToArray())}|ConvertTo-Json -Depth 5))
  $stream=[IO.File]::Open($destinationFull,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{
    $zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
    try{foreach($name in $content.Keys){$entry=$zip.CreateEntry($name);$output=$entry.Open();try{$output.Write($content[$name],0,$content[$name].Length)}finally{$output.Dispose()}}}finally{$zip.Dispose()}
  }finally{$stream.Dispose()}
  return $destinationFull
}
if($Run){
  $ErrorActionPreference='Stop'
  $interactive = -not $AppDir -or -not $OutputPath
  try{
    if($interactive){
      Add-Type -AssemblyName System.Windows.Forms
      if(-not $AppDir){$pick=New-Object Windows.Forms.FolderBrowserDialog;$pick.Description='Select the CFS installation folder (no update or restart will run).';if($pick.ShowDialog() -ne 'OK'){exit 0};$AppDir=$pick.SelectedPath;$pick.Dispose()}
      if(-not $OutputPath){$save=New-Object Windows.Forms.SaveFileDialog;$save.Filter='ZIP diagnostics (*.zip)|*.zip';$save.FileName='CFS-update-diagnostics-'+(Get-Date -Format yyyyMMdd-HHmmss)+'.zip';if($save.ShowDialog() -ne 'OK'){exit 0};$OutputPath=$save.FileName;$save.Dispose()}
    }
    $result=Export-CfsUpdateDiagnostics -Root $AppDir -Destination $OutputPath
    Write-Host ('Diagnostics saved: '+$result)
    if($interactive){$null=[Windows.Forms.MessageBox]::Show(('Diagnostics saved: '+$result),'CFS update diagnostics',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Information)}
  }catch{
    $message='Diagnostics could not be saved. Choose a readable CFS folder and a new ZIP in a local folder outside CFS, such as Downloads. Linked or redirected folders are not supported. No update was started.'
    if($interactive -and ('System.Windows.Forms.MessageBox' -as [type])){$null=[Windows.Forms.MessageBox]::Show($message,'CFS update diagnostics',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Error)}
    Write-Error $message -ErrorAction Continue
    exit 1
  }
}
