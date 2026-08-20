import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { migrateProjectsPayload } from "../../lib/storage";

export const runtime = "nodejs";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "projects.json");
const PROJECTS_LOCK_DIR = `${DATA_FILE}.lock`;
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const PROJECTS_LOCK_TIMEOUT_MS = 5_000;
const PROJECTS_LOCK_STALE_MS = 30_000;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_PROJECTS_TABLE = process.env.SUPABASE_PROJECTS_TABLE ?? "cfs_projects";
const ALLOW_LEGACY_SERVICE_ROLE_SYNC = process.env.CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC?.trim() === "1";
const SUPABASE_TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PROJECT_CONFLICT_MESSAGE = "Project was updated by another user. Reload before saving.";

async function readProjects(): Promise<ProjectData[]> {
  if (isSupabaseConfigured()) {
    return readProjectsFromSupabase();
  }
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return migrateProjectsPayload(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function writeProjects(projects: ReadonlyArray<ProjectData>): Promise<void> {
  if (isSupabaseConfigured()) {
    await writeProjectsToSupabase(projects);
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
  await rename(tmpFile, DATA_FILE);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function acquireProjectsFileLock(): Promise<void> {
  const startedAt = Date.now();
  await mkdir(DATA_DIR, { recursive: true });
  for (;;) {
    try {
      await mkdir(PROJECTS_LOCK_DIR);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - startedAt > PROJECTS_LOCK_TIMEOUT_MS) {
        try {
          const info = await stat(PROJECTS_LOCK_DIR);
          if (Date.now() - info.mtimeMs > PROJECTS_LOCK_STALE_MS) {
            const stalePath = `${PROJECTS_LOCK_DIR}.stale.${process.pid}.${Date.now()}.${randomUUID()}`;
            await rename(PROJECTS_LOCK_DIR, stalePath);
            await rm(stalePath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        throw new Error("Project store is busy. Please try again.");
      }
      await sleep(20);
    }
  }
}

async function withProjectsFileLock<T>(operation: () => Promise<T>): Promise<T> {
  await acquireProjectsFileLock();
  try {
    return await operation();
  } finally {
    await rm(PROJECTS_LOCK_DIR, { recursive: true, force: true });
  }
}

async function readProjectsFromSupabase(): Promise<ProjectData[]> {
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
  return migrateProjectsPayload(rows.map((row) => row.payload));
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

  const staleFilter =
    projects.length === 0
      ? "id=not.is.null"
      : `id=not.in.(${projects.map((project) => encodeURIComponent(project.id)).join(",")})`;
  const deleteResponse = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${staleFilter}`, {
    method: "DELETE",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
  });
  if (!deleteResponse.ok) {
    throw new Error(`Supabase project stale-row cleanup failed: ${deleteResponse.status}`);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAllowedReadRequest(request)) {
    return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
  }
  if (isSecureSharingEnabled()) {
    return callSecureSharingFunction(request, "projects.read");
  }
  const projects = await readProjects();
  return NextResponse.json({ projects });
}

export async function POST(request: Request): Promise<NextResponse> {
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
  if (rawProject !== undefined) {
    const projects = migrateProjectsPayload([rawProject]);
    if (projects.length !== 1) {
      return NextResponse.json({ error: "project contains invalid project data" }, { status: 400 });
    }

    const project = projects[0];
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
    if (isSecureSharingEnabled()) {
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
    await withProjectsFileLock(async () => {
      const currentProjects = await readProjects();
      const existing = currentProjects.find((candidate) => candidate.id === project.id);
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
      const replaced = Boolean(existing);
      nextProjects = replaced
        ? currentProjects.map((candidate) => (candidate.id === project.id ? project : candidate))
        : [project, ...currentProjects];
      await writeProjects(nextProjects);
    });
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

  const projects = migrateProjectsPayload(rawProjects);
  if (projects.length !== rawProjects.length) {
    return NextResponse.json({ error: "projects contains invalid project data" }, { status: 400 });
  }

  if (isSecureSharingEnabled()) {
    return callSecureSharingFunction(request, "projects.save", { ...secureSharingSessionPayload(request), projects });
  }

  const editCheck = await requireCollaborationEditLock(request);
  if (!editCheck.ok) {
    return NextResponse.json({ error: editCheck.error }, { status: editCheck.status });
  }

  await withProjectsFileLock(() => writeProjects(projects));
  const lastUpdatedBy = await recordCollaborationSave(editCheck.editor);
  return NextResponse.json({ ok: true, projects, lastUpdatedBy });
}
