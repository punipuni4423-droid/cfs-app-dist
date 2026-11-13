import type { CfsZoneRow, FunctionColumn } from "./cfsTableModel";
import type { BacklightLevelSetting, RoomType, SwitchEntry } from "../types";
import { BACKLIGHT_LEVEL_NAMES, normalizeBacklightLevels } from "./constants";
import { normalizeBacklightCondition, switchGroupId } from "./useCfsZoneRows";

function hasUniqueBacklightReference(value: string, roomLevels: readonly BacklightLevelSetting[], source?: SwitchEntry): boolean {
  const sourceLevels = normalizeBacklightLevels(source?.backlightLevels, { useDefaultsWhenMissing: false });
  const definitionsFor = (key: string) => {
    const shared = roomLevels.filter(level => level.key === key);
    return shared.length ? shared : sourceLevels.filter(level => level.key === key);
  };
  const exact = definitionsFor(value);
  if (exact.length) return exact.length === 1;

  const name = value.toLowerCase();
  const keys = new Set(
    [...roomLevels, ...sourceLevels].filter(level => level.name.trim().toLowerCase() === name).map(level => level.key),
  );
  for (const level of BACKLIGHT_LEVEL_NAMES) {
    const isLegacyMasterOn = level.key === "masterOn" && /^master\s*on$/i.test(value);
    if ((level.name.toLowerCase() === name || isLegacyMasterOn) && definitionsFor(level.key).length) {
      keys.add(level.key);
    }
  }
  const [key] = keys;
  return keys.size === 1 && definitionsFor(key).length === 1;
}

/** Keep canonical target rows in storage, Link Map and external exports.
 * CFS groups only rows that agree across every function column, including hidden columns.
 */
export function groupCfsBacklightRows(
  rows: readonly CfsZoneRow[],
  columns: readonly FunctionColumn[],
  roomType: Pick<RoomType, "switches" | "backlightLevels">,
): CfsZoneRow[] {
  if (!rows.some(row => row.isBacklight)) return [...rows];
  const numbers = new Map(roomType.switches.filter(sw => sw.kind === "lutronPd").map(sw => [switchGroupId(sw), sw.switchNumber.trim()]));
  const roomLevels = normalizeBacklightLevels(roomType.backlightLevels);
  const conditions = columns.map(column => {
    const value = column.roomScene?.backlightCondition ?? column.source?.backlightCondition ?? "";
    const condition = normalizeBacklightCondition(value, column.source);
    const targets = column.source?.backlightTarget.split(",").map(id => id.trim()) ?? [];
    return {
      condition, targets, isScene: Boolean(column.roomScene),
      known: !condition || hasUniqueBacklightReference(value.trim(), roomLevels, column.source),
    };
  });
  const groups = new Map<string, { members: CfsZoneRow[] }>();
  const order: Array<CfsZoneRow | { members: CfsZoneRow[] }> = [];
  for (const row of rows) {
    const target = row.backlightTargetGroupId;
    if (!row.isBacklight || !target) {
      order.push(row);
      continue;
    }
    const vector = conditions.map(value => value.isScene || value.targets.includes(target) ? value.condition : "");
    const unresolved = vector.some((condition, index) => condition && !conditions[index].known);
    const key = JSON.stringify([vector, unresolved ? target : ""]);
    let group = groups.get(key);
    if (!group) {
      group = { members: [] };
      groups.set(key, group);
      order.push(group);
    }
    group.members.push(row);
  }
  return order.map(item => {
    if (!("members" in item)) return item;
    const [first] = item.members;
    const labels = new Set(item.members.map(row => numbers.get(row.backlightTargetGroupId!) || "-"));
    const label = [...labels].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).join(", ");
    return {
      ...first, backlightTargetLabel: label, backlightMemberRowIds: item.members.map(row => row.id),
    };
  });
}

export function cfsBacklightDisplayRowId(rows: readonly CfsZoneRow[], id: string): string {
  return rows.find(row => row.backlightMemberRowIds?.includes(id))?.id ?? id;
}
