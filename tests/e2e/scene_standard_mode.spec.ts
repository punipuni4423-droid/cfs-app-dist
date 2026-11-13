import { test, expect } from "@playwright/test";
import { canUseStandardValue, setSceneSettingModes } from "../../app/lib/sceneValueMode";
import { normalizeInspectionInput } from "../../app/lib/cfsValueResolver";
import type { SceneCircuitSetting } from "../../app/types";

test("Standard supports existing numeric/actions while arbitrary notes need Text", () => {
  for (const value of ["", "0", "37", "37.5", "100%", "Off", "On", "Uneffected", "Raise", "Lower", "Blinking (Short)", "0.5 sec"]) expect(canUseStandardValue(value, "0-10V")).toBe(true);
  for (const value of ["Occupied: 50% / Vacant: Off", "abc", "37x", "50\n75"]) expect(canUseStandardValue(value, "0-10V")).toBe(false);
  expect(canUseStandardValue("Off", "On/Off")).toBe(true); expect(canUseStandardValue("37", "On/Off")).toBe(false);
  expect(canUseStandardValue("Open", "Curtain")).toBe(true);
  expect(normalizeInspectionInput("150", "0-10V")).toBe("100");
  expect(normalizeInspectionInput("-5", "0-10V")).toBe("0");
  expect(normalizeInspectionInput("25°C", "Setpoint")).toBe("25");
  expect(normalizeInspectionInput("Auto", "Fan Mode")).toBe("Auto");
});

test("mode-only changes preserve all mixed bodies, untouched metadata and atomic Text-to-Standard refusal", () => {
  const settings: SceneCircuitSetting[] = [{ circuitId: "a", percentage: "50" }, { circuitId: "b", percentage: "75" },
    { circuitId: "unrelated", percentage: "Keep\nThis", valueMode: "text" }];
  const snapshot = JSON.stringify(settings);
  const text = setSceneSettingModes(settings, ["a", "b"], "text", "0-10V")!;
  expect(text.map((setting) => setting.percentage)).toEqual(["50", "75", "Keep\nThis"]);
  expect(text.slice(0, 2).every((setting) => setting.valueMode === "text")).toBe(true);
  expect(text[2]).toBe(settings[2]); expect(JSON.stringify(settings)).toBe(snapshot);
  const mixedText = text.map((setting) => setting.circuitId === "b" ? { ...setting, percentage: "Occupied\nVacant" } : setting);
  const before = JSON.stringify(mixedText);
  expect(setSceneSettingModes(mixedText, ["a", "b"], "standard", "0-10V")).toBeUndefined();
  expect(JSON.stringify(mixedText)).toBe(before);
  expect(setSceneSettingModes(text, ["a", "b"], "standard", "0-10V")?.map((setting) => setting.percentage)).toEqual(["50", "75", "Keep\nThis"]);
});

test("legacy free bodies are not migrated away and empty/zero/Off retain their established meanings", () => {
  const legacy: SceneCircuitSetting[] = [{ circuitId: "old", percentage: "Legacy note" }, { circuitId: "zero", percentage: "0" }, { circuitId: "off", percentage: "Off" }];
  const text = setSceneSettingModes(legacy, ["old", "zero", "off", "empty"], "text", "0-10V")!;
  expect(text.map((setting) => setting.percentage)).toEqual(["Legacy note", "0", "Off", ""]);
  expect(legacy[0]).toEqual({ circuitId: "old", percentage: "Legacy note" });
  const standard = setSceneSettingModes(text, ["zero", "off", "empty"], "standard", "0-10V")!;
  expect(standard.find((setting) => setting.circuitId === "zero")?.percentage).toBe("0");
  expect(standard.find((setting) => setting.circuitId === "off")?.percentage).toBe("Off");
  expect(standard.some((setting) => setting.circuitId === "empty")).toBe(false);
});
