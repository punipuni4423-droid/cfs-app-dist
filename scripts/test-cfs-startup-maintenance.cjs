const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const evidence = process.env.CFS_RESILIENCE_TEST_DIR || path.join(require('node:os').tmpdir(), 'cfs-startup-tests');
fs.mkdirSync(evidence, { recursive: true });
const work = fs.mkdtempSync(path.join(evidence, 'startup-'));
const app = path.join(work, 'CFS 起動 space');
const product = path.resolve(__dirname, '..');
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const copy = (name) => { const to = path.join(app, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(product, name), to); };
for (const name of ['START_CFS_APP.bat', 'scripts/cfs-update-maintenance.ps1', 'scripts/test-cfs-instance.ps1', 'scripts/start-cfs-background-server.ps1', 'scripts/cfs-access.mjs', 'app/lib/apiAuthCore.mjs']) copy(name);
fs.mkdirSync(path.join(app, 'runtime'));
fs.writeFileSync(path.join(app, 'runtime/server.js'), `const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');
(async()=>{const auth=await import(pathToFileURL(path.join(process.env.CFS_APP_DIR,'app/lib/apiAuthCore.mjs')));const keys=await auth.readAuthKeys();fs.writeFileSync(path.join(process.env.CFS_APP_DIR,'synthetic-server.pid'),String(process.pid));
http.createServer((req,res)=>{if(req.url.startsWith('/api/')&&!auth.readSession(req.headers['x-cfs-access-token'],keys)){res.writeHead(401);return res.end();}if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<html>synthetic startup fixture</html>');}res.setHeader('content-type','application/json');setTimeout(()=>res.end(JSON.stringify({appDir:process.env.CFS_APP_DIR})),1000);}).listen(Number(process.env.PORT),'127.0.0.1');})();`);
function psRun(args) { return cp.spawnSync(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args], { windowsHide:true, encoding:'utf8', timeout:15000 }); }
const helper = path.join(app, 'scripts/cfs-update-maintenance.ps1');
const pause = (ms) => new Promise(r => setTimeout(r,ms));
(async()=>{
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,PORT:String(port),CFS_AUTH_REDIRECT_PORT:String(port),CFS_LOCALHOST_ONLY:'1',CFS_OPEN_BROWSER:'0'};
  delete env.CFS_AUTH_DIR;delete env.CFS_LOG_DIR;delete env.CFS_ALLOW_PORT_FALLBACK;
  const command='""'+path.join(app,'START_CFS_APP.bat')+'" --worker --no-browser"';
  const child=cp.spawn(process.env.ComSpec,['/d','/s','/c',command],{env,windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const done=new Promise(r=>child.once('exit',r));
  try{
    const lock=path.join(app,'.cfs-updater/maintenance.lock');const deadline=Date.now()+15000;
    while(!fs.existsSync(lock)&&Date.now()<deadline&&child.exitCode===null)await pause(30);
    assert(fs.existsSync(lock),'Startup did not acquire maintenance lock: '+output);
    assert.equal(psRun(['-File',helper,'-AppRoot',app,'-Check']).status,1,'Startup lock must remain held until ready');
    const exit=await Promise.race([done,pause(60000).then(()=>{throw Error('Startup timed out');})]);
    assert.equal(exit,0,'Real START failed: '+output);
    const status=fs.readFileSync(path.join(app,'artifacts/startup/latest-status.txt'),'utf8');
    assert(status.includes('CFS is ready at http://localhost:'+port));
    assert.equal(psRun(['-File',helper,'-AppRoot',app,'-Check']).status,0,'Startup must release lock after ready');
    const bypass=cp.spawnSync(process.env.ComSpec,['/d','/s','/c','""'+path.join(app,'START_CFS_APP.bat')+'" --locked-worker --no-browser"'],{env,windowsHide:true,windowsVerbatimArguments:true,encoding:'utf8',timeout:15000});
    assert.notEqual(bypass.status,0,'An arbitrary caller must not bypass the startup lock');
    const startedPid=Number(fs.readFileSync(path.join(app,'synthetic-server.pid'),'utf8'));process.kill(startedPid);await pause(500);
    const gitArgs=[['init','-b','master',app],['-C',app,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','synthetic installed version']];
    for(const args of gitArgs){const result=cp.spawnSync('git.exe',args,{env,windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
    fs.mkdirSync(path.join(app,'artifacts/self-update'),{recursive:true});
    fs.writeFileSync(path.join(app,'artifacts/self-update/status.json'),JSON.stringify({state:'failed',currentStep:'build'}));
    fs.writeFileSync(path.join(app,'runtime/.cfs-build-info.json'),JSON.stringify({gitSha:'b'.repeat(40)}));
    fs.unlinkSync(path.join(app,'synthetic-server.pid'));
    const refused=cp.spawnSync(process.env.ComSpec,['/d','/s','/c',command],{env,windowsHide:true,windowsVerbatimArguments:true,encoding:'utf8',timeout:20000});
    assert.equal(refused.status,1,'START must refuse an old bundled runtime after failed update');
    assert(fs.readFileSync(path.join(app,'artifacts/startup/latest-status.txt'),'utf8').includes('UPDATE_CFS_APP.cmd'));
    assert(!fs.existsSync(path.join(app,'synthetic-server.pid')),'Old runtime started after rejection');
    const result={pass:true,app,port,realStartBatch:true,syntheticAuthenticatedRuntime:true,lockHeldUntilReady:true,lockReleased:true,forgedInternalModeRejected:true};
    result.failedUpdateOldRuntimeRefused=true;
    fs.writeFileSync(path.join(evidence,'startup-maintenance-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{
    if(child.exitCode===null)child.kill();
    const pidfile=path.join(app,'synthetic-server.pid');
    if(fs.existsSync(pidfile)){const pid=Number(fs.readFileSync(pidfile,'utf8'));try{process.kill(pid);}catch{}}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
