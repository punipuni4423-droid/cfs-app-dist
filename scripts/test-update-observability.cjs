// Real PS5.1 process/job tests. Isolated synthetic files only; no CFS server or DB.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
assert.equal(process.platform,'win32');
const root=fs.mkdtempSync(path.join(process.env.CFS_OBSERVABILITY_TEST_DIR||os.tmpdir(),'cfs-observation-'));
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const q=s=>"'"+s.replaceAll("'","''")+"'";
const worker=path.join(__dirname,'update-cfs-app.ps1');
const fixture=path.join(root,"space's 日本語 & fixture");fs.mkdirSync(fixture);
fs.writeFileSync(path.join(fixture,'child.cjs'),`const fs=require('fs'),cp=require('child_process');const mode=process.argv[2];
if(mode==='early'){console.log('EARLY 日本語');setTimeout(()=>console.log('LATE'),1800);}
if(mode==='flood'){process.stdout.write('a'.repeat(700000));process.stderr.write('b'.repeat(100000));}
if(mode==='nonzero'){process.exit(37);}
if(mode==='hang'){const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant.json',JSON.stringify({pid:c.pid}));setInterval(()=>{},1000);}
if(mode==='parent-exit'){const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});fs.writeFileSync('parent-exit-child.json',JSON.stringify({pid:c.pid}));c.unref();process.exit(0);}
if(mode==='unicode'){process.stdout.write(Buffer.from([0xe6]));setTimeout(()=>process.stdout.write(Buffer.from([0x97,0xa5])),50);}
`);
const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
const body=`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. ${q(path.join(__dirname,'cfs-update-process-runner.ps1'))}
. ${q(path.join(__dirname,'cfs-update-observability.ps1'))}
. ${q(path.join(__dirname,'cfs-update-maintenance.ps1'))}
. ${q(path.join(__dirname,'cfs-update-diagnostics.ps1'))}
. ${q(path.join(__dirname,'cfs-update-monitor.ps1'))} -DefinitionsOnly
$results=New-Object 'Collections.Generic.List[string]'
function Check($ok,$name){if(-not $ok){throw $name};$results.Add($name)}
$folder=${q(fixture)};$logPath=Join-Path $folder 'update.log';$node=${q(process.execPath)};$scriptFile=Join-Path $folder 'child.cjs'
$ast=[Management.Automation.Language.Parser]::ParseFile(${q(worker)},[ref]$null,[ref]$null)
foreach($name in @('Write-Log','Write-UpdateStatus','Invoke-LoggedCommand','Invoke-NpmDependencyInstall')){$f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f.Extent.Text}
Initialize-CfsObservation -ArtifactRoot (Join-Path $folder 'artifacts/self-update') -RunId 'synthetic'
$job=New-CfsOwnedCommand $node @($scriptFile,'early') $folder
try{Start-Sleep -Milliseconds 600;$early=($job.Drain()|ForEach-Object{$_.Text}) -join '';Check ($early.Contains('EARLY') -and -not $job.Sample().RootExited) 'output-before-exit';while(-not $job.Sample().Empty){Start-Sleep -Milliseconds 100}}finally{$job.Dispose()}
Invoke-LoggedCommand $node @($scriptFile,'unicode') $folder
Check ([IO.File]::ReadAllText($logPath).Contains('日')) 'split-utf8'
Invoke-LoggedCommand $node @($scriptFile,'flood') $folder
$text=[IO.File]::ReadAllText($logPath);Check ($text.Contains(('a'*4096)) -and $text.Contains(('b'*4096))) 'both-pipes-drained'
Check ($script:CfsObservation.outputBytes -eq 800000) 'output-byte-accounting'
Check ($script:CfsObservation.droppedBytes -eq 0) 'bounded-terminal-queue-drained'
$reason='';try{Invoke-LoggedCommand $node @($scriptFile,'nonzero') $folder}catch{$reason=$_.Exception.Data['CfsReason'];Check ($_.Exception.Message -match 'exited with code 37') 'actual-nonzero'}
Check ($reason -eq 'native_nonzero') 'typed-native-failure'
$reason='';try{Invoke-LoggedCommand $node @($scriptFile,'nonzero') (Join-Path $folder 'missing-cwd')}catch{$reason=$_.Exception.Data['CfsReason']}
Check ($reason -eq 'spawn_failed') 'spawn-generic-reason-retained'
Check (@($script:CfsObservation.safeFailures|Where-Object{$_.source -eq 'spawn' -and $_.stage -eq 'create_owned_process' -and $_.win32Code -eq 267 -and $_.exceptionType -eq 'System.InvalidOperationException'}).Count -eq 1) 'spawn-native-stage-code-retained'
$reason='';$timer=[Diagnostics.Stopwatch]::StartNew()
try{Invoke-LoggedCommand $node @($scriptFile,'hang') $folder -TimeoutSeconds 1}catch{$reason=$_.Exception.Data['CfsReason']}
Check ($reason -eq 'deadline_exceeded' -and $timer.ElapsedMilliseconds -lt 12000) 'active-deadline'
Check ($script:CfsObservation.cleanupState -eq 'verified' -and -not $script:CfsCleanupUncertain) 'owned-job-cleanup'
Check ($script:CfsObservation.commandExitCode -eq 1460 -and $script:CfsObservation.failureCode -eq 'deadline_exceeded') 'deadline-retains-real-killed-root-exit'
$desc=Get-Content -LiteralPath (Join-Path $folder 'descendant.json') -Raw|ConvertFrom-Json
Check ($null -eq (Get-Process -Id $desc.pid -ErrorAction SilentlyContinue)) 'descendant-absent'
Check ($null -ne (Get-Process -Id ${unrelated.pid} -ErrorAction Stop)) 'unrelated-survives'
$reason='';try{Invoke-LoggedCommand $node @($scriptFile,'parent-exit') $folder -TimeoutSeconds 1.3}catch{$reason=$_.Exception.Data['CfsReason']}
Check ($reason -eq 'deadline_exceeded' -and $script:CfsObservation.commandExitCode -eq 0 -and $script:CfsObservation.cleanupState -eq 'verified') 'deadline-retains-exited-parent-with-live-descendant'
$desc=Get-Content -LiteralPath (Join-Path $folder 'parent-exit-child.json') -Raw|ConvertFrom-Json
Check ($null -eq (Get-Process -Id $desc.pid -ErrorAction SilentlyContinue)) 'parent-exit-descendant-absent'
$script:CfsObservation.workerAwakeStarted=(Get-CfsAwakeMs)-3600001
$reason='';try{Set-CfsObservationOperation 'readiness'}catch{$reason=$_.Exception.Data['CfsReason']}
Check ($reason -eq 'attempt_deadline') 'cooperative-total-deadline'
$script:CfsObservation.workerAwakeStarted=Get-CfsAwakeMs
$lock=Enter-CfsUpdateMaintenance $folder
try{
 Start-CfsUpdateMonitor
 $receipt=Read-CfsDiagnosticJson (Join-Path $script:CfsObservation.directory 'monitor.json')
 $monitor=[Diagnostics.Process]::GetProcessById($receipt.pid);$null=$monitor.Handle
 Check ($monitor.StartTime.ToUniversalTime().Ticks.ToString() -ceq $receipt.startTicks) 'monitor-fixed-identity'
 for($i=0;$i -lt 60 -and $monitor.MainWindowHandle -eq [IntPtr]::Zero;$i++){Start-Sleep -Milliseconds 100;$monitor.Refresh()}
 Check ($monitor.MainWindowHandle -ne [IntPtr]::Zero) 'native-monitor-visible'
 Check ($monitor.CloseMainWindow() -and $monitor.WaitForExit(5000)) 'native-monitor-normal-close'
 Check ($lock.CanWrite -and -not [Diagnostics.Process]::GetCurrentProcess().HasExited) 'monitor-close-preserves-worker-lock'
}finally{$lock.Dispose()}
Set-CfsObservationOperation 'runtime-check'
$script:CfsObservation.workerHeartbeatUtc=[DateTime]::UtcNow.AddSeconds(-40).ToString('o');Set-CfsObservationOperation 'runtime-check' -End
Check ($script:CfsObservation.maxGapMs -ge 40000) 'synchronous-gap-recorded'
$h=[pscustomobject]@{state='running';workerHeartbeatUtc=[DateTime]::UtcNow.AddSeconds(-301).ToString('o');lastActivityUtc=$null}
Check ((Get-CfsMonitorView $h).code -eq 'unresponsive') 'monitor-error-not-kill'
$h.workerHeartbeatUtc=[DateTime]::UtcNow.AddSeconds(-31).ToString('o');Check ((Get-CfsMonitorView $h).code -eq 'stale') 'monitor-stale'
$h.workerHeartbeatUtc=[DateTime]::UtcNow.ToString('o');Check ((Get-CfsMonitorView $h).code -eq 'running') 'heartbeat-not-hang'
$h|Add-Member NoteProperty startedUtc ([DateTime]::UtcNow.AddSeconds(-121).ToString('o'))
Check ((Get-CfsMonitorView $h).code -eq 'inactive') 'no-first-activity-warning'
$h|Add-Member NoteProperty observationQuality 'unavailable'
Check ((Get-CfsMonitorView $h).code -eq 'unavailable') 'activity-unavailable-distinct'
$h.state='completed';Check ((Get-CfsMonitorView $h -WorkerIdentity changed).code -eq 'unavailable') 'identity-before-terminal'
$statusPath=Join-Path $folder 'artifacts/self-update/status.json';$AttemptId='synthetic';$TargetCommit=('a'*40);$ExpectedHead=('b'*40);$ConsoleProgress=$false;$script:StartedAt=[DateTime]::UtcNow.ToString('o')
Write-UpdateStatus -State running -Step build -Message 'synthetic'
Set-CfsObservationOperation 'backup-data';$syncOperationId=$script:CfsObservation.operationId
$reader=[IO.File]::Open($statusPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{try{Write-UpdateStatus -State completed -Step done -Message 'synthetic'}catch{}}finally{$reader.Dispose()}
Check (-not $script:CfsObservation.terminal -and $script:CfsObservation.state -eq 'running') 'failed-publication-never-native-success'
Write-UpdateStatus -State failed -Step failed -Message 'synthetic'
Check ($script:CfsObservation.state -eq 'failed' -and $script:CfsObservation.terminal) 'failed-terminal-after-publication'
Set-CfsObservationPhase -State failed -Phase failed
$events=@(Get-Content -LiteralPath (Join-Path $script:CfsObservation.directory 'events.jsonl')|ForEach-Object{$_|ConvertFrom-Json})
$operationEnds=@($events|Where-Object{$_.operationId -eq $syncOperationId -and $_.kind -eq 'operation-end'})
Check ($operationEnds.Count -eq 1 -and $operationEnds[0].operationOutcome -eq 'failed' -and -not $script:CfsObservation.operationActive) 'failed-sync-operation-closed-once'
Check ($operationEnds[0].sequence -lt @($events|Where-Object{$_.kind -eq 'worker-terminal'})[0].sequence) 'failed-sync-operation-ends-before-terminal'
$newZip=${q(path.join(root,'new-diagnostics.zip'))};$null=Export-CfsUpdateDiagnostics $folder $newZip
$wrong=${q(path.join(root,'wrong-diagnostics.zip'))};$null=Export-CfsUpdateDiagnostics $folder $wrong -FixedAttempt 'other-attempt' -FixedWorkerPid $PID -FixedWorkerStartTicks ([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())
$legacy=Join-Path $folder 'legacy';$null=New-Item -ItemType Directory -Force -Path (Join-Path $legacy 'artifacts/self-update')
$secret='SENTINEL_SECRET_DO_NOT_EXPORT';@{state='failed';currentStep='build';message=('Stream was not readable '+$secret);logPath=$secret;startedAt='2026-10-01T00:00:00Z';environment=$secret;commandLine=$secret;failure=@{exceptionType='System.IO.IOException';hResult=-2147024891;message=$secret;scriptStackTrace=$secret};writerInventoryDiagnostics=@(@{phase='enumerate';result='query-error';exceptionType='Microsoft.Management.Infrastructure.CimException';hResult=-2147217407;errorCode='CimQueryFailed';category='PermissionDenied';message=$secret},@{phase=$secret;exceptionType=$secret;hResult=$secret;errorCode=$secret})}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $legacy 'artifacts/self-update/status.json') -Encoding UTF8
$zipPath=Join-Path $folder 'diagnostics.zip';$null=Export-CfsUpdateDiagnostics $legacy $zipPath
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
try{$all='';foreach($e in $zip.Entries){$r=New-Object IO.StreamReader($e.Open());try{$all+=$r.ReadToEnd()}finally{$r.Dispose()}};Check (-not $all.Contains($secret)) 'diagnostic-secret-excluded';Check ($all.Contains('legacy_stream_read_error') -and $all.Contains('legacy26.10.2')) 'legacy-failure-retained';Check ($zip.Entries.Count -eq 4) 'diagnostic-allowlist'}finally{$zip.Dispose()}
$zip=[IO.Compression.ZipFile]::OpenRead($wrong);try{Check ($null -eq $zip.GetEntry('health.json')) 'different-attempt-not-mixed';$r=New-Object IO.StreamReader($zip.GetEntry('summary.json').Open());try{$summary=$r.ReadToEnd()|ConvertFrom-Json;Check ($summary.legacyFailureClass -eq 'unknown') 'different-attempt-classification-omitted'}finally{$r.Dispose()}}finally{$zip.Dispose()}
$zip=[IO.Compression.ZipFile]::OpenRead($newZip);try{Check ($null -ne $zip.GetEntry('health.json')) 'new-diagnostics-bound';$r=New-Object IO.StreamReader($zip.GetEntry('health.json').Open());try{$health=$r.ReadToEnd()|ConvertFrom-Json;Check (@($health.safeFailures|Where-Object{$_.stage -eq 'create_owned_process' -and $_.win32Code -eq 267}).Count -ge 1) 'diagnostic-native-cause-exported'}finally{$r.Dispose()}}finally{$zip.Dispose()}
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath);try{$r=New-Object IO.StreamReader($zip.GetEntry('status.json').Open());try{$safeStatus=$r.ReadToEnd()|ConvertFrom-Json;Check ($safeStatus.failure.hResult -eq -2147024891 -and $safeStatus.writerInventoryDiagnostics[0].errorCode -eq 'CimQueryFailed' -and $safeStatus.writerInventoryDiagnostics[0].hResult -eq -2147217407 -and $safeStatus.writerInventoryDiagnostics[1].exceptionType -eq 'unknown') 'legacy-safe-cim-and-failure-retained'}finally{$r.Dispose()}}finally{$zip.Dispose()}
$heldLock=Enter-CfsUpdateMaintenance $folder
try{
 $script:HeldSamples=0;$script:HeldDisposed=$false
 $mock=New-Object PSObject
 $mock|Add-Member ScriptMethod Sample {$script:HeldSamples++;if(-not $heldLock.CanWrite){throw 'maintenance released'};if($script:HeldSamples -eq 1){throw 'synthetic observation unavailable'};return @{Empty=$true;RootExited=$true;ExitCode=1460}}
 $mock|Add-Member ScriptMethod Dispose {$script:HeldDisposed=$true}
 $script:CfsHeldJob=$mock;$script:CfsCleanupUncertain=$true;Wait-CfsOwnedCleanup
 Check ($heldLock.CanWrite -and $script:HeldDisposed -and -not $script:CfsCleanupUncertain -and $script:HeldSamples -eq 2) 'uncertain-cleanup-retains-lock-until-proof'
 Check ($script:CfsObservation.commandExitCode -eq 1460 -and -not $script:CfsObservation.cleanupInProgress) 'held-cleanup-retains-observed-exit'
}finally{$heldLock.Dispose()}
function Invoke-LoggedCommand { param($FilePath,$Arguments,$WorkingDirectory) $script:DependencyCalls++;Throw-CfsCommandFailure $script:DependencyFailure 'synthetic typed failure' }
foreach($typed in @('deadline_exceeded','monitor_unavailable','spawn_failed','cleanup_unverifiable')){
 $script:DependencyCalls=0;$script:DependencyFailure=$typed;$caught=$false
 try{Invoke-NpmDependencyInstall $folder}catch{$caught=$_.Exception.Data['CfsReason'] -eq $typed}
 Check ($caught -and $script:DependencyCalls -eq 1) ('no-npm-fallback-'+$typed)
}
# Deterministic gap/observation-failure checks use an owned-job test double;
# real Job Object creation, timeout and descendants were exercised above.
function New-CfsOwnedCommand {param($FilePath,$Arguments,$WorkingDirectory) return $script:FakeOwnedJob}
$script:FakeSamples=0;$script:FakeTerminated=$false;$script:FakeDisposed=$false
$script:FakeOwnedJob=New-Object PSObject
$script:FakeOwnedJob|Add-Member ScriptMethod Sample { $script:FakeSamples++;if($script:FakeSamples -eq 1){Check (-not $script:CfsObservation.cleanupInProgress) 'normal-command-not-cleaning';$e=New-Object InvalidOperationException('SYNTHETIC_SECRET');$e.Data['CfsNativeStage']='job_accounting';$e.Data['CfsWin32Code']=5;throw $e};return @{Empty=$true;RootExited=$true;ExitCode=1460} }
$script:FakeOwnedJob|Add-Member ScriptMethod Terminate {Check $script:CfsObservation.cleanupInProgress 'termination-is-cleanup-phase';$script:FakeTerminated=$true}
$script:FakeOwnedJob|Add-Member ScriptMethod Dispose {$script:FakeDisposed=$true}
$reason='';try{Invoke-CfsObservedCommand $node @() $folder}catch{$reason=$_.Exception.Data['CfsReason']}
Check ($reason -eq 'monitor_unavailable' -and $script:FakeTerminated -and $script:FakeDisposed) 'monitor-failure-cleans-owned-job'
Check (@($script:CfsObservation.safeFailures|Where-Object{$_.source -eq 'command-observation' -and $_.stage -eq 'job_accounting' -and $_.win32Code -eq 5}).Count -eq 1) 'monitor-native-cause-retained'
$script:FakeTerminated=$false;$script:FakeDisposed=$false
$script:FakeOwnedJob=New-Object PSObject
$script:FakeOwnedJob|Add-Member ScriptMethod Sample {return [pscustomobject]@{PipeFailure=$null;RootExited=$true;Empty=$true;PipesClosed=$true;ExitCode=0;PipeReadFailed=$false;CpuMs=0;ReadBytes=0;WriteBytes=0;OutputBytes=0;DroppedBytes=0;Active=0}}
$script:FakeOwnedJob|Add-Member ScriptMethod Drain {return @()}
$script:FakeOwnedJob|Add-Member ScriptMethod Terminate {$script:FakeTerminated=$true}
$script:FakeOwnedJob|Add-Member ScriptMethod Dispose {$script:FakeDisposed=$true}
$script:FakeClock=0;function Get-CfsAwakeMs {$script:FakeClock+=31000;return $script:FakeClock}
$script:CfsObservation.workerAwakeStarted=0
Invoke-CfsObservedCommand $node @() $folder -TimeoutSeconds 1
Check ($script:FakeDisposed -and -not $script:FakeTerminated -and $script:CfsObservation.commandExitCode -eq 0) 'post-gap-actual-exit-precedes-deadline'
$results|ConvertTo-Json|Set-Content -LiteralPath ${q(path.join(root,'results.json'))} -Encoding UTF8
Write-Host ('PASS '+$results.Count)
`;
fs.writeFileSync(path.join(root,'run.ps1'),'\ufeff'+body);
try{
const run=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'run.ps1')],{windowsHide:true,encoding:'utf8',timeout:90000});
fs.writeFileSync(path.join(root,'stdout.txt'),run.stdout||'');fs.writeFileSync(path.join(root,'stderr.txt'),run.stderr||'');fs.writeFileSync(path.join(root,'exit.json'),JSON.stringify({exit:run.status,error:run.error?.message},null,2));
assert.equal(run.status,0,`${run.stderr}\nEvidence: ${root}`);console.log(JSON.stringify({pass:true,root,results:JSON.parse(fs.readFileSync(path.join(root,'results.json'),'utf8').replace(/^\uFEFF/,''))}));
}finally{unrelated.kill();}
