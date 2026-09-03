import type { DeviceMaster } from "../types";

// Shared Low End / High End value resolution (T-32 Device Assign columns and
// T-33 CFS base columns use the same rules).
//
// Resolution order per zone/address row:
//   1. A non-empty per-row override (DeviceAssignment.lowEnd/highEnd).
//   2. The DeviceMaster value resolved by device model. The master is never
//      written from these views; it only provides the displayed default.
//
// T-55: the master default (and the override input) only applies to zones
// that are actually dimmable. A zone qualifies when it has at least one
// linked circuit whose Circuit-tab dimming type is DALI, PWM or Phase
// (DIMMING_TYPE_OPTIONS in constants.ts; the judgement always uses the
// original CircuitEntry.dimmingType, never the CFS display conversion).
// Everything else - zones with no assigned circuit, On/Off-only zones and
// any other type - displays "-" and rejects input. Overrides stored on rows
// that no longer qualify are hidden but never deleted from the data.

export const LOW_HIGH_END_DIMMING_TYPES: readonly string[] = ["DALI", "PWM", "Phase"];

/**
 * True when the zone qualifies for the Low/High End auto fill and override
 * input: at least one linked circuit whose original Circuit-tab dimming type
 * is DALI, PWM or Phase. An empty list (no assigned circuit) never qualifies.
 */
export function isLowHighEndEligibleDimmingTypes(dimmingTypes: readonly string[]): boolean {
  return dimmingTypes.some((value) => LOW_HIGH_END_DIMMING_TYPES.includes(value.trim()));
}

export interface LowHighEndOverride {
  lowEnd?: string;
  highEnd?: string;
}

export interface ResolvedLowHighEnd {
  lowEnd: string;
  highEnd: string;
}

/**
 * Resolves the displayed Low/High End for one zone/address row: the row
 * override wins when non-empty, otherwise the DeviceMaster value for the
 * device model. Returns "" when neither exists.
 */
export function resolveLowHighEnd(
  override: LowHighEndOverride | undefined,
  deviceModel: string,
  deviceByModel: ReadonlyMap<string, DeviceMaster>,
): ResolvedLowHighEnd {
  const master = deviceByModel.get(deviceModel);
  const low = (override?.lowEnd ?? "").trim();
  const high = (override?.highEnd ?? "").trim();
  return {
    lowEnd: low !== "" ? low : (master?.lowEnd ?? "").trim(),
    highEnd: high !== "" ? high : (master?.highEnd ?? "").trim(),
  };
}
