import type { SwitchEntry } from "../types";
import { switchGroupId } from "./switchSync";
import { copiedCircuitSettings, validOperationPriorities } from "./switchOperationContent";
import { hasTstatBindingQuarantine } from "./tstatBindingQuarantine";

export interface SwitchButtonCopyTarget {
  id: string;
  label: string;
  functionCount: number;
  reason?: string;
}

function hasPhysicalButton(row: SwitchEntry): boolean {
  return !hasTstatBindingQuarantine(row) && (row.kind === "lutronPd" || row.kind === "lutronPico") && Boolean(row.buttonLabel.trim()) && row.buttonLabel !== "-";
}

function sameButton(left: SwitchEntry, right: SwitchEntry): boolean {
  return left.kind === right.kind && switchGroupId(left) === switchGroupId(right) && left.buttonLabel === right.buttonLabel;
}

export function reorderSwitchButtonFunction(
  rows: SwitchEntry[], sourceId: string, targetId: string, position: "before" | "after",
): SwitchEntry[] {
  const source = rows.find(row => row.id === sourceId);
  const target = rows.find(row => row.id === targetId);
  if (!source || !target || source === target || !hasPhysicalButton(source) || !sameButton(source, target)) return rows;
  const group = rows.filter(row => sameButton(source, row));
  if (group.some(hasTstatBindingQuarantine)) return rows;
  const remaining = group.filter(row => row !== source);
  remaining.splice(remaining.indexOf(target) + (position === "after" ? 1 : 0), 0, source);
  if (remaining.every((row, index) => row === group[index])) return rows;
  let index = 0;
  return rows.map(row => sameButton(row, source) ? remaining[index++] : row);
}

export function switchButtonCopyLabel(rows: SwitchEntry[], row: SwitchEntry): string {
  const groups = [...new Set(rows.filter(candidate => candidate.kind === row.kind).map(switchGroupId))];
  const number = row.switchNumber || `#${groups.indexOf(switchGroupId(row)) + 1}`;
  return `${row.kind === "lutronPd" ? "Palladiom" : "Pico"} ${number}${row.switchName ? ` / ${row.switchName}` : ""} / ${row.buttonLabel}`;
}

/** Physical button destinations only; each button represents all of its function rows. */
export function switchButtonCopyTargets(rows: SwitchEntry[], sourceId: string): SwitchButtonCopyTarget[] {
  const source = rows.find(row => row.id === sourceId);
  if (!source || !hasPhysicalButton(source) || rows.some(row => sameButton(row, source) && hasTstatBindingQuarantine(row))) return [];
  const seen = new Set<string>();
  const targets: SwitchButtonCopyTarget[] = [];
  const sourceCount = rows.filter(row => sameButton(row, source)).length;
  for (const row of rows) {
    if (row.kind !== source.kind || !hasPhysicalButton(row)) continue;
    const groupId = switchGroupId(row);
    const key = JSON.stringify([groupId, row.buttonLabel]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sameButton(row, source)) continue;
    const functionCount = rows.filter(candidate => sameButton(candidate, row)).length;
    targets.push({
      id: row.id,
      label: switchButtonCopyLabel(rows, row),
      functionCount,
      ...(rows.some(candidate => sameButton(candidate, row) && hasTstatBindingQuarantine(candidate))
        ? { reason: "Quarantined controls are retained and cannot be replaced." }
        : functionCount > sourceCount ? { reason: "Existing function rows would be removed, potentially losing wiring or inspection references." } : {}),
    });
  }
  return targets;
}

/** Atomic explicit replacement. Invalid/stale selection never writes a partial result. */
export function copySwitchButton(
  rows: SwitchEntry[], sourceId: string, destinationIds: readonly string[], makeId: () => string,
): SwitchEntry[] {
  const source = rows.find(row => row.id === sourceId);
  if (!source || !hasPhysicalButton(source) || destinationIds.length === 0) return rows;
  const valid = new Set(switchButtonCopyTargets(rows, sourceId).filter(target => !target.reason).map(target => target.id));
  if (destinationIds.some(id => !valid.has(id))) return rows;
  const destinations = [...new Set(destinationIds)].map(id => rows.find(row => row.id === id)!);
  const sourceRows = rows.filter(row => sameButton(row, source));
  const replaced = new Set<string>();
  const changed = new Set<string>();
  const next = rows.flatMap(row => {
    const destination = destinations.find(target => sameButton(row, target));
    if (!destination) return [row];
    if (replaced.has(destination.id)) return [];
    replaced.add(destination.id);
    const previousRows = rows.filter(candidate => sameButton(candidate, destination));
    return sourceRows.map((template, index): SwitchEntry => {
      const id = previousRows[index]?.id ?? makeId();
      changed.add(id);
      return ({
      ...(previousRows[index] ?? destination),
      id,
      switchGroupId: switchGroupId(destination),
      // Destination wiring, physical group and button identity remain local.
      settingLinkGroupId: undefined,
      buttonFunction: template.buttonFunction,
      buttonType: template.buttonType,
      condition: template.condition,
      isPriorityFunction: template.isPriorityFunction,
      buttonSetting: {
        ...template.buttonSetting,
        sceneIds: [...template.buttonSetting.sceneIds],
        circuitSettings: copiedCircuitSettings(template.buttonSetting.circuitSettings, switchGroupId(source), switchGroupId(destination)),
      },
      backlightTarget: previousRows[index]?.backlightTarget ?? "",
      backlightCondition: template.backlightCondition,
      });
    });
  });
  return validOperationPriorities(next, changed) ? next : rows;
}
