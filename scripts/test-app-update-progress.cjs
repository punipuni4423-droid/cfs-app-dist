const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const ts = require('typescript');
const { chromium } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const webpackModule = require('next/dist/compiled/webpack/webpack');
webpackModule.init();
const root = path.resolve(__dirname, '..');
const scratch = process.env.CFS_PROGRESS_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-progress-ui-'));
fs.mkdirSync(path.join(scratch, 'app/components'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'app/lib'), { recursive: true });
for (const file of ['app/components/AppUpdateControl.tsx', 'app/lib/appUpdateProgress.ts']) {
  fs.writeFileSync(path.join(scratch, file.replace(/\.tsx?$/, '.js')), ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText);
}
fs.writeFileSync(path.join(scratch, 'entry.js'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './app/components/AppUpdateControl.js'; createRoot(document.getElementById('root')).render(React.createElement(App));`);
const status = (state = 'available', run) => ({ enabled: true, state, message: 'Synthetic update status', ahead: 0, behind: state === 'available' ? 1 : 0, dirty: false, checkedAt: new Date().toISOString(), ...(run ? { lastRun: run } : {}) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function loadTsModule(file) {
  const filename = path.join(root, file);
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = module.paths;
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
(async () => {
  const { isAppUpdateStatus, remainingUpdateEstimate } = loadTsModule('app/lib/appUpdateProgress.ts');
  assert.equal(isAppUpdateStatus({ error: 'unauthorized' }), false);
  assert.equal(isAppUpdateStatus({ ...status(), lastRun: { progress: NaN } }), false);
  assert.equal(isAppUpdateStatus({ ...status(), message: {} }), false);
  assert.match(remainingUpdateEstimate('unknown', 600, {}, true, false), /pending/);
  assert.equal(remainingUpdateEstimate('build', 50, {}, true, true), '');
  await new Promise((resolve, reject) => webpackModule.webpack({
    mode: 'development', entry: path.join(scratch, 'entry.js'), devtool: false,
    output: { path: scratch, filename: 'bundle.js' },
    resolve: { modules: [path.join(root, 'node_modules')] },
  }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); return res.end(fs.readFileSync(path.join(scratch, 'bundle.js'))); }
    if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end(fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8').replace('@import "tailwindcss";', '')); }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  const results = [];
  try {
    async function scene(name, config, test, width = 1280) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      await page.addInitScript(config => {
        window.fixture = { ...config, posts: 0, gets: 0 };
        if (config.active) {
          sessionStorage.setItem('cfs-self-update-active', '1');
          sessionStorage.setItem('cfs-self-update-started-at', String(config.activeStartedAt || Date.now() - (config.elapsed || 0)));
        }
        const realFetch = window.fetch.bind(window);
        window.fetch = async (url, init = {}) => {
          const f = window.fixture;
          if (String(url).startsWith('/api/app-update/status')) {
            f.gets++;
            if (f.mode === 'hang') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
            return new Response(JSON.stringify(f.status), { status: f.code || 200, headers: { 'content-type': 'application/json' } });
          }
          if (String(url) === '/api/app-update/apply') {
            f.posts++;
            if (f.postUnknown) throw new TypeError('Synthetic lost response');
            if (f.postServerError) return new Response('{}', { status: 502 });
            return new Response('{}', { status: 200 });
          }
          return realFetch(url, init);
        };
        window.confirm = () => true;
        window.alert = () => {};
      }, config);
      await page.goto(origin);
      await page.waitForSelector('.app-update-control');
      await test(page);
      assert.deepEqual(errors, [], `${name}: page errors`);
      results.push({ name, pass: true });
      await page.close();
    }
    await scene('unknown 2 percent elapsed and diagnostics', { active: true, elapsed: 65000, status: status('available', { state: 'running', startedAt: new Date(Date.now() - 64000).toISOString() }) }, async page => {
      await page.waitForSelector('[role="alertdialog"]');
      assert.match(await page.locator('.app-update-progress-elapsed').first().innerText(), /Elapsed: 1:/);
      assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '2');
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /pending/);
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /Do not run another update or overwrite the installation/);
      await page.screenshot({ path: path.join(scratch, 'unknown-2-percent.png') });
    });
    await scene('queued keeps real percent; 401 preserves checkpoint', { active: true, status: status('available', { state: 'running', currentStep: 'queued', progress: 1, startedAt: new Date(Date.now() + 500).toISOString() }) }, async page => {
      await page.waitForSelector('[role="progressbar"]');
      await page.evaluate(() => { window.fixture.code = 401; window.fixture.status = { error: 'unauthorized' }; });
      await page.clock.runFor(2500);
      assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '1');
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /Authentication is required/);
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /waiting for the connection to recover/);
      await page.screenshot({ path: path.join(scratch, 'auth-reconnect.png') });
    });
    await scene('malformed successful payload is not accepted', { active: true, status: { error: 'not a status' } }, async page => {
      await page.waitForSelector('[role="progressbar"]');
      assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '2');
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /waiting for the connection to recover/);
    });
    await scene('build ETA labelled and progress stays real', { status: status('available', { state: 'running', currentStep: 'build', progress: 78, startedAt: new Date(Date.now() - 1000).toISOString() }) }, async page => {
      await page.waitForSelector('[role="progressbar"]');
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /Estimated time remaining: about \d+–\d+ min/);
      await page.clock.runFor(450000);
      assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '78');
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /taking longer than usual/);
      await page.screenshot({ path: path.join(scratch, 'build-estimate-overrun.png') });
    });
    await scene('GET timeout releases polling guard', { active: true, status: status('available'), mode: 'hang' }, async page => {
      await page.clock.runFor(21000);
      await page.evaluate(() => { window.fixture.mode = ''; window.fixture.status = { enabled: true, state: 'available', message: 'Synthetic', ahead: 0, behind: 1, dirty: false, checkedAt: new Date().toISOString() }; });
      await page.clock.runFor(2500);
      assert((await page.evaluate(() => window.fixture.gets)) >= 2);
      assert.equal(await page.evaluate(() => window.fixture.posts), 0);
    });
    await scene('POST response unknown and stale completed never unlock', { status: status('available'), postUnknown: true }, async page => {
      await page.getByRole('button', { name: 'Update Available' }).waitFor();
      await page.getByRole('button', { name: 'Update Available' }).click();
      await page.waitForSelector('[role="alertdialog"]');
      await page.evaluate(() => { window.fixture.status.lastRun = { state: 'completed', currentStep: 'done', progress: 100, startedAt: new Date(Date.now() - 60000).toISOString() }; });
      await page.clock.runFor(5000);
      assert.equal(await page.evaluate(() => window.fixture.posts), 1);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('cfs-self-update-active')), '1');
      assert.match(await page.locator('[role="alertdialog"]').innerText(), /previous update result/);
      assert.equal(await page.locator('.app-update-button').isDisabled(), true);
    });
    await scene('POST server error remains guarded', { status: status('available'), postServerError: true }, async page => {
      await page.getByRole('button', { name: 'Update Available' }).waitFor();
      await page.getByRole('button', { name: 'Update Available' }).click();
      await page.waitForSelector('[role="alertdialog"]');
      await page.clock.runFor(5000);
      assert.equal(await page.evaluate(() => window.fixture.posts), 1);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('cfs-self-update-active')), '1');
    });
    // Real PowerShell worker-start failure -> same status -> actual UI.
    const { buildUpdateLaunchCommand, windowsPowerShellExecutable } = loadTsModule('app/lib/appUpdateLaunch.ts');
    const faultRoot = path.join(scratch, "helper fault's folder");
    fs.mkdirSync(faultRoot, { recursive: true });
    const faultStatusPath = path.join(faultRoot, 'status.json');
    const startedAt = new Date().toISOString();
    fs.writeFileSync(faultStatusPath, JSON.stringify({ state: 'running', currentStep: 'queued', startedAt }));
    const command = buildUpdateLaunchCommand({ appDir: faultRoot, scriptPath: path.join(faultRoot, 'missing-worker.ps1'), statusFile: faultStatusPath, port: '3999', hostName: '127.0.0.1', startedAt });
    const launched = spawnSync(windowsPowerShellExecutable(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 10000 });
    assert.equal(launched.status, 0);
    let fault;
    const deadline = Date.now() + 15000;
    do { try { fault = JSON.parse(fs.readFileSync(faultStatusPath, 'utf8').replace(/^\uFEFF/, '')); } catch {} if (fault?.state === 'failed') break; await sleep(100); } while (Date.now() < deadline);
    assert.equal(fault?.startedAt, startedAt);
    assert.equal(fault?.state, 'failed');
    await scene('real helper launch failure is accepted as this run', { active: true, activeStartedAt: Date.parse(startedAt) - 100, status: status('available', fault) }, async page => {
      await page.getByRole('heading', { name: 'Update failed' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).count(), 1);
      assert.doesNotMatch(await page.locator('[role="alertdialog"]').innerText(), /Estimated time remaining/);
      await page.screenshot({ path: path.join(scratch, 'worker-launch-failed.png') });
    });
    const colors = {};
    for (const state of ['current', 'available', 'build_required']) {
      await scene(`status color ${state}`, { status: status(state) }, async page => {
        const button = page.locator('.app-update-button');
        await page.waitForSelector(`.app-update-button-${state}`);
        colors[state] = await button.evaluate(el => { const c = getComputedStyle(el); return { background: c.backgroundColor, color: c.color }; });
        await button.focus();
        if (state !== 'current') assert.equal(await button.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
        await page.screenshot({ path: path.join(scratch, `button-${state}.png`) });
      }, state === 'available' ? 480 : 1280);
    }
    assert.notEqual(colors.current.background, colors.available.background);
    assert.equal(colors.available.background, colors.build_required.background);
    function luminance(rgb) {
      const channels = rgb.match(/\d+/g).slice(0, 3).map(v => { const c = Number(v) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    const ratio = (luminance(colors.available.background) + 0.05) / (luminance(colors.available.color) + 0.05);
    assert(ratio >= 4.5, `Available button contrast ${ratio}`);
    fs.writeFileSync(path.join(scratch, 'result.json'), JSON.stringify({ results, colors, externalApiWrites: 0, realProjectData: 'untouched' }, null, 2));
    console.log(`PASS: ${results.length} isolated actual-component browser scenarios. Evidence: ${scratch}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
