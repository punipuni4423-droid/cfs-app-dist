// Real PowerShell functions/catch, isolated files, and harmless native commands.
// Listener/restart probes are doubles: this suite never starts or stops an app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
assert.equal(process.platform, 'win32');
const root = fs.mkdtempSync(path.join(process.env.CFS_LOG_TEST_DIR || os.tmpdir(), 'cfs-log-resilience-'));
const source = path.resolve(process.env.CFS_LOG_TEST_SOURCE || path.join(__dirname, 'update-cfs-app.ps1'));
const engines = [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), process.env.CFS_TEST_PWSH || path.join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe')];
const quote = (s) => `'${s.replace(/'/g, "''")}'`;
const results = [];
function execute(engine, name, body, expectedExit = 0) {
  const folder = path.join(root, path.basename(engine) + '-' + name + " 日本語 space's");
  fs.mkdirSync(folder);
  const setup = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
    [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$OutputEncoding=[Console]::OutputEncoding;$ProgressPreference='SilentlyContinue';
    . ${quote(path.join(path.dirname(source), 'cfs-update-process-runner.ps1'))};
    . ${quote(path.join(path.dirname(source), 'cfs-update-observability.ps1'))};
    $tokens=$null;$errors=$null;
    $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$tokens,[ref]$errors);
    if($errors.Count){throw 'Worker parse failed'}
    foreach($name in @('Write-Log','Write-UpdateStatus','Invoke-LoggedCommand','Invoke-NpmDependencyInstall')){
      $f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      Invoke-Expression $f.Extent.Text
    }
    $folder=${quote(folder)};$logPath=Join-Path $folder 'update.log';$statusPath=Join-Path $folder 'status.json';
    $backupPath='synthetic-backup';$AttemptId='synthetic-attempt';$TargetCommit=('a'*40);$ExpectedHead=('b'*40);
    $ConsoleProgress=$false;$script:StartedAt='2026-01-01T00:00:00Z';$script:StoppedAppWriters=$true;$Port=43999;
    [IO.File]::WriteAllText($logPath,'original'+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)));
    function Assert-Test($ok,$message){if(-not $ok){throw $message}}
    function Read-Status{Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8|ConvertFrom-Json}
    function Get-CfsPortListeners{param($Port)}
    function Start-CfsAppServer{[IO.File]::WriteAllText((Join-Path $folder 'restart.txt'),'recovery reached')}
  `;
  const started = Date.now();
  const run = spawnSync(engine, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(setup + body, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  fs.writeFileSync(path.join(folder, 'stdout.txt'), run.stdout || '');
  fs.writeFileSync(path.join(folder, 'stderr.txt'), run.stderr || '');
  const result = { name, engine, exit: run.status, expectedExit, elapsedMs: Date.now() - started, error: run.error?.message };
  results.push(result);
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ source, results }, null, 2));
  assert.equal(run.status, expectedExit, `${name}: ${run.stderr}; evidence=${folder}`);
  return folder;
}
const catchBody = `$outerTry=$ast.Find({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $n.CatchClauses.Count -gt 0 -and $n.CatchClauses[0].Body.Extent.Text.Contains('$updateFailureMessage =')},$true);
  Invoke-Expression ("try { throw 'original build failure' } catch " + $outerTry.CatchClauses[0].Body.Extent.Text);`;
try {
  for (const engine of engines) {
    assert(fs.existsSync(engine), `Missing PowerShell engine: ${engine}`);
    execute(engine, 'normal-and-write-sharing', `
      Write-Log 'first 日本語';
      $reader=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Write);
      try {Write-Log 'second 日本語'} finally {$reader.Dispose()}
      $text=[IO.File]::ReadAllText($logPath);
      Assert-Test ($text.Contains('original') -and $text.Contains('first 日本語') -and $text.Contains('second 日本語')) 'Compatible reader must not break append logging';
    `);
    for (const access of ['Write', 'ReadWrite']) {
      execute(engine, 'append-with-' + access, `
        $other=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::${access},[IO.FileShare]::${access});
        try {Write-Log 'append completed'} finally {$other.Dispose()}
        Assert-Test ([IO.File]::ReadAllText($logPath).Contains('append completed')) 'Write-only/shared handles must not cause a stream-read error';
      `);
    }
    execute(engine, 'read-only-log', `
      [IO.File]::SetAttributes($logPath,[IO.FileAttributes]::ReadOnly);
      try {Write-Log 'not writable';Write-UpdateStatus -State completed -Step done -Message 'complete'} finally {[IO.File]::SetAttributes($logPath,[IO.FileAttributes]::Normal)}
      $status=Read-Status;Assert-Test ($status.state -eq 'completed' -and $status.logWarning) 'Access denial must not stop the update';
    `);
    execute(engine, 'locked-log-command-success', `
      $command=Join-Path $folder 'success.cmd';[IO.File]::WriteAllText($command,"@echo off\r\necho command-ran> marker.txt\r\necho output\r\nexit /b 0\r\n");
      $reader=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
      try {Invoke-LoggedCommand -FilePath $command -Arguments @() -WorkingDirectory $folder;Write-UpdateStatus -State completed -Step done -Message 'complete'} finally {$reader.Dispose()}
      Assert-Test (Test-Path -LiteralPath (Join-Path $folder 'marker.txt')) 'Logging must not stop the native command';
      $status=Read-Status;Assert-Test ($status.state -eq 'completed' -and $status.logWarning) 'Log loss must be recorded without changing command success';
    `);
    execute(engine, 'locked-log-command-failure', `
      $command=Join-Path $folder 'failure.cmd';[IO.File]::WriteAllText($command,"@echo off\r\necho output\r\nexit /b 37\r\n");
      $reader=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
      $message='';try {Invoke-LoggedCommand -FilePath $command -Arguments @() -WorkingDirectory $folder} catch {$message=$_.Exception.Message} finally {$reader.Dispose()}
      Assert-Test ($message -match 'exited with code 37') 'Logging must preserve the actual command failure';
    `);
    for (const ciFails of [false, true]) {
      execute(engine, 'npm-fallback-' + ciFails, `
        $command=Join-Path $folder 'npm.cmd';
        [IO.File]::WriteAllText($command,${quote('@echo off\r\necho %1>> npm-calls.txt\r\n' + (ciFails ? 'if "%1"=="ci" exit /b 37\r\n' : '') + 'echo output\r\nexit /b 0\r\n')});
        $env:PATH=$folder+';'+$env:PATH;
        $reader=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
        try {Invoke-NpmDependencyInstall -WorkingDirectory $folder} finally {$reader.Dispose()}
        $calls=@(Get-Content -LiteralPath (Join-Path $folder 'npm-calls.txt'));
        Assert-Test (($calls -join ',') -eq '${ciFails ? 'ci,install' : 'ci'}') 'Only actual npm ci failure may cause fallback';
      `);
    }
    for (const lockStatus of [false, true]) {
      const folder = execute(engine, 'catch-locked-log-status-' + lockStatus, `
        Write-UpdateStatus -State running -Step build -Message 'original state';
        $reader=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
        ${lockStatus ? '$statusReader=[IO.File]::Open($statusPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);' : ''}
        ${catchBody}
      `, 1);
      assert(fs.existsSync(path.join(folder, 'restart.txt')), 'Actual worker catch must reach the safe recovery probe despite logging/status faults');
      const status = JSON.parse(fs.readFileSync(path.join(folder, 'status.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(status.state, lockStatus ? 'running' : 'failed');
      if (!lockStatus) {
        assert.equal(status.message, 'original build failure');
        assert(status.logWarning);
        assert.equal(status.backupPath, 'synthetic-backup');
        assert.equal(status.failure.message, 'original build failure');
        assert(status.failure.exceptionType);
        assert.equal(typeof status.failure.hResult, 'number');
        assert(status.failure.scriptStackTrace);
      }
    }
    for (const mode of ['existing-listener', 'writers-not-stopped', 'restart-refused']) {
      const folder = execute(engine, mode, `
        ${mode === 'existing-listener' ? 'function Get-CfsPortListeners{param($Port) 123}' : ''}
        ${mode === 'writers-not-stopped' ? '$script:StoppedAppWriters=$false;' : ''}
        ${mode === 'restart-refused' ? "function Start-CfsAppServer{throw 'No verified updated build is available'}" : ''}
        $reader=[IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
        ${catchBody}
      `, 1);
      assert(!fs.existsSync(path.join(folder, 'restart.txt')), 'Recovery must not bypass listener/writer/build protections');
      const status = JSON.parse(fs.readFileSync(path.join(folder, 'status.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(status.state, 'failed');
      assert.equal(status.message, 'original build failure');
    }
    execute(engine, 'persistent-log-failure-bounded', `
      $logPath=Join-Path $folder 'missing\\update.log';$timer=[Diagnostics.Stopwatch]::StartNew();
      for($i=0;$i -lt 100;$i++){Write-Log ('line '+$i)}
      Assert-Test ($timer.ElapsedMilliseconds -lt 2000) 'Diagnostic failure must not introduce long retry delays';
      Write-UpdateStatus -State completed -Step done -Message 'complete';
      $status=Read-Status;Assert-Test ($status.state -eq 'completed' -and $status.logWarning) 'Persistent log loss must be visible in status';
      $logPath=Join-Path $folder 'update.log';Write-Log 'logging resumed';
      Assert-Test ([IO.File]::ReadAllText($logPath).Contains('logging resumed')) 'Logging must resume after a transient fault';
      Write-UpdateStatus -State completed -Step done -Message 'complete';
      Assert-Test ([bool](Read-Status).logWarning) 'Earlier lost log entries must remain disclosed';
    `);
  }
  console.log(JSON.stringify({ pass: true, root, cases: results.length }));
} catch (error) {
  console.error(error);
  console.error(`Evidence: ${root}`);
  process.exitCode = 1;
}
