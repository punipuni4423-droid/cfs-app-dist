import type { SceneCircuitSetting, SceneValueMode } from "../types";

export function settingValueMode(setting: Pick<SceneCircuitSetting, "valueMode"> | undefined): SceneValueMode {
  return setting?.valueMode === "text" ? "text" : "standard";
}

export function normalizeSettingValue(value: string, mode: SceneValueMode): string {
  return mode === "text" ? value.replace(/\r\n?/g, "\n") : value.trim();
}

export function isPlainNumericSetting(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%?$/.test(value.trim());
}

export function canUseStandardValue(value: string, dimmingType: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (isPlainNumericSetting(trimmed) && !["On/Off", "Switch", "CCO", "Curtain"].includes(dimmingType)) return true;
  return ["On", "Off", "Uneffected", "Raise", "Lower", "Blinking (Short)", "Blinking (Long)", "0.5 sec", "Open", "Close", "Stop"].includes(trimmed);
}

/** Mode-only edits retain each member's own body, including mixed and empty Text. */
export function setSceneSettingModes(settings: readonly SceneCircuitSetting[], targetIds: readonly string[], mode: SceneValueMode, dimmingType: string): SceneCircuitSetting[] | undefined {
  const ids = new Set(targetIds);
  if (mode === "standard" && targetIds.some((id) => !canUseStandardValue(settings.find((setting) => setting.circuitId === id)?.percentage ?? "", dimmingType))) return undefined;
  const next = settings.filter((setting) => !(ids.has(setting.circuitId) && mode === "standard" && !setting.percentage.trim()))
    .map((setting) => ids.has(setting.circuitId) ? { ...setting, valueMode: mode === "text" ? "text" as const : undefined } : setting);
  if (mode === "text") for (const id of ids) {
    if (!next.some((setting) => setting.circuitId === id)) next.push({ circuitId: id, percentage: "", valueMode: "text" });
  }
  return next;
}

export function settingValuesEqual(left: string, leftMode: SceneValueMode, right: string, rightMode: SceneValueMode): boolean {
  if (leftMode !== rightMode) return false;
  if (leftMode === "text") return normalizeSettingValue(left, leftMode) === normalizeSettingValue(right, rightMode);
  return left.trim().replace(/%$/, "").trim() === right.trim().replace(/%$/, "").trim();
}

export function settingComparisonKey(setting: Pick<SceneCircuitSetting, "percentage" | "valueMode">): string {
  const mode = settingValueMode(setting);
  return JSON.stringify([mode, normalizeSettingValue(setting.percentage, mode)]);
}
