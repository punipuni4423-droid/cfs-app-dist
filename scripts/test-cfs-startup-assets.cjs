const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const evidence = process.env.CFS_STARTUP_ASSET_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-startup-assets-'));
fs.mkdirSync(evidence, { recursive: true });
const app = fs.mkdtempSync(path.join(evidence, 'synthetic-'));
fs.mkdirSync(path.join(app, 'scripts'));
fs.writeFileSync(path.join(app, 'scripts/cfs-access.mjs'), "process.stdout.write('synthetic-assets-token');");
const shells = [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), process.env.CFS_TEST_PWSH || path.join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe')];
// Restrict regression work to readiness when the sync helper has not changed.
const httpOnly = process.argv.includes('--http-only');
let callIndex = 0;
function run(shell, script, args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', script), ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const timer = setTimeout(() => { child.kill(); reject(Error('Test timeout')); }, 25000);
    child.once('error', reject); child.once('exit', code => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(evidence, 'call-' + (++callIndex) + '.json'), JSON.stringify({ shell, script, code, stdout, stderr }, null, 2));
      resolve({ code, stdout, stderr });
    });
  });
}
(async () => {
  const results = [];
  for (const shell of httpOnly ? [] : shells) {
    assert(fs.existsSync(shell));
    const fixture = fs.mkdtempSync(path.join(evidence, 'sync-'));
    const source = path.join(fixture, '.next/static/chunks');
    const target = path.join(fixture, '.next/standalone/.next/static');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.join(fixture, '.next/standalone'), { recursive: true });
    fs.writeFileSync(path.join(fixture, '.next/standalone/server.js'), '// synthetic');
    fs.writeFileSync(path.join(source, 'app.js'), 'one');
    const invoke = () => run(shell, 'sync-cfs-startup-static.ps1', ['-AppRoot', fixture]);
    for (const scenario of ['copy', 'repeat', 'missing-source', 'target-file', 'target-junction', 'source-junction']) {
      let expected = 0;
      if (scenario === 'missing-source') { fs.renameSync(path.join(source, 'app.js'), path.join(fixture, 'held.js')); expected = 1; }
      if (scenario === 'target-file') { fs.renameSync(target, target + '-held'); fs.writeFileSync(target, 'block'); expected = 1; }
      if (scenario === 'target-junction' || scenario === 'source-junction') {
        const outside = fs.mkdtempSync(path.join(evidence, 'outside-')); fs.writeFileSync(path.join(outside, 'marker'), 'unchanged');
        fs.symlinkSync(outside, path.join(scenario === 'target-junction' ? target : source, 'link'), 'junction'); expected = 1;
      }
      const actual = await invoke(); assert.equal(actual.code, expected, shell + ': ' + scenario);
      if (!expected) assert.equal(fs.readFileSync(path.join(target, 'chunks/app.js'), 'utf8'), 'one');
      results.push({ shell, scenario, exit: actual.code, expected });
      if (scenario === 'missing-source') fs.renameSync(path.join(fixture, 'held.js'), path.join(source, 'app.js'));
      if (scenario === 'target-file') { fs.unlinkSync(target); fs.renameSync(target + '-held', target); }
      if (scenario === 'target-junction' || scenario === 'source-junction') fs.rmdirSync(path.join(scenario === 'target-junction' ? target : source, 'link'));
    }
    for (const scenario of ['hardlink-protected', 'hardlink-source', 'hardlink-extra']) {
      const fixture = fs.mkdtempSync(path.join(evidence, 'alias-'));
      const source = path.join(fixture, '.next/static'); const target = path.join(fixture, '.next/standalone/.next/static');
      fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(fixture, '.next/standalone/server.js'), '// synthetic');
      fs.writeFileSync(path.join(source, 'a.js'), 'new first'); fs.writeFileSync(path.join(target, 'a.js'), 'old first');
      const protectedDir = fs.mkdtempSync(path.join(evidence, 'protected-')); const marker = path.join(protectedDir, 'marker');
      fs.writeFileSync(marker, 'protected original');
      const from = path.join(source, 'z.js'); fs.writeFileSync(from, 'new last');
      const link = path.join(target, scenario === 'hardlink-extra' ? 'extra.js' : 'z.js');
      fs.linkSync(scenario === 'hardlink-source' ? from : marker, link);
      assert.equal(fs.statSync(link).nlink, 2, 'Actual NTFS hardlink fixture required');
      const beforeMarker = fs.readFileSync(marker); const beforeLink = fs.readFileSync(link);
      const actual = await run(shell, 'sync-cfs-startup-static.ps1', ['-AppRoot', fixture]);
      assert.equal(actual.code, 1, scenario); assert.deepEqual(fs.readFileSync(marker), beforeMarker);
      assert.deepEqual(fs.readFileSync(link), beforeLink); assert.equal(fs.readFileSync(path.join(target, 'a.js'), 'utf8'), 'old first');
      results.push({ shell, scenario, exit: actual.code, expected: 1, protectedUnchanged: true, earlierTargetUnchanged: true, fixture });
    }
    // A later destination that cannot be opened must reject before updating a.js.
    const locked = fs.mkdtempSync(path.join(evidence, 'locked-'));
    const lockedSource = path.join(locked, '.next/static'); const lockedTarget = path.join(locked, '.next/standalone/.next/static');
    fs.mkdirSync(lockedSource, { recursive: true }); fs.mkdirSync(lockedTarget, { recursive: true });
    fs.writeFileSync(path.join(locked, '.next/standalone/server.js'), '// synthetic');
    for (const name of ['a.js', 'z.js']) { fs.writeFileSync(path.join(lockedSource, name), 'new'); fs.writeFileSync(path.join(lockedTarget, name), 'old'); }
    const holderScript = path.join(locked, 'hold.ps1'); const ready = path.join(locked, 'ready');
    fs.writeFileSync(holderScript, 'param($Target,$Ready)\n$s=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{[IO.File]::WriteAllText($Ready,"ready");[Console]::ReadLine()|Out-Null}finally{$s.Dispose()}');
    const holder = cp.spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', holderScript, '-Target', path.join(lockedTarget, 'z.js'), '-Ready', ready], { windowsHide: true });
    const holderExit = new Promise(resolve => holder.once('exit', resolve));
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(ready) && Date.now() < deadline && holder.exitCode === null) await new Promise(r => setTimeout(r, 20));
      assert(fs.existsSync(ready), 'Exclusive test holder did not become ready');
      const actual = await run(shell, 'sync-cfs-startup-static.ps1', ['-AppRoot', locked]); assert.equal(actual.code, 1);
      assert.equal(fs.readFileSync(path.join(lockedTarget, 'a.js'), 'utf8'), 'old');
      results.push({ shell, scenario: 'later-target-unknown-locked', exit: actual.code, expected: 1, earlierTargetUnchanged: true, fixture: locked });
    } finally {
      holder.stdin.end('\n');
      const released = await Promise.race([holderExit, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
      if (released === 'timeout' && holder.exitCode === null) holder.kill();
      assert.equal(released, 0, 'Test holder must release naturally within its deadline');
    }
    assert.equal(fs.readFileSync(path.join(lockedTarget, 'z.js'), 'utf8'), 'old');
  }
  let mode = 'ok'; let externalHits = 0; let assetHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      const src = mode === 'external' ? 'http://127.0.0.1:' + server.address().port + '/_next/static/app.js' : '/_next/static/app.js';
      return res.end(mode === 'no-assets' ? '<html>empty</html>' : '<html><script src="' + src + '"></script><link href="/_next/static/app.css" rel="stylesheet"></html>');
    }
    if (req.url.startsWith('/_next/')) {
      assetHits++; if (req.headers.host.startsWith('127.0.0.1')) externalHits++;
      if (mode === '404') { res.statusCode = 404; return res.end('missing'); }
      if (mode === 'redirect') { res.statusCode = 302; res.setHeader('location', '/'); return res.end(); }
      res.setHeader('content-type', mode === 'html-fallback' ? 'text/html' : req.url.endsWith('.css') ? 'text/css' : 'application/javascript; charset=utf-8');
      let body = mode === 'empty' ? '' : 'synthetic';
      const isJS = req.url.endsWith('.js');
      if ((mode === 'html-js-mime' && isJS) || (mode === 'html-css-mime' && !isJS)) body = '<html><body>Error</body></html>';
      if (mode === 'html-bom') body = '\uFEFF\r\n  <!DOCTYPE html><html>Error</html>';
      if (mode === 'html-space-bom') body = ' \t\uFEFF  <html>Error</html>';
      if (mode === 'html-comment') body = '<!-- cached --> \uFEFF\r\n<HTML>Error</HTML>';
      if (mode === 'html-upper') body = '<HTML>Error</HTML>';
      if (mode === 'whitespace') body = ' \t\r\n';
      if (mode === 'bom-whitespace') body = ' \uFEFF \t\r\n';
      if (mode === 'normal-html-string') body = isJS ? "const template = '<html><body>text</body></html>';" : ".note::before { content: '<html>'; }";
      const fragment = mode.match(/^fragment-(form|h1|title)-(js|css)$/);
      if (fragment && (fragment[2] === 'js') === isJS) body = {
        form: '<form action="/login"><input name="user"></form>',
        h1: '<h1>Login</h1>',
        title: '<title>Sign in</title>',
      }[fragment[1]];
      if (mode === 'fragment-bom') body = '\uFEFF \r\n<form>Sign in</form>';
      if (mode === 'fragment-comment') body = '<!-- cached --> \uFEFF <h1>Sign in</h1>';
      if (mode === 'fragment-custom') body = '<my-login>Sign in</my-login>';
      if (mode === 'fragment-closing') body = '</form>';
      if (mode === 'fragment-unclosed-comment') body = '<!-- login';
      if (mode === 'normal-string-expression') body = isJS ? "'<form>text</form>';" : '[data-note="<h1>"] { color: red; }';
      if (mode === 'normal-template') body = isJS ? '`<title>text</title>`;' : ':root { --message: "<form>"; }';
      if (mode === 'normal-leading-comment') body = isJS ? "/* <form> */ const x = 1;" : '/* <title> */ .normal { color: red; }';
      if (mode === 'normal-html-comment') body = isJS ? "<!-- generated -->\nconst text = '<form>';" : "<!-- -->\n.normal { content: '<form>'; }";
      return res.end(body);
    }
    assert.equal(req.headers['x-cfs-access-token'], 'synthetic-assets-token');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ appDir: app }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;
  try {
    for (const shell of shells) for (const scenario of ['ok', '404', 'html-fallback', 'empty', 'redirect', 'external', 'no-assets', 'legacy-no-assets', 'html-js-mime', 'html-css-mime', 'html-bom', 'html-space-bom', 'html-comment', 'html-upper', 'whitespace', 'bom-whitespace', 'normal-html-string', 'fragment-form-js', 'fragment-form-css', 'fragment-h1-js', 'fragment-h1-css', 'fragment-title-js', 'fragment-title-css', 'fragment-bom', 'fragment-comment', 'fragment-custom', 'fragment-closing', 'fragment-unclosed-comment', 'normal-string-expression', 'normal-template', 'normal-leading-comment', 'normal-html-comment']) {
      mode = scenario === 'legacy-no-assets' ? 'no-assets' : scenario;
      const args = ['-Port', String(server.address().port), '-AppRoot', app];
      if (scenario !== 'legacy-no-assets') args.push('-CheckStaticAssets');
      const actual = await run(shell, 'test-cfs-instance.ps1', args);
      const expected = ['ok', 'legacy-no-assets', 'normal-html-string', 'normal-string-expression', 'normal-template', 'normal-leading-comment', 'normal-html-comment'].includes(scenario) ? 0 : 1;
      assert.equal(actual.code, expected, shell + ': ' + scenario); assert.equal(actual.stdout, ''); assert.equal(actual.stderr, '');
      results.push({ shell, scenario, exit: actual.code, expected });
    }
    assert.equal(externalHits, 0, 'Foreign origin assets must not be fetched'); assert(assetHits > 0);
  } finally { await new Promise(r => server.close(r)); }
  fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify({ results, pass: true, externalDB: false, scope: httpOnly ? 'http-only' : 'all', httpPort }, null, 2));
  console.log('PASS ' + results.length + ' scenarios; evidence: ' + evidence);
})().catch(error => { console.error(error); process.exitCode = 1; });
