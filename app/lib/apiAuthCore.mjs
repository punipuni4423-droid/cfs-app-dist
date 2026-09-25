import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const COOKIE_NAME = 'cfs-access-v1';
// Release owner must replace this provisional cutoff with release day + 90 days.
export const LEGACY_COOKIE_READ_UNTIL = '2026-12-24';
export const SESSION_SECONDS = 90 * 24 * 60 * 60;
const randomSecret = () => randomBytes(32).toString('base64url');
export function authFile() {
  return path.join(process.env.CFS_AUTH_DIR || path.join(process.env.CFS_APP_DIR || process.cwd(), 'data', 'auth'), 'access.json');
}
export async function readAuthKeys() {
  const file = authFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, JSON.stringify({ version: 1, secret: randomSecret() }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Another process may have just created the file and still be writing it.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const keys = JSON.parse(await readFile(file, 'utf8'));
      if (keys.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(keys.secret)) throw new Error('Invalid CFS access key file');
      return keys;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
function sign(payload, keys) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', keys.secret).update(body).digest('base64url')}`;
}
function verify(token, keys, kind) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', keys.secret).update(parts[0]).digest('base64url');
  const signature = Buffer.from(parts[1]);
  const expectedBytes = Buffer.from(expected);
  if (signature.length !== expectedBytes.length || !timingSafeEqual(signature, expectedBytes)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (payload.kind !== kind || !Number.isFinite(payload.exp) || payload.exp <= Date.now() || !['admin', 'editor'].includes(payload.role)) return null;
    return payload;
  } catch { return null; }
}
export function createGrant(keys, role = 'admin') {
  // Launch links are short-lived; tablet invitations remain usable for one day.
  return sign({ kind: 'grant', role, nonce: randomUUID(), exp: Date.now() + (role === 'admin' ? 300_000 : 86_400_000) }, keys);
}
export function exchangeGrant(grant, keys) {
  const payload = verify(grant, keys, 'grant');
  if (!payload) return null;
  return sign({ kind: 'session', role: payload.role, userId: `user:${randomUUID()}`, sessionId: `session:${randomUUID()}`, exp: Date.now() + SESSION_SECONDS * 1000 }, keys);
}
export function readSession(token, keys) {
  const session = verify(token, keys, 'session');
  return session && typeof session.userId === 'string' && typeof session.sessionId === 'string' ? session : null;
}
export function cookieNameFor(request) {
  const host = request.headers.get('host') || '';
  // An explicit authority and port are required, including bracketed IPv6.
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(host);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  try { if (!new URL(`http://${host}`).hostname) return null; } catch { return null; }
  const configured = process.env.PORT;
  if (configured !== undefined && (!/^[0-9]{1,5}$/.test(configured) || Number(configured) !== port)) return null;
  return `cfs-access-v2-p${port}`;
}

function requestToken(request) {
  const name = cookieNameFor(request);
  if (!name) return null;
  // Presence, including an empty/invalid value, prevents credential downgrade.
  // This separate header leaves Supabase's Authorization header intact.
  if (request.headers.has('x-cfs-access-token')) {
    return { token: request.headers.get('x-cfs-access-token') || '', legacy: false, name };
  }
  const cookies = (request.headers.get('cookie') || '').split(';').map(part => part.trim());
  for (const candidate of [name, COOKIE_NAME]) {
    if (candidate === COOKIE_NAME && Date.now() >= Date.parse(LEGACY_COOKIE_READ_UNTIL)) break;
    const matches = cookies.filter(part => part === candidate || part.startsWith(`${candidate}=`));
    if (matches.length > 1) return null;
    if (matches.length === 1) return { token: matches[0].slice(candidate.length + 1), legacy: candidate === COOKIE_NAME, name };
  }
  return null;
}

export function sessionToken(request) {
  return requestToken(request)?.token || '';
}

export function readRequestSession(request, keys) {
  const selected = requestToken(request);
  const session = selected && readSession(selected.token, keys);
  return session ? { ...selected, session } : null;
}
