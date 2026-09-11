import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireApiAccess } from '../../../lib/apiAuth';
import { requireCollaborationEditLock } from '../../../lib/collaborationServer';
import { isAllowedWriteRequest } from '../../../lib/requestGuard';
import { localProjectStore } from '../../../lib/localProjectStore';
import { callSecureSharingFunction, isSecureSharingEnabled, secureSharingSessionPayload } from '../../../lib/secureSharingServer';

export const runtime = 'nodejs';
const MAX_TRASH_BYTES = 10 * 1024 * 1024;

function trashByteSize(value: unknown): number {
  const json = JSON.stringify(value);
  let separators = 0;
  let quoted = false;
  let escaped = false;
  for (const character of json) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && (character === ',' || character === ':')) separators++;
  }
  return Buffer.byteLength(json, 'utf8') + separators;
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: 'write request origin is not allowed' }, { status: 403 });
  if (request.headers.get('x-cfs-project-id')?.trim()) {
    return NextResponse.json({ error: 'Deleting a project requires the workspace edit lock.' }, { status: 400 });
  }
  if (Number(request.headers.get('content-length')) > 4096) return NextResponse.json({ error: 'request body is too large' }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 4096) return NextResponse.json({ error: 'request body is too large' }, { status: 413 });
  let body: { projectId?: unknown; expectedUpdatedAt?: unknown };
  try { body = JSON.parse(raw); }
  catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!body || typeof body.projectId !== 'string' || !body.projectId.trim() || typeof body.expectedUpdatedAt !== 'string') {
    return NextResponse.json({ error: 'projectId and expectedUpdatedAt are required' }, { status: 400 });
  }
  if (isSecureSharingEnabled()) {
    return callSecureSharingFunction(request, 'projects.delete', {
      ...secureSharingSessionPayload(request), projectId: body.projectId, expectedUpdatedAt: body.expectedUpdatedAt,
    });
  }
  // The legacy remote project table and local trash cannot share a transaction.
  if (process.env.CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC === '1' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Atomic deletion requires local storage or secure sharing.' }, { status: 503 });
  }
  const edit = await requireCollaborationEditLock(request);
  if (!edit.ok) return NextResponse.json({ error: edit.error }, { status: edit.status });
  try {
    return await localProjectStore.locked(async () => {
      const source = await localProjectStore.readProjects();
      const projects = Array.isArray(source) ? source : (source as { projects?: unknown })?.projects;
      if (!Array.isArray(projects)) throw new Error('Project store is invalid.');
      const matches = projects.filter(project => project?.id === body.projectId);
      if (matches.length !== 1 || matches[0].updatedAt !== body.expectedUpdatedAt) {
        return NextResponse.json({ error: 'Project changed. Reload before deleting.', code: 'PROJECT_CONFLICT' }, { status: 409 });
      }
      const previous = await localProjectStore.readTrash() as Record<string, unknown>;
      if (!previous || !Array.isArray(previous.projects) || !Array.isArray(previous.roomTypes)) throw new Error('Trash store is invalid.');
      const lastTime = Date.parse(typeof previous.updatedAt === 'string' ? previous.updatedAt : '');
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(lastTime) ? lastTime + 1 : 0)).toISOString();
      const trash = { projects: [{ id: randomUUID(), deletedAt: updatedAt, project: matches[0] }, ...previous.projects], roomTypes: previous.roomTypes };
      // JSONB uses spaces after separators; count the same conservative encoding.
      const bytes = trashByteSize(trash);
      if (bytes >= MAX_TRASH_BYTES) return NextResponse.json({ error: 'Trash reaches the 10 MiB limit. Project was not deleted.' }, { status: 413 });
      const remaining = projects.filter(project => project?.id !== body.projectId);
      await localProjectStore.commit(remaining, { ...trash, updatedAt });
      return NextResponse.json({ ok: true, projects: remaining, trash, updatedAt });
    });
  } catch (error) {
    console.error('Atomic project deletion failed.', error);
    return NextResponse.json({ error: 'Deletion could not be confirmed. Reload to check the project and Trash.' }, { status: 503 });
  }
}
