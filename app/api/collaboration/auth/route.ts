import { NextResponse } from "next/server";
import { callSecureSharingFunction, isSecureSharingEnabled } from "../../../lib/secureSharingServer";
import { isAllowedWriteRequest } from "../../../lib/requestGuard";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAllowedWriteRequest(request)) {
    return NextResponse.json({ error: "write request origin is not allowed" }, { status: 403 });
  }
  if (!isSecureSharingEnabled()) {
    return NextResponse.json({ error: "Secure sharing is not enabled." }, { status: 404 });
  }
  return callSecureSharingFunction(request, "auth.me");
}
