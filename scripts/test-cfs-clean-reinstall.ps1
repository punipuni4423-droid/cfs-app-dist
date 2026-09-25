param([Parameter(Mandatory=$true)][string]$ScratchDirectory)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null; $errors=$null
$file=Join-Path $PSScriptRoot 'clean-reinstall-cfs-app.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Reinstall parser error'}
$definitions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
foreach($definition in $definitions){Invoke-Expression $definition.Extent.Text}
$source=Get-Content -LiteralPath $file -Raw
$main=$source.Substring($source.IndexOf('if (-not (Test-Path -LiteralPath (Join-Path $appRootFull "LAUNCH_CFS_APP.cmd")'))
$scratch=[IO.Path]::GetFullPath($ScratchDirectory)
$old=Join-Path $scratch (([char]0x65e7)+' CFS App')
$appRootFull=Join-Path $scratch (([char]0x65b0)+' CFS App')
$prefix=Join-Path $scratch (([char]0x65e7)+' CFS App2')
foreach($root in @($old,$appRootFull,$prefix)){
 $null=New-Item -ItemType Directory -Path $root -Force
 [IO.File]::WriteAllText((Join-Path $root 'LAUNCH_CFS_APP.cmd'),'@echo off')
}
$OldAppRoot=$old; $NoShortcut=$true; $SkipProcessStop=$false; $SkipOldFolderPrompt=$true; $NoStart=$false
$stamp='test'; $logPath=Join-Path $scratch 'mock.log'
$env:PORT='3088';$env:CFS_AUTH_REDIRECT_PORT='3091'
$script:passes=0
function Check([string]$Name,[scriptblock]$Body){ & $Body; $script:passes++; Write-Output ('PASS '+$Name) }
function Assert([bool]$Condition,[string]$Message='Assertion failed'){if(-not $Condition){throw $Message}}
function Refuses([scriptblock]$Body){$failed=$false;try{&$Body|Out-Null}catch{$failed=$true};Assert $failed 'Expected refusal'}
function Proc([string]$Name,[string]$Command,[int]$Id=70001){return [pscustomobject]@{Name=$Name;CommandLine=$Command;ProcessId=$Id;CreationDate=[datetime]'2026-09-24T00:00:00Z'}}
function Match($Process){return Test-CfsOldRootProcess -Process $Process -Roots @($old)}
Check 'runtime and standalone: exact old root' {
 foreach($script in @('runtime\server.js','.next\standalone\server.js')){Assert (Match (Proc node.exe ('node.exe "'+(Join-Path $old $script)+'"')))}
}
Check 'prefix and new root excluded' {
 foreach($root in @($prefix,$appRootFull,'C:\dev\AI\CFS\cfs-app-verify','C:\dev\AI\CFS\.update-qa\fixture')){Assert (-not(Match (Proc node.exe ('node.exe "'+$root+'\runtime\server.js"'))))}
}
Check 'shared executable path does not establish ownership' { Assert (-not(Match (Proc node.exe ('"'+$old+'-tools\node.exe" "'+$prefix+'\runtime\server.js"')))) }
Check 'cmd quoted launchers including cmd /s outer quote' {
 Assert (Match (Proc cmd.exe ('cmd.exe /d /s /c ""'+$old+'\START_CFS_APP.bat""')))
 Assert (Match (Proc cmd.exe ('cmd.exe /c "'+$old+'\LAUNCH_CFS_APP.cmd"')))
}
Check 'PowerShell explicit File launcher' {Assert (Match (Proc powershell.exe ('powershell.exe -NoProfile -File "'+$old+'\START_CFS_APP.cmd"')))}
Check 'relative server argv refused' {Refuses {Match (Proc node.exe 'node.exe runtime\server.js')}}
Check 'unknown argv ignored; attributed missing creation time refused' {
 Assert (-not (Match (Proc node.exe '')))
 $p=Proc node.exe ('node.exe "'+$old+'\runtime\server.js"');$p.CreationDate=$null;Refuses {Match $p}
}
Check 'complex command and decoy path refused' {
 Refuses {Match (Proc cmd.exe ('cmd.exe /c echo "'+$old+'\START_CFS_APP.bat"'))}
 Refuses {Match (Proc node.exe ('node.exe --eval "console.log('''+$old+'\runtime\server.js'')"'))}
}
Check 'NoShortcut can resolve no old root for first-install validation' {$save=$OldAppRoot;$OldAppRoot='';try{Assert (@(Resolve-CfsOldRoots).Count -eq 0)}finally{$OldAppRoot=$save}}
Check 'helper direct argv exact old root only' {
 Assert (Match (Proc node.exe ('node.exe "'+$old+'\scripts\auth-redirect-helper.mjs" --port 3091')))
 Assert (-not (Match (Proc node.exe ('node.exe "'+$prefix+'\scripts\auth-redirect-helper.mjs" --port 3092'))))
 Refuses {Match (Proc node.exe 'node.exe scripts\auth-redirect-helper.mjs')}
}
Check 'exact helper cmd wrapper accepted; chained command refused' {
 $wrapper='cmd.exe /d /s /c "node.exe "'+$old+'\scripts\auth-redirect-helper.mjs" --port 3091 --target-file "'+$old+'\artifacts\startup\auth-redirect-target.json" --target "http://localhost:3088" >> "'+$old+'\artifacts\startup\auth-redirect-helper.log" 2>&1"'
 Assert (Match (Proc cmd.exe $wrapper))
 Refuses {Match (Proc cmd.exe ($wrapper+' & echo unsafe'))}
}
Check 'shortcut target establishes root without guessing from working directory' {
 Assert ((Get-CfsShortcutAppRoot ([pscustomobject]@{TargetPath=(Join-Path $old 'LAUNCH_CFS_APP.cmd');WorkingDirectory=$old})) -eq $old)
 Refuses {Get-CfsShortcutAppRoot ([pscustomobject]@{TargetPath=(Join-Path $prefix 'LAUNCH_CFS_APP.cmd');WorkingDirectory=$old})}
 Refuses {Get-CfsShortcutAppRoot ([pscustomobject]@{TargetPath='C:\Windows\System32\cmd.exe';WorkingDirectory=$old})}
}
Check 'explicit OldAppRoot normalizes trailing slash' {$save=$OldAppRoot;$OldAppRoot=$old+'\';try{Assert (@(Resolve-CfsOldRoots)[0] -eq $old) 'Single root resolution failed'}finally{$OldAppRoot=$save}}
Check 'current and related roots refused' {
 foreach($bad in @($appRootFull,$scratch)){$save=$OldAppRoot;$OldAppRoot=$bad;try{Refuses {Resolve-CfsOldRoots}}finally{$OldAppRoot=$save}}
}
Check 'protected .update-qa refused' {
 $qa=Join-Path $scratch '.update-qa\old';$null=New-Item -ItemType Directory -Path $qa -Force
 [IO.File]::WriteAllText((Join-Path $qa 'LAUNCH_CFS_APP.cmd'),'@echo off')
 $save=$OldAppRoot;$OldAppRoot=$qa;try{Refuses {Resolve-CfsOldRoots}}finally{$OldAppRoot=$save}
}
Check 'reparse ancestor refused' {
 $junction=Join-Path $scratch 'junction';$null=New-Item -ItemType Junction -Path $junction -Target $old
 Refuses {Resolve-CfsReinstallRoot $junction}
 # Remove the junction entry only; never recurse through its target.
 [IO.Directory]::Delete($junction)
 Assert (Test-Path -LiteralPath (Join-Path $old 'LAUNCH_CFS_APP.cmd'))
}

# Replace only OS boundaries for deterministic failure/race tests.
function Reset-Mocks {
 $script:inventory=@(Proc node.exe ('node.exe "'+$old+'\runtime\server.js"'))
 $script:stops=0;$script:starts=0;$script:renames=0;$script:cimCalls=0
 $script:race='';$script:stopFails=$false;$script:waitFails=$false;$script:portStuck=$false;$script:queryFails=$false
 $script:noListener=$false;$script:listenerOwner=70001
}
function Get-CimInstance {
 param($ClassName,$Filter,$ErrorAction)
 if($script:queryFails){throw 'Synthetic CIM failure'}
 if(-not $Filter){return $script:inventory}
 $script:cimCalls++
 $p=$script:inventory|Select-Object -First 1
 if($script:race -eq 'pid' -and $script:cimCalls -eq 2){$p=$p.PSObject.Copy();$p.CreationDate=$p.CreationDate.AddSeconds(1)}
 if($script:race -eq 'argv' -and $script:cimCalls -eq 2){$p=$p.PSObject.Copy();$p.CommandLine+=' --changed'}
 return $p
}
function Get-Process {
 param($Id,$ErrorAction)
 $p=[pscustomobject]@{Handle=1;StartTime=$script:inventory[0].CreationDate;HasExited=$false}
 $p|Add-Member ScriptMethod WaitForExit {param($timeout) return -not $script:waitFails}
 $p|Add-Member ScriptMethod Dispose {}
 return $p
}
function Stop-Process {param($InputObject,[switch]$Force,$ErrorAction) if($script:stopFails){throw 'Synthetic stop failure'};$script:stops++;$script:inventory=@()}
function Get-NetTCPConnection {param($ErrorAction) if(-not $script:noListener -and ($script:stops -eq 0 -or $script:portStuck)){return [pscustomobject]@{State='Listen';LocalPort=3088;OwningProcess=$script:listenerOwner}}}
function Start-Process {param($FilePath,$WorkingDirectory,$WindowStyle) $script:starts++}
function Rename-OldFolder {param($OldPath) $script:renames++}
function Create-CfsShortcut {}
Check 'held identity success stops one and frees port' {Reset-Mocks;Stop-OldCfsRootProcesses @($old);Assert ($script:stops -eq 1)}
foreach($raceMode in @('pid','argv')){Check ('identity change '+$raceMode+' stops none') {Reset-Mocks;$script:race=$raceMode;Refuses {Stop-OldCfsRootProcesses @($old)};Assert ($script:stops -eq 0)}}
Check 'stop failure aborts launch and rename' {Reset-Mocks;$script:stopFails=$true;Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0 -and $script:renames -eq 0)}
Check 'wait timeout aborts launch and rename' {Reset-Mocks;$script:waitFails=$true;Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0 -and $script:renames -eq 0)}
Check 'occupied port aborts launch' {Reset-Mocks;$script:portStuck=$true;Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0)}
Check 'CIM failure never means no processes' {Reset-Mocks;$script:queryFails=$true;Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0)}
Check 'SkipProcessStop refuses running app' {Reset-Mocks;$SkipProcessStop=$true;try{Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0 -and $script:stops -eq 0)}finally{$SkipProcessStop=$false}}
Check 'successful flow starts exactly once after stop' {Reset-Mocks;Invoke-Expression $main;Assert ($script:starts -eq 1 -and $script:stops -eq 1)}
Check 'unknown root aborts with no launch' {Reset-Mocks;$save=$OldAppRoot;$OldAppRoot='';try{Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0 -and $script:stops -eq 0)}finally{$OldAppRoot=$save}}
Check 'unknown argv unrelated to target port is ignored' {
 Reset-Mocks;$script:inventory+=Proc cmd.exe '' 70002
 Stop-OldCfsRootProcesses @($old);Assert ($script:stops -eq 1)
}
Check 'unknown argv owning target port refuses before stopping anything' {
 Reset-Mocks;$script:inventory+=Proc cmd.exe '' 70002;$script:listenerOwner=70002
 Refuses {Invoke-Expression $main};Assert ($script:stops -eq 0 -and $script:starts -eq 0)
 Assert ((Get-Content -LiteralPath $logPath -Raw) -match 'Target port 3088 has an unknown process owner')
}
Check 'missing CIM listener owner refuses' {
 Reset-Mocks;$script:listenerOwner=79999;Refuses {Stop-OldCfsRootProcesses @($old)};Assert ($script:stops -eq 0)
}
Check 'first install empty port and no CFS starts without stop' {
 Reset-Mocks;$script:inventory=@(Proc powershell.exe '' 70002);$script:noListener=$true
 $save=$OldAppRoot;$OldAppRoot=''
 try{Invoke-Expression $main;Assert ($script:starts -eq 1 -and $script:stops -eq 0)}finally{$OldAppRoot=$save}
}
Check 'first install empty port but other helper refuses with guidance' {
 Reset-Mocks;$script:inventory=@(Proc node.exe ('node.exe "'+$prefix+'\scripts\auth-redirect-helper.mjs"'));$script:noListener=$true
 $save=$OldAppRoot;$OldAppRoot=''
 try{Refuses {Invoke-Expression $main};Assert ($script:starts -eq 0);Assert ((Get-Content -LiteralPath $logPath -Raw) -match 'Specify -OldAppRoot')}finally{$OldAppRoot=$save}
}
Check 'first install may retain new-root helper on another port' {
 Reset-Mocks;$script:inventory=@(Proc node.exe ('node.exe "'+$appRootFull+'\scripts\auth-redirect-helper.mjs"'));$script:noListener=$true
 $save=$OldAppRoot;$OldAppRoot=''
 try{Invoke-Expression $main;Assert ($script:starts -eq 1 -and $script:stops -eq 0)}finally{$OldAppRoot=$save}
}
Check 'shortcut root is resolved before stop' {
 Reset-Mocks;$save=$OldAppRoot;$OldAppRoot='';$NoShortcut=$false
 function Get-CfsShortcutRoots {Assert ($script:stops -eq 0);return $old}
 try{Invoke-Expression $main;Assert ($script:starts -eq 1 -and $script:stops -eq 1)}finally{$OldAppRoot=$save;$NoShortcut=$true}
}
Write-Output ("PASS: $script:passes clean-reinstall checks; mocked OS boundaries only")
