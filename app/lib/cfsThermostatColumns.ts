import type { RoomType, SwitchEntry } from "../types";
import { HVAC_METRICS, hvacSettingId } from "./settingTargets";
import { thermostatNumberForAssignment, tstatActiveAssignments } from "./tstatOccupancy";

type CfsThermostatSource = Pick<RoomType, "hvacAssignments" | "switches">;

/** Only the CFS projection uses this filter. Command and storage still see every source row. */
export function excludedCfsThermostatSwitchIds(room: CfsThermostatSource, derived: readonly SwitchEntry[]): Set<string> {
  const assigned = room.hvacAssignments.filter(assignment => assignment.area);
  const targets = new Map(assigned.flatMap(assignment =>
    HVAC_METRICS.map(metric => [hvacSettingId(assignment.id, metric), assignment.id] as const)));
  const legacyGroups = new Map<string, SwitchEntry[]>();
  for (const row of room.switches) {
    if (row.kind !== "lutronPd" || !row.switchGroupId || !/^TH\d+$/i.test(row.switchNumber.trim()) ||
        !/\b(?:thermostat|tstat)\b/i.test(row.switchName)) continue;
    const group = legacyGroups.get(row.switchGroupId) ?? [];
    group.push(row);
    legacyGroups.set(row.switchGroupId, group);
  }
  const groupCounts = new Map<string, number>();
  for (const group of legacyGroups.values()) {
    const linked = new Set(group.flatMap(row => row.buttonSetting.circuitSettings)
      .map(setting => targets.get(setting.circuitId)).filter(id => id !== undefined));
    if (linked.size !== 1) continue;
    const [id] = linked;
    const expected = thermostatNumberForAssignment(room.hvacAssignments, id).toUpperCase();
    if (!group.every(row => row.switchNumber.trim().toUpperCase() === expected)) continue;
    groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1);
  }
  const excluded = new Set<string>();
  const storedIds = new Set(room.switches.map(row => row.id));
  for (const row of derived) {
    if (row.kind !== "tstat" || storedIds.has(row.id)) continue;
    const members = tstatActiveAssignments(row, assigned);
    if (members.length === 1 && groupCounts.get(members[0].id) === 1) {
      // An existing, uniquely linked heading already represents this assignment.
      excluded.add(row.id);
    }
  }
  return excluded;
}
