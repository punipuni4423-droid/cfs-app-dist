import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { DeviceMaster, ProjectData } from "../../../types";
import { buildCfsLutronBridgeExport } from "../../../lib/lutronBridgeExport";
import { buildLutronAutomationSpec } from "../../../lib/lutronSpec";
import { isAllowedReadRequest } from "../../../lib/requestGuard";
import { migrateProjectsPayload } from "../../../lib/storage";
import { callSecureSharingFunction, isSecureSharingEnabled } from "../../../lib/secureSharingServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA_FILE = path.join(process.cwd(), "data", "projects.json");
const MAX_BODY_BYTES = 50 * 1024 * 1024;

async function readProjects(request: Request): Promise<ProjectData[]> {
  if (isSecureSharingEnabled()) {
    const response = await callSecureSharingFunction(request, "projects.read");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(typeof payload?.error === "string" ? payload.error : "Could not read shared CFS projects."), { status: response.status });
    }
    return migrateProjectsPayload(payload);
  }
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return migrateProjectsPayload(JSON.parse(raw) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function findProject(projects: readonly ProjectData[], projectId: string | null): ProjectData | undefined {
  if (projectId) return projects.find((project) => project.id === projectId);
  return projects[0];
}

function specErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message === "Project has no room types." || error.message === "Selected room type was not found.")
  ) {
    return error.message;
  }
  return "spec generation failed";
}

function isBridgeFormat(value: string | null | undefined): boolean {
  return ["bridge", "ld", "lutron-designer"].includes((value ?? "").trim().toLowerCase());
}

function parseRoomTypeIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return ids.length === value.length ? ids : undefined;
}

function parseDevices(value: unknown): DeviceMaster[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const devices = value.filter((device): device is DeviceMaster => {
    if (device === null || typeof device !== "object") return false;
    const row = device as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      typeof row.model === "string" &&
      typeof row.control === "string" &&
      typeof row.abbrev === "string" &&
      typeof row.lowEnd === "string" &&
      typeof row.highEnd === "string" &&
      typeof row.isDefault === "boolean"
    );
  });
  return devices.length === value.length ? devices : undefined;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAllowedReadRequest(request)) {
    return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
  }
  const url = new URL(request.url);
  let projects: ProjectData[];
  try {
    projects = await readProjects(request);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read CFS projects." }, { status: Number((error as { status?: number })?.status) || 503 });
  }
  const project = findProject(projects, url.searchParams.get("projectId"));
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  try {
    if (isBridgeFormat(url.searchParams.get("format"))) {
      const roomTypeId = url.searchParams.get("roomTypeId");
      const bridge = buildCfsLutronBridgeExport({
        project,
        roomTypeIds: roomTypeId ? [roomTypeId] : undefined,
      });
      return NextResponse.json({ bridge });
    }
    const spec = buildLutronAutomationSpec({
      project,
      roomTypeId: url.searchParams.get("roomTypeId") ?? undefined,
    });
    return NextResponse.json({ spec });
  } catch (error) {
    return NextResponse.json({ error: specErrorMessage(error) }, { status: 400 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAllowedReadRequest(request)) {
    return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
  }
  if (isSecureSharingEnabled()) {
    const authorization = await callSecureSharingFunction(request, "auth.me");
    if (!authorization.ok) return authorization;
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
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (payload === null || typeof payload !== "object") {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  if (!body.project || typeof body.project !== "object") {
    return NextResponse.json({ error: "project is required" }, { status: 400 });
  }

  try {
    const [project] = migrateProjectsPayload([body.project]);
    if (!project) {
      return NextResponse.json({ error: "project is invalid" }, { status: 400 });
    }
    if (isBridgeFormat(typeof body.format === "string" ? body.format : undefined)) {
      const bridge = buildCfsLutronBridgeExport({
        project,
        roomTypeIds:
          typeof body.roomTypeId === "string"
            ? [body.roomTypeId]
            : parseRoomTypeIds(body.roomTypeIds),
      });
      return NextResponse.json({ bridge });
    }
    const spec = buildLutronAutomationSpec({
      project,
      roomTypeId: typeof body.roomTypeId === "string" ? body.roomTypeId : undefined,
      devices: parseDevices(body.devices),
    });
    return NextResponse.json({ spec });
  } catch (error) {
    return NextResponse.json({ error: specErrorMessage(error) }, { status: 400 });
  }
}
