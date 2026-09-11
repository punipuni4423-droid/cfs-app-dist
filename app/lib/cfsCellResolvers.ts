import type { Scene, SwitchEntry } from "../types";
import type { CfsZoneRow, FunctionColumn } from "./cfsTableModel";
import { cfsTargetsForRow } from "./cfsTargets";
import {
  areaSceneDisplayName, cellValues, formatLevel, normalizeLevelForCompare,
  roomSceneCellValue, roomSceneHasAreaSceneValue, roomSceneSelectedAreaSceneId,
  roomSceneSettingValue, roomSceneUsesAreaSceneValue, sceneMatchesArea,
  sceneRawValuesForCircuit, sceneRawValuesForTarget, sceneValueForCircuit,
  selectedSceneIdsForSwitch, switchUsesAreaSceneValue, uniqueNonEmptyValues,
} from "./cfsValueResolver";

export interface CfsCellValueContext {
  scenesById: Map<string, Scene>;
  showAreaSceneNames: boolean;
  displayBacklightCondition(value: string, source?: SwitchEntry): string;
  // Only the visible sheet opts into unconfirmed Inspection values.
  inspectionDisplayValues?(row: CfsZoneRow, col: FunctionColumn): string[] | null;
}

/** One value policy for the screen, current-sheet export and per-room export. */
export function createCfsCellResolvers(context: CfsCellValueContext) {
  const { scenesById, showAreaSceneNames, displayBacklightCondition } = context;
  function targetDisplayValues(row: CfsZoneRow, col: FunctionColumn): string[] {
    return uniqueNonEmptyValues(cfsTargetsForRow(row).flatMap((target) => {
      const direct = (col.roomScene?.settings ?? col.source?.buttonSetting.circuitSettings ?? [])
        .find((setting) => setting.circuitId === target.targetId)?.percentage.trim() ?? "";
      const scenes = col.roomScene
        ? [scenesById.get(roomSceneSelectedAreaSceneId(col.roomScene, target.areaId))]
        : col.source ? selectedSceneIdsForSwitch(col.source).map((id) => scenesById.get(id))
          .filter((scene) => scene && sceneMatchesArea(scene, target.areaId)) : [];
      const scene = scenes.find((entry) => entry && sceneValueForCircuit(entry, target.targetId));
      const raw = direct || (scene ? sceneValueForCircuit(scene, target.targetId) : "");
      if (!raw) return [];
      const name = !direct && showAreaSceneNames && scene ? areaSceneDisplayName(scene) : "";
      // This path is only used for CCO targets, whose labels are not percentages.
      return name ? [name, raw] : [raw];
    }));
  }
  function rawFunctionValues(row: CfsZoneRow, col: FunctionColumn): string[] {
    const draft = context.inspectionDisplayValues?.(row, col);
    if (draft) return draft.length ? draft : [""];
    if (row.isBacklight) {
      if (col.roomScene) return [displayBacklightCondition(col.roomScene.backlightCondition) || ""];
      if (!col.source || !row.backlightTargetGroupId) return [""];
      const targets = col.source.backlightTarget.split(",").map((value) => value.trim()).filter(Boolean);
      const condition = displayBacklightCondition(col.source.backlightCondition, col.source);
      return [targets.includes(row.backlightTargetGroupId) && condition ? condition : ""];
    }
    if (row.isHvac && row.hvacSettingId) {
      const dimmingType = row.hvacMetric || "HVAC";
      if (col.roomScene) return [roomSceneSettingValue(col.roomScene, row.hvacSettingId, dimmingType) || ""];
      if (!col.source) return [""];
      const direct = col.source.buttonSetting.circuitSettings.find((setting) => setting.circuitId === row.hvacSettingId)?.percentage ?? "";
      if (direct.trim()) return [formatLevel(direct, dimmingType)];
      return sceneRawValuesForTarget(col.source, row.hvacSettingId, row.locationId, scenesById).map((value) => formatLevel(value, dimmingType)).filter(Boolean);
    }
    if (row.circuits.length === 0) {
      const targets = cfsTargetsForRow(row);
      return targets.length > 0 && targets.every((target) => target.targetId.startsWith("cco:") || target.dimmingType === "CCO") ? targetDisplayValues(row, col) : [""];
    }
    if (col.roomScene) return row.circuits.flatMap((item) => roomSceneCellValue(col.roomScene!, item.circuit, scenesById, showAreaSceneNames));
    if (!col.source) return [""];
    return row.circuits.flatMap((item) => cellValues(col.source!, item.circuit, scenesById, showAreaSceneNames));
  }
  function functionValues(row: CfsZoneRow, col: FunctionColumn): string[] {
    const values = rawFunctionValues(row, col);
    return row.isBacklight || values.some((value) => value.trim() !== "") ? values : ["-"];
  }
  function hasSceneDifferentOverride(row: CfsZoneRow, col: FunctionColumn): boolean {
    if (col.roomScene) {
      if (row.isBacklight || row.isHvac || row.circuits.length === 0) return false;
      return row.circuits.some((item) => {
        const direct = col.roomScene!.settings.find((setting) => setting.circuitId === item.circuit.id)?.percentage.trim() ?? "";
        return direct !== "" && roomSceneHasAreaSceneValue(col.roomScene!, item.circuit, scenesById);
      });
    }
    const sw = col.source;
    if (!sw || row.isBacklight || row.circuits.length === 0) return false;
    return row.circuits.some((item) => {
      const direct = sw.buttonSetting.circuitSettings.find((setting) => setting.circuitId === item.circuit.id)?.percentage.trim() ?? "";
      return Boolean(direct) && sceneRawValuesForCircuit(sw, item.circuit, scenesById)
        .some((value) => normalizeLevelForCompare(value) !== normalizeLevelForCompare(direct));
    });
  }
  function hasAreaSceneValueCell(row: CfsZoneRow, col: FunctionColumn): boolean {
    if (row.isBacklight) return false;
    if (row.isHvac && row.hvacSettingId) return col.source ? switchUsesAreaSceneValue(col.source, row.hvacSettingId, row.locationId, scenesById) : false;
    if (row.circuits.length === 0) return false;
    if (col.roomScene) return row.circuits.some((item) => roomSceneUsesAreaSceneValue(col.roomScene!, item.circuit, scenesById));
    return Boolean(col.source) && row.circuits.some((item) => switchUsesAreaSceneValue(col.source!, item.circuit.id, item.circuit.area, scenesById));
  }
  return { rawFunctionValues, functionValues, hasSceneDifferentOverride, hasAreaSceneValueCell };
}
