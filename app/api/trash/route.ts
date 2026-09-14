import { requireApiAccess } from "../../lib/apiAuth";
import { localProjectStore } from "../../lib/localProjectStore";
import { NextResponse } from "next/server";
import type { TrashData } from "../../types";
import { requireCollaborationEditLock } from "../../lib/collaborationServer";
import { isAllowedReadRequest, isAllowedWriteRequest } from "../../lib/requestGuard";
import { callSecureSharingFunction, isSecureSharingEnabled, secureSharingSessionPayload } from "../../lib/secureSharingServer";
import { migrateTrashPayload } from "../../lib/storage";
import { canonicalJson } from '../../lib/canonicalJson';

export const runtime = "nodejs";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
type RawTrash = Record<string, unknown> & { projects: unknown[]; roomTypes: unknown[] };

async function readRawTrashSnapshot(): Promise<{ trash: RawTrash; updatedAt: string }> {
  const parsed = await localProjectStore.readTrash() as Record<string, unknown>;
  if (!parsed || !Array.isArray(parsed.projects) || !Array.isArray(parsed.roomTypes)) throw new Error('Trash store is invalid.');
  // Local file metadata is separate from the raw Trash payload returned to callers.
  const { updatedAt, ...trash } = parsed;
  return { trash: trash as RawTrash, updatedAt: typeof updatedAt === 'string' ? updatedAt : '' };
}

async function cleanupRestoredTrash(request: Request, source: Record<string, unknown>): Promise<NextResponse> {
  if (source.saveProtocol !== 2) return NextResponse.json({ code: 'SAVE_PROTOCOL_REQUIRED', error: 'Update the save format.' }, { status: 409 });
  if (request.headers.get('x-cfs-project-id')?.trim() || source.projectId) return NextResponse.json({ error: 'Restore cleanup requires the workspace edit lock.' }, { status: 400 });
  const original = (source.restoreCleanup as { original?: unknown } | null)?.original;
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || typeof (original as { id?: unknown }).id !== 'string' || !(original as { id: string }).id
    || !source.trash || typeof source.trash !== 'object' || Array.isArray(source.trash)) return NextResponse.json({ error: 'Restore cleanup data is invalid.' }, { status: 400 });
  if (isSecureSharingEnabled()) return callSecureSharingFunction(request, 'trash.save', {
    ...secureSharingSessionPayload(request), projectId: '', saveProtocol: 2,
    restoreCleanup: source.restoreCleanup, trash: source.trash, expectedUpdatedAt: source.expectedUpdatedAt,
  });
  if (process.env.CFS_ALLOW_LEGACY_SERVICE_ROLE_SYNC === '1' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Restore cleanup requires local storage or secure sharing.' }, { status: 503 });
  const edit = await requireCollaborationEditLock(request);
  if (!edit.ok) return NextResponse.json({ error: edit.error }, { status: edit.status });
  return localProjectStore.locked(async () => {
    const current = await readRawTrashSnapshot();
    const target = original as { id: string; project?: { id?: unknown } };
    const matches = current.trash.projects.filter(item => item && typeof item === 'object' && (item as { id?: unknown }).id === target.id);
    const next = { ...current.trash, projects: current.trash.projects.filter(item => !matches.includes(item)) };
    if (typeof source.expectedUpdatedAt !== 'string' || source.expectedUpdatedAt !== current.updatedAt
      || matches.length !== 1 || canonicalJson(matches[0]) !== canonicalJson(original)
      || canonicalJson(next) !== canonicalJson(source.trash)) return NextResponse.json({ code: 'TRASH_CONFLICT', error: 'The original Trash item has changed. It is retained without deletion.' }, { status: 409 });
    const rawProjects = await localProjectStore.readProjects();
    const projects = Array.isArray(rawProjects) ? rawProjects : (rawProjects as { projects?: unknown })?.projects;
    if (typeof target.project?.id !== 'string' || !Array.isArray(projects)
      || projects.filter(project => project?.id === target.project!.id).length !== 1) return NextResponse.json({ code: 'PROJECT_RESTORE_REQUIRED', error: 'The restored Project could not be verified. The original Trash item is retained.' }, { status: 409 });
    const commitAccess = await requireCollaborationEditLock(request);
    if (!commitAccess.ok) return NextResponse.json({ error: commitAccess.error }, { status: commitAccess.status });
    const previous = Date.parse(current.updatedAt);
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    await localProjectStore.writeTrash({ ...next, updatedAt });
    return NextResponse.json({ ok: true, trash: next, updatedAt });
  });
}

