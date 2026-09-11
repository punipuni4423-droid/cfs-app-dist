import { NextResponse } from "next/server";
import { finiteFetch } from './projectSaveProtocol';

export type SecureSharingMode = "local" | "supabase";

export interface SecureSharingPublicConfig {
  mode: SecureSharingMode;
  url?: string;
  publishableKey?: string;
  functionName?: string;
  error?: string;
}

interface SecureFunctionPayload {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface SecureFunctionResult {
  status: number;
  body: SecureFunctionPayload;
}

function configuredMode(): SecureSharingMode {
  return process.env.CFS_SHARING_MODE?.trim().toLowerCase() === "supabase" ? "supabase" : "local";
}

function supabaseUrl(): string {
  return (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
}

function publishableKey(): string {
  return (process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
}

function functionName(): string {
  return (process.env.CFS_SUPABASE_FUNCTION_NAME || "cfs-api").trim();
}

export function secureSharingPublicConfig(): SecureSharingPublicConfig {
  if (configuredMode() !== "supabase") return { mode: "local" };
  const url = supabaseUrl();
  const key = publishableKey();
  const name = functionName();
  if (!url || !key || !name) {
    return {
      mode: "supabase",
      error: "Secure sharing is enabled but its public Supabase configuration is incomplete.",
    };
  }
  return { mode: "supabase", url, publishableKey: key, functionName: name };
}

export function isSecureSharingEnabled(): boolean {
  return secureSharingPublicConfig().mode === "supabase";
}

export function secureSharingSessionPayload(request: Request): { sessionId?: string } {
  const sessionId = request.headers.get("x-cfs-session-id")?.trim();
  return sessionId ? { sessionId } : {};
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

export async function callSecureSharingFunctionJson(
  request: Request,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<SecureFunctionResult> {
  const config = secureSharingPublicConfig();
  if (config.mode !== "supabase" || !config.url || !config.publishableKey || !config.functionName) {
    return { status: 503, body: { error: config.error || "Secure sharing is not enabled." } };
  }
  const token = bearerToken(request);
  if (!token) {
    return { status: 401, body: { error: "Sign in is required to access shared CFS projects." } };
  }

  let response: Response;
  try {
    response = await finiteFetch(`${config.url}/functions/v1/${encodeURIComponent(config.functionName)}`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        apikey: config.publishableKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    }, 25_000);
  } catch {
    return { status: 504, body: { error: "Could not confirm the secure CFS sharing response within the deadline.", code: 'SAVE_RESULT_UNKNOWN' } };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: response.ok ? 502 : response.status, body: { error: 'The secure CFS sharing response was invalid.', code: 'SAVE_RESULT_UNKNOWN' } };
  }
  const record = body as SecureFunctionPayload;
  if (response.ok && ['projects.read', 'project.save', 'projects.merge'].includes(action)
    && (record.ok !== true || (action === 'projects.read' && !Array.isArray(record.projects)))) {
    return { status: 502, body: { error: 'The secure CFS sharing response was incomplete.', code: 'SAVE_RESULT_UNKNOWN' } };
  }
  return { status: response.status, body: record };
}

export async function callSecureSharingFunction(
  request: Request,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<NextResponse> {
  const result = await callSecureSharingFunctionJson(request, action, payload);
  return NextResponse.json(result.body, { status: result.status });
}
