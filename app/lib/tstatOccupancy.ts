import type { HvacAssignment, LocationMaster, ProjectData, RoomType, SwitchEntry } from "../types";
import { createEmptySwitchEntry } from "./constants";
import { hasTstatBindingQuarantine, TSTAT_QUARANTINE_WARNING } from "./tstatBindingQuarantine";

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const thermostatNumberLabel = (number: number | undefined) => `TH${number}`;

/** Read-only fallback labels for old assignments; no registration or save occurs. */
function assignmentNumbers(assignments: readonly HvacAssignment[]): Map<string, number> {
  const result = new Map<string, number>();
  const used = new Set<number>();
  for (const row of assignments) {
    if (positiveInteger(row.thermostatNumber) && !used.has(row.thermostatNumber)) {
      used.add(row.thermostatNumber); result.set(row.id, row.thermostatNumber);
    }
  }
  let candidate = 1;
  for (const row of assignments) {
    if (result.has(row.id)) continue;
    while (used.has(candidate)) candidate++;
    result.set(row.id, candidate); used.add(candidate++);
  }
  return result;
}

export function thermostatNumberForAssignment(assignments: readonly HvacAssignment[], assignmentId: string): string {
  const index = assignments.findIndex(row => row.id === assignmentId);
  return index < 0 ? "Unregistered TSTAT" : thermostatNumberLabel(thermostatDisplayNumber(index));
}

export function thermostatDisplayNumber(registrationIndex: number): number {
  return registrationIndex + 1;
}

export function thermostatControlDisplayNumber(row: SwitchEntry, assignments: readonly HvacAssignment[]): string {
  return tstatActiveAssignments(row, assignments)
    .map(assignment => thermostatNumberForAssignment(assignments, assignment.id))
    .join(" / ");
}

export function thermostatNumberHighWater(room: Pick<RoomType, "hvacAssignments" | "nextThermostatNumber">): number {
  return Math.max(positiveInteger(room.nextThermostatNumber) ? room.nextThermostatNumber : 1,
    ...room.hvacAssignments.map((row) => positiveInteger(row.thermostatNumber) ? row.thermostatNumber + 1 : 1));
}

/** Undo/Redo restores user data, while allocated display numbers remain reserved. */
export function preserveThermostatNumberReservations(target: ProjectData, current: ProjectData): ProjectData {
  const currentRooms = new Map(current.roomTypes.map((room) => [room.id, room]));
  let changed = false;
  const roomTypes = target.roomTypes.map((room) => {
    const previous = currentRooms.get(room.id);
    if (!previous) return room;
    const highWater = Math.max(thermostatNumberHighWater(room), thermostatNumberHighWater(previous));
    if (highWater <= 1 || room.nextThermostatNumber === highWater) return room;
    changed = true; return { ...room, nextThermostatNumber: highWater };
  });
  return changed ? { ...target, roomTypes } : target;
}

/** Stored command references may be stable IDs; UI/export only presents their TH label. */
export function tstatCommandReferenceLabel(row: SwitchEntry, switches: readonly SwitchEntry[], assignments?: readonly HvacAssignment[]): string {
  if (hasTstatBindingQuarantine(row)) return "Quarantined control";
  if (row.kind !== "command") return row.kind === "tstat" && assignments
    ? thermostatControlDisplayNumber(row, assignments)
    : row.switchNumber;
  const target = switches.find((candidate) => (candidate.tstatBinding || hasTstatBindingQuarantine(candidate)) && (candidate.switchGroupId || candidate.id) === row.switchNumber);
  if (target && hasTstatBindingQuarantine(target)) return "Quarantined control";
  if (target) return assignments
    ? thermostatControlDisplayNumber(target, assignments) || "Unresolved control"
    : target.switchNumber || "TSTAT";
  return row.switchNumber.startsWith("tstat-control:") || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.switchNumber)
    ? "Unresolved control" : row.switchNumber;
}

export function tstatActiveAssignments(row: SwitchEntry, assignments: readonly HvacAssignment[]): HvacAssignment[] {
  if (hasTstatBindingQuarantine(row)) return [];
  if (!row.tstatBinding) return [];
  const ids = new Set(row.tstatBinding.assignmentIds);
  return assignments.filter((assignment) => ids.has(assignment.id) && assignment.area === row.tstatBinding?.areaId);
}

