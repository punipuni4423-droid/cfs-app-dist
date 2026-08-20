import type { SceneCircuitSetting } from "../types";

export type BulkSettingMode =
  | "percent"
  | "on"
  | "off"
  | "clear"
  | "raise"
  | "lower"
  | "halfSec"
  | "blinkShort"
  | "blinkLong";

function normalizedDimmingType(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function isOnOffLikeDimmingType(value: string): boolean {
  const normalized = normalizedDimmingType(value);
  return normalized === "on/off" || normalized === "switch" || normalized === "cco" || normalized === "curtain";
}

export function isPercentLikeDimmingType(value: string): boolean {
  const normalized = normalizedDimmingType(value);
  return !["on/off", "switch", "cco", "cci", "curtain", "hvac", "setpoint", "fanmode", "drift"].includes(normalized);
}

export function clampPercentValue(raw: string): string {
  if (raw.trim() === "") return "";
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return "";
  return String(Math.min(100, Math.max(0, Math.round(n))));
}

export function stepPercentValue(raw: string, delta: number): string {
  const current = Number.parseFloat(raw || "0");
  return clampPercentValue(String(current + delta));
}

export function setSceneSettingValue(
  settings: SceneCircuitSetting[],
  targetId: string,
  value: string,
): SceneCircuitSetting[] {
  const trimmed = value.trim();
  const existing = settings.find((setting) => setting.circuitId === targetId);
  if (!trimmed) return settings.filter((setting) => setting.circuitId !== targetId);
  if (existing) {
    return settings.map((setting) =>
      setting.circuitId === targetId ? { ...setting, percentage: trimmed } : setting,
    );
  }
  return [...settings, { circuitId: targetId, percentage: trimmed }];
}

export function bulkModeAppliesToTarget(mode: BulkSettingMode, isOnOff: boolean): boolean {
  if (mode === "clear") return true;
  if (mode === "on" || mode === "off" || mode === "halfSec" || mode === "blinkShort" || mode === "blinkLong") {
    return isOnOff;
  }
  return !isOnOff;
}

export function settingValueForBulkMode(
  mode: BulkSettingMode,
  isOnOff: boolean,
  percentValue: string,
): string | null {
  if (!bulkModeAppliesToTarget(mode, isOnOff)) return null;
  if (mode === "clear") return "";
  if (mode === "on") return "On";
  if (mode === "off") return "Off";
  if (mode === "halfSec") return "0.5 sec";
  if (mode === "blinkShort") return "Blinking (Short)";
  if (mode === "blinkLong") return "Blinking (Long)";
  if (mode === "raise") return "Raise";
  if (mode === "lower") return "Lower";
  const value = clampPercentValue(percentValue);
  return value || null;
}
