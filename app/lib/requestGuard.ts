export function isAllowedWriteRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host = request.headers.get("host");
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isAllowedReadRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  // CFS is a local/LAN tool. Browser cross-site reads are blocked, while same-origin
  // app calls and local automation clients without Sec-Fetch-Site are allowed.
  return !fetchSite || ["same-origin", "same-site", "none"].includes(fetchSite);
}
