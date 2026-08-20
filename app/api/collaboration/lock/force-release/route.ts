import { NextResponse } from "next/server";
import { collaborationStatus, forceReleaseCollaborationLock } from "../../../../lib/collaborationServer";
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
      // Admin gating happens in the cfs-api Edge Function (requireRole admin).
      return callSecureSharingFunction(request, "lock.forceRelease", {
        sessionId: body?.sessionId ?? "",
        projectId: body?.projectId ?? "",
      });
    }
    const result = await forceReleaseCollaborationLock(body);
    const status = await collaborationStatus({
      userId: typeof body?.userId === "string" ? body.userId : "",
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : "",
      projectId: typeof body?.projectId === "string" ? body.projectId : "",
    });
    return NextResponse.json({ ok: true, released: result.released, releasedLock: result.lock, status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Edit lock force release failed." }, { status: 400 });
  }
}