/** The collection only displays controls with a current physical registration. */
export function thermostatCollectionRows(rows: readonly SwitchEntry[], assignments: readonly HvacAssignment[]): SwitchEntry[] {
  return rows.filter(row => row.kind === "tstat" && hasCurrentThermostat(row, assignments));
}

function hasCurrentThermostat(row: SwitchEntry, assignments: readonly HvacAssignment[]): boolean {
  return tstatActiveAssignments(row, assignments).length > 0;
}

export function registeredThermostatSwitches(rows: readonly SwitchEntry[], assignments: readonly HvacAssignment[]): readonly SwitchEntry[] {
  return rows.filter(row => row.kind !== "tstat" || hasCurrentThermostat(row, assignments));
}

/** Operational CFS views also require the shared control to have an active Area. */
export function isCfsSwitchControlActive(row: SwitchEntry, assignments: readonly HvacAssignment[], switches: readonly SwitchEntry[]): boolean {
  return (row.kind !== "tstat" || hasCurrentThermostat(row, assignments)) && isActiveTstatControl(row, assignments, switches);
}

export function isActiveTstatControl(row: SwitchEntry, assignments: readonly HvacAssignment[], switches: readonly SwitchEntry[] = []): boolean {
  if (hasTstatBindingQuarantine(row)) return false;
  // Preserve existing unbound tstat sources; only managed, unassigned/orphan sources are inactive.
  if (row.kind !== "tstat" || !row.tstatBinding) return true;
  const areaId = row.tstatBinding.areaId;
  const groups = new Set(switches.filter((candidate) => !hasTstatBindingQuarantine(candidate) && candidate.kind === "tstat" && candidate.tstatBinding?.areaId === areaId).map((candidate) => candidate.switchGroupId || candidate.id));
  return groups.size <= 1 && Boolean(areaId && tstatActiveAssignments(row, assignments).length);
}

function bindingKey(areaId: string, assignmentId: string): string {
  return areaId ? `area:${areaId}` : `unassigned:${assignmentId}`;
}

export interface TstatOccupancyView {
  switches: SwitchEntry[];
  warnings: string[];
  columnLabels: Map<string, string>;
}

