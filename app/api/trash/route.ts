import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import type { TrashData } from "../../types";
import { requireCollaborationEditLock } from "../../lib/collaborationServer";
import { isAllowedReadRequest, isAllowedWriteRequest } from "../../lib/requestGuard";
import { callSecureSharingFunction, isSecureSharingEnabled, secureSharingSessionPayload } from "../../lib/secureSharingServer";
import { emptyTrashData, migrateTrashPayload } from "../../lib/storage";

export const runtime = "nodejs";

const DATA_DIR = path.join(process.cwd(), "data");
const TRASH_DIR = path.join(DATA_DIR, "trash");
const TRASH_FILE = path.join(TRASH_DIR, "trash.json");
const MAX_BODY_BYTES = 10 * 1024 * 1024;

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

async function readTrash(): Promise<TrashData> {
  try {
    const raw = await readFile(TRASH_FILE, "utf8");
    if (raw.trim() === "") return emptyTrashData();
    return migrateTrashPayload(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyTrashData();
    throw error;
  }
}

async function writeTrash(trash: TrashData): Promise<void> {
  await mkdir(TRASH_DIR, { recursive: true });
  const tmpFile = `${TRASH_FILE}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(trash, null, 2)}\n`, "utf8");
  await rename(tmpFile, TRASH_FILE);
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAllowedReadRequest(request)) {
    return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
  }
  if (isSecureSharingEnabled()) {
    return callSecureSharingFunction(request, "trash.read");
  }
  const trash = await readTrash();
  return NextResponse.json({ trash });
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
    });
  }

  const editCheck = await requireCollaborationEditLock(request);
  if (!editCheck.ok) {
    return NextResponse.json({ error: editCheck.error }, { status: editCheck.status });
  }

  const scopedProjectId = request.headers.get("x-cfs-project-id")?.trim() ?? "";
  if (scopedProjectId) {
    const validationError = validateProjectScopedTrashUpdate(await readTrash(), trash, scopedProjectId);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
  }

  await writeTrash(trash);
  return NextResponse.json({ ok: true, trash });
}
