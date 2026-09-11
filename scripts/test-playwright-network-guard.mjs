import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
for (const mode of ['main', 'popup', 'request', 'context-request', 'new-context', 'mocked']) {
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.safety.config.ts', '--reporter=line'], { env: { ...process.env, CFS_GUARD_PROBE: mode }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const output = result.stdout + result.stderr;
  console.log(output);
  if (mode === 'mocked') assert.equal(result.status, 0);
  else { assert.equal(result.status, 1); assert.match(output, /Unmocked requests were blocked/); }
  console.log(`PASS network safety probe: ${mode}`);
}
