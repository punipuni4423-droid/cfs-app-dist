import { requireApiAccess } from "../../lib/apiAuth";
import { createHash } from "node:crypto";
import { localProjectStore } from "../../lib/localProjectStore";
import { NextResponse } from "next/server";
import type { ProjectData } from "../../types";
import { recordCollaborationSave, requireCollaborationEditLock, requireCollaborationProjectCreate } from "../../lib/collaborationServer";
import { isAllowedReadRequest, isAllowedWriteRequest } from "../../lib/requestGuard";
import {
  callSecureSharingFunction,
  callSecureSharingFunctionJson,
  isSecureSharingEnabled,
  secureSharingSessionPayload,
} from "../../lib/secureSharingServer";
import { migrateProjectsPayload, migrateProjectsWithReport } from "../../lib/storage";
import { collectionLosses, migrationReport } from "../../lib/migrationSafety";
import { commonHistoryPreserved, matchesSaveIntent, saveContent, SAVE_PROTOCOL_VERSION } from '../../lib/projectSaveProtocol';
import { validCommonHistory } from '../../lib/projectCommonHistory';
import { canonicalJson } from '../../lib/canonicalJson';

export const runtime = "nodejs";

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_PROJECTS_TABLE = process.env.SUPABASE_PROJECTS_TABLE ?? "cfs_projects";
const ALLOW_LEGACY_SERVICE_ROLE_SYNC = process.env.CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC?.trim() === "1";
const SUPABASE_TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PROJECT_CONFLICT_MESSAGE = "Project was updated by another user. Reload before saving.";

async function readRawProjects(): Promise<unknown> {
  if (isSupabaseConfigured()) {
    return readProjectsFromSupabase();
  }
  return localProjectStore.readProjects();
}

async function writeProjects(projects: ReadonlyArray<ProjectData>): Promise<void> {
  if (isSupabaseConfigured()) {
    await writeProjectsToSupabase(projects);
    return;
  }
  await localProjectStore.writeProjects(projects);
}

function isSupabaseConfigured(): boolean {
  return ALLOW_LEGACY_SERVICE_ROLE_SYNC && Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseTableName(): string {
  if (!SUPABASE_TABLE_NAME_PATTERN.test(SUPABASE_PROJECTS_TABLE)) {
    throw new Error("SUPABASE_PROJECTS_TABLE must be a simple table name.");
  }
  return SUPABASE_PROJECTS_TABLE;
}

function supabaseHeaders(extra?: HeadersInit): HeadersInit {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

function requestProjectId(request: Request): string {
  return request.headers.get("x-cfs-project-id")?.trim() ?? "";
}

function projectConflictResponse(project?: ProjectData): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: "PROJECT_CONFLICT",
      error: PROJECT_CONFLICT_MESSAGE,
      project,
      serverUpdatedAt: project?.updatedAt ?? "",
    },
    { status: 409 },
  );
}

async function withProjectsFileLock<T>(operation: () => Promise<T>): Promise<T> {
  return localProjectStore.locked(operation);
}

