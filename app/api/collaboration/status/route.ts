import { NextResponse } from "next/server";
import { collaborationStatus } from "../../../lib/collaborationServer";
import { isAllowedReadRequest } from "../../../lib/requestGuard";
import { callSecureSharingFunction, isSecureSharingEnabled } from "../../../lib/secureSharingServer";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    if (!isAllowedReadRequest(request)) {
      return NextResponse.json({ error: "read request origin is not allowed" }, { status: 403 });
    }
    const url = new URL(request.url);
    if (isSecureSharingEnabled()) {
      return callSecureSharingFunction(request, "status", {
        sessionId: url.searchParams.get("sessionId") ?? "",
        projectId: url.searchParams.get("projectId") ?? "",
      });
    }
    const status = await collaborationStatus({
      userId: url.searchParams.get("userId") ?? "",
      sessionId: url.searchParams.get("sessionId") ?? "",
      projectId: url.searchParams.get("projectId") ?? "",
    });
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ error: "Failed to read collaboration status." }, { status: 500 });
  }
}
