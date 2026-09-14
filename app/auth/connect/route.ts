import { NextResponse } from 'next/server';
import { COOKIE_NAME, SESSION_SECONDS, exchangeGrant, readAuthKeys, readSession, sessionToken } from '../../lib/apiAuthCore.mjs';
import { isAllowedWriteRequest } from '../../lib/requestGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = readSession(sessionToken(request), await readAuthKeys());
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json({ userId: session.userId, sessionId: session.sessionId, role: session.role }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  const text = await request.text();
  if (text.length > 4096) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  let grant: unknown;
  try { grant = JSON.parse(text).grant; } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const keys = await readAuthKeys();
  let token = typeof grant === 'string' ? exchangeGrant(grant, keys) : null;
  if (!token) return NextResponse.json({ error: 'The connection link is invalid or has expired. Reopen CFS using the launcher.' }, { status: 401 });
  const previous = sessionToken(request);
  const previousSession = readSession(previous, keys);
  if (previousSession && previousSession.role === readSession(token, keys)?.role) token = previous;
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: SESSION_SECONDS });
  return response;
}
