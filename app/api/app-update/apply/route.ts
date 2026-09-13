import { requireApiAccess } from "../../../lib/apiAuth";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { appDir, getAppUpdateStatus, selfUpdateStatusFile } from "../../../lib/appUpdateServer";
import { isAllowedWriteRequest } from "../../../lib/requestGuard";
import { buildBootstrapInvocation, startBootstrap } from "../../../lib/appUpdateLaunch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  if (!isAllowedWriteRequest(request)) return NextResponse.json({ error: "update request origin is not allowed" }, { status: 403 });
  const status = await getAppUpdateStatus({ fetchRemote: false });
  if (status.dirty || status.ahead > 0 || !status.localSha || !["available", "build_required", "current"].includes(status.state)) {
    return NextResponse.json({ error: "The installation is not ready for an update. Use UPDATE_CFS_APP.cmd for diagnostics.", status }, { status: 409 });
  }
  // No queued write or stale-running veto here. The OS lock in the common
  // bootstrap owns dispatch and status publication for both the API and CMD.
  const requestUrl = new URL(request.url);
  const attemptId = randomUUID();
  const result = await startBootstrap(buildBootstrapInvocation({
    appDir,
    port: requestUrl.port || process.env.PORT || "3014",
    hostName: process.env.CFS_LOCALHOST_ONLY === "1" ? "127.0.0.1" : "0.0.0.0",
    expectedHead: status.localSha,
    startedAt: new Date().toISOString(),
    attemptId,
    repairBuild: status.state === "build_required" || status.buildStale === true,
  }), appDir, attemptId);
  if (result.state === "failed" || result.state === "busy") return NextResponse.json({ error: result.message, status }, { status: 409 });
  return NextResponse.json({ ok: true, state: result.state, message: result.message, statusFile: selfUpdateStatusFile }, { status: 202 });
}
