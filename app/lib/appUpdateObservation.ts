export interface AppUpdateObservation {
  schemaVersion: 1;
  state: string;
  phase: string;
  operation: string;
  workerHeartbeatUtc: string;
  elapsedAwakeMs: number;
  elapsedWallMs: number;
  lastActivityUtc: string | null;
  observationQuality: "complete" | "partial" | "unavailable" | "stale";
  cleanupState: "not_needed" | "pending" | "verified" | "unverifiable";
  cleanupInProgress?: boolean;
  failureCode: string | null;
}
export function parseUpdateObservation(value: unknown): AppUpdateObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return;
  for (const key of ["state", "phase", "operation", "workerHeartbeatUtc"])
    if (typeof v[key] !== "string" || (v[key] as string).length > 100) return;
  if (!Number.isFinite(Date.parse(v.workerHeartbeatUtc as string))) return;
  for (const key of ["elapsedAwakeMs", "elapsedWallMs"])
    if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || (v[key] as number) < 0) return;
  if (v.lastActivityUtc !== null && (typeof v.lastActivityUtc !== "string" || !Number.isFinite(Date.parse(v.lastActivityUtc)))) return;
  if (!["complete", "partial", "unavailable", "stale"].includes(v.observationQuality as string)
    || !["not_needed", "pending", "verified", "unverifiable"].includes(v.cleanupState as string)) return;
  if (v.failureCode !== null && (typeof v.failureCode !== "string" || !/^[a-z_]{1,60}$/.test(v.failureCode))) return;
  if (v.cleanupInProgress !== undefined && typeof v.cleanupInProgress !== "boolean") return;
  return { schemaVersion: 1, state: v.state as string, phase: v.phase as string, operation: v.operation as string,
    workerHeartbeatUtc: v.workerHeartbeatUtc as string, elapsedAwakeMs: v.elapsedAwakeMs as number,
    elapsedWallMs: v.elapsedWallMs as number, lastActivityUtc: v.lastActivityUtc as string | null,
    observationQuality: v.observationQuality as AppUpdateObservation["observationQuality"],
    cleanupState: v.cleanupState as AppUpdateObservation["cleanupState"], cleanupInProgress: v.cleanupInProgress === true,
    failureCode: v.failureCode as string | null };
}
function cleanupMessage(value: AppUpdateObservation): string {
  if (value.cleanupState === "unverifiable") return "Command cleanup could not be confirmed. Do not start another update. Export diagnostics from the update monitor.";
  if (value.cleanupState === "pending" && (value.cleanupInProgress || value.state === "failed")) return "Command cleanup is still being verified. Do not start another update. Check the update monitor.";
  return "";
}
export function updateObservationAllowsTimeReference(value: AppUpdateObservation | undefined, now: number): boolean {
  if (!value) return true;
  const age = now - Date.parse(value.workerHeartbeatUtc);
  return value.state === "running" && !cleanupMessage(value) && value.observationQuality === "complete" && age >= -5_000 && age <= 30_000;
}
export function updateObservationMessage(value: AppUpdateObservation, now: number): string {
  const cleanup = cleanupMessage(value);
  const suffix = cleanup ? ` ${cleanup}` : "";
  const age = now - Date.parse(value.workerHeartbeatUtc);
  if (age > 300_000) return "Worker response has not been observed for 5 minutes. This does not confirm that the update stopped. Check the update monitor and export diagnostics." + suffix;
  if (age > 30_000 || age < -5_000 || value.observationQuality === "stale") return "Worker observation is unavailable or stale. The current operation may still be running." + suffix;
  if (value.observationQuality === "unavailable") return "Worker responding, but OS activity observation is unavailable. Completion cannot be inferred." + suffix;
  if (cleanup) return cleanup;
  return "The update monitor shows worker response and OS activity separately. Progress may stay at the same percentage while work continues.";
}
