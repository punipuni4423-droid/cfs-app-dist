const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');

assert.equal(process.platform, 'win32', 'Real Windows PowerShell and Git are required.');
const root = fs.mkdtempSync(path.join(process.env.CFS_NATIVE_TEST_DIR || os.tmpdir(), 'cfs-native-utf8-'));
const ps5 = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps7 = process.env.CFS_TEST_PWSH || path.join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe');
assert(fs.existsSync(ps7), 'Set CFS_TEST_PWSH to the installed PowerShell 7 executable.');
const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
const quote = (value) => `'${value.replace(/'/g, "''")}'`;
function git(...args) {
  const result = spawnSync('git.exe', args, { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'Synthetic Git command failed: ' + result.stderr);
  return result.stdout.trim();
}
function powershell(executable, body) {
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, 'Synthetic PowerShell test failed: ' + result.stderr);
}
const helperPath = path.resolve(__dirname, '../app/lib/appUpdateLaunch.ts');
const helper = new Module(helperPath, module);
helper.filename = helperPath;
helper.paths = module.paths;
helper._compile(ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, helperPath);

const remote = path.join(root, 'remote.git');
const author = path.join(root, 'author');
git('init', '--bare', '--initial-branch=master', remote);
git('clone', remote, author);
fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify({ name: 'synthetic-cfs-update-fixture', private: true, scripts: { build: 'node -e "process.exit(73)"' } }));
fs.writeFileSync(path.join(author, '.gitignore'), 'artifacts/\ndata/\n.cfs-build-info.json\n.cfs-updater/\nnode_modules/\n.next/\n');
fs.writeFileSync(path.join(author, 'README.md'), 'Synthetic baseline\n');
fs.mkdirSync(path.join(author, 'scripts'));
for (const file of ['update-cfs-app.ps1', 'cfs-local-data-preservation.ps1', 'cfs-update-maintenance.ps1', 'test-cfs-instance.ps1']) fs.copyFileSync(path.join(__dirname, file), path.join(author, 'scripts', file));
git('-C', author, 'add', '.');
git('-C', author, '-c', 'user.name=CFS Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Synthetic baseline');
git('-C', author, 'push', 'origin', 'master');
const before = git('-C', author, 'rev-parse', 'HEAD');
const cases = [];
for (const [name, executable, detached] of [['ps5', ps5, false], ['ps7', ps7, false], ['ps5-detached', ps5, true]]) {
  for (const codePage of [932, 65001]) {
    const folder = path.join(root, `${name}-${codePage} 改善 space's (folder) & value`);
    git('clone', remote, folder);
    fs.mkdirSync(path.join(folder, 'data'));
    fs.mkdirSync(path.join(folder, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'node_modules/.bin/next.cmd'), 'rem Synthetic dependency marker; no dependency download\n');
    fs.writeFileSync(path.join(folder, 'data', 'synthetic-marker.json'), '{"synthetic":"preserve-original-bytes"}\n');
    fs.writeFileSync(path.join(folder, '.cfs-build-info.json'), JSON.stringify({ gitSha: before }));
    cases.push({ name, executable, detached, codePage, folder });
  }
}
// Reproduce the old native-output boundary without executing an old updater.
const redPath = path.join(root, 'red.json');
powershell(ps5, `[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(932); $root=& git.exe -C ${quote(cases[0].folder)} rev-parse --show-toplevel; $first=$LASTEXITCODE; $null=& git.exe -C $root rev-parse HEAD 2>$null; @{first=$first; second=$LASTEXITCODE; pathMatches=($root -eq ${quote(cases[0].folder.replace(/\\/g, '/'))})}|ConvertTo-Json|Set-Content -LiteralPath ${quote(redPath)} -Encoding UTF8`);
const red = JSON.parse(fs.readFileSync(redPath, 'utf8').replace(/^\uFEFF/, ''));
assert.deepEqual(red, { first: 0, second: 128, pathMatches: false });
fs.writeFileSync(path.join(author, 'README.md'), 'Synthetic docs update\n');
git('-C', author, 'add', 'README.md');
git('-C', author, '-c', 'user.name=CFS Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Synthetic docs update');
git('-C', author, 'push', 'origin', 'master');
const after = git('-C', author, 'rev-parse', 'HEAD');

(async () => {
  const results = [];
  for (const test of cases) {
    const worker = path.join(test.folder, 'scripts/update-cfs-app.ps1');
    const wrapper = path.join(root, `${test.name}-${test.codePage}.ps1`);
    // The prelude runs inside the worker process, including detached launches.
    fs.writeFileSync(wrapper, `\uFEFFparam([string]$AppDir,[int]$Port,[string]$HostName)\n[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(${test.codePage})\n& ${quote(worker)} -AppDir $AppDir -Port $Port -HostName $HostName\n`, 'utf8');
    const statusPath = path.join(test.folder, 'artifacts/self-update/status.json');
    if (test.detached) {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      const command = helper.exports.buildUpdateLaunchCommand({ appDir: test.folder, scriptPath: wrapper, statusFile: statusPath, port: '43999', hostName: '127.0.0.1', startedAt: new Date().toISOString() });
      const launch = spawnSync(ps5, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(launch.status, 0, launch.stderr);
    } else powershell(test.executable, `& ${quote(wrapper)} -AppDir ${quote(test.folder)} -Port 43999 -HostName '127.0.0.1'`);
    let status;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, '')); } catch {}
      if (['completed', 'failed'].includes(status?.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status?.state, 'failed', `Worker did not reach the deliberate build failure: ${test.name}/${test.codePage}`);
    assert.match(status.message, /npm.cmd exited with code 73/);
    assert.equal(git('-C', test.folder, 'rev-parse', 'HEAD'), after);
    assert.equal(git('-C', test.folder, 'rev-parse', '@{u}'), after);
    assert.equal(git('-C', test.folder, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(JSON.parse(fs.readFileSync(path.join(test.folder, '.cfs-build-info.json'), 'utf8').replace(/^\uFEFF/, '')).gitSha, before, 'Failed build must not be stamped as current');
    assert.equal(fs.readFileSync(path.join(test.folder, 'data/synthetic-marker.json'), 'utf8'), '{"synthetic":"preserve-original-bytes"}\n');
    results.push({ name: test.name, initialCodePage: test.codePage, state: status.state, shaMatches: true, markerPreserved: true });
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ red, before, after, results }, null, 2));
  console.log(`PASS: old CP932 boundary rejected; ${results.length} real workers applied the target then reported the deliberate build failure without losing data or stamping success (PS5/PS7, detached, CP932/UTF8). Fixtures: ${root}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
