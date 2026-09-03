import type { LocationMaster, SwitchEntry } from "../types";
import { createAppId } from './id';

export interface PirInstanceOption {
  value: string;
  areaId: string;
  index: number;
  globalIndex: number;
  areaName: string;
  label: string;
}

function createDefaultId(): string {
  return createAppId();
}

export function switchGroupId(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

export function supportsPriorityFunction(sw: SwitchEntry): boolean {
  return sw.kind !== "command" && sw.kind !== "pir" && sw.kind !== "qsm";
}

export function switchPriorityFunctionGroupKey(sw: SwitchEntry): string {
  const button =
    sw.kind === "lutronPd" || sw.kind === "lutronPico"
      ? sw.buttonLabel.trim() || "-"
      : "single-button";
  return `${sw.kind}\u0000${switchGroupId(sw)}\u0000${button}`;
}

export function normalizeSwitchPriorityFunctions(switches: SwitchEntry[]): SwitchEntry[] {
  const groupCounts = new Map<string, number>();
  const selectedCounts = new Map<string, number>();
  const lastSelectedIds = new Map<string, string>();
  for (const sw of switches) {
    if (!supportsPriorityFunction(sw)) continue;
    const key = switchPriorityFunctionGroupKey(sw);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    if (sw.isPriorityFunction === true) {
      selectedCounts.set(key, (selectedCounts.get(key) ?? 0) + 1);
      lastSelectedIds.set(key, sw.id);
    }
  }

  let changed = false;
  const next = switches.map((sw) => {
    if (!supportsPriorityFunction(sw)) {
      if (sw.isPriorityFunction) changed = true;
      return sw.isPriorityFunction ? { ...sw, isPriorityFunction: undefined } : sw;
    }
    const key = switchPriorityFunctionGroupKey(sw);
    const groupCount = groupCounts.get(key) ?? 0;
    if (groupCount > 1 && sw.isPriorityFunction === true) {
      if ((selectedCounts.get(key) ?? 0) >= groupCount && lastSelectedIds.get(key) === sw.id) {
        changed = true;
        return { ...sw, isPriorityFunction: undefined };
      }
      return sw;
    }
    if (sw.isPriorityFunction) {
      changed = true;
      return { ...sw, isPriorityFunction: undefined };
    }
    return sw;
  });

  return changed ? next : switches;
}

function cleanSwitchValue(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "-" ? "" : trimmed;
}

export function hasSwitchOperationalIdentity(sw: SwitchEntry): boolean {
  const hasDisplayOrAssignment = [
    sw.switchNumber,
    sw.switchName,
    sw.cciAssignment,
    sw.buttonCount,
    sw.buttonLabel,
    sw.allocation,
    sw.buttonFunction,
    sw.condition,
  ].some((value) => cleanSwitchValue(value));
  if (hasDisplayOrAssignment) return true;

  const setting = sw.buttonSetting;
  return Boolean(
    cleanSwitchValue(setting?.sceneId) ||
      setting?.sceneIds?.some((sceneId) => cleanSwitchValue(sceneId)) ||
      setting?.circuitSettings?.some(
        (item) => cleanSwitchValue(item.circuitId) || cleanSwitchValue(item.percentage),
      ),
  );
}

export function hasMeaningfulBacklightSource(sw: SwitchEntry): boolean {
  if (!hasSwitchOperationalIdentity(sw)) return false;
  if (!cleanSwitchValue(sw.backlightTarget)) return false;
  return cleanSwitchValue(sw.backlightCondition) !== "__byScene";
}

export function hasBacklightConfiguration(sw: SwitchEntry): boolean {
  if (!hasSwitchOperationalIdentity(sw)) return false;
  return Boolean(cleanSwitchValue(sw.backlightTarget) || cleanSwitchValue(sw.backlightCondition));
}

export function parsePirAreaNumbers(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function pirInstanceValue(areaId: string, index: number): string {
  return `${areaId}::${index}`;
}

export function normalizePirCount(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count < 1) return "";
  return String(Math.min(99, count));
}

export function parseQsmAssignments(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  } catch {
    return raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
}

export function parsePirSelections(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    }
  } catch {
    // Legacy single-selection values are stored as plain strings.
  }
  return [value];
}

