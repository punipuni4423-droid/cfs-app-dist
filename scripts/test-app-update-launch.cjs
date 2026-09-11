const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const Module = require('node:module');

const source = path.resolve(__dirname, '../app/lib/appUpdateLaunch.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = module.paths;
loaded._compile(compiled, source);
const { buildUpdateLaunchCommand, windowsPowerShellExecutable } = loaded.exports;

async function runCase(folder, body, expected) {
  fs.mkdirSync(folder, { recursive: true });
  const scriptPath = path.join(folder, 'worker.ps1');
  const statusFile = path.join(folder, 'status.json');
  if (body !== null) fs.writeFileSync(scriptPath, body, 'utf8');
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'running', currentStep: 'queued' }));
  const startedAt = new Date().toISOString();
  const command = buildUpdateLaunchCommand({ appDir: folder, scriptPath, statusFile, port: '3999', hostName: '127.0.0.1', startedAt });
  const result = spawnSync(windowsPowerShellExecutable(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const deadline = Date.now() + 15000;
  let status;
  while (Date.now() < deadline) {
    try {
      status = JSON.parse(fs.readFileSync(statusFile, 'utf8').replace(/^\uFEFF/, ''));
      if (status.currentStep !== 'queued') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.state, expected);
  if (expected === 'completed') {
    assert.equal(status.appDir, folder);
    assert.equal(status.port, 3999);
    assert.equal(status.hostName, '127.0.0.1');
  } else {
    assert.equal(status.currentStep, 'launch');
    assert.equal(status.startedAt, startedAt);
    assert(!JSON.stringify(status).includes('private-test-value'));
  }
}

(async () => {
  assert.equal(process.platform, 'win32', 'These are real Windows PowerShell process tests.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-update-launch-'));
  const body = `param([string]$AppDir, [int]$Port, [string]$HostName)
@{state='completed'; currentStep='done'; appDir=$AppDir; port=$Port; hostName=$HostName} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $AppDir 'status.json') -Encoding UTF8`;
  await runCase(path.join(root, 'plain'), body, 'completed');
  await runCase(path.join(root, "日本語 space's (folder) & value"), body, 'completed');
  await runCase(path.join(root, 'failure folder'), "throw 'private-test-value'", 'failed');
  await runCase(path.join(root, 'parse failure'), 'param([broken syntax)', 'failed');
  await runCase(path.join(root, 'missing worker'), null, 'failed');
  console.log('PASS: 5 actual Windows updater launch checks. Synthetic fixtures:', root);
})().catch((error) => { console.error(error); process.exitCode = 1; });
