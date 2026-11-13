import type { LocationMaster, SwitchEntry } from "../types";
import { buildPirRegisteredOptions, parsePirSelections, switchGroupId } from "./switchSync";
import { copiedCircuitSettings, validOperationPriorities } from "./switchOperationContent";
import { hasTstatBindingQuarantine } from "./tstatBindingQuarantine";

export type OperationScope = "function" | "switch";
type FunctionContent = Pick<SwitchEntry, "buttonFunction" | "buttonType" | "condition" | "isPriorityFunction" | "buttonSetting" | "backlightCondition" | "backlightTarget">;
export interface OperationClipboard {
  scope: OperationScope;
  kind: SwitchEntry["kind"];
  sourceId: string;
  sourceGroupId: string;
  label: string;
  rows: readonly { button: string; content: FunctionContent }[];
  buttonCount: string;
}
export interface OperationPasteTarget { id: string; label: string; functionCount: number; reason?: string }

function content(row: SwitchEntry): FunctionContent {
  return {
    buttonFunction: row.buttonFunction, buttonType: row.buttonType, condition: row.condition,
    isPriorityFunction: row.isPriorityFunction,
    buttonSetting: { ...row.buttonSetting, sceneIds: [...row.buttonSetting.sceneIds], circuitSettings: row.buttonSetting.circuitSettings.map(setting => ({ ...setting })) },
    backlightCondition: row.backlightCondition,
    backlightTarget: row.backlightTarget,
  };
}
function applyContent(target: SwitchEntry, value: FunctionContent, sourceGroup: string, scope: OperationScope): SwitchEntry {
  const copied = content({ ...target, ...value });
  const settingsOnly = scope === "function" && target.kind !== "command";
  return {
    ...target,
    ...copied,
    ...(settingsOnly ? {
      buttonFunction: target.buttonFunction, buttonType: target.buttonType, condition: target.condition,
    } : { backlightTarget: target.backlightTarget }),
    buttonSetting: { ...copied.buttonSetting, circuitSettings: copiedCircuitSettings(copied.buttonSetting.circuitSettings, sourceGroup, switchGroupId(target)) },
    settingLinkGroupId: undefined,
  };
}
function groupRows(rows: readonly SwitchEntry[], row: SwitchEntry): SwitchEntry[] {
  // Commands are independent rows even if imported legacy data reuses a group ID.
  return rows.filter(candidate => row.kind === "command" ? candidate.id === row.id : candidate.kind === row.kind && switchGroupId(candidate) === switchGroupId(row));
}
export function operationRowLabel(rows: readonly SwitchEntry[], row: SwitchEntry, scope: OperationScope, locations: readonly LocationMaster[] = []): string {
  const kind = ({ lutronPd: "Palladiom", lutronPico: "Pico", contact: "Contact", pir: "PIR", tstat: "Thermostat", command: "Command", qsm: "QSM" })[row.kind];
  const ordinal = [...new Set(rows.filter(candidate => candidate.kind === row.kind).map(switchGroupId))].indexOf(switchGroupId(row)) + 1;
  if (row.kind === "pir") {
    const selected = new Set(parsePirSelections(row.buttonLabel));
    const names = buildPirRegisteredOptions(rows, locations).filter(option => selected.has(option.value)).map(option => `${option.label} (${option.areaName})`);
    const name = `${names.join(", ") || "PIR unassigned"} / Group #${ordinal}`;
    const functions = groupRows(rows, row);
    return scope === "switch" ? name : `${name} / Function ${functions.findIndex(candidate => candidate.id === row.id) + 1}${row.buttonFunction ? `: ${row.buttonFunction}` : ""}`;
  }
  const name = `${kind} ${row.switchNumber || `#${ordinal}`}${row.switchName ? ` / ${row.switchName}` : ""}`;
  return scope === "switch" ? name : `${name}${row.buttonLabel && row.buttonLabel !== "-" ? ` / ${row.buttonLabel}` : ""} / Function ${groupRows(rows, row).findIndex(candidate => candidate.id === row.id) + 1}${row.buttonFunction ? `: ${row.buttonFunction}` : ""}`;
}
export function copyOperation(rows: readonly SwitchEntry[], sourceId: string, scope: OperationScope, locations: readonly LocationMaster[] = []): OperationClipboard | null {
  const source = rows.find(row => row.id === sourceId);
  if (!source || source.kind === "qsm" || hasTstatBindingQuarantine(source)) return null;
  if (scope === "switch" && groupRows(rows, source).some(hasTstatBindingQuarantine)) return null;
  return {
    scope, kind: source.kind, sourceId, sourceGroupId: switchGroupId(source), label: operationRowLabel(rows, source, scope, locations), buttonCount: source.buttonCount,
    rows: (scope === "function" ? [source] : groupRows(rows, source)).map(row => ({ button: row.buttonLabel, content: content(row) })),
  };
}
function layoutReason(rows: readonly SwitchEntry[], target: SwitchEntry, clipboard: OperationClipboard): string | undefined {
  if (clipboard.scope !== "switch") return;
  const previous = groupRows(rows, target);
  if (target.kind === "lutronPd" || target.kind === "lutronPico") {
    const buttons = [...new Set(previous.map(row => row.buttonLabel))].sort();
    const sourceButtons = [...new Set(clipboard.rows.map(row => row.button))].sort();
    if (target.buttonCount !== clipboard.buttonCount || JSON.stringify(buttons) !== JSON.stringify(sourceButtons)) return "Button layouts differ. Device registration will not be changed.";
  }
  const physicalButtons = target.kind === "lutronPd" || target.kind === "lutronPico";
  const removesRows = physicalButtons
    ? previous.some(row => previous.filter(item => item.buttonLabel === row.buttonLabel).length > clipboard.rows.filter(item => item.button === row.buttonLabel).length)
    : previous.length > clipboard.rows.length;
  if (removesRows) {
    return "Existing function rows would be removed, potentially losing wiring or inspection references.";
  }
}
export function operationPasteTargets(rows: readonly SwitchEntry[], clipboard: OperationClipboard, locations: readonly LocationMaster[] = []): OperationPasteTarget[] {
  if (!clipboard.rows.length || !rows.some(row => !hasTstatBindingQuarantine(row) && row.id === clipboard.sourceId && row.kind === clipboard.kind && switchGroupId(row) === clipboard.sourceGroupId)) return [];
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (row.kind !== clipboard.kind || row.kind === "qsm" || hasTstatBindingQuarantine(row)) return [];
    if (clipboard.scope === "switch" && groupRows(rows, row).some(hasTstatBindingQuarantine)) return [];
    const id = clipboard.scope === "function" || row.kind === "command" ? row.id : switchGroupId(row);
    if (seen.has(id)) return [];
    seen.add(id);
    if (clipboard.scope === "function" ? row.id === clipboard.sourceId : row.kind === "command" ? row.id === clipboard.sourceId : switchGroupId(row) === clipboard.sourceGroupId) return [];
    return [{ id, label: operationRowLabel(rows, row, clipboard.scope, locations), functionCount: clipboard.scope === "function" ? 1 : groupRows(rows, row).length, reason: layoutReason(rows, row, clipboard) }];
  });
}
/** Match checked row IDs against the same eligibility list used for direct paste. */
export function checkedOperationPasteRows(
  checkedIds: ReadonlySet<string>,
  targets: ReadonlyMap<string, OperationPasteTarget>,
): { ids: string[]; reasons: string[] } {
  const ids: string[] = [];
  const reasons = new Set<string>();
  for (const id of checkedIds) {
    const target = targets.get(id);
    if (!target || target.reason) {
      reasons.add(target?.reason ?? "The source, incompatible, quarantined, or non-representative rows cannot receive this copy.");
    } else {
      ids.push(id);
    }
  }
  return { ids, reasons: [...reasons] };
}

