const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const original=process.argv[2];assert(original&&path.isAbsolute(original),'Supply the preserved first-shipped bootstrap v1 path.');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(fs.readFileSync(original)),'721eb58dce3e8cb64d7107eb64df037d1e16ce5e266acd132b79891d39e86eae');
const root=fs.mkdtempSync(path.join(process.env.CFS_V1_TEST_DIR||os.tmpdir(),'cfs-v1-observation-')),repo=path.join(root,'repo'),stage=path.join(root,'stage');fs.mkdirSync(path.join(repo,'scripts'),{recursive:true});
const env={...process.env,GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
function git(args){const r=cp.spawnSync('git.exe',['-C',repo,...args],{env,windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const contract=JSON.parse(fs.readFileSync(path.join(__dirname,'cfs-update-contract.json'),'utf8'));
for(const file of [...contract.files,'scripts/cfs-update-contract.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(repo,file));
git(['init']);git(['add','.']);git(['-c','user.name=Synthetic test','-c','user.email=test@example.invalid','commit','-m','Synthetic v1 payload']);const commit=git(['rev-parse','HEAD']);
const q=s=>"'"+s.replaceAll("'","''")+"'";
const script=`$ErrorActionPreference='Stop';$ast=[Management.Automation.Language.Parser]::ParseFile(${q(original)},[ref]$null,[ref]$null);foreach($name in @('ConvertTo-BootstrapArgument','Invoke-BootstrapGit','Get-BootstrapSnapshot')){$f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f.Extent.Text};$entry=Get-BootstrapSnapshot (Get-Command git.exe).Source ${q(repo)} ${q(stage)} ${q(commit)};. (Join-Path (Split-Path $entry) 'cfs-update-process-runner.ps1');. (Join-Path (Split-Path $entry) 'cfs-update-observability.ps1');if([CfsUpdate.NativeJob]::AwakeMs() -lt 0){throw 'clock unavailable'};Write-Host 'v1 payload loaded'`;
fs.writeFileSync(path.join(root,'run.ps1'),script);
const r=cp.spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'run.ps1')],{env,windowsHide:true,encoding:'utf8',timeout:30000});
fs.writeFileSync(path.join(root,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(root,'stderr.log'),r.stderr||'');assert.equal(r.status,0,r.stderr);
for(const file of contract.files)assert.equal(sha(fs.readFileSync(path.join(stage,file))),sha(fs.readFileSync(path.join(repo,file))));
const result={pass:true,bootstrapSha:sha(fs.readFileSync(original)),commit,files:contract.files,stage,exit:r.status};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({pass:true,root,files:contract.files.length}));