async function readProjectsFromSupabase(): Promise<unknown> {
  const table = supabaseTableName();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=id,payload,updated_at&order=updated_at.desc`,
    {
      cache: "no-store",
      headers: supabaseHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`Supabase project read failed: ${response.status}`);
  }
  const rows = (await response.json()) as Array<{ payload?: unknown }>;
  return rows.map((row) => row.payload);
}

function rawProjectList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { projects?: unknown }).projects)) {
    return (value as { projects: unknown[] }).projects;
  }
  return [];
}

function validSaveMetadata(project: ProjectData): boolean {
  const op = project.lastSaveOperation;
  return op === undefined || Boolean(op && typeof op.id === 'string' && op.id
    && ['current', 'revision', 'idle'].includes(op.kind) && typeof op.fingerprint === 'string' && op.fingerprint);
}

function restoreContent(project: ProjectData): string | undefined {
  return canonicalJson({ ...saveContent(project) as Record<string, unknown>, name: undefined });
}

async function trashedProjects(): Promise<ProjectData[]> {
  const trash = await localProjectStore.readTrash() as { projects?: Array<{ project?: ProjectData }> };
  if (!Array.isArray(trash?.projects)) throw new Error('Trash store is invalid.');
  return trash.projects.map(item => item.project).filter((project): project is ProjectData => Boolean(project));
}

function shrinkageResponse(before: unknown, rawIncoming: unknown[], source: Record<string, unknown>): NextResponse | undefined {
  const inputReport = migrateProjectsWithReport(rawIncoming).report;
  // Compare the requested data, before normalization can refill empty legacy arrays.
  const report = migrationReport([...collectionLosses(before, rawIncoming), ...inputReport.issues]);
  if (!report.issues.length) return undefined;
  // Bind confirmation to both snapshots, so a concurrent change requires a new review.
  const confirmation = createHash('sha256').update(JSON.stringify({ before, rawIncoming })).digest('hex');
  if (source.migrationConfirmation === confirmation) return undefined;
  console.warn('CFS MigrationReport: save blocked', report);
  return NextResponse.json({
    code: 'MIGRATION_CONFIRMATION_REQUIRED',
    error: 'A save that reduces data counts was blocked. Review the repairs, exclusions, or deletions.',
    migrationReport: report,
    migrationConfirmation: confirmation,
  }, { status: 409 });
}

async function writeProjectsToSupabase(projects: ReadonlyArray<ProjectData>): Promise<void> {
  const table = supabaseTableName();
  if (projects.length > 0) {
    const rows = projects.map((project) => ({
      id: project.id,
      name: project.name,
      updated_at: project.updatedAt,
      payload: project,
    }));
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=id`, {
      method: "POST",
      headers: supabaseHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(rows),
    });
    if (!response.ok) {
      throw new Error(`Supabase project write failed: ${response.status}`);
    }
  }

  // Absence from a caller snapshot never authorizes deletion.
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedReadRequest(request)) {
    return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
  }
  const restoreRaw = new URL(request.url).searchParams.get('restoreRaw') === '1';
  if (isSecureSharingEnabled()) {
    const result = await callSecureSharingFunctionJson(request, "projects.read");
    if (result.status !== 200) return NextResponse.json(result.body, { status: result.status });
    if (restoreRaw) return NextResponse.json(result.body, { headers: { 'Cache-Control': 'no-store' } });
    const { projects, report } = migrateProjectsWithReport(result.body);
    if (report.issues.length) console.warn('CFS MigrationReport', report);
    return NextResponse.json({ ...result.body, projects, migrationReport: report });
  }
  const raw = await localProjectStore.locked(readRawProjects);
  if (restoreRaw) return NextResponse.json({ projects: rawProjectList(raw) }, { headers: { 'Cache-Control': 'no-store' } });
  const { projects, report } = migrateProjectsWithReport(raw);
  if (report.issues.length) console.warn('CFS MigrationReport', report);
  return NextResponse.json({ projects, migrationReport: report });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) {
    return NextResponse.json({ error: "write request origin is not allowed" }, { status: 403 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body is too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const source = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const rawProject = source.project;
  if (source.saveProtocol !== SAVE_PROTOCOL_VERSION) return NextResponse.json({ error: 'Update the save format.', code: 'SAVE_PROTOCOL_REQUIRED' }, { status: 409 });
  // Legacy direct table upserts cannot enforce the SQL save contract.
  if (!isSecureSharingEnabled() && isSupabaseConfigured()) return NextResponse.json({ error: 'Safe project saves require local storage or secure sharing.', code: 'SAVE_PROTOCOL_REQUIRED' }, { status: 503 });
  if (rawProject !== undefined) {
    const projects = migrateProjectsPayload([rawProject]);
    if (projects.length !== 1) {
      return NextResponse.json({ error: "project contains invalid project data" }, { status: 400 });
    }

    let project = projects[0];
    if (project.commonRevisions !== undefined && !validCommonHistory(project.commonRevisions)) return NextResponse.json({ error: 'Common history is invalid. Check the original data.', code: 'COMMON_HISTORY_PROTECTED' }, { status: 409 });
    if (!validSaveMetadata(project)) return NextResponse.json({ error: 'The save operation is invalid.' }, { status: 400 });
    const scopedProjectId = requestProjectId(request);
    if (scopedProjectId && scopedProjectId !== project.id) {
      return NextResponse.json({ error: "project id does not match the edit lock scope" }, { status: 400 });
    }

    const expectedUpdatedAt = typeof source.expectedUpdatedAt === "string" ? source.expectedUpdatedAt.trim() : "";
    const createOnly = source.createOnly === true;
    const forceOverwrite = !createOnly && source.forceOverwrite === true;
    const forceOverwriteUpdatedAt = typeof source.forceOverwriteUpdatedAt === "string"
      ? source.forceOverwriteUpdatedAt.trim()
      : "";
    if (expectedUpdatedAt.startsWith('__CFS_') || forceOverwriteUpdatedAt.startsWith('__CFS_')) {
      return NextResponse.json({ error: 'Reserved update tokens cannot be used.' }, { status: 400 });
    }
    if (isSecureSharingEnabled()) {
      const snapshot = await callSecureSharingFunctionJson(request, "projects.read");
      if (snapshot.status !== 200) return NextResponse.json(snapshot.body, { status: snapshot.status });
      const rawExisting = rawProjectList(snapshot.body).filter((candidate) =>
        candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === project.id);
      const blocked = shrinkageResponse(rawExisting, [rawProject], source);
      if (blocked) return blocked;
      if (forceOverwrite) {
        const latest = await callSecureSharingFunctionJson(request, "projects.read");
        if (latest.status !== 200) {
          return NextResponse.json(latest.body, { status: latest.status });
        }
        const latestProjects = migrateProjectsPayload(latest.body.projects);
        const existing = latestProjects.find((candidate) => candidate.id === project.id);
        if (!existing || !forceOverwriteUpdatedAt || existing.updatedAt !== forceOverwriteUpdatedAt) {
          return projectConflictResponse(existing);
        }
        return callSecureSharingFunction(request, "project.save", {
          ...secureSharingSessionPayload(request),
          projectId: project.id,
          saveProtocol: SAVE_PROTOCOL_VERSION,
          project,
          expectedUpdatedAt: existing.updatedAt,
          createOnly,
          forceOverwrite,
          forceOverwriteUpdatedAt,
        });
      }
      return callSecureSharingFunction(request, "project.save", {
        ...secureSharingSessionPayload(request),
        projectId: project.id,
        saveProtocol: SAVE_PROTOCOL_VERSION,
        project,
        expectedUpdatedAt,
        createOnly,
        forceOverwrite,
        forceOverwriteUpdatedAt,
      });
    }

    const editCheck = createOnly
      ? await requireCollaborationProjectCreate(request)
      : await requireCollaborationEditLock(request);
    if (!editCheck.ok) {
      return NextResponse.json({ error: editCheck.error }, { status: editCheck.status });
    }

    let nextProjects: ProjectData[] = [];
    let conflict = false;
    let conflictProject: ProjectData | undefined;
    let migrationBlocked: NextResponse | undefined;
    await withProjectsFileLock(async () => {
      const rawCurrent = rawProjectList(await readRawProjects());
      const currentProjects = migrateProjectsPayload(rawCurrent);
      const existing = currentProjects.find((candidate) => candidate.id === project.id);
      if (currentProjects.filter(candidate => candidate.id === project.id).length > 1) { conflict = true; return; }
      if (existing?.commonRevisions !== undefined && !validCommonHistory(existing.commonRevisions)) {
        migrationBlocked = NextResponse.json({ error: 'Saved common history is invalid. Check the original data.', code: 'COMMON_HISTORY_PROTECTED' }, { status: 409 }); return;
      }
      if (existing && await matchesSaveIntent(project, existing)) { project = existing; nextProjects = currentProjects; return; }
      if (existing && project.lastSaveOperation && existing.lastSaveOperation?.id === project.lastSaveOperation.id) {
        migrationBlocked = NextResponse.json({ error: 'The contents for the same save operation do not match. Check Save Status.', code: 'SAVE_OPERATION_CONFLICT' }, { status: 409 }); return;
      }
      if (!createOnly && !existing) { conflict = true; nextProjects = currentProjects; return; }
      if (createOnly && (await trashedProjects()).some(item => item.id === project.id)) { conflict = true; return; }
      if (!commonHistoryPreserved(existing, project)) {
        migrationBlocked = NextResponse.json({ error: 'Existing common history cannot be deleted or changed.', code: 'COMMON_HISTORY_PROTECTED' }, { status: 409 }); return;
      }
      if (existing && createOnly) {
        conflict = true;
        conflictProject = existing;
        nextProjects = currentProjects;
        return;
      }
      if (existing && forceOverwrite) {
        if (!forceOverwriteUpdatedAt || existing.updatedAt !== forceOverwriteUpdatedAt) {
          conflict = true;
          conflictProject = existing;
          nextProjects = currentProjects;
          return;
        }
      } else if (existing && !expectedUpdatedAt) {
        conflict = true;
        conflictProject = existing;
        nextProjects = currentProjects;
        return;
      } else if (existing && expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
        conflict = true;
        conflictProject = existing;
        nextProjects = currentProjects;
        return;
      }
      const rawExisting = rawCurrent.filter((candidate) => candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === project.id);
      migrationBlocked = shrinkageResponse(rawExisting, [rawProject], source);
      if (migrationBlocked) return;
      const previousTime = Date.parse(existing?.updatedAt ?? '');
      project = { ...project, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString() };
      const replaced = Boolean(existing);
      nextProjects = replaced
        ? currentProjects.map((candidate) => (candidate.id === project.id ? project : candidate))
        : [project, ...currentProjects];
      // Preserve unrelated raw projects; reading one broken project must not rewrite all others.
      const rawNext = rawExisting.length
        ? rawCurrent.map((candidate) => rawExisting.includes(candidate) ? project : candidate)
        : [project, ...rawCurrent];
      const commitAccess = createOnly ? await requireCollaborationProjectCreate(request) : await requireCollaborationEditLock(request);
      if (!commitAccess.ok) {
        migrationBlocked = NextResponse.json({ error: commitAccess.error }, { status: commitAccess.status }); return;
      }
      await writeProjects(rawNext as ProjectData[]);
    });
    if (migrationBlocked) return migrationBlocked;
    if (conflict) {
      return projectConflictResponse(conflictProject);
    }
    const lastUpdatedBy = await recordCollaborationSave(editCheck.editor);
    return NextResponse.json({ ok: true, project, projects: nextProjects, lastUpdatedBy });
  }

  const rawProjects = source.projects;
  if (!Array.isArray(rawProjects)) {
    return NextResponse.json({ error: "projects must be an array" }, { status: 400 });
  }
  if (requestProjectId(request)) {
    return NextResponse.json({ error: "project-scoped requests must save one project" }, { status: 400 });
  }

  const restoreRaw = source.restoreRaw === true;
  if (restoreRaw && (!Array.isArray(source.restoreProjectIds) || !source.restoreProjectIds.length
    || source.restoreProjectIds.length !== rawProjects.length
    || rawProjects.some(project => !project || typeof project !== 'object' || Array.isArray(project)
      || typeof project.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(project.id)
      || typeof project.name !== 'string' || !project.name.trim() || !Array.isArray(project.roomTypes)
      || project.roomTypes.some((room: unknown) => !room || typeof room !== 'object' || Array.isArray(room))
      || !(source.restoreProjectIds as unknown[]).includes(project.id)))) {
    return NextResponse.json({ error: 'An original-data restore can save only the explicitly selected restore targets.' }, { status: 400 });
  }
  const projects = restoreRaw ? rawProjects as ProjectData[] : migrateProjectsPayload(rawProjects);
  if (projects.some(project => project.commonRevisions !== undefined && !validCommonHistory(project.commonRevisions))) return NextResponse.json({ error: 'Common history is invalid.', code: 'COMMON_HISTORY_PROTECTED' }, { status: 409 });
  if (projects.some(project => !validSaveMetadata(project))) return NextResponse.json({ error: 'The save operation is invalid.' }, { status: 400 });
  if (projects.length !== rawProjects.length) {
    return NextResponse.json({ error: "projects contains invalid project data" }, { status: 400 });
  }
  const expected = source.expectedUpdatedAts;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || new Set(projects.map(project => project.id)).size !== projects.length
    || projects.some(project => !Object.prototype.hasOwnProperty.call(expected, project.id)
      || ((expected as Record<string, unknown>)[project.id] !== null && typeof (expected as Record<string, unknown>)[project.id] !== 'string'))) {
    return NextResponse.json({ error: 'Project list saves require per-ID update tokens. Reload or upgrade the app.', code: 'PROJECT_LIST_UPGRADE_REQUIRED' }, { status: 409 });
  }
  const expectedUpdatedAts = expected as Record<string, string | null>;
  const submittedIds = new Set(projects.map(project => project.id));
  const restoreProjectIds = source.restoreProjectIds ?? [];
  if (!Array.isArray(restoreProjectIds) || restoreProjectIds.some(id => typeof id !== 'string' || !submittedIds.has(id))) return NextResponse.json({ error: 'The restore target is invalid.' }, { status: 400 });
  const restoreIds = new Set(restoreProjectIds as string[]);
  const targetedRaw = (raw: unknown[]) => raw.filter(candidate => candidate && typeof candidate === 'object' && submittedIds.has((candidate as { id: string }).id));

  if (isSecureSharingEnabled()) {
    const snapshot = await callSecureSharingFunctionJson(request, "projects.read");
    if (snapshot.status !== 200) return NextResponse.json(snapshot.body, { status: snapshot.status });
    const blocked = restoreRaw ? undefined : shrinkageResponse(targetedRaw(rawProjectList(snapshot.body)), rawProjects, source);
    if (blocked) return blocked;
    return callSecureSharingFunction(request, "projects.merge", { ...secureSharingSessionPayload(request), saveProtocol: SAVE_PROTOCOL_VERSION, projects, expectedUpdatedAts, restoreProjectIds, restoreRaw });
  }

  if (isSupabaseConfigured()) return NextResponse.json({ error: 'Safe list updates require local storage or secure sharing.' }, { status: 503 });

  const editCheck = await requireCollaborationEditLock(request);
  if (!editCheck.ok) {
    return NextResponse.json({ error: editCheck.error }, { status: editCheck.status });
  }

  let savedProjects = projects;
  const blocked = await withProjectsFileLock(async () => {
    const current = rawProjectList(await readRawProjects());
    const trashProjects = await trashedProjects();
    const receipts = new Map<string, ProjectData>();
    for (const project of projects) {
      const matches = current.filter(candidate => candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === project.id) as ProjectData[];
      if (matches[0]?.commonRevisions !== undefined && !validCommonHistory(matches[0].commonRevisions)) return NextResponse.json({ error: 'Saved common history is invalid.', code: 'COMMON_HISTORY_PROTECTED' }, { status: 409 });
      if (matches.length === 1 && await matchesSaveIntent(project, matches[0])) { receipts.set(project.id, matches[0]); continue; }
      if (matches[0] && project.lastSaveOperation && matches[0].lastSaveOperation?.id === project.lastSaveOperation.id) return NextResponse.json({ error: 'The contents for the same save operation do not match.', code: 'SAVE_OPERATION_CONFLICT' }, { status: 409 });
      if (!commonHistoryPreserved(matches[0], project)) return NextResponse.json({ error: 'Existing common history cannot be deleted or changed.', code: 'COMMON_HISTORY_PROTECTED' }, { status: 409 });
      if (matches.length > 1 || (matches.length ? matches[0].updatedAt !== expectedUpdatedAts[project.id] : expectedUpdatedAts[project.id] !== null)) return projectConflictResponse(matches[0]);
      const originals = trashProjects.filter(item => item.id === project.id);
      if (restoreIds.has(project.id)) {
        if (matches.length || !originals.some(item => Array.isArray(item.roomTypes) && restoreContent(item) === restoreContent(project))) return NextResponse.json({ error: 'The restore contents do not match the original Trash item.', code: 'PROJECT_RESTORE_REQUIRED' }, { status: 409 });
      } else if (!matches.length && originals.length) return NextResponse.json({ error: 'Explicitly restore the project from Trash.', code: 'PROJECT_RESTORE_REQUIRED' }, { status: 409 });
    }
    const rejected = restoreRaw ? undefined : shrinkageResponse(targetedRaw(current), rawProjects, source);
    if (rejected) return rejected;
    savedProjects = projects.map(project => {
      if (receipts.has(project.id)) return receipts.get(project.id)!;
      const previous = current.find(candidate => candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === project.id) as ProjectData | undefined;
      const previousTime = Date.parse(previous?.updatedAt ?? '');
      return { ...project, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString() };
    });
    const updates = new Map(savedProjects.map(project => [project.id, project]));
    const existingIds = new Set(current.map(candidate => candidate && typeof candidate === 'object' ? (candidate as { id?: unknown }).id : undefined));
    const commitAccess = await requireCollaborationEditLock(request);
    if (!commitAccess.ok) return NextResponse.json({ error: commitAccess.error }, { status: commitAccess.status });
    await writeProjects([...savedProjects.filter(project => !existingIds.has(project.id)), ...current.map(candidate =>
      candidate && typeof candidate === 'object' ? updates.get((candidate as { id: string }).id) ?? candidate : candidate)] as ProjectData[]);
  });
  if (blocked) return blocked;
  const lastUpdatedBy = await recordCollaborationSave(editCheck.editor);
  return NextResponse.json({ ok: true, projects: savedProjects, lastUpdatedBy });
}