/** Derive empty scaffolds without changing the stored room or inventing action presets. */
export function deriveTstatOccupancy(room: Pick<RoomType, "id" | "switches" | "hvacAssignments">): TstatOccupancyView {
  // These labels are also used by the registration writer and legacy Command references.
  const storedNumbers = assignmentNumbers(room.hvacAssignments);
  const members = new Map<string, HvacAssignment[]>();
  for (const assignment of room.hvacAssignments) {
    const key = bindingKey(assignment.area, assignment.id);
    members.set(key, [...(members.get(key) ?? []), assignment]);
  }
  const groups = new Map<string, Map<string, SwitchEntry[]>>();
  const quarantined = room.switches.filter(hasTstatBindingQuarantine);
  for (const row of room.switches) {
    if (hasTstatBindingQuarantine(row)) continue;
    if (row.kind !== "tstat" || !row.tstatBinding) continue;
    const binding = row.tstatBinding;
    const key = binding.areaId ? bindingKey(binding.areaId, "") : bindingKey("", binding.assignmentIds[0] ?? row.switchGroupId);
    const byGroup = groups.get(key) ?? new Map<string, SwitchEntry[]>();
    byGroup.set(row.switchGroupId || row.id, [...(byGroup.get(row.switchGroupId || row.id) ?? []), row]);
    groups.set(key, byGroup);
  }
  const warnings: string[] = [];
  const ambiguous = new Set(Array.from(groups).filter(([, byGroup]) => byGroup.size > 1).map(([key]) => key));
  if (ambiguous.size) warnings.push("Multiple saved TSTAT control groups share an Area. Their settings are retained inactive; resolve the duplicate groups before applying controls.");
  const switches = room.switches.map((row) => {
    if (hasTstatBindingQuarantine(row)) { warnings.push(TSTAT_QUARANTINE_WARNING); return row; }
    if (row.kind !== "tstat" || !row.tstatBinding) return row;
    const binding = row.tstatBinding;
    const key = binding.areaId ? bindingKey(binding.areaId, "") : bindingKey("", binding.assignmentIds[0] ?? row.switchGroupId);
    const current = ambiguous.has(key) ? [] : members.get(key) ?? [];
    const assignmentIds = current.map((member) => member.id);
    const label = current.map(member => thermostatNumberLabel(storedNumbers.get(member.id))).join(" / ");
    // Keep the original binding too; removal or ambiguity is not authorization to erase it.
    if (!current.length) return row;
    const sameMembers = assignmentIds.length === binding.assignmentIds.length && assignmentIds.every((id, index) => id === binding.assignmentIds[index]);
    if (sameMembers && (!label || row.switchNumber === label)) return row;
    return { ...row, switchNumber: label || row.switchNumber, tstatBinding: { ...binding, assignmentIds } };
  });
  for (const [key, groupMembers] of members) {
    if (groups.has(key)) continue;
    const areaId = groupMembers[0].area;
    const groupId = `tstat-control:${room.id}:${key}`;
    if (quarantined.some(row => (row.tstatBinding?.areaId && bindingKey(row.tstatBinding.areaId, "") === key)
      || (row.switchGroupId || row.id) === groupId || row.id === `${groupId}:function:1`)) {
      warnings.push("A quarantined TSTAT control reserves this identity or Area. No replacement control is generated automatically.");
      continue;
    }
    const empty = createEmptySwitchEntry("tstat");
    switches.push({
      ...empty, id: `${groupId}:function:1`, switchGroupId: groupId,
      switchNumber: groupMembers.map(member => thermostatNumberLabel(storedNumbers.get(member.id))).join(" / "),
      // PIR's initial function is a marker; no trigger, value, delay or BL action is inferred.
      buttonFunction: "PIR", tstatBinding: { areaId, assignmentIds: groupMembers.map((member) => member.id) },
    });
  }
  // CFS headings can be disambiguated without changing saved switch numbers or Command references.
  const occupied = new Set(switches.filter(row => row.kind !== "tstat").map(row => row.switchNumber.trim().toUpperCase()));
  const labelsByNumber = new Map<string, string>();
  const columnLabels = new Map<string, string>();
  for (const row of switches) {
    if (row.kind !== "tstat") continue;
    const number = thermostatControlDisplayNumber(row, room.hvacAssignments);
    if (!number) continue;
    let label = labelsByNumber.get(number);
    if (!label) {
      label = number;
      if (number.split(" / ").some(part => occupied.has(part)) || occupied.has(number)) {
        label = `${number} (TSTAT)`;
        for (let suffix = 2; occupied.has(label); suffix++) {
          label = `${number} (TSTAT ${suffix})`;
        }
      }
      labelsByNumber.set(number, label);
      occupied.add(label);
    }
    columnLabels.set(row.id, label);
  }
  return { switches, warnings: [...new Set(warnings)], columnLabels };
}

function planTstatDeletion(room: RoomType, next: readonly HvacAssignment[]) {
  const remainingIds = new Set(next.map(row => row.id));
  const removed = room.hvacAssignments.filter(row => !remainingIds.has(row.id));
  if (!removed.length) return null;

  const removedIds = new Set(removed.map(row => row.id));
  const remainingAreas = new Set(next.map(row => row.area));
  const storedIds = new Set(room.switches.map(row => row.id));
  const derived = deriveTstatOccupancy(room).switches;
  const controls = derived.filter(row => {
    const binding = row.tstatBinding;
    if (row.kind !== "tstat" || !binding || !storedIds.has(row.id) || hasTstatBindingQuarantine(row)) return false;
    if (binding.areaId) {
      return !remainingAreas.has(binding.areaId)
        && isActiveTstatControl(row, room.hvacAssignments, derived)
        && binding.assignmentIds.some(id => removedIds.has(id));
    }
    // An unassigned control only belongs to its own unassigned registration.
    if (binding.assignmentIds.length !== 1 || !removedIds.has(binding.assignmentIds[0])) return false;
    return removed.some(assignment => assignment.id === binding.assignmentIds[0] && !assignment.area);
  });
  const controlIds = new Set(controls.map(row => row.id));
  const groupIds = new Set(controls.map(row => row.switchGroupId || row.id));
  for (const row of room.switches) {
    if ((row.tstatBinding || hasTstatBindingQuarantine(row)) && !controlIds.has(row.id)) {
      groupIds.delete(row.switchGroupId || row.id);
    }
  }
  const detachedCommands = new Set(room.switches.filter(row =>
    row.kind === "command" && !hasTstatBindingQuarantine(row) && groupIds.has(row.switchNumber),
  ).map(row => row.id));
  return { controls, controlIds, detachedCommands };
}

