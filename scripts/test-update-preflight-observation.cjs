// Actual worker, synthetic helper fault only. No real app/DB or process enumeration.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('assert/strict');
const root=fs.mkdtempSync(path.join(process.env.CFS_PREFLIGHT_TEST_DIR||os.tmpdir(),'cfs-preflight-observation-'));
const app=path.join(root,'app');fs.mkdirSync(path.join(app,'scripts'),{recursive:true});
for(const file of JSON.parse(fs.readFileSync(path.join(__dirname,'cfs-update-contract.json'),'utf8')).files)fs.copyFileSync(path.join(__dirname,'..',file),path.join(app,file));
fs.appendFileSync(path.join(app,'scripts/cfs-update-maintenance.ps1'),`
function Assert-CfsNoLegacyUpdateWorker {
 param([string]$Root)
 $directory=Join-Path $Root 'artifacts/self-update/observability/preflight-fixture'
 $health=Get-Content -LiteralPath (Join-Path $directory 'health.json') -Raw|ConvertFrom-Json
 if($health.operation -ne 'legacy-worker-check' -or $health.state -ne 'running' -or -not (Test-Path (Join-Path $directory 'monitor.json'))){throw 'preflight_observation_missing'}
 [IO.File]::WriteAllText((Join-Path $Root 'preflight-seen.json'),($health|ConvertTo-Json -Depth 6))
 throw [System.ComponentModel.Win32Exception]::new(5,'SYNTHETIC_PREFLIGHT_FAILURE')
}
`);
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const result=cp.spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(app,'scripts/update-cfs-app.ps1'),'-AppDir',app,'-Port','43998','-AttemptId','preflight-fixture'],{windowsHide:true,encoding:'utf8',timeout:20000});
fs.writeFileSync(path.join(root,'stdout.log'),result.stdout||'');fs.writeFileSync(path.join(root,'stderr.log'),result.stderr||'');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const directory=path.join(app,'artifacts/self-update/observability/preflight-fixture');
try{
 assert.equal(result.status,1,result.stderr);
 assert.equal(read(path.join(app,'preflight-seen.json')).state,'running');
 assert.equal(read(path.join(app,'artifacts/self-update/status.json')).state,'failed');
 const health=read(path.join(directory,'health.json'));assert.equal(health.state,'failed');assert.equal(health.operation,'legacy-worker-check');
 assert(health.safeFailures.some(x=>x.source==='worker'&&x.win32Code===5&&x.exceptionType==='System.ComponentModel.Win32Exception'));
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({pass:true,workerExit:result.status,observationBeforePreflight:true,terminalFailed:true,safeCause:true},null,2));
 console.log(JSON.stringify({pass:true,root}));
}finally{
 const receipt=read(path.join(directory,'monitor.json'));
 const command=`$p=Get-Process -Id ${receipt.pid} -ErrorAction SilentlyContinue;if($p){$null=$p.Handle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne '${receipt.startTicks}'){throw 'Identity mismatch'};for($i=0;$i -lt 60 -and $p.MainWindowHandle -eq [IntPtr]::Zero;$i++){Start-Sleep -Milliseconds 100;$p.Refresh()};if(-not $p.CloseMainWindow() -or -not $p.WaitForExit(5000)){throw 'Normal monitor close failed'}}`;
 const close=cp.spawnSync(ps,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(close.status,0,close.stderr);
}
