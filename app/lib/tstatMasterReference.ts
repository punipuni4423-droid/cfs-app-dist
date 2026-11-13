import type { HvacAssignment, LocationMaster } from "../types";
import { thermostatNumberForAssignment } from "./tstatOccupancy";

/** Physical Master reference; independent of Area-shared occupancy settings. */
export function tstatAssignmentLabel(row: HvacAssignment, assignments: readonly HvacAssignment[], locations: readonly LocationMaster[]): string {
  // TH numbers are the display identity; Area/protocol remain in their own columns.
  void locations;
  return thermostatNumberForAssignment(assignments, row.id);
}

export function tstatMasterCandidates(row: HvacAssignment, assignments: readonly HvacAssignment[]): HvacAssignment[] {
  return assignments.filter((candidate) => candidate.id !== row.id && candidate.thermostatRole === "Master"
    && assignments.filter((other) => other.id === candidate.id).length === 1);
}

export function canSelectTstatMaster(row: HvacAssignment, masterId: string, assignments: readonly HvacAssignment[]): boolean {
  return row.thermostatRole === "Slave" && (!masterId || tstatMasterCandidates(row, assignments).some((candidate) => candidate.id === masterId));
}

export interface TstatMasterReference {
  status: "not-applicable" | "unselected" | "valid" | "missing" | "self" | "not-master" | "ambiguous" | "inactive";
  label: string;
  warning?: string;
}

/** Invalid stored references are retained and described, never rebound or exposed as raw IDs. */
export function tstatMasterReference(row: HvacAssignment, assignments: readonly HvacAssignment[], locations: readonly LocationMaster[]): TstatMasterReference {
  const id = row.masterAssignmentId;
  if (!id) return row.thermostatRole === "Slave" ? { status: "unselected", label: "-" }
    : { status: "not-applicable", label: "-" };
  const matches = assignments.filter((candidate) => candidate.id === id);
  let result: TstatMasterReference;
  if (id === row.id) result = { status: "self", label: "Invalid self reference", warning: "A Slave cannot reference itself. Select a Master." };
  else if (!matches.length) result = { status: "missing", label: "Unavailable Master", warning: "The saved Master is unavailable. Its reference is retained; select a Master or clear it." };
  else if (matches.length > 1) result = { status: "ambiguous", label: "Ambiguous Master", warning: "The saved Master identity is duplicated. Resolve the duplicate before selecting it." };
  else {
    const label = tstatAssignmentLabel(matches[0], assignments, locations);
    result = matches[0].thermostatRole === "Master" ? { status: "valid", label }
      : { status: "not-master", label: `${label} (not Master)`, warning: "The saved reference is no longer a Master. Its reference is retained; select a Master or clear it." };
  }
  return row.thermostatRole === "Slave" ? result
    : { status: "inactive", label: `${result.label} (inactive)`, warning: "A saved Slave reference is retained but inactive while this device is Master." };
}
