import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createHmac } from 'node:crypto';
import * as apiAuth from '../../app/lib/apiAuth';
import { createGrant, exchangeGrant, readAuthKeys, readSession } from '../../app/lib/apiAuthCore.mjs';

const routes = readdirSync(path.resolve('app/api'), { recursive: true }).map(String).filter(p => p.endsWith('route.ts'));
test('every API method rejects missing credentials before any side effect', async () => {
  let calls = 0;
  const results: string[] = [];
  for (const relative of routes) {
    const filename = path.resolve('app/api', relative);
    const source = process.env.CFS_AUTH_BASELINE === '1' ? execFileSync('git', ['show', `HEAD:app/api/${relative.replaceAll('\\', '/')}`], { encoding: 'utf8' }) : readFileSync(filename, 'utf8');
    const loaded = new Module(filename, module) as Module & { _compile(code: string, filename: string): void; paths: string[] };
    loaded.filename = filename; loaded.paths = module.paths;
    const native = loaded.require.bind(loaded);
    loaded.require = ((id: string) => {
      if (id.endsWith('/apiAuth')) return apiAuth;
      if (id === 'next/server' || id === 'node:path' || id === 'node:crypto') return native(id);
      return new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : (..._args: unknown[]) => { calls++; return {}; } });
    }) as NodeRequire;
    loaded._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, filename);
    for (const method of ['GET', 'POST']) {
      if (!loaded.exports[method]) continue;
      const url = `http://127.0.0.1:3087/api/${relative.replaceAll('\\', '/').replace('/route.ts', '')}`;
      let status = 0;
      try { status = (await loaded.exports[method](new Request(url, { method, headers: { host: 'localhost:3087', 'x-forwarded-for': '127.0.0.1' }, ...(method === 'POST' ? { body: '{}' } : {}) }))).status; } catch { status = 500; }
      results.push(`${method} ${relative} ${status}`);
      expect.soft(status, results.at(-1)).toBe(401);
    }
  }
  await test.info().attach('api-route-matrix', { body: results.join('\n'), contentType: 'text/plain' });
  expect(calls).toBe(0);
});

test('signed sessions reject tampering, raw grants, forged identities, and tablet admin operations', async () => {
  const keys = await readAuthKeys();
  const editor = exchangeGrant(createGrant(keys, 'editor'), keys)!;
  const admin = exchangeGrant(createGrant(keys), keys)!;
  const session = readSession(editor, keys)!;
  const req = (token: string, body = {}) => new Request('http://127.0.0.1:3087/api/collaboration/lock/acquire', { method: 'POST', headers: { 'x-cfs-access-token': token }, body: JSON.stringify(body) });
  expect((await apiAuth.requireApiAccess(req(createGrant(keys))))?.status).toBe(401);
  expect((await apiAuth.requireApiAccess(req(editor + 'x')))?.status).toBe(401);
  expect((await apiAuth.requireApiAccess(req(editor), true))?.status).toBe(403);
  expect(await apiAuth.requireApiAccess(req(admin), true)).toBeNull();
  expect((await apiAuth.requireApiAccess(req(editor, { userId: 'someone-else' })))?.status).toBe(403);
  expect((await apiAuth.requireApiAccess(req(editor, { sessionId: 'another-session:tab' })))?.status).toBe(403);
  expect(await apiAuth.requireApiAccess(req(editor, { userId: session.userId, sessionId: `${session.sessionId}:tab-1` }))).toBeNull();
  expect(readSession(editor, { ...keys, secret: 'a'.repeat(43) })).toBeNull();
  const expired = Buffer.from(JSON.stringify({ ...session, exp: Date.now() - 1 })).toString('base64url');
  expect(readSession(`${expired}.${createHmac('sha256', keys.secret).update(expired).digest('base64url')}`, keys)).toBeNull();
});

test('local launcher CLI produces an exchangeable loopback link without exposing the key', async () => {
  const link = execFileSync(process.execPath, [path.resolve('scripts/cfs-access.mjs'), 'http://localhost:3087/'], { encoding: 'utf8', windowsHide: true });
  const parsed = new URL(link);
  expect(parsed.origin).toBe('http://localhost:3087');
  const grant = new URLSearchParams(parsed.hash.slice(1)).get('cfs_access')!;
  const keys = await readAuthKeys();
  expect(link.includes(keys.secret)).toBe(false);
  expect(readSession(exchangeGrant(grant, keys)!, keys)?.role).toBe('admin');
});
