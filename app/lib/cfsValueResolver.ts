import type { CircuitEntry, RoomScene, Scene, SceneCircuitSetting, SwitchEntry } from "../types";

export function uniqueNonEmptyValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function areaSceneDisplayName(scene: Scene): string {
  return scene.name.trim();
}

export function sceneValueForCircuit(scene: Scene, circuitId: string): string {
  return scene.settings.find((setting) => setting.circuitId === circuitId)?.percentage.trim() ?? "";
}

export function hasSetting(settings: SceneCircuitSetting[], targetId: string): boolean {
  return settings.some((setting) => setting.circuitId === targetId);
}

export function setSettingsValue(settings: SceneCircuitSetting[], targetId: string, value: string): SceneCircuitSetting[] {
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

function appendTemperatureUnit(value: string): string {
  return value.replace(/(^|[:/\s])([+-]?\d+(?:\.\d+)?)(?=$|[\s/])/g, (_match, prefix: string, n: string) => {
    return `${prefix}${n}°C`;
  });
}

export function formatLevel(value: string, dimmingType: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (dimmingType === "Curtain") return trimmed;
  if (dimmingType === "On/Off") return trimmed;
  if (dimmingType === "Setpoint" || dimmingType === "Drift") return appendTemperatureUnit(trimmed);
  if (!Number.isFinite(Number.parseFloat(trimmed))) return trimmed;
  return `${trimmed}%`;
}

export function selectedSceneIdsForSwitch(sw: SwitchEntry): string[] {
  return uniqueNonEmptyValues(
    sw.buttonSetting.sceneIds.length > 0
      ? sw.buttonSetting.sceneIds
      : sw.buttonSetting.sceneId
        ? [sw.buttonSetting.sceneId]
        : [],
  );
}

// Scene-name lines inside CFS cell stacks are tagged with this prefix so the
// renderer bolds exactly the Area Scene name, never a setting value. The old
// even/odd line heuristic mis-bolded values whenever a zone row mixed a
// direct-override circuit (1 line) with an area-scene circuit (2 lines).
export const SCENE_NAME_LINE_PREFIX = "\u0001";

export function stripSceneNameLinePrefix(value: string): string {
  return value.startsWith(SCENE_NAME_LINE_PREFIX) ? value.slice(1) : value;
}

export function isSceneNameLine(value: string): boolean {
  return value.startsWith(SCENE_NAME_LINE_PREFIX);
}

export function cellValues(
  sw: SwitchEntry,
  circuit: CircuitEntry,
  scenesById: Map<string, Scene>,
  showAreaSceneNames = true,
): string[] {
  const direct = sw.buttonSetting.circuitSettings.find((setting) => setting.circuitId === circuit.id)?.percentage ?? "";
  if (direct.trim()) return [formatLevel(direct, circuit.dimmingType)];

  const selectedSceneIds = selectedSceneIdsForSwitch(sw);
  const seenSceneValues = new Set<string>();

  return selectedSceneIds
    .map((sceneId) => scenesById.get(sceneId))
    .filter((scene): scene is Scene => Boolean(scene))
    .flatMap((scene) => {
      // Only the scene of the circuit's own area may label this cell. Scenes
      // can hold stale rows for circuits that were later moved to another
      // area (e.g. TP-08 Vanity -> Bedroom, 2026-08-24); without this guard
      // the old area's scene added a second name/value pair to the cell.
      if (scene.areaId !== circuit.area) return [];
      const value = sceneValueForCircuit(scene, circuit.id);
      if (!value) return [];
      const formattedValue = formatLevel(value, circuit.dimmingType);
      const label = areaSceneDisplayName(scene);
      const key = `${showAreaSceneNames ? label : ""}\u0000${formattedValue}`;
      if (seenSceneValues.has(key)) return [];
      seenSceneValues.add(key);
      return showAreaSceneNames && label ? [SCENE_NAME_LINE_PREFIX + label, formattedValue] : [formattedValue];
    })
    .filter(Boolean)
    .filter((value) => value.trim() !== "");
}

export function roomSceneSelectedAreaSceneId(scene: RoomScene, areaId: string): string {
  return (scene.areaSceneSelections ?? []).find((selection) => selection.areaId === areaId)?.sceneId ?? "";
}

export function roomSceneCellValue(
  scene: RoomScene,
  circuit: CircuitEntry,
  scenesById: Map<string, Scene>,
  showAreaSceneNames: boolean,
): string[] {
  const value = scene.settings.find((setting) => setting.circuitId === circuit.id)?.percentage ?? "";
  if (value.trim()) return [formatLevel(value, circuit.dimmingType)];
  const areaSceneId = roomSceneSelectedAreaSceneId(scene, circuit.area);
  if (!areaSceneId) return [];
  const areaScene = scenesById.get(areaSceneId);
  if (!areaScene) return [];
  const areaSceneValue = sceneValueForCircuit(areaScene, circuit.id);
  if (!areaSceneValue) return [];
  const formattedValue = formatLevel(areaSceneValue, circuit.dimmingType);
  const label = areaSceneDisplayName(areaScene);
  return showAreaSceneNames && label ? [SCENE_NAME_LINE_PREFIX + label, formattedValue] : [formattedValue];
}

export function roomSceneSettingValue(scene: RoomScene, targetId: string, dimmingType: string): string {
  const value = scene.settings.find((setting) => setting.circuitId === targetId)?.percentage ?? "";
  return formatLevel(value, dimmingType);
}

export function roomSceneHasAreaSceneValue(scene: RoomScene, circuit: CircuitEntry, scenesById: Map<string, Scene>): boolean {
  const areaSceneId = roomSceneSelectedAreaSceneId(scene, circuit.area);
  if (!areaSceneId) return false;
  const areaScene = scenesById.get(areaSceneId);
  if (!areaScene) return false;
  return sceneValueForCircuit(areaScene, circuit.id).trim() !== "";
}

export function roomSceneUsesAreaSceneValue(scene: RoomScene, circuit: CircuitEntry, scenesById: Map<string, Scene>): boolean {
  const direct = scene.settings.find((setting) => setting.circuitId === circuit.id)?.percentage.trim() ?? "";
  return !direct && roomSceneHasAreaSceneValue(scene, circuit, scenesById);
}

export function sceneRawValuesForTarget(sw: SwitchEntry, targetId: string, scenesById: Map<string, Scene>): string[] {
  return selectedSceneIdsForSwitch(sw)
    .map((sceneId) => scenesById.get(sceneId))
    .filter((scene): scene is Scene => Boolean(scene))
    .map((scene) => sceneValueForCircuit(scene, targetId).trim())
    .filter(Boolean);
}

export function sceneRawValuesForCircuit(sw: SwitchEntry, circuitId: string, scenesById: Map<string, Scene>): string[] {
  return sceneRawValuesForTarget(sw, circuitId, scenesById);
}

export function switchUsesAreaSceneValue(sw: SwitchEntry, targetId: string, scenesById: Map<string, Scene>): boolean {
  const direct = sw.buttonSetting.circuitSettings.find((setting) => setting.circuitId === targetId)?.percentage.trim() ?? "";
  if (direct) return false;
  return sceneRawValuesForTarget(sw, targetId, scenesById).length > 0;
}

export function normalizeLevelForCompare(value: string): string {
  return value.trim().replace(/%$/, "").trim();
}

export function normalizeInspectionInput(value: string, dimmingType: string): string {
  const trimmed = value.trim().replace(/°C$/i, "").replace(/%$/, "").trim();
  if (!trimmed) return "";
  if (
    dimmingType === "On/Off" ||
    dimmingType === "CCO" ||
    dimmingType === "CCI" ||
    dimmingType === "Curtain" ||
    dimmingType === "HVAC" ||
    dimmingType === "Setpoint" ||
    dimmingType === "Fan Mode" ||
    dimmingType === "Drift"
  ) {
    return trimmed;
  }
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric)) return trimmed;
  return String(Math.min(100, Math.max(0, Math.round(numeric))));
}

export function isPercentInspectionType(dimmingType: string): boolean {
  return !["On/Off", "Switch", "CCO", "CCI", "Curtain", "HVAC", "Setpoint", "Fan Mode", "Drift"].includes(dimmingType);
}
