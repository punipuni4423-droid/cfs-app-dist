import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createHmac } from 'node:crypto';
import * as apiAuth from '../../app/lib/apiAuth';
import { COOKIE_NAME, LEGACY_COOKIE_READ_UNTIL, cookieNameFor, sessionToken, readRequestSession, createGrant, exchangeGrant, readAuthKeys, readSession } from '../../app/lib/apiAuthCore.mjs';
import { GET as connectGet, POST as connectPost } from '../../app/auth/connect/route';

let savedPort: string | undefined;
test.beforeEach(() => { savedPort = process.env.PORT; process.env.PORT = '3087'; });
test.afterEach(() => { if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; });

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
  const req = (token: string, body = {}) => new Request('http://127.0.0.1:3087/api/collaboration/lock/acquire', { method: 'POST', headers: { host: '127.0.0.1:3087', 'x-cfs-access-token': token }, body: JSON.stringify(body) });
  expect((await apiAuth.requireApiAccess(req(createGrant(keys))))?.status).toBe(401);
  expect((await apiAuth.requireApiAccess(req(editor + 'x')))?.status).toBe(401);
  expect((await apiAuth.requireApiAccess(req(editor.split('.')[0] + '.' + 'é'.repeat(43))))?.status).toBe(401);
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

test('port authority validates explicit ports and rejects malformed or mismatched Host', () => {
  const request = (host: string) => new Request('http://localhost:3087/', { headers: { host } });
  for (const host of ['localhost:3087', '127.0.0.1:3087', '192.168.1.2:3087', '[::1]:3087']) expect(cookieNameFor(request(host))).toBe('cfs-access-v2-p3087');
  for (const host of ['', 'localhost', 'localhost:0', 'localhost:65536', 'localhost:3088', 'localhost:abc', 'localhost:3087/path', 'user@localhost:3087', 'localhost:3087,localhost:3087', '::1:3087', '[not-ip]:3087', 'localhost:3087?x', 'localhost:3087#x']) expect(cookieNameFor(request(host))).toBeNull();
  expect(cookieNameFor(new Request('http://localhost:3087/'))).toBeNull();
  delete process.env.PORT;
  for (const port of [1, 80, 443, 65535]) expect(cookieNameFor(request(`localhost:${port}`))).toBe(`cfs-access-v2-p${port}`);
  for (const port of ['', 'bad', '0', '65536']) { process.env.PORT = port; expect(cookieNameFor(request('localhost:3087'))).toBeNull(); }
});

test('credential presence fixes priority; duplicate selected cookies and invalid tokens never downgrade', async () => {
  const keys = await readAuthKeys();
  const valid = exchangeGrant(createGrant(keys), keys)!;
  const other = exchangeGrant(createGrant({ version: 1, secret: 'b'.repeat(43) }), { version: 1, secret: 'b'.repeat(43) })!;
  const name = 'cfs-access-v2-p3087';
  const req = (cookie: string, header?: string) => new Request('http://localhost:3087/auth/connect', { headers: { host: 'localhost:3087', cookie, ...(header === undefined ? {} : { 'x-cfs-access-token': header }) } });
  const selected = req(`${COOKIE_NAME}=${other}; cfs-access-v2-p3088=${other}; ${name}=${valid}`);
  expect(sessionToken(selected) === valid).toBe(true);
  expect(readRequestSession(selected, keys)?.legacy).toBe(false);
  expect(readRequestSession(req(`${COOKIE_NAME}=${valid}`), keys)?.legacy).toBe(true);
  expect(readRequestSession(req(`cfs-access-v2-p3088=${valid}`), keys)).toBeNull();
  expect(readRequestSession(req(`${name}=bad; ${name}=bad; ${COOKIE_NAME}=bad`, valid), keys)?.legacy).toBe(false);
  for (const cookie of [`${name}=bad; ${COOKIE_NAME}=${valid}`, `${name}=; ${COOKIE_NAME}=${valid}`, `${name}; ${COOKIE_NAME}=${valid}`, `${name}=${valid}; ${name}=${valid}`, `${COOKIE_NAME}=${valid}; ${COOKIE_NAME}=${valid}`, `${name}=${other}; ${COOKIE_NAME}=${valid}`, `${name}=${valid}x; ${COOKIE_NAME}=${valid}`, `${name}=${createGrant(keys)}; ${COOKIE_NAME}=${valid}`]) {
    expect((await connectGet(req(cookie))).status).toBe(401);
  }
  for (const header of ['', 'bad', other]) expect((await apiAuth.requireApiAccess(req(`${name}=${valid}; ${COOKIE_NAME}=${valid}`, header)))?.status).toBe(401);
  expect((await connectGet(new Request('http://localhost:3087/auth/connect', { headers: { host: 'localhost:3088', 'x-cfs-access-token': valid } }))).status).toBe(401);
});

