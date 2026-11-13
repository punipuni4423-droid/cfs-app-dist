import type { SwitchEntry } from "../types";
import { canonicalJson } from "./canonicalJson";

/** Never interpret forensic raw values as membership or control instructions. */
export function hasTstatBindingQuarantine(row: object): boolean {
  return Object.prototype.hasOwnProperty.call(row, "tstatBindingQuarantine");
}

export function isValidTstatBinding(value: unknown): value is NonNullable<SwitchEntry["tstatBinding"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.areaId === "string" && Array.isArray(binding.assignmentIds)
    && binding.assignmentIds.every(id => typeof id === "string");
}

export const TSTAT_QUARANTINE_WARNING = "A saved TSTAT control has an invalid binding and is quarantined inactive. Its original data is preserved; automatic repair and reconnection are not available.";

/** A relocated binding is not lost only when both forensic values are exact.
 * Callers restrict this exception to the direct Switch record boundary. */
export function isLosslessTstatQuarantineTransition(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (typeof previous.id !== "string" || next.id !== previous.id || previous.tstatBinding === undefined || isValidTstatBinding(previous.tstatBinding)) return false;
  const binding = next.tstatBinding;
  if (!isValidTstatBinding(binding) || binding.areaId !== "" || binding.assignmentIds.length || Object.keys(binding).length !== 2) return false;
  const quarantine = next.tstatBindingQuarantine;
  if (!quarantine || typeof quarantine !== "object" || Array.isArray(quarantine)) return false;
  const record = quarantine as Record<string, unknown>;
  if (record.version !== 1 || record.reason !== "invalid-binding" || !Object.hasOwn(record, "raw")) return false;
  try {
    if (canonicalJson(record.raw) !== canonicalJson(previous.tstatBinding)) return false;
    return hasTstatBindingQuarantine(previous)
      ? Object.hasOwn(record, "previousQuarantine") && canonicalJson(record.previousQuarantine) === canonicalJson(previous.tstatBindingQuarantine)
      : !Object.hasOwn(record, "previousQuarantine");
  } catch { return false; }
}
