const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scratch = process.env.CFS_INSTANCE_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-instance-utf8-'));
const appRoot = path.join(scratch, 'CFS 検証 フォルダ');
fs.mkdirSync(path.join(appRoot, 'scripts'), { recursive: true });
// Synthetic authentication CLI only. Never read production auth files/tokens.
fs.writeFileSync(path.join(appRoot, 'scripts/cfs-access.mjs'), "process.stdout.write('synthetic-instance-check');\n");

function runShell(executable, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/test-cfs-instance.ps1'), '-Port', String(port), '-AppRoot', appRoot], {
      windowsHide: true,
      env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Synthetic readiness test timed out.')); }, 45000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

(async () => {
  assert.equal(process.platform, 'win32');
  let mode = 'no-charset';
  let authenticated = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<html><body>synthetic</body></html>'); }
    if (req.headers['x-cfs-access-token'] !== 'synthetic-instance-check') { res.statusCode = 401; return res.end('{}'); }
    authenticated++;
    if (req.url === '/api/sharing/config') { res.setHeader('content-type', 'application/json'); return res.end('{}'); }
    if (req.url === '/api/app-update/status?fetchRemote=0') {
      res.setHeader('content-type', mode === 'charset' ? 'application/json; charset=utf-8' : 'application/json');
      if (mode === 'unauthorized' || mode === 'forbidden') { res.statusCode = mode === 'unauthorized' ? 401 : 403; return res.end('{}'); }
      if (mode === 'invalid-utf8') return res.end(Buffer.from([0x7b, 0xff, 0x7d]));
      if (mode === 'invalid-json') return res.end('{invalid JSON');
      if (mode === 'missing-path') return res.end('{}');
      const json = JSON.stringify({ appDir: mode === 'different-path' ? appRoot + ' 別' : appRoot });
      return res.end(Buffer.from((mode === 'bom' ? '\uFEFF' : '') + json, 'utf8'));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const shells = [
    { name: 'Windows PowerShell 5.1', executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') },
    { name: 'PowerShell 7', executable: process.env.CFS_TEST_PWSH || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell/7/pwsh.exe') },
  ];
  const results = [];
  try {
    for (const shell of shells) {
      assert(fs.existsSync(shell.executable), `${shell.name} required for this compatibility test`);
      for (const scenario of ['no-charset', 'charset', 'bom', 'different-path', 'unauthorized', 'forbidden', 'invalid-utf8', 'invalid-json', 'missing-path']) {
        mode = scenario;
        const before = authenticated;
        const actual = await runShell(shell.executable, port);
        const expected = ['no-charset', 'charset', 'bom'].includes(scenario) ? 0 : 1;
        assert.equal(actual.code, expected, `${shell.name}: ${scenario}`);
        assert.equal(actual.stdout, '', 'Readiness must not print authentication material.');
        assert.equal(actual.stderr, '', 'Readiness must not print authentication material.');
        assert.equal(authenticated - before, 2, 'Both protected endpoints must use the supplied auth header.');
        results.push({ shell: shell.name, scenario, exit: actual.code, expected, pass: true });
      }
    }
    fs.writeFileSync(path.join(scratch, 'result.json'), JSON.stringify({ results, realDataAccess: false, realAuthAccess: false }, null, 2));
    console.log(`PASS: ${results.length} actual HTTP readiness checks on Windows PowerShell 5.1 and PowerShell 7. Evidence: ${scratch}`);
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
