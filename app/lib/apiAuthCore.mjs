import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const COOKIE_NAME = 'cfs-access-v1';
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
  if (parts[1].length !== expected.length || !timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
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
export function sessionToken(request) {
  // A separate header keeps the existing Supabase Authorization header intact.
  const header = request.headers.get('x-cfs-access-token');
  if (header) return header;
  const cookies = request.headers.get('cookie') || '';
  return cookies.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) || '';
}
