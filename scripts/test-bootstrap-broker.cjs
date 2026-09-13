const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const Module = require('node:module');
const source = path.resolve(__dirname, '..');
const helperPath = path.join(source, 'app/lib/appUpdateLaunch.ts');
const loaded = new Module(helperPath, module);
loaded.filename = helperPath; loaded.paths = module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, helperPath);
const helper = loaded.exports;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function options(dir, attemptId) { return { appDir: dir, port: '3096', hostName: '127.0.0.1', expectedHead: 'a'.repeat(40), startedAt: new Date().toISOString(), attemptId, repairBuild: true }; }
async function launch(dir, attemptId) { return helper.startBootstrap(helper.buildBootstrapInvocation(options(dir, attemptId)), dir, attemptId); }
if (process.argv[2] === '--parent') {
  const [dir, attemptId] = process.argv.slice(3);
  launch(dir, attemptId).then(ack => { fs.writeFileSync(path.join(dir, 'parent-ack.json'), JSON.stringify({ ack, at: new Date().toISOString() })); });
  setTimeout(() => process.exit(2), 30000);
} else (async () => {
  const root = fs.mkdtempSync(path.join(source, 'artifacts', 'bootstrap-broker-test-'));
  const results = [];
  const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
  function fixture(name, config) {
    const dir = path.join(root, name); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(config));
    const body = `param([string]$AppDir,[int]$Port,[string]$HostName,[string]$ExpectedHead,[string]$StartedAt,[string]$AttemptId,[switch]$RepairBuild,[switch]$ApiHandshake)
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')+';'+[IO.Path]::Combine($env:SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')
$cfg=[IO.File]::ReadAllText([IO.Path]::Combine($AppDir,'fixture.json'))|ConvertFrom-Json
if($cfg.state -eq 'throw'){throw 'Inert fixture startup failure'}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${psQuote(path.join(source, 'scripts/cfs-update-bootstrap.ps1'))},[ref]$tokens,[ref]$parseErrors)
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Send-BootstrapAck'},$true)
Invoke-Expression $fn.Extent.Text
$script:acknowledged=$false
$lock=[IO.File]::Open([IO.Path]::Combine($AppDir,'held.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
 if($cfg.state -eq 'none'){exit 0}
 if($cfg.state -eq 'partial'){
  $ack=[IO.Path]::Combine($AppDir,'artifacts/self-update/launch-acks/'+$AttemptId+'/ack.jsonl')
  [IO.File]::WriteAllText($ack,'');Start-Sleep -Milliseconds 150
  [IO.File]::WriteAllText($ack,'CFS_UPDATE_ACK:{');Start-Sleep -Milliseconds 150
  [IO.File]::WriteAllText($ack,'CFS_UPDATE_ACK:{"state":"started","message":"Recovered partial read."}'+[Environment]::NewLine)
  exit 0
 }
 Send-BootstrapAck $cfg.state 'Dedicated fixture acknowledgement.'
 if($cfg.killParent){
  Start-Sleep -Milliseconds 400
  $identity=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cfg.parentId)
  if(-not $identity -or $identity.Name -ne 'node.exe' -or $identity.CommandLine -notlike ('*test-bootstrap-broker.cjs*--parent*'+$AttemptId+'*')){throw 'Dedicated parent identity mismatch'}
  $owned=Get-Process -Id $cfg.parentId;$null=$owned.Handle
  $again=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cfg.parentId)
  if($again.CreationDate -ne $identity.CreationDate -or $again.CommandLine -cne $identity.CommandLine){throw 'Dedicated PID changed'}
  Stop-Process -InputObject $owned -Force
 }
 [IO.File]::WriteAllText([IO.Path]::Combine($AppDir,'after-ack.json'),(@{pid=$PID;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json))
 Start-Sleep -Milliseconds $cfg.holdMs
 [IO.File]::WriteAllText([IO.Path]::Combine($AppDir,'terminal.json'),'completed')
}finally{$lock.Dispose()}
exit 0
`;
    fs.writeFileSync(path.join(dir, 'scripts/cfs-update-bootstrap.ps1'), body);
    return dir;
  }
  for (const state of ['started', 'busy', 'failed', 'throw']) {
    const dir = fixture(`${state}-日本語 space's (folder) & value`, { state, holdMs: 3000, killParent: false });
    const start = Date.now(), ack = await launch(dir, crypto.randomUUID());
    assert.equal(ack.state, state === 'throw' ? 'failed' : state);
    if (state !== 'throw') assert(!fs.existsSync(path.join(dir, 'terminal.json')), 'ACK must precede worker completion');
    results.push({ name: state, elapsedMs: Date.now() - start, ack });
    await sleep(3200);
  }
  const unknownDir = fixture('unknown', { state: 'none', holdMs: 0, killParent: false });
  const partialDir = fixture('partial-read', { state: 'partial', holdMs: 0, killParent: false });
  assert.equal((await launch(partialDir, crypto.randomUUID())).state, 'started');
  results.push({ name: 'zero-byte and partial ACK reads wait for complete valid record' });
  const unrelated = path.join(unknownDir, 'artifacts/self-update/launch-acks', crypto.randomUUID());
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'ack.jsonl'), 'CFS_UPDATE_ACK:{"state":"started","message":"Previous attempt"}\n');
  const started = Date.now(), unknown = await launch(unknownDir, crypto.randomUUID());
  assert.equal(unknown.state, 'unknown'); assert(Date.now() - started >= 19500);
  results.push({ name: 'missing ACK and unrelated attempt remain unknown', elapsedMs: Date.now() - started });
  const collisionDir = fixture('collision', { state: 'started' }), id = crypto.randomUUID();
  await helper.reserveBootstrapAcknowledgement(collisionDir, id);
  await assert.rejects(() => helper.reserveBootstrapAcknowledgement(collisionDir, id), /EEXIST/);
  const linked = path.join(root, 'reparse'); fs.mkdirSync(linked);
  fs.symlinkSync(path.join(collisionDir, 'artifacts'), path.join(linked, 'artifacts'), 'junction');
  await assert.rejects(() => helper.reserveBootstrapAcknowledgement(linked, crypto.randomUUID()), /plain directory/);
  results.push({ name: 'reservation collision and reparse rejected' });
  const attemptId = crypto.randomUUID();
  const dir = fixture('parent-stop-日本語 space', { state: 'started', holdMs: 4000, killParent: true, parentId: 0 });
  const parent = spawn(process.execPath, [__filename, '--parent', dir, attemptId], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ state: 'started', holdMs: 4000, killParent: true, parentId: parent.pid }));
  await new Promise(resolve => parent.once('exit', resolve));
  await sleep(300);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'parent-ack.json'))).ack.state, 'started');
  assert(fs.existsSync(path.join(dir, 'after-ack.json')));
  assert.throws(() => fs.openSync(path.join(dir, 'held.lock'), 'r+'), /EBUSY|EACCES/);
  await sleep(4500);
  assert.equal(fs.readFileSync(path.join(dir, 'terminal.json'), 'utf8'), 'completed');
  results.push({ name: 'actual generated broker args ACK precedes parent death and worker lock survives to terminal', dir, parentPid: parent.pid });
  const report = { root, productSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex'), productWorkerBuildVerified: false, passed: results.length, results };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
