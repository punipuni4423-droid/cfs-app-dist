import { networkInterfaces } from "node:os";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function preferredLanAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      return entry.address;
    }
  }
  return null;
}

function portFromHost(host: string): string {
  const match = host.match(/:(\d+)$/);
  return match ? match[1] : "";
}

export function GET(request: Request) {
  const host = request.headers.get("host") ?? "";
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol = forwardedProto?.split(",")[0]?.trim() || "http";
  const port = portFromHost(host);
  const hostOnly = host.replace(/:\d+$/, "");
  const lanHost =
    hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "::1"
      ? preferredLanAddress() ?? hostOnly
      : hostOnly;
  const url = `${protocol}://${lanHost}${port ? `:${port}` : ""}`;

  return NextResponse.json({
    url,
    host: lanHost,
    port,
  });
}