/** Apply one registration edit. Only deletion compacts TH labels and removes newly orphaned controls. */
export function updateTstatRegistration(room: RoomType, nextAssignments: readonly HvacAssignment[]): RoomType {
  const deletion = planTstatDeletion(room, nextAssignments);
  const existing = assignmentNumbers(room.hvacAssignments);
  const reserved = new Set(existing.values());
  let nextNumber = Math.max(positiveInteger(room.nextThermostatNumber) ? room.nextThermostatNumber : 1, ...Array.from(existing.values(), (value) => value + 1));
  const seen = new Set<number>();
  const hvacAssignments = nextAssignments.map((row, index) => {
    if (deletion) return { ...row, thermostatNumber: index + 1 };
    let number = existing.get(row.id);
    if (!number && positiveInteger(row.thermostatNumber) && !seen.has(row.thermostatNumber) && !reserved.has(row.thermostatNumber)) number = row.thermostatNumber;
    if (!number || seen.has(number)) number = nextNumber++;
    seen.add(number); nextNumber = Math.max(nextNumber, number + 1);
    return row.thermostatNumber === number ? row : { ...row, thermostatNumber: number };
  });
  const remainingSwitches = deletion ? room.switches
    .filter(row => !deletion.controlIds.has(row.id))
    .map(row => deletion.detachedCommands.has(row.id) ? { ...row, switchNumber: "" } : row) : room.switches;
  const nextRoom = {
    ...room,
    hvacAssignments,
    nextThermostatNumber: deletion ? hvacAssignments.length + 1 : nextNumber,
    switches: remainingSwitches,
  };
  const storedIds = new Set(remainingSwitches.map((row) => row.id));
  const switches = deriveTstatOccupancy(nextRoom).switches.filter((row) =>
    // Empty unassigned scaffolds are display-only until their first explicit edit.
    !row.tstatBinding || Boolean(row.tstatBinding.areaId) || storedIds.has(row.id),
  );
  return { ...nextRoom, switches };
}

function hasConfiguredTstatAction(row: SwitchEntry): boolean {
  return Boolean(row.condition.trim() || (row.buttonFunction.trim() && row.buttonFunction !== "PIR")
    || row.buttonSetting.sceneId || row.buttonSetting.sceneIds.length || row.buttonSetting.circuitSettings.length
    || row.backlightTarget.trim() || row.backlightCondition.trim());
}

/** Warnings at the registration boundary, including Area changes and destructive deletions. */
export function tstatAreaChangeWarnings(room: RoomType, next: readonly HvacAssignment[], locations: readonly LocationMaster[]): string[] {
  const warnings: string[] = [];
  const deletion = planTstatDeletion(room, next);
  if (deletion?.controls.some(hasConfiguredTstatAction)) {
    warnings.push("Deleting this Thermostat will remove its configured controls and settings.");
  }
  if (deletion?.detachedCommands.size) {
    warnings.push("Commands linked to the removed controls will be unlinked.");
  }
  for (const current of room.hvacAssignments) {
    const following = next.find((row) => row.id === current.id);
    if (!following || following.area === current.area) continue;
    const source = room.switches.filter((row) => !hasTstatBindingQuarantine(row) && row.tstatBinding?.assignmentIds.includes(current.id));
    const target = following.area ? room.switches.filter((row) => !hasTstatBindingQuarantine(row) && row.tstatBinding?.areaId === following.area) : [];
    if (![...source, ...target].some(hasConfiguredTstatAction)) continue;
    const area = locations.find((row) => row.id === following.area)?.name || "Unassigned";
    warnings.push(`${thermostatNumberForAssignment(room.hvacAssignments, current.id)} will use ${following.area ? `${area}'s shared controls` : "separate, inactive controls"}. Previously saved controls are retained.`);
  }
  return warnings;
}
