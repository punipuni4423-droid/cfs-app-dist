import { NextResponse } from "next/server";
import { isAllowedWriteRequest } from "../../../lib/requestGuard";
import { callSecureSharingFunction, isSecureSharingEnabled } from "../../../lib/secureSharingServer";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isSecureSharingEnabled()) {
    return NextResponse.json({ error: "Secure sharing is not enabled." }, { status: 404 });
  }
  return callSecureSharingFunction(request, "members.list");
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAllowedWriteRequest(request)) {
    return NextResponse.json({ error: "write request origin is not allowed" }, { status: 403 });
  }
  if (!isSecureSharingEnabled()) {
    return NextResponse.json({ error: "Secure sharing is not enabled." }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid membership request." }, { status: 400 });
  }
  return callSecureSharingFunction(request, "members.upsert", body as Record<string, unknown>);
}
