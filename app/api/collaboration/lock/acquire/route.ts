import { NextResponse } from "next/server";
import { acquireCollaborationLock } from "../../../../lib/collaborationServer";
import { isAllowedWriteRequest } from "../../../../lib/requestGuard";
import { callSecureSharingFunction, isSecureSharingEnabled } from "../../../../lib/secureSharingServer";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAllowedWriteRequest(request)) {
    return NextResponse.json({ error: "write request origin is not allowed" }, { status: 403 });
  }
  try {
    const body = await request.json();
    if (isSecureSharingEnabled()) {
      return callSecureSharingFunction(request, "lock.acquire", {
        sessionId: body?.sessionId ?? "",
        projectId: body?.projectId ?? "",
      });
    }
    const result = await acquireCollaborationLock(body);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Edit lock could not be acquired." }, { status: 400 });
  }
}
