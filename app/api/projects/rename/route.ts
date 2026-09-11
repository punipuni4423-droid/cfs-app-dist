import { NextResponse } from 'next/server';
import { requireApiAccess } from '../../../lib/apiAuth';
import { requireCollaborationEditLock, recordCollaborationSave } from '../../../lib/collaborationServer';
import { isAllowedWriteRequest } from '../../../lib/requestGuard';
import { localProjectStore } from '../../../lib/localProjectStore';
import { callSecureSharingFunction, isSecureSharingEnabled, secureSharingSessionPayload } from '../../../lib/secureSharingServer';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: 'write request origin is not allowed' }, { status: 403 });
  if (request.headers.get('x-cfs-project-id')?.trim()) return NextResponse.json({ error: 'Renaming requires the workspace edit lock.' }, { status: 400 });
  if (Number(request.headers.get('content-length')) > 4096) return NextResponse.json({ error: 'request body is too large' }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 4096) return NextResponse.json({ error: 'request body is too large' }, { status: 413 });
  let body: { projectId?: unknown; name?: unknown; expectedUpdatedAt?: unknown };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!body || typeof body.projectId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.projectId)
    || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 240
    || typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt.trim()) {
    return NextResponse.json({ error: 'projectId, name (1–240 characters) and expectedUpdatedAt are required' }, { status: 400 });
  }
  if (isSecureSharingEnabled()) return callSecureSharingFunction(request, 'project.rename', {
    ...secureSharingSessionPayload(request), projectId: body.projectId, name: body.name.trim(), expectedUpdatedAt: body.expectedUpdatedAt,
  });
  if (process.env.CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC === '1' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Safe rename requires local storage or secure sharing.' }, { status: 503 });
  }
  const edit = await requireCollaborationEditLock(request);
  if (!edit.ok) return NextResponse.json({ error: edit.error }, { status: edit.status });
  try {
    const result = await localProjectStore.locked(async () => {
      const rawProjects = await localProjectStore.readProjects();
      const projects = Array.isArray(rawProjects) ? rawProjects : (rawProjects as { projects?: unknown })?.projects;
      if (!Array.isArray(projects)) throw new Error('Project store is invalid.');
      const matches = projects.filter(candidate => candidate?.id === body.projectId);
      if (matches.length !== 1 || matches[0].updatedAt !== body.expectedUpdatedAt) return null;
      const previousTime = Date.parse(matches[0].updatedAt);
      const project = { ...matches[0], name: (body.name as string).trim(), updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString() };
      await localProjectStore.writeProjects(projects.map(candidate => candidate?.id === body.projectId ? project : candidate));
      return project;
    });
    if (!result) return NextResponse.json({ error: 'Project changed. Reload before renaming.', code: 'PROJECT_CONFLICT' }, { status: 409 });
    const lastUpdatedBy = await recordCollaborationSave(edit.editor);
    return NextResponse.json({ ok: true, project: result, lastUpdatedBy });
  } catch (error) {
    console.error('Project rename failed.', error);
    return NextResponse.json({ error: 'Rename could not be confirmed. Reload before retrying.' }, { status: 503 });
  }
}
