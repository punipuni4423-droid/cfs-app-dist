import { requireApiAccess } from "../../../lib/apiAuth";
import { NextResponse } from "next/server";
import { secureSharingPublicConfig } from "../../../lib/secureSharingServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  return NextResponse.json(secureSharingPublicConfig(), {
    headers: { "Cache-Control": "no-store" },
  });
}