test('legacy cutoff is fixed and GET promotion preserves token identity and remaining lifetime', async () => {
  const keys = await readAuthKeys();
  const token = exchangeGrant(createGrant(keys), keys)!;
  const request = (cookie: string) => new Request('http://localhost:3087/auth/connect', { headers: { host: 'localhost:3087', cookie } });
  const before = readSession(token, keys)!;
  const response = await connectGet(request(`${COOKIE_NAME}=${token}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: before.userId, sessionId: before.sessionId, role: before.role });
  const promoted = response.cookies.get('cfs-access-v2-p3087');
  expect(promoted?.value === token).toBe(true);
  expect(response.cookies.get(COOKIE_NAME)).toBeUndefined();
  const maxAge = Number(/Max-Age=(\d+)/i.exec(response.headers.get('set-cookie') || '')?.[1]);
  expect(maxAge).toBeLessThanOrEqual(Math.ceil((before.exp - Date.now()) / 1000));
  expect(maxAge).toBeGreaterThan(0);
  expect((await connectGet(request(`cfs-access-v2-p3087=${token}`))).headers.has('set-cookie')).toBe(false);
  const now = Date.now;
  try {
    const cutoff = Date.parse(LEGACY_COOKIE_READ_UNTIL);
    Date.now = () => cutoff - 1000;
    const fresh = exchangeGrant(createGrant(keys), keys)!;
    expect(readRequestSession(request(`${COOKIE_NAME}=${fresh}`), keys)?.legacy).toBe(true);
    Date.now = () => cutoff;
    expect(readRequestSession(request(`${COOKIE_NAME}=${fresh}`), keys)).toBeNull();
    expect(readRequestSession(request(`cfs-access-v2-p3087=${fresh}`), keys)?.legacy).toBe(false);
    Date.now = () => cutoff + 91 * 86400000;
    expect(readRequestSession(request(`cfs-access-v2-p3087=${fresh}`), keys)).toBeNull();
  } finally { Date.now = now; }
});

test('POST writes only the port cookie, preserves valid identity, and reconnects expired credentials', async () => {
  const keys = await readAuthKeys();
  const token = exchangeGrant(createGrant(keys), keys)!;
  const post = (cookie: string, host = 'localhost:3087') => connectPost(new Request('http://localhost:3087/auth/connect', { method: 'POST', headers: { host, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ grant: createGrant(keys) }) }));
  for (const name of [COOKIE_NAME, 'cfs-access-v2-p3087']) {
    const result = await post(`${name}=${token}`);
    expect(result.status).toBe(200);
    expect(result.cookies.get('cfs-access-v2-p3087')?.value === token).toBe(true);
    expect(result.cookies.get(COOKIE_NAME)).toBeUndefined();
  }
  const reconnected = await post('cfs-access-v2-p3087=invalid');
  expect(reconnected.status).toBe(200);
  expect(Boolean(readSession(reconnected.cookies.get('cfs-access-v2-p3087')!.value, keys))).toBe(true);
  expect((await post('', 'localhost:3088')).status).toBe(401);
});
