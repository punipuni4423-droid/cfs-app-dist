import type { SwitchEntry } from "../types";

/**
 * T-35/T-58: shared color/symbol assignment for switch setting-link groups
 * (SwitchEntry.settingLinkGroupId).
 *
 * The Switch tab badges and the CFS column-header link bands MUST show the
 * same color for the same group, so both screens derive their colors from
 * this module. Groups are numbered by FIRST APPEARANCE ORDER in the room
 * type's switches array; do not change that rule in one screen only.
 */

// T-35: group colors avoid the configured-state teal (#0f766e) and the area
// accent hues. 9th group onward cycles.
export const SETTING_LINK_COLORS = [
  "#6d28d9", // violet
  "#1d4ed8", // blue
  "#b45309", // amber
  "#a21caf", // fuchsia
  "#15803d", // green
  "#0369a1", // sky
  "#4338ca", // indigo
  "#be123c", // rose
];

/** Group symbols: A, B, ..., Z, A2, B2, ... in first-appearance order. */
export function settingLinkSymbol(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  const cycle = Math.floor(index / 26);
  return cycle > 0 ? `${letter}${cycle + 1}` : letter;
}

export interface SettingLinkGroupInfo {
  color: string;
  symbol: string;
}

/**
 * Builds groupId -> { color, symbol } for every setting-link group, ordered
 * by the group's first appearance in the given switches array (the exact
 * logic the Switch tab has used since T-35).
 */
export function buildSettingLinkGroups(
  switches: readonly SwitchEntry[],
): Map<string, SettingLinkGroupInfo> {
  const map = new Map<string, SettingLinkGroupInfo>();
  for (const sw of switches) {
    const groupId = sw.settingLinkGroupId;
    if (!groupId || map.has(groupId)) continue;
    const index = map.size;
    map.set(groupId, {
      color: SETTING_LINK_COLORS[index % SETTING_LINK_COLORS.length],
      symbol: settingLinkSymbol(index),
    });
  }
  return map;
}
