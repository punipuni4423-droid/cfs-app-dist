import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let failed = 0;
for (const config of readdirSync('.').filter((name) => /^playwright.*config\.ts$/.test(name))) {
  for (const value of [undefined, 'http://127.0.0.1:3014', 'http://localhost:3064']) {
    const env = { ...process.env, CFS_TEST_AUTH: '0' };
    delete env.PLAYWRIGHT_BASE_URL;
    if (value) env.PLAYWRIGHT_BASE_URL = value;
    const result = spawnSync(process.execPath, [path.resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', config, '--list', '--reporter=line'], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /CFS_TEST_SAFETY/);
      console.log(`PASS ${config} ${value ?? 'UNSET'}: rejected before execution`);
    } catch {
      failed++;
      console.log(`FAIL ${config} ${value ?? 'UNSET'}: status=${result.status}, safety rejection absent`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
