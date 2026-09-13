const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
assert.equal(process.platform, 'win32');
const root = fs.mkdtempSync(path.join(process.env.CFS_STATUS_TEST_DIR || os.tmpdir(), 'cfs-status-atomic-'));
const source = path.join(__dirname, 'update-cfs-app.ps1');
const ps5 = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps7 = process.env.CFS_TEST_PWSH || path.join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe');
assert(fs.existsSync(ps7), 'Set CFS_TEST_PWSH to PowerShell 7.');
const quote = (s) => `'${s.replace(/'/g, "''")}'`;
const parse = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function child(executable, body) {
  const process = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  const done = new Promise((resolve) => process.once('exit', resolve));
  return { process, done };
}
const load = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$tokens,[ref]$errors); $f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-UpdateStatus'},$true)[0]; Invoke-Expression $f.Extent.Text; $logPath='synthetic';$script:StoppedAppWriters=$true; $AttemptId='';$TargetCommit='';$ExpectedHead='';$ConsoleProgress=$false; $script:StartedAt='2026-01-01T00:00:00Z';`;
async function run(executable, name) {
  const folder = path.join(root, name + " 日本語 space's");
  fs.mkdirSync(folder);
  const status = path.join(folder, 'status.json');
  const resultFile = path.join(folder, 'result.json');
  // No status exists initially: the first publication must use Move.
  let reads = 0, partial = 0, unavailable = 0, pending = false;
  const readErrorCodes = {};
  const poll = setInterval(async () => {
    if (pending) return;
    pending = true;
    try {
      const raw = await fs.promises.readFile(status, 'utf8');
      reads++;
      try { JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { partial++; }
    } catch (error) { unavailable++; readErrorCodes[error.code] = (readErrorCodes[error.code] || 0) + 1; } finally { pending = false; }
  }, 1);
  const body = load + `$statusPath=${quote(status)}; $failures=0; for($i=0;$i -lt 600;$i++){try{Write-UpdateStatus -State running -Step test -Message '進捗を確認中' -Progress 40}catch{$failures++}}; Write-UpdateStatus -State completed -Step done -Message '更新完了' -Progress 100; @{writes=601; failures=$failures}|ConvertTo-Json|Set-Content -LiteralPath ${quote(resultFile)} -Encoding UTF8`;
  const writer = child(executable, body);
  assert.equal(await writer.done, 0);
  clearInterval(poll);
  while (pending) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(parse(resultFile).failures, 0);
  assert.equal(partial, 0);
  assert(reads > 0);
  const completed = parse(status);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.progress, 100);
  assert.equal(completed.message, '更新完了');
  assert.equal(completed.startedAt, '2026-01-01T00:00:00Z');
  assert(completed.finishedAt);
  const original = fs.readFileSync(status);
  const holdReady = path.join(folder, 'locked');
  const holder = child(executable, `$f=[IO.File]::Open(${quote(status)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try{[IO.File]::WriteAllText(${quote(holdReady)},'ready'); Start-Sleep -Seconds 30}finally{$f.Dispose()}`);
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(holdReady) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert(fs.existsSync(holdReady));
    const fault = child(executable, load + `$statusPath=${quote(status)}; $timer=[Diagnostics.Stopwatch]::StartNew(); $failed=$false; try{Write-UpdateStatus -State running -Step test -Message 'must not publish' -Progress 40}catch{$failed=$true}; @{failed=$failed; elapsedMs=$timer.ElapsedMilliseconds}|ConvertTo-Json|Set-Content -LiteralPath ${quote(resultFile)} -Encoding UTF8`);
    assert.equal(await fault.done, 0);
    const bounded = parse(resultFile);
    assert.equal(bounded.failed, true);
    assert(bounded.elapsedMs < 5000, 'Sharing failure did not return within the bounded retry period.');
    assert.deepEqual(fs.readFileSync(status), original);
  } finally { holder.process.kill(); await holder.done; }
  // A missing parent is a persistent write failure, with no publication retry.
  const invalid = child(executable, load + `$statusPath=${quote(path.join(folder, 'missing/status.json'))}; $timer=[Diagnostics.Stopwatch]::StartNew(); $failed=$false; try{Write-UpdateStatus -State running -Step test -Message 'must not publish'}catch{$failed=$true}; @{failed=$failed; elapsedMs=$timer.ElapsedMilliseconds}|ConvertTo-Json|Set-Content -LiteralPath ${quote(resultFile)} -Encoding UTF8`);
  assert.equal(await invalid.done, 0);
  const immediate = parse(resultFile);
  assert.equal(immediate.failed, true);
  assert(immediate.elapsedMs < 900);
  assert.equal(fs.readdirSync(folder).filter((file) => file.endsWith('.tmp')).length, 0);
  // Exercise the actual outer catch with a permanently locked status file.
  // Only listener/restart and logging are test doubles; no real app is stopped.
  for (const listenerExists of [false, true]) {
    const marker = path.join(folder, `restart-${listenerExists}.txt`);
    const diagnostic = path.join(folder, `recovery-${listenerExists}.log`);
    const recoveryBody = load + `$statusPath=${quote(status)}; $backupPath=''; $Port=43999; function Write-Log([string]$Message){[IO.File]::AppendAllText(${quote(diagnostic)},$Message+[Environment]::NewLine)}; function Get-CfsPortListeners{param($Port) ${listenerExists ? '123' : ''}}; function Start-CfsAppServer{[IO.File]::WriteAllText(${quote(marker)},'recovery reached')}; $outerTry=$ast.Find({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $n.CatchClauses.Count -gt 0 -and $n.CatchClauses[0].Body.Extent.Text.Contains('$updateFailureMessage =')},$true); $catchText=$outerTry.CatchClauses[0].Body.Extent.Text; $lock=[IO.File]::Open($statusPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); Invoke-Expression ("try { throw 'synthetic original failure' } catch " + $catchText)`;
    const recovery = child(executable, recoveryBody);
    assert.equal(await recovery.done, 1, 'Original failure must remain exit 1.');
    assert.equal(fs.existsSync(marker), !listenerExists, 'Recovery must run only when no listener remains.');
    const diagnosticText = fs.readFileSync(diagnostic, 'utf8');
    assert(diagnosticText.includes('FAILED: synthetic original failure'));
    assert(diagnosticText.includes('Could not publish failed update status; continuing app recovery.'));
    assert.deepEqual(fs.readFileSync(status), original);
    assert.equal(fs.readdirSync(folder).filter((file) => file.endsWith('.tmp')).length, 0);
  }
  return { name, writes: 601, writeFailures: 0, reads, partialJson: partial, temporaryReadUnavailable: unavailable, readErrorCodes, finalState: completed.state, boundedLockFailure: true, persistentFailure: true, temporaryFiles: 0, recoveryOnStatusFailure: true, existingListenerNotDuplicated: true, originalFailureExit: 1 };
}
(async () => {
  const results = [await run(ps5, 'ps5'), await run(ps7, 'ps7')];
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ root, results }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
