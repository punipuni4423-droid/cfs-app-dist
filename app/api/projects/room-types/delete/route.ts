import { NextResponse } from 'next/server';
import { requireApiAccess } from '../../../../lib/apiAuth';
import { requireCollaborationEditLock } from '../../../../lib/collaborationServer';
import { isAllowedReadRequest, isAllowedWriteRequest } from '../../../../lib/requestGuard';
import { localProjectStore } from '../../../../lib/localProjectStore';
import { localProjectBase } from '../../../../lib/localRevisionRestore';
import { validProjectBase, type ProjectBase } from '../../../../lib/projectBase';
import { callSecureSharingFunction, callSecureSharingFunctionJson, isSecureSharingEnabled, secureSharingSessionPayload } from '../../../../lib/secureSharingServer';
import type { ProjectData, TrashData } from '../../../../types';

export const runtime = 'nodejs';
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const conflict = () => NextResponse.json({ code: 'PROJECT_CONFLICT', error: 'The project changed. Reload before deleting the Room Type.' }, { status: 409 });
function projectsOf(source: unknown): ProjectData[] {
  const projects = Array.isArray(source) ? source : (source as { projects?: unknown })?.projects;
  if (!Array.isArray(projects)) throw new Error('Project store is invalid.');
  return projects;
}
function scopeMatches(request: Request, projectId: string): boolean {
  const scope = request.headers.get('x-cfs-project-id')?.trim();
  return !scope || scope === projectId;
}
function legacyRemote(): boolean {
  return process.env.CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC === '1' && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Read the exact deletion base without migration, drafts or local fallback. */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedReadRequest(request)) return NextResponse.json({ error: 'Read request origin is not allowed.' }, { status: 403 });
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!identifier(projectId) || !scopeMatches(request, projectId)) return NextResponse.json({ error: 'Invalid project scope.' }, { status: 400 });
  try {
    if (isSecureSharingEnabled()) {
      const response = await callSecureSharingFunctionJson(request, 'projects.read');
      if (response.status !== 200) return NextResponse.json(response.body, { status: response.status });
      const matches = projectsOf(response.body).filter(project => project?.id === projectId);
      const base = (response.body.bases as Record<string, unknown> | undefined)?.[projectId];
      if (matches.length !== 1 || !validProjectBase(base)) return conflict();
      return NextResponse.json({ project: matches[0], base }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (legacyRemote()) return NextResponse.json({ error: 'Atomic Room Type deletion requires local storage or secure sharing.' }, { status: 503 });
    return await localProjectStore.locked(async () => {
      const matches = projectsOf(await localProjectStore.readProjects()).filter(project => project?.id === projectId);
      if (matches.length !== 1) return conflict();
      return NextResponse.json({ project: matches[0], base: localProjectBase(matches[0]) }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch {
    return NextResponse.json({ error: 'The deletion base could not be verified.' }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: 'Write request origin is not allowed.' }, { status: 403 });
  if (Number(request.headers.get('content-length')) > 4096) return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 4096) return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
  let body: { projectId: string; roomTypeId: string; operationId: string; base: ProjectBase };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || !identifier(body.projectId) || !identifier(body.roomTypeId)
    || typeof body.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operationId)
    || !validProjectBase(body.base) || !scopeMatches(request, body.projectId)) {
    return NextResponse.json({ error: 'Project, Room Type, operation and exact base are required.' }, { status: 400 });
  }
  if (isSecureSharingEnabled()) return callSecureSharingFunction(request, 'room-types.delete', {
    ...secureSharingSessionPayload(request), projectId: body.projectId, roomTypeId: body.roomTypeId, operationId: body.operationId, base: body.base,
  });
  if (legacyRemote()) return NextResponse.json({ error: 'Atomic Room Type deletion requires local storage or secure sharing.' }, { status: 503 });
  const edit = await requireCollaborationEditLock(request);
  if (!edit.ok) return NextResponse.json({ error: edit.error }, { status: edit.status });
  try {
    return await localProjectStore.locked(async () => {
      const projects = projectsOf(await localProjectStore.readProjects());
      const matches = projects.filter(project => project?.id === body.projectId);
      if (matches.length !== 1 || !Array.isArray(matches[0].roomTypes)) return conflict();
      const original = matches[0], base = localProjectBase(original);
      if (body.base.version !== base.version || body.base.hash !== base.hash || body.base.updatedAt !== base.updatedAt) return conflict();
      const rooms = original.roomTypes.filter(room => room?.id === body.roomTypeId);
      if (rooms.length !== 1) return conflict();
      const previous = await localProjectStore.readTrash() as TrashData & { updatedAt?: string };
      if (!previous || !Array.isArray(previous.projects) || !Array.isArray(previous.roomTypes)) throw new Error('Trash store is invalid.');
      if ([...previous.projects, ...previous.roomTypes].some(item => item.id === body.operationId)) return conflict();
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(original.updatedAt) || 0) + 1, (Date.parse(previous.updatedAt ?? '') || 0) + 1)).toISOString();
      const project = { ...original, roomTypes: original.roomTypes.filter(room => room.id !== body.roomTypeId), updatedAt };
      // The old save receipt does not describe the new project contents.
      delete project.lastSaveOperation;
      const item = { id: body.operationId, deletedAt: updatedAt, projectId: original.id, projectName: original.name, roomType: rooms[0] };
      const trash = { ...previous, roomTypes: [item, ...previous.roomTypes] };
      // Pretty-print size is conservative relative to PostgreSQL JSONB encoding.
      if (Buffer.byteLength(JSON.stringify(trash, null, 1), 'utf8') >= 10 * 1024 * 1024) {
        return NextResponse.json({ error: 'Trash capacity has been reached. The Room Type was not deleted.' }, { status: 413 });
      }
      const access = await requireCollaborationEditLock(request);
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      await localProjectStore.commit(projects.map(value => value === original ? project : value), { ...trash, updatedAt });
      return NextResponse.json({ ok: true, operationId: body.operationId, projectId: project.id, base: localProjectBase(project), updatedAt });
    });
  } catch {
    return NextResponse.json({ code: 'SAVE_RESULT_UNKNOWN', error: 'Deletion could not be confirmed. Check the project and Trash before retrying.' }, { status: 503 });
  }
}
