const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=process.argv[2];assert(root&&path.isAbsolute(root));fs.mkdirSync(root,{recursive:false});
const cases=['complete','recovers','recovers-third','date-recovers','multiple','disappears','reappears-writer','pid-reused','alive-unknown','omitted-alive','another-unknown','third-unknown','date-missing','secret','access-denied','similar-notfound','wrong-category','cim-error','cim-error-second','cim-timeout','cim-partial-error','logging-fails','logging-fails-unknown','catch-complete','catch-unknown','catch-data-writer','catch-listener','start-complete','start-unknown','start-late-unknown','start-data-writer','start-listener'];
const engines=[path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),process.env.CFS_TEST_PWSH];assert(engines.every(p=>p&&fs.existsSync(p)));
cases.push('empty-probe');
cases.push('resolved-last-unknown','always-disappears');
const selected=process.argv[3]?cases.filter(name=>process.argv[3].split(',').includes(name)):cases;
assert(selected.length>0);
const results=[];
for(let i=0;i<engines.length;i++)for(const name of selected){
 const folder=path.join(root,`ps${i===0?5:7}-${name}`);fs.mkdirSync(folder);
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'test-writer-inventory.ps1'),'-Case',name,'-EvidenceRoot',folder];
 const r=cp.spawnSync(engines[i],args,{windowsHide:true,timeout:20000,encoding:'utf8'});
 fs.writeFileSync(path.join(folder,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(folder,'stderr.log'),r.stderr||'');
 const expected=name.startsWith('catch-')?1:0;let pass=r.status===expected;
 if(name.startsWith('catch-')){
  try{const s=JSON.parse(fs.readFileSync(path.join(folder,'status.json'),'utf8').replace(/^\uFEFF/,''));pass&&=s.state==='failed'&&s.failure.message==='original failure'&&fs.existsSync(path.join(folder,'started.marker'))===(name==='catch-complete');}catch{pass=false;}
 }
 results.push({case:name,engine:engines[i],args,exitCode:r.status,signal:r.signal,error:r.error?.message??null,expectedExit:expected,pass});
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2)+'\n');
 console.log(`${pass?'PASS':'FAIL'} ps${i===0?5:7} ${name}`);
}
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,total:results.length,evidence:root}));
process.exitCode=results.every(r=>r.pass)?0:1;
