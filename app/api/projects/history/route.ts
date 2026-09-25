import { NextResponse } from 'next/server';
import { requireApiAccess } from '../../../lib/apiAuth';
import { isAllowedReadRequest, isAllowedWriteRequest } from '../../../lib/requestGuard';
import { callSecureSharingFunctionJson, isSecureSharingEnabled } from '../../../lib/secureSharingServer';
import { localProjectStore } from '../../../lib/localProjectStore';
import { validRestoreProject } from '../../../lib/projectDraftStore';
import { localProjectBase, localRevisionRestore } from '../../../lib/localRevisionRestore';
import { requireCollaborationEditLock } from '../../../lib/collaborationServer';
import type { RestoreSource } from '../../../lib/projectBase';

export const runtime = 'nodejs';
const MAX_PREVIEW_BODY_BYTES = 4096;

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
}

function sharedOnly(): NextResponse | null {
  return isSecureSharingEnabled() ? null : NextResponse.json({ error: 'Server history requires secure sharing.', code: 'SERVER_HISTORY_UNAVAILABLE' }, { status: 501 });
}

// Only metadata is requested by the list operation. A snapshot is fetched on demand.
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedReadRequest(request)) return NextResponse.json({ error: 'read request origin is not allowed' }, { status: 403 });
  const unavailable = sharedOnly();
  if (unavailable) return unavailable;
  const query = new URL(request.url).searchParams;
  const projectId = query.get('projectId');
  if (!validProjectId(projectId)) return NextResponse.json({ error: 'A valid projectId is required.' }, { status: 400 });
  const id = query.get('id');
  if (id !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: 'A valid history id is required.' }, { status: 400 });
  const limit = query.has('limit') ? Number(query.get('limit')) : 50;
  const beforeVersion = query.has('beforeVersion') ? Number(query.get('beforeVersion')) : null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1))) return NextResponse.json({ error: 'History pagination is invalid.' }, { status: 400 });
  const result = await callSecureSharingFunctionJson(request, id ? 'projects.history.get' : 'projects.history.list', { projectId, id, limit, beforeVersion });
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}

// Preview is read-only. Confirmation saves through POST /api/projects with its
// original base and restoreSource; this route never writes project data.
export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: 'write request origin is not allowed' }, { status: 403 });
  if (Number(request.headers.get('content-length')) > MAX_PREVIEW_BODY_BYTES) return NextResponse.json({ error: 'request body is too large' }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_PREVIEW_BODY_BYTES) return NextResponse.json({ error: 'request body is too large' }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid body');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!validProjectId(body.projectId) || !body.source || typeof body.source !== 'object' || Array.isArray(body.source)) return NextResponse.json({ error: 'A projectId and restore source are required.' }, { status: 400 });
  if (!isSecureSharingEnabled()) {
    const access = await requireCollaborationEditLock(request);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    try {
      return await localProjectStore.locked(async () => {
        const raw = await localProjectStore.readProjects();
        const list = Array.isArray(raw) ? raw : (raw as { projects?: unknown } | null)?.projects;
        const head = Array.isArray(list) ? list.find(project => project?.id === body.projectId) : undefined;
        if (!head) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
        if (!validRestoreProject(head)) return NextResponse.json({ error: 'The original project is invalid. Export it before restoring.', code: 'RESTORE_SOURCE_INVALID' }, { status: 409 });
        const project = localRevisionRestore(head, body.source as RestoreSource);
        return NextResponse.json({ project, base: localProjectBase(head), restoreSource: body.source }, { headers: { 'Cache-Control': 'no-store' } });
      });
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Restore preview failed.', code: 'RESTORE_SOURCE_INVALID' }, { status: 409 }); }
  }
  const result = await callSecureSharingFunctionJson(request, 'projects.history.preview', { projectId: body.projectId, source: body.source });
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
