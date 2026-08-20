import { NextResponse } from "next/server";
import { secureSharingPublicConfig } from "../../../lib/secureSharingServer";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(secureSharingPublicConfig(), {
    headers: { "Cache-Control": "no-store" },
  });
}