export function buildPirRegistrationCounts(switches: readonly SwitchEntry[]): Record<string, string> {
  const counts: Record<string, string> = {};
  for (const sw of switches) {
    if (sw.kind !== "pir") continue;
    const rowCounts = parsePirAreaNumbers(sw.allocation);
    const areaIds = new Set([
      ...sw.switchNumber.split(",").map((value) => value.trim()).filter(Boolean),
      ...Object.keys(rowCounts),
    ]);
    for (const areaId of areaIds) {
      const normalized = normalizePirCount(rowCounts[areaId] ?? sw.switchName.trim());
      if (!normalized) continue;
      const existing = Number.parseInt(counts[areaId] ?? "", 10);
      const next = Number.parseInt(normalized, 10);
      if (!Number.isFinite(existing) || next > existing) counts[areaId] = normalized;
    }
  }
  return counts;
}

export function pirInstanceOptionsFrom(
  locations: readonly LocationMaster[],
  areaIds: Set<string>,
  counts: Record<string, string>,
): PirInstanceOption[] {
  const options: PirInstanceOption[] = [];
  let globalIndex = 1;
  for (const location of locations) {
    if (!areaIds.has(location.id)) continue;
    const parsedCount = Number.parseInt(counts[location.id] ?? "", 10);
    const count = Number.isFinite(parsedCount) ? Math.min(99, Math.max(0, parsedCount)) : 0;
    for (let index = 1; index <= count; index += 1) {
      options.push({
        value: pirInstanceValue(location.id, index),
        areaId: location.id,
        index,
        globalIndex,
        areaName: location.name,
        label: `PIR${globalIndex}`,
      });
      globalIndex += 1;
    }
  }
  return options;
}

export function buildPirRegisteredOptions(
  switches: readonly SwitchEntry[],
  locations: readonly LocationMaster[],
): PirInstanceOption[] {
  const counts = buildPirRegistrationCounts(switches);
  return pirInstanceOptionsFrom(locations, new Set(Object.keys(counts).filter((areaId) => counts[areaId])), counts);
}

export function normalizeQsmAssignments(
  rows: SwitchEntry[],
  locations: readonly LocationMaster[],
  preferred?: { qsmId: string; pirValue: string },
): SwitchEntry[] {
  const qsmRows = rows.filter((sw) => sw.kind === "qsm");
  if (qsmRows.length === 0) return rows;

  const validPirValues = buildPirRegisteredOptions(rows, locations).map((option) => option.value);
  const validPirSet = new Set(validPirValues);
  const qsmIds = new Set(qsmRows.map((sw) => sw.id));
  const firstQsmId = qsmRows[0].id;
  const ownerByPir = new Map<string, string>();

  for (const sw of qsmRows) {
    for (const value of parseQsmAssignments(sw.allocation)) {
      if (!validPirSet.has(value)) continue;
      if (!ownerByPir.has(value)) ownerByPir.set(value, sw.id);
    }
  }

  if (preferred && validPirSet.has(preferred.pirValue) && qsmIds.has(preferred.qsmId)) {
    ownerByPir.set(preferred.pirValue, preferred.qsmId);
  }

  for (const value of validPirValues) {
    if (!ownerByPir.has(value)) ownerByPir.set(value, firstQsmId);
  }

  let changed = false;
  const nextRows = rows.map((sw) => {
    if (sw.kind !== "qsm") return sw;
    const ordered = validPirValues.filter((value) => ownerByPir.get(value) === sw.id);
    const nextAllocation = JSON.stringify(ordered);
    if (sw.allocation === nextAllocation) return sw;
    changed = true;
    return { ...sw, allocation: nextAllocation };
  });

  return changed ? nextRows : rows;
}

export function dedupeSwitchIds(
  switches: SwitchEntry[],
  createId: () => string = createDefaultId,
): SwitchEntry[] {
  const seen = new Set<string>();
  let changed = false;
  const next = switches.map((sw) => {
    if (!seen.has(sw.id)) {
      seen.add(sw.id);
      return sw;
    }
    changed = true;
    const id = createId();
    seen.add(id);
    // T-35: a re-identified clone must not silently join a setting link
    // group; dropping the id prevents accidental link multiplication.
    return { ...sw, id, settingLinkGroupId: undefined };
  });
  return changed ? next : switches;
}
