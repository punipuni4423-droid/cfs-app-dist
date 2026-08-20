import { NextResponse } from "next/server";
import { registerCollaborationUser } from "../../../../lib/collaborationServer";
import { isAllowedWriteRequest } from "../../../../lib/requestGuard";
import { isSecureSharingEnabled } from "../../../../lib/secureSharingServer";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAllowedWriteRequest(request)) {
    return NextResponse.json({ error: "write request origin is not allowed" }, { status: 403 });
  }
  if (isSecureSharingEnabled()) {
    return NextResponse.json({ error: "Use email sign-in and an Admin-provisioned membership for secure sharing." }, { status: 405 });
  }
  try {
    const user = await registerCollaborationUser(await request.json());
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "User registration failed." }, { status: 400 });
  }
}
