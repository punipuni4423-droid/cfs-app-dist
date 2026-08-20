import { NextResponse } from "next/server";
import { getAppUpdateStatus } from "../../../lib/appUpdateServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const status = await getAppUpdateStatus({ fetchRemote: url.searchParams.get("fetchRemote") === "1" });
  return NextResponse.json(status);
}
