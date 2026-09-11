import { NextResponse } from 'next/server';
import { readAuthKeys, readSession, sessionToken } from './apiAuthCore.mjs';
import { isSecureSharingEnabled } from './secureSharingServer';

export async function requireApiAccess(request: Request, admin = false): Promise<NextResponse | null> {
  const session = readSession(sessionToken(request), await readAuthKeys());
  if (!session) return NextResponse.json({ error: '認証が必要です。PCのランチャーまたは接続リンクから開き直してください。' }, { status: 401 });
  if (admin && session.role !== 'admin') return NextResponse.json({ error: 'PC管理者の操作が必要です。' }, { status: 403 });
  const url = new URL(request.url);
  const identities: Record<string, unknown>[] = [{ userId: request.headers.get('x-cfs-user-id'), sessionId: request.headers.get('x-cfs-session-id') }];
  if (url.pathname.startsWith('/api/collaboration/')) {
    identities.push({ userId: url.searchParams.get('userId'), sessionId: url.searchParams.get('sessionId') });
    if (request.method === 'POST') {
      const length = Number(request.headers.get('content-length') || '0');
      if (length > 65536) return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
      const body = await request.clone().text();
      if (body.length > 65536) return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
      try { identities.push(JSON.parse(body)); } catch { /* The route reports invalid JSON. */ }
    }
  }
  for (const identity of identities) {
    if (!identity || typeof identity !== 'object') continue;
    const { userId, sessionId } = identity;
    // Supabase identities remain authenticated and authorized by the Edge Function.
    if (!isSecureSharingEnabled() && userId && userId !== session.userId) return NextResponse.json({ error: 'User identity does not match the session' }, { status: 403 });
    if (sessionId && (typeof sessionId !== 'string' || !sessionId.startsWith(`${session.sessionId}:`))) return NextResponse.json({ error: 'Editor session does not match the access session' }, { status: 403 });
  }
  return null;
}
