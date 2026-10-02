param([string]$ObservationDirectory,[int]$ExpectedWorkerPid,[string]$ExpectedWorkerStartTicks,[switch]$DefinitionsOnly)
function Get-CfsMonitorView {
  param($Health,[DateTime]$Now=[DateTime]::UtcNow,[string]$WorkerIdentity='unknown')
  if(-not $Health){return @{code='unavailable';text='Observation unavailable. No update will be restarted.'}}
  if($WorkerIdentity -eq 'changed'){return @{code='unavailable';text='Worker identity changed. Current activity cannot be verified.'}}
  if($Health.state -eq 'completed'){return @{code='completed';text='Update completed. Reload CFS.'}}
  if($Health.state -eq 'failed'){
    if($Health.cleanupState -in @('pending','unverifiable')){return @{code='cleanup-unverified';text='ERROR: Update failed and stopping could not be confirmed. Do not retry. Export diagnostics for support.'}}
    if($Health.failureCode -in @('deadline_exceeded','attempt_deadline')){return @{code='failed';text='ERROR: The active-time limit was reached. Command cleanup was verified. Export diagnostics and resolve the cause before a new update.'}}
    return @{code='failed';text='Update failed. Export diagnostics and resolve the cause before a new update.'}
  }
  if($WorkerIdentity -eq 'exited'){return @{code='interrupted';text='The observed worker exited without a terminal record. Outcome is unknown.'}}
  try{$age=($Now-[DateTimeOffset]::Parse($Health.workerHeartbeatUtc).UtcDateTime).TotalSeconds}catch{return @{code='unavailable';text='Heartbeat unavailable. Current activity cannot be verified.'}}
  if($age -gt 300){return @{code='unresponsive';text='ERROR: Worker response has not been observed for 5 minutes. It has not been confirmed stopped. Do not start another update.'}}
  if($age -gt 30 -or $age -lt -5){return @{code='stale';text='Worker response is stale. The current operation may still be running.'}}
  if($Health.PSObject.Properties['observationQuality'] -and $Health.observationQuality -eq 'unavailable'){return @{code='unavailable';text='Worker responding, but OS activity observation is unavailable. Completion cannot be inferred.'}}
  $activityReference=$Health.lastActivityUtc
  if(-not $activityReference -and $Health.PSObject.Properties['startedUtc']){$activityReference=$Health.startedUtc}
  if($activityReference){try{if(($Now-[DateTimeOffset]::Parse($activityReference).UtcDateTime).TotalSeconds -gt 120){return @{code='inactive';text='No recent OS activity observed. This does not prove the operation is stuck.'}}}catch{}}
  return @{code='running';text='Worker responding. OS activity is separate from completion progress.'}
}
if($DefinitionsOnly){return}
$ErrorActionPreference='Stop'
if($ExpectedWorkerPid -le 0 -or $ExpectedWorkerStartTicks -notmatch '^\d{1,20}$'){throw 'A fixed worker identity is required.'}
. (Join-Path $PSScriptRoot 'cfs-update-diagnostics.ps1')
$directory=Assert-CfsDiagnosticPath $ObservationDirectory
$obs=Split-Path $directory -Parent;$selfUpdate=Split-Path $obs -Parent;$artifacts=Split-Path $selfUpdate -Parent;$appRoot=Split-Path $artifacts -Parent
if((Split-Path $obs -Leaf) -ne 'observability' -or (Split-Path $selfUpdate -Leaf) -ne 'self-update' -or (Split-Path $artifacts -Leaf) -ne 'artifacts'){throw 'Invalid observation folder.'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CfsMonitorWindow {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
}
'@
$form=New-Object Windows.Forms.Form;$form.Text='CFS update monitor';$form.Width=660;$form.Height=340;$form.StartPosition='CenterScreen';$form.BackColor=[Drawing.Color]::White
$label=New-Object Windows.Forms.Label;$label.SetBounds(20,20,600,72);$label.Font=New-Object Drawing.Font('Segoe UI',10);$form.Controls.Add($label)
$details=New-Object Windows.Forms.Label;$details.SetBounds(20,100,600,100);$details.Font=New-Object Drawing.Font('Segoe UI',10);$form.Controls.Add($details)
$export=New-Object Windows.Forms.Button;$export.Text='Export diagnostics';$export.SetBounds(20,215,165,35);$form.Controls.Add($export)
$note=New-Object Windows.Forms.Label;$note.SetBounds(20,260,610,30);$note.Text='Closing this monitor does not stop or restart the update.';$form.Controls.Add($note)
$script:MonitorHandle=$null;$script:LastMonitorTick=[DateTime]::UtcNow;$script:HealthIdentity=([string]$ExpectedWorkerPid)+'/'+$ExpectedWorkerStartTicks
$script:MonitorAttempt=Split-Path $directory -Leaf
$script:MonitorWindowShown=$false
$timer=New-Object Windows.Forms.Timer;$timer.Interval=1000
$timer.Add_Tick({
  try{
    # PowerShell is launched hidden to avoid a console. Windows applies that
    # startup flag to the first ShowWindow too; explicitly show only our form.
    if(-not $script:MonitorWindowShown){$null=[CfsMonitorWindow]::ShowWindow($form.Handle,5);$script:MonitorWindowShown=$true}
    $now=[DateTime]::UtcNow;$gap=($now-$script:LastMonitorTick).TotalSeconds;$script:LastMonitorTick=$now
    $h=Read-CfsDiagnosticJson (Join-Path $directory 'health.json');$identity='unknown'
    if(-not $h -or $h.attemptId -cne $script:MonitorAttempt){throw 'Attempt mismatch.'}
    $identityText=([string]$h.workerPid)+'/'+([string]$h.workerStartTicks)
    if($script:HealthIdentity -and $identityText -cne $script:HealthIdentity){throw 'Worker mismatch.'}
    if($h -and $h.workerPid -is [int] -and $h.workerStartTicks -match '^\d{1,20}$'){
      if(-not $script:MonitorHandle){try{$p=[Diagnostics.Process]::GetProcessById($h.workerPid);$null=$p.Handle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -ceq $h.workerStartTicks){$script:MonitorHandle=$p;$script:HealthIdentity=$identityText}else{$p.Dispose();$identity='changed'}}catch{$identity='unknown'}}
      if($script:MonitorHandle){$identity=if($script:MonitorHandle.HasExited){'exited'}else{'matched'}}
    }
    $view=Get-CfsMonitorView -Health $h -Now $now -WorkerIdentity $identity
    if($gap -gt 30 -and $view.code -notin @('completed','failed')){$view=@{code='revalidating';text='Observation gap detected. Rechecking current worker state; no stop or retry will run.'}}
    $label.Text=$view.text
    if($h){
      $safe=Get-CfsSafeDiagnosticObject $h
      $labels=@{'build'='Building app';'npm-install'='Installing dependencies';'backup-data'='Protecting local data';'restart'='Restarting app';'git-check'='Checking installation';'git-fetch'='Fetching update';'git-pull'='Applying update';'clear-build-output'='Preparing build files';'sync-static-assets'='Preparing app assets';'verify-writers'='Checking app processes';'runtime-check'='Checking runtime';'readiness'='Checking updated app';'done'='Completed';'failed'='Failed';'start'='Preparing update'}
      $step=if($labels.ContainsKey([string]$safe.operation)){$labels[[string]$safe.operation]}elseif($labels.ContainsKey([string]$safe.phase)){$labels[[string]$safe.phase]}else{'Preparing update'}
      $details.Text=$step+"`r`nWall elapsed: "+[math]::Round($safe.elapsedWallMs/1000)+' s / Active clock: '+[math]::Round($safe.elapsedAwakeMs/1000)+" s`r`nLast worker response: "+$safe.workerHeartbeatUtc+"`r`nLast OS activity: "+$safe.lastActivityUtc
    }
  }catch{$label.Text='Observation unavailable. The monitor cannot determine whether the update is progressing.'}
})
$export.Add_Click({
  $save=New-Object Windows.Forms.SaveFileDialog;$save.Filter='ZIP diagnostics (*.zip)|*.zip';$save.FileName='CFS-update-diagnostics-'+(Get-Date -Format yyyyMMdd-HHmmss)+'.zip'
  try{if($save.ShowDialog() -eq 'OK'){
    if(-not $script:HealthIdentity){throw 'Worker identity not bound.'}
    $parts=$script:HealthIdentity -split '/'
    $null=Export-CfsUpdateDiagnostics -Root $appRoot -Destination $save.FileName -FixedAttempt $script:MonitorAttempt -FixedWorkerPid ([int]$parts[0]) -FixedWorkerStartTicks $parts[1]
    $note.Text='Diagnostics saved. The update was not changed.'
  }}
  catch{$note.Text='Export failed. Choose a new ZIP outside the installation. The update was not changed.'}
  finally{$save.Dispose()}
})
$timer.Start()
try{[Windows.Forms.Application]::Run($form)}finally{$timer.Stop();$timer.Dispose();if($script:MonitorHandle){$script:MonitorHandle.Dispose()};$form.Dispose()}
