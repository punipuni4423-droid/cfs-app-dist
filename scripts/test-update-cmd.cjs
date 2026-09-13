const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const source = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(source, 'artifacts', 'update-cmd-test-'));
const original = fs.readFileSync(path.join(source, 'UPDATE_CFS_APP.cmd'));
assert([...original].every(byte => byte < 128), 'CMD must remain ASCII to avoid code-page parsing corruption');
const cases = [];
for (const ending of ['LF', 'CRLF']) {
  for (const suffix of ['ascii', "日本語 space's (folder) & value"]) {
    const dir = path.join(root, `${ending}-${suffix}`);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    const bytes = Buffer.from(original.toString('ascii').replace(/\r?\n/g, ending === 'LF' ? '\n' : '\r\n'));
    fs.writeFileSync(path.join(dir, 'UPDATE_CFS_APP.cmd'), bytes);
    // The real CMD runs unchanged except Git-style line endings; only its target is inert.
    fs.writeFileSync(path.join(dir, 'scripts', 'cfs-update-bootstrap.ps1'), "param([string]$AppDir,[int]$Port,[switch]$RepairBuild)\n[IO.File]::WriteAllText([IO.Path]::Combine($AppDir,'reached.json'),(@{port=$Port;repair=[bool]$RepairBuild;appDir=$AppDir}|ConvertTo-Json))\nexit 0\n");
    const result = spawnSync(process.env.ComSpec, ['/d', '/c', 'UPDATE_CFS_APP.cmd'], { cwd: dir, env: { ...process.env, PORT: '3096' }, input: '\r\n', windowsHide: true, timeout: 15000 });
    fs.writeFileSync(path.join(dir, 'stdout.bin'), result.stdout || Buffer.alloc(0));
    fs.writeFileSync(path.join(dir, 'stderr.bin'), result.stderr || Buffer.alloc(0));
    assert.equal(result.status, 0, `CMD failed: ${dir}`);
    assert.equal(result.stderr.length, 0, `CMD parsing error: ${dir}`);
    const reached = JSON.parse(fs.readFileSync(path.join(dir, 'reached.json'), 'utf8'));
    assert.equal(path.resolve(reached.appDir).toLowerCase(), dir.toLowerCase());
    assert.equal(reached.port, 3096);
    assert.equal(reached.repair, true);
    cases.push({ ending, path: dir, exitCode: result.status, stderrBytes: result.stderr.length, entrySha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
const report = { root, sourceSha256: createHash('sha256').update(original).digest('hex'), productBootstrapVerified: false, passed: cases.length, cases };
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
