/**
 * Isolated real-server check of the startup maintenance lock probe in
 * POST /api/app-update/apply. Requires a dedicated dev server started with
 * CFS_APP_DIR pointing at an empty scratch folder whose name starts with
 * "cfs-startup-lock-" (never a real installation): this spec turns that folder
 * into a tiny Git fixture with an upstream and a stub .cfs-updater/bootstrap-v1.ps1
 * that only acknowledges "started". The frozen bootstrap is never executed.
 *
 *   held lock  -> 409 { code: "startup_maintenance_running" }, no bootstrap launch
 *   free lock  -> unchanged flow: 202 after the bootstrap acknowledgement
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STARTUP_MAINTENANCE_RUNNING_CODE, STARTUP_MAINTENANCE_RUNNING_MESSAGE } from '../../app/lib/appUpdateProgress';

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const STUB_BOOTSTRAP = [
  'param([string]$AppDir,[string]$Port,[string]$HostName,[string]$ExpectedHead,[string]$StartedAt,[string]$AttemptId,[switch]$ApiHandshake,[switch]$RepairBuild)',
  "$ErrorActionPreference = 'Stop'",
  "$record = @{ appDir = $AppDir; port = $Port; expectedHead = $ExpectedHead; attemptId = $AttemptId; apiHandshake = [bool]$ApiHandshake; repairBuild = [bool]$RepairBuild; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress",
  "[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'stub-invocations.jsonl'), $record + \"`n\")",
  "Write-Output 'CFS_UPDATE_ACK:{\"state\":\"started\",\"message\":\"Fixture bootstrap acknowledged the start.\"}'",
  'exit 0',
  '',
].join('\r\n');

function fixtureDir(): string {
  const configured = process.env.CFS_APP_DIR;
  if (!configured) throw new Error('CFS_APP_DIR (scratch fixture) is required');
  const dir = path.resolve(configured);
  const repo = path.resolve('.');
  if (!path.basename(dir).startsWith('cfs-startup-lock-') || dir === repo || dir.startsWith(repo + path.sep) || repo.startsWith(dir + path.sep)) {
    throw new Error('Unsafe fixture: CFS_APP_DIR must be a scratch folder named cfs-startup-lock-* outside the repository');
  }
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=CFS Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** Minimal Git-managed app folder: tracked package.json, clean tree, upstream origin/main at the same commit. */
function prepareFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, '.git'))) {
    const origin = `${dir}-origin.git`;
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cfs-startup-lock-fixture', version: '0.0.0', private: true }, null, 2) + '\n');
    writeFileSync(path.join(dir, '.gitignore'), 'data/\nartifacts/\n.cfs-updater/\n');
    git(dir, ['add', 'package.json', '.gitignore']);
    git(dir, ['commit', '-q', '-m', 'fixture']);
    if (!existsSync(origin)) git(dir, ['init', '-q', '--bare', origin]);
    git(dir, ['remote', 'add', 'origin', origin]);
    git(dir, ['push', '-q', '-u', 'origin', 'main']);
  }
  mkdirSync(path.join(dir, '.cfs-updater'), { recursive: true });
  writeFileSync(path.join(dir, '.cfs-updater', 'bootstrap-v1.ps1'), STUB_BOOTSTRAP);
}

/** Holds .cfs-updater/maintenance.lock exactly like cfs-update-maintenance.ps1 -RunStartup (FileShare.None). */
async function holdLock(lockPath: string): Promise<ChildProcess> {
  const script = `$ErrorActionPreference='Stop'; $s=[IO.File]::Open('${lockPath.replace(/'/g, "''")}',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`;
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder did not start')), 20000);
    child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('HELD')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`lock holder exited early (${code})`)); });
  });
  return child;
}

async function releaseLock(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  holder.kill();
  await exited;
}

function stubInvocations(dir: string): string[] {
  const file = path.join(dir, '.cfs-updater', 'stub-invocations.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
}

function launchAckAttempts(dir: string): string[] {
  const acks = path.join(dir, 'artifacts', 'self-update', 'launch-acks');
  return existsSync(acks) ? readdirSync(acks) : [];
}

async function assertServerUsesFixture(request: APIRequestContext, dir: string): Promise<Record<string, unknown>> {
  const response = await request.get('/api/app-update/status?fetchRemote=0');
  expect(response.status()).toBe(200);
  const status = await response.json() as Record<string, unknown>;
  // Hard guard: never POST apply to a server that serves anything but this fixture.
  expect(path.resolve(String(status.appDir))).toBe(dir);
  expect(['current', 'available', 'build_required']).toContain(status.state);
  expect(status.dirty).toBe(false);
  expect(status.ahead).toBe(0);
  return status;
}

test('held startup lock -> 409 startup_maintenance_running without launching the bootstrap; free lock -> 202', async ({ request }, testInfo) => {
  test.setTimeout(180000);
  const dir = fixtureDir();
  prepareFixture(dir);
  const lockPath = path.join(dir, '.cfs-updater', 'maintenance.lock');
  const invocationsBefore = stubInvocations(dir).length;
  const acksBefore = launchAckAttempts(dir).length;
  await assertServerUsesFixture(request, dir);

  const holder = await holdLock(lockPath);
  try {
    const held = await request.post('/api/app-update/apply', { data: { confirm: true } });
    const body = await held.json();
    await testInfo.attach('held-response', { body: JSON.stringify({ status: held.status(), headers: held.headers(), body }, null, 2), contentType: 'application/json' });
    expect(held.status()).toBe(409);
    expect(body.code).toBe(STARTUP_MAINTENANCE_RUNNING_CODE);
    expect(body.error).toBe(STARTUP_MAINTENANCE_RUNNING_MESSAGE);
    expect(body.retryAfterSeconds).toBe(60);
    expect(held.headers()['retry-after']).toBe('60');
    expect(path.resolve(String(body.status?.appDir))).toBe(dir);
    // Nothing was dispatched: no acknowledgement folder, no bootstrap invocation.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(launchAckAttempts(dir).length).toBe(acksBefore);
    expect(stubInvocations(dir).length).toBe(invocationsBefore);
  } finally {
    await releaseLock(holder);
  }

  // The lock file stays behind as a 0-byte residue, exactly as after a real launch.
  expect(existsSync(lockPath)).toBe(true);
  await assertServerUsesFixture(request, dir);
  const free = await request.post('/api/app-update/apply', { data: { confirm: true } });
  const freeBody = await free.json();
  await testInfo.attach('free-response', { body: JSON.stringify({ status: free.status(), body: freeBody }, null, 2), contentType: 'application/json' });
  expect(free.status()).toBe(202);
  expect(freeBody.ok).toBe(true);
  expect(freeBody.state).toBe('started');
  expect(freeBody.message).toBe('Fixture bootstrap acknowledged the start.');
  const attempts = launchAckAttempts(dir);
  expect(attempts.length).toBe(acksBefore + 1);
  const invocations = stubInvocations(dir);
  expect(invocations.length).toBe(invocationsBefore + 1);
  const invoked = JSON.parse(invocations[invocations.length - 1]) as Record<string, unknown>;
  expect(path.resolve(String(invoked.appDir))).toBe(dir);
  expect(invoked.apiHandshake).toBe(true);
  expect(attempts).toContain(String(invoked.attemptId));
  expect(readFileSync(path.join(dir, 'artifacts', 'self-update', 'launch-acks', String(invoked.attemptId), 'ack.jsonl'), 'utf8')).toContain('"state":"started"');
});