function rawTrashCounts(value: unknown): { projects: number; roomTypes: number } | null {
  if (value === null || typeof value !== "object") return null;
  const source =
    "trash" in value && typeof (value as { trash?: unknown }).trash === "object"
      ? (value as { trash: unknown }).trash
      : value;
  if (source === null || typeof source !== "object") return null;
  const raw = source as Record<string, unknown>;
  return {
    projects: Array.isArray(raw.projects) ? raw.projects.length : 0,
    roomTypes: Array.isArray(raw.roomTypes) ? raw.roomTypes.length : 0,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function validateProjectScopedTrashUpdate(current: TrashData, next: TrashData, projectId: string): string {
  if (!projectId) return "";
  if (stableJson(current.projects) !== stableJson(next.projects)) {
    return "project-scoped trash saves cannot change trashed projects";
  }
  const currentRoomTypes = new Map(current.roomTypes.map((item) => [item.id, item]));
  const nextRoomTypes = new Map(next.roomTypes.map((item) => [item.id, item]));
  for (const item of current.roomTypes) {
    if (item.projectId === projectId) continue;
    const nextItem = nextRoomTypes.get(item.id);
    if (!nextItem || stableJson(nextItem) !== stableJson(item)) {
      return "project-scoped trash saves cannot change other projects";
    }
  }
  for (const item of next.roomTypes) {
    const currentItem = currentRoomTypes.get(item.id);
    if (!currentItem && item.projectId !== projectId) {
      return "project-scoped trash saves cannot add other projects";
    }
  }
  return "";
}

async function readTrashSnapshot(): Promise<{ trash: TrashData; updatedAt: string }> {
  const parsed = await localProjectStore.readTrash() as { updatedAt?: unknown };
  return { trash: migrateTrashPayload(parsed), updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
}

async function writeTrash(trash: TrashData, updatedAt: string): Promise<void> {
  await localProjectStore.writeTrash({ ...trash, updatedAt });
}

async function withTrashLock<T>(operation: () => Promise<T>): Promise<T> {
  return localProjectStore.locked(operation);
}

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!isAllowedReadRequest(request)) {
    return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
  }
  if (isSecureSharingEnabled()) {
    const response = await callSecureSharingFunction(request, "trash.read");
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
  if (new URL(request.url).searchParams.get('restoreRaw') === '1') {
    return NextResponse.json(await localProjectStore.locked(readRawTrashSnapshot), { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(await localProjectStore.locked(readTrashSnapshot), { headers: { "Cache-Control": "no-store" } });
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

  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'restoreCleanup' in payload) {
    return cleanupRestoredTrash(request, payload as Record<string, unknown>);
  }

  const counts = rawTrashCounts(payload);
  if (!counts) {
    return NextResponse.json({ error: "trash must be an object" }, { status: 400 });
  }

  const trash = migrateTrashPayload(payload);
  if (trash.projects.length !== counts.projects || trash.roomTypes.length !== counts.roomTypes) {
    return NextResponse.json({ error: "trash contains invalid item data" }, { status: 400 });
  }

  if (isSecureSharingEnabled()) {
    return callSecureSharingFunction(request, "trash.save", {
      ...secureSharingSessionPayload(request),
      projectId: request.headers.get("x-cfs-project-id")?.trim() ?? "",
      trash,
      expectedUpdatedAt: (payload as Record<string, unknown>).expectedUpdatedAt,
    });
  }

  const editCheck = await requireCollaborationEditLock(request);
  if (!editCheck.ok) {
    return NextResponse.json({ error: editCheck.error }, { status: editCheck.status });
  }

  return withTrashLock(async () => {
  const current = await readTrashSnapshot();
  const expected = (payload as Record<string, unknown>).expectedUpdatedAt;
  if (typeof expected !== "string" || expected !== current.updatedAt) {
    return NextResponse.json({ error: "Trash has been updated. Reload before saving.", code: "TRASH_CONFLICT", serverUpdatedAt: current.updatedAt }, { status: 409 });
  }
  const scopedProjectId = request.headers.get("x-cfs-project-id")?.trim() ?? "";
  if (scopedProjectId) {
    const validationError = validateProjectScopedTrashUpdate(current.trash, trash, scopedProjectId);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
  }

  const previousTime = Date.parse(current.updatedAt);
  const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
  await writeTrash(trash, updatedAt);
  return NextResponse.json({ ok: true, trash, updatedAt });
  });
}