/** Explicit, atomic replacement of action content. Physical wiring/binding and other rows stay local. */
export function pasteOperation(rows: SwitchEntry[], clipboard: OperationClipboard, destinationIds: readonly string[], makeId: () => string): SwitchEntry[] {
  if (!destinationIds.length) return rows;
  const targets = operationPasteTargets(rows, clipboard);
  if (destinationIds.some(id => !targets.some(target => target.id === id && !target.reason))) return rows;
  const selected = new Set(destinationIds), changed = new Set<string>(), emitted = new Set<string>();
  const next = rows.flatMap(row => {
    if (row.kind !== clipboard.kind) return [row];
    if (clipboard.scope === "function") {
      if (!selected.has(row.id)) return [row];
      changed.add(row.id); return [applyContent(row, clipboard.rows[0].content, clipboard.sourceGroupId, clipboard.scope)];
    }
    const id = row.kind === "command" ? row.id : switchGroupId(row);
    if (!selected.has(id)) return [row];
    if (emitted.has(id)) return [];
    emitted.add(id);
    const previous = groupRows(rows, row), used = new Set<string>();
    const physicalButtons = row.kind === "lutronPd" || row.kind === "lutronPico";
    return clipboard.rows.map((template, index) => {
      const matched = physicalButtons ? previous.find(candidate => !used.has(candidate.id) && candidate.buttonLabel === template.button) : previous[index];
      const target = matched ?? row;
      const existing = Boolean(matched);
      if (existing) used.add(target.id);
      const result = applyContent({ ...target, id: existing ? target.id : makeId(), backlightTarget: existing ? target.backlightTarget : "", switchGroupId: switchGroupId(row), buttonLabel: row.kind === "lutronPd" || row.kind === "lutronPico" ? template.button : target.buttonLabel }, template.content, clipboard.sourceGroupId, clipboard.scope);
      changed.add(result.id); return result;
    });
  });
  return validOperationPriorities(next, changed) ? next : rows;
}
