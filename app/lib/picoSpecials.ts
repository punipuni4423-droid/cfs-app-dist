import type { LocationMaster, SwitchEntry } from "../types";

export const PICO_CORRIDOR_BUTTON_COUNT = "Corridor";
export const PICO_PRIVACY_BUTTON_COUNT = "Privacy";
export const PICO_BUTTON_COUNT_OPTIONS = ["1", "2", "3", "4", "5", PICO_CORRIDOR_BUTTON_COUNT, PICO_PRIVACY_BUTTON_COUNT] as const;

export const PICO_CORRIDOR_ALLOCATION = "CorridorPico";
export const PICO_CORRIDOR_BUTTON_LABEL = "Chime Button";

export type PicoLedKey = "mur" | "dnd";

export interface PicoLedTarget {
  id: string;
  key: PicoLedKey;
  label: string;
  switchGroupId: string;
  switchNumber: string;
  switchName: string;
  areaId: string;
  areaName: string;
}

export const PICO_LED_DEFINITIONS: Array<{ key: PicoLedKey; label: string }> = [
  { key: "mur", label: "MUR LED" },
  { key: "dnd", label: "DND LED" },
];

const OTHER_AREA_ID = "__other__";

function normalizeToken(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

export function switchGroupIdForPico(sw: SwitchEntry): string {
  return sw.switchGroupId || sw.id;
}

export function isCorridorPicoSwitch(sw: SwitchEntry): boolean {
  if (sw.kind !== "lutronPico") return false;
  return (
    normalizeToken(sw.buttonCount) === normalizeToken(PICO_CORRIDOR_BUTTON_COUNT) ||
    normalizeToken(sw.allocation) === normalizeToken(PICO_CORRIDOR_ALLOCATION)
  );
}

export function isPrivacyPicoButtonCount(count: string): boolean {
  return normalizeToken(count) === normalizeToken(PICO_PRIVACY_BUTTON_COUNT);
}

export function picoButtonLabels(count: string): string[] {
  if (normalizeToken(count) === normalizeToken(PICO_CORRIDOR_BUTTON_COUNT)) return [PICO_CORRIDOR_BUTTON_LABEL];
  if (isPrivacyPicoButtonCount(count)) return ["M1", "M2"];
  const n = Number.parseInt(count, 10);
  return Number.isFinite(n) ? Array.from({ length: n }, (_, index) => String(index + 1)) : [];
}

export function defaultPicoButtonFunction(count: string, label: string): string {
  if (normalizeToken(count) === normalizeToken(PICO_CORRIDOR_BUTTON_COUNT)) return PICO_CORRIDOR_BUTTON_LABEL;
  if (isPrivacyPicoButtonCount(count)) {
    if (label === "M1") return "MUR";
    if (label === "M2") return "DND";
  }
  return "";
}

export function picoAllocationForButtonCount(count: string, currentAllocation: string): string {
  if (normalizeToken(count) === normalizeToken(PICO_CORRIDOR_BUTTON_COUNT)) return PICO_CORRIDOR_ALLOCATION;
  if (normalizeToken(currentAllocation) === normalizeToken(PICO_CORRIDOR_ALLOCATION)) return "";
  return currentAllocation;
}

export function displayedPicoButtonCount(sw: SwitchEntry): string {
  return isCorridorPicoSwitch(sw) ? PICO_CORRIDOR_BUTTON_COUNT : sw.buttonCount;
}

export function picoLedSettingId(groupId: string, key: PicoLedKey): string {
  return `pico-led:${groupId}:${key}`;
}

function corridorArea(locations: LocationMaster[]): { id: string; name: string } {
  const corridor = locations.find((location) => /corridor/i.test(location.name.trim()));
  if (corridor) return { id: corridor.id, name: corridor.name || "Corridor" };
  return { id: OTHER_AREA_ID, name: "Other" };
}

export function corridorPicoLedTargets(
  switches: readonly SwitchEntry[] = [],
  locations: LocationMaster[] = [],
): PicoLedTarget[] {
  const area = corridorArea(locations);
  const groups = new Map<string, SwitchEntry>();
  for (const sw of switches) {
    if (!isCorridorPicoSwitch(sw)) continue;
    const groupId = switchGroupIdForPico(sw);
    if (!groups.has(groupId)) groups.set(groupId, sw);
  }
  return Array.from(groups.entries()).flatMap(([groupId, sw]) =>
    PICO_LED_DEFINITIONS.map((definition) => ({
      id: picoLedSettingId(groupId, definition.key),
      key: definition.key,
      label: definition.label,
      switchGroupId: groupId,
      switchNumber: sw.switchNumber.trim(),
      switchName: sw.switchName.trim() || PICO_CORRIDOR_ALLOCATION,
      areaId: area.id,
      areaName: area.name,
    })),
  );
}
