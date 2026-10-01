param([Parameter(Mandatory=$true)][string]$Case,[Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'cfs-local-data-preservation.ps1')
$appPath=Join-Path $EvidenceRoot 'app'; $null=New-Item -ItemType Directory -Path $appPath -Force
$script:calls=0;$script:waitMs=0;$script:probes=0;$script:stops=0;$script:logs=@();$script:timeouts=@()
$baseDate=[datetime]'2026-10-01T00:00:00Z'
function Row([int]$Number,[string]$Command='node.exe other.js',[object]$Created=$baseDate){[pscustomobject]@{ProcessId=$Number;ParentProcessId=42;CommandLine=$Command;CreationDate=$Created}}
function Write-Log([string]$Message){if($Case -in @('logging-fails','logging-fails-unknown')){throw 'synthetic log IO failure'};$script:logs+=,$Message}
function Start-Sleep {param([int]$Milliseconds) $script:waitMs+=$Milliseconds}
function Get-CimInstance {
 param($ClassName,$Filter,$ErrorAction,[int]$OperationTimeoutSec)
 $script:calls++;$script:timeouts+=,$OperationTimeoutSec
 if($Case -eq 'cim-error'){throw [UnauthorizedAccessException]::new('synthetic CIM denied')}
 if($Case -eq 'cim-error-second' -and $script:calls -gt 1){throw [UnauthorizedAccessException]::new('synthetic CIM denied')}
 if($Case -eq 'cim-partial-error'){Row 111;throw [TimeoutException]::new('synthetic CIM timeout')}
 if($Case -eq 'cim-timeout'){throw [TimeoutException]::new('synthetic CIM timeout')}
 switch($Case){
  'complete' {Row 111;Row 222 ('node.exe "'+$appPath+'\writer.js"');break}
  'recovers' {if($script:calls -eq 1){Row 111 ''}else{Row 111};break}
  'recovers-third' {if($script:calls -lt 3){Row 111 ''}else{Row 111};break}
  'date-recovers' {if($script:calls -eq 1){Row 111 'node.exe other.js' $null}else{Row 111};break}
  'logging-fails' {if($script:calls -eq 1){Row 111 ''}else{Row 111};break}
  'disappears' {if($script:calls -eq 1){Row 111 ''};break}
  'reappears-writer' {if($script:calls -eq 1){Row 111 ''}else{Row 111 ('node.exe "'+$appPath+'\writer.js"') $baseDate.AddSeconds(2)};break}
  'omitted-alive' {if($script:calls -eq 1){Row 111 ''};break}
  'pid-reused' {if($script:calls -eq 1){Row 111 ''}else{Row 111 ('node.exe "'+$appPath+'\writer.js"') $baseDate.AddSeconds(1)};break}
  'another-unknown' {if($script:calls -eq 1){Row 111 ''}else{Row 111;Row 333 ''};break}
  'third-unknown' {if($script:calls -lt 3){Row 111 ''}else{Row 111;Row 333 ''};break}
  'resolved-last-unknown' {if($script:calls -eq 1){Row 111 '';Row 222 ''}else{Row 222};break}
  'always-disappears' {Row 111 '';break}
  'multiple' {if($script:calls -eq 1){Row 111 '';Row 222 ''}else{Row 111;Row 222};break}
  'date-missing' {Row 111 'node.exe SECRET_VALUE' $null;break}
  'secret' {Row 111 'node.exe --token=SECRET_VALUE' $null;break}
  'catch-complete' {break}
  'start-complete' {break}
  'start-late-unknown' {if($script:late){Row 111 ''};break}
  'start-data-writer' {Row 111 ('node.exe "'+$appPath+'\writer.js"');break}
  'start-listener' {break}
  'catch-unknown' {Row 111 '';break}
  'catch-data-writer' {Row 111 ('node.exe "'+$appPath+'\writer.js"');break}
  'catch-listener' {break}
  default {Row 111 ''}
 }
}
function Get-Process {
 param([int]$Id,$ErrorAction)
 $script:probes++
 if($Case -eq 'empty-probe'){return}
 if($Case -eq 'access-denied'){throw [UnauthorizedAccessException]::new('synthetic process denied')}
 if($Case -eq 'similar-notfound'){throw [Management.Automation.ErrorRecord]::new([Exception]::new('synthetic not found'),'NoProcessFoundForGivenIdFake',[Management.Automation.ErrorCategory]::ObjectNotFound,$Id)}
 if($Case -eq 'wrong-category'){throw [Management.Automation.ErrorRecord]::new([Exception]::new('synthetic denied'),'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand',[Management.Automation.ErrorCategory]::PermissionDenied,$Id)}
 if($Case -in @('disappears','reappears-writer','always-disappears')){return Microsoft.PowerShell.Management\Get-Process -Id 2147483647 -ErrorAction Stop}
 return [pscustomobject]@{Id=$Id}
}
function Get-NetTCPConnection {param($ErrorAction) if($Case -in @('catch-listener','start-listener')){[pscustomobject]@{State='Listen';LocalPort=39999;OwningProcess=111}}}
function Stop-Process {throw 'MUST NOT STOP A PROCESS'}
function Check([bool]$Ok,[string]$Message){if(-not $Ok){throw $Message}}
if($Case.StartsWith('catch-') -or $Case.StartsWith('start-')){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'update-cfs-app.ps1'),[ref]$tokens,[ref]$errors)
 foreach($name in @('Write-Log','Write-UpdateStatus','Start-CfsAppServer')){$definition=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $definition.Extent.Text}
 $logPath=Join-Path $EvidenceRoot 'update.log';$statusPath=Join-Path $EvidenceRoot 'status.json';$backupPath='synthetic-backup';$Port=39999
 $script:StoppedAppWriters=$true;$script:StartedAt='2026-10-01T00:00:00Z';$AttemptId='test';$TargetCommit=('a'*40);$ExpectedHead=('b'*40);$ConsoleProgress=$false
 $HostName='127.0.0.1';$script:late=$false
 function Import-PublicSupabaseEnv{}
 function Test-CfsVerifiedBuild {param($Commit) return $true}
 function Get-NextDistPath {param($RootPath) return (Join-Path $RootPath '.next')}
 function Initialize-CfsUpdateNode {param($RootPath) $script:late=$true;return 'synthetic-node.exe'}
 function Start-Process {param($FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError,$WindowStyle,[switch]$PassThru) [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'started.marker'),'started')}
 if($Case.StartsWith('start-')){
  $refused=$false;try{Start-CfsAppServer}catch{$refused=$true}
  Check ($refused -eq ($Case -ne 'start-complete')) 'Wrong start refusal'
  Check ((Test-Path -LiteralPath (Join-Path $EvidenceRoot 'started.marker')) -eq ($Case -eq 'start-complete')) 'Unsafe start'
  'PASS '+$Case;exit 0
 }
 $outer=$ast.Find({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $n.CatchClauses.Count -gt 0 -and $n.CatchClauses[0].Body.Extent.Text.Contains('$updateFailureMessage =')},$true)
 Invoke-Expression ("try { throw 'original failure' } catch "+$outer.CatchClauses[0].Body.Extent.Text)
 throw 'Catch did not exit'
}
$caught=$null;$writers=@()
try{$writers=@(Get-CfsAppWriters $appPath)}catch{$caught=$_}
$refusal=$Case -in @('alive-unknown','date-missing','secret','access-denied','similar-notfound','wrong-category','empty-probe','cim-error','cim-error-second','cim-partial-error','cim-timeout','omitted-alive','another-unknown','third-unknown','logging-fails-unknown')
$refusal=$refusal -or $Case -in @('resolved-last-unknown','always-disappears')
Check (($null -ne $caught) -eq $refusal) ('Unexpected outcome: '+$Case)
Check ($script:calls -le 3) 'More than three full CIM queries'
Check ($script:waitMs -le 200) 'Too much added waiting'
Check (@($script:timeouts|Where-Object{$_ -le 0}).Count -eq 0) 'Missing query timeout'
if($Case -eq 'complete'){Check ($writers.Count -eq 1 -and $writers[0].ProcessId -eq 222 -and $script:calls -eq 1) 'Wrong ownership or query count'}
if($Case -in @('recovers','disappears','logging-fails','date-recovers','multiple','reappears-writer')){Check ($script:calls -eq 2) 'Recovery did not use a fresh full inventory'}
if($Case -eq 'recovers-third'){Check ($script:calls -eq 3) 'Third observation not used'}
if($Case -eq 'pid-reused'){Check ($writers.Count -eq 1 -and $writers[0].CreationDate -eq $baseDate.AddSeconds(1)) 'Old identity reused'}
if($Case -eq 'reappears-writer'){Check ($writers.Count -eq 1 -and $writers[0].CreationDate -eq $baseDate.AddSeconds(2)) 'Reappearing writer ignored'}
if($Case -in @('access-denied','cim-error','similar-notfound','wrong-category','empty-probe','cim-timeout','cim-partial-error')){Check ($script:calls -eq 1 -and $script:waitMs -eq 0) 'Access/query failure was retried'}
if($Case -in @('alive-unknown','date-missing','secret','omitted-alive','another-unknown','third-unknown','logging-fails-unknown')){Check ($script:calls -eq 3) 'Unresolved identity was not bounded'}
if($Case -in @('alive-unknown','date-missing','secret')){Check ($caught.Exception.Message -match 'pid=111') 'Missing PID diagnostic';Check ($caught.Exception.Message -match 'missingFields=') 'Missing field diagnostic'}
if($Case -eq 'resolved-last-unknown'){Check ($caught.Exception.Message -match 'pid=111;' -and $caught.Exception.Message -notmatch 'pid=222;') 'Error reports a resolved PID'}
if($Case -eq 'always-disappears'){Check ($caught.Exception.Message -match 'result=final-inventory-incomplete' -and $script:calls -eq 3) 'Final incomplete inventory mislabeled as live unresolved PID'}
$diag=Get-Variable CfsWriterInventoryDiagnostics -Scope Script -ErrorAction SilentlyContinue
$all=($script:logs -join "`n")+$(if($caught){$caught.Exception.Message})+$(if($diag){$diag.Value|ConvertTo-Json -Depth 6})
Check (-not $all.Contains('SECRET_VALUE')) 'Diagnostic exposed raw command line'
if($Case -in @('recovers','disappears','pid-reused','logging-fails')){Check ($null -ne $diag -and @($diag.Value).Count -gt 0) 'No observation evidence retained'}
@{case=$Case;pass=$true;queries=$script:calls;waitMs=$script:waitMs;probes=$script:probes;error=$(if($caught){$caught.Exception.Message});diagnostics=$(if($diag){$diag.Value})}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $EvidenceRoot 'result.json') -Encoding UTF8
'PASS '+$Case
