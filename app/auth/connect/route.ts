import { NextResponse } from 'next/server';
import { cookieNameFor, SESSION_SECONDS, exchangeGrant, readAuthKeys, readSession, readRequestSession } from '../../lib/apiAuthCore.mjs';
import { isAllowedWriteRequest } from '../../lib/requestGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function setSessionCookie(response: NextResponse, request: Request, name: string, token: string, exp: number) {
  response.cookies.set(name, token, { httpOnly: true, sameSite: 'strict', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: Math.max(0, Math.min(SESSION_SECONDS, Math.floor((exp - Date.now()) / 1000))) });
}

export async function GET(request: Request) {
  const access = readRequestSession(request, await readAuthKeys());
  if (!access) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const { session } = access;
  const response = NextResponse.json({ userId: session.userId, sessionId: session.sessionId, role: session.role }, { headers: { 'Cache-Control': 'no-store' } });
  if (access.legacy) setSessionCookie(response, request, access.name, access.token, session.exp);
  return response;
}

export async function POST(request: Request) {
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const name = cookieNameFor(request);
  if (!name) return NextResponse.json({ error: 'Invalid connection port' }, { status: 401 });
  const text = await request.text();
  if (text.length > 4096) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  let grant: unknown;
  try { grant = JSON.parse(text).grant; } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const keys = await readAuthKeys();
  let token = typeof grant === 'string' ? exchangeGrant(grant, keys) : null;
  if (!token) return NextResponse.json({ error: 'The connection link is invalid or has expired. Reopen CFS using the launcher.' }, { status: 401 });
  let session = readSession(token, keys)!;
  const previous = readRequestSession(request, keys);
  if (previous && previous.session.role === session.role) { token = previous.token; session = previous.session; }
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  setSessionCookie(response, request, name, token, session.exp);
  return response;
}
