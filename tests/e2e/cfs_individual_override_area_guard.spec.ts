import { expect, test } from "@playwright/test";
import type { CircuitEntry, Scene, SwitchEntry } from "../../app/types";
import {
  SCENE_NAME_LINE_PREFIX,
  cellValues,
  sceneMatchesArea,
  sceneRawValuesForCircuit,
  sceneRawValuesForTarget,
  switchUsesAreaSceneValue,
} from "../../app/lib/cfsValueResolver";
import { OTHER_AREA_ID } from "../../app/lib/cfsTableModel";

function circuit(overrides: Partial<CircuitEntry>): CircuitEntry {
  return {
    id: "circuit-x",
    circuitGroupId: "group-x",
    daliFixtureGroupId: "",
    designerNumber: "TP-08",
    internalNumber: "",
    dimmingType: "On/Off",
    fixture: "",
    pcs: "1",
    detail: "Night Foot",
    area: "area-bedroom",
    ffe: false,
    energySaving: false,
    ...overrides,
  };
}

function switchRow(overrides: Partial<SwitchEntry> = {}): SwitchEntry {
  return {
    id: "switch-row",
    switchGroupId: "switch-group",
    kind: "lutronPd",
    switchNumber: "SW-1",
    switchName: "Master",
    cciAssignment: "",
    buttonCount: "4",
    buttonLabel: "M1",
    allocation: "",
    buttonFunction: "Master",
    buttonType: "single",
    condition: "",
    buttonSetting: {
      sceneId: "",
      sceneIds: ["scene-bedroom-bright", "scene-vanity-max"],
      circuitSettings: [],
    },
    backlightTarget: "",
    backlightCondition: "",
    backlightAssignment: "",
    backlightLevels: [],
    ...overrides,
  };
}

function scenesById(scenes: Scene[]): Map<string, Scene> {
  return new Map(scenes.map((scene) => [scene.id, scene]));
}

test("ignores stale Area Scene values from a target's previous area", () => {
  const target = circuit({ id: "tp-08", area: "area-bedroom" });
  const scenes = scenesById([
    {
      id: "scene-bedroom-bright",
      areaId: "area-bedroom",
      name: "Bright",
      settings: [],
    },
    {
      id: "scene-vanity-max",
      areaId: "area-vanity",
      name: "MAX",
      settings: [{ circuitId: "tp-08", percentage: "On" }],
    },
  ]);
  const sw = switchRow({
    buttonSetting: {
      sceneId: "",
      sceneIds: ["scene-bedroom-bright", "scene-vanity-max"],
      circuitSettings: [{ circuitId: "tp-08", percentage: "Off" }],
    },
  });

  expect(cellValues(sw, target, scenes)).toEqual(["Off"]);
  expect(sceneRawValuesForCircuit(sw, target, scenes)).toEqual([]);
});

test("does not mark an empty same-area scene as an Area Scene value", () => {
  const target = circuit({ id: "tp-08", area: "area-bedroom" });
  const scenes = scenesById([
    {
      id: "scene-bedroom-bright",
      areaId: "area-bedroom",
      name: "Bright",
      settings: [],
    },
    {
      id: "scene-vanity-max",
      areaId: "area-vanity",
      name: "MAX",
      settings: [{ circuitId: "tp-08", percentage: "On" }],
    },
  ]);
  const sw = switchRow();

  expect(cellValues(sw, target, scenes)).toEqual([]);
  expect(switchUsesAreaSceneValue(sw, target.id, target.area, scenes)).toBe(false);
});

test("keeps true same-area Individual Override evidence", () => {
  const target = circuit({ id: "tp-08", area: "area-bedroom" });
  const scenes = scenesById([
    {
      id: "scene-bedroom-bright",
      areaId: "area-bedroom",
      name: "Bright",
      settings: [{ circuitId: "tp-08", percentage: "On" }],
    },
    {
      id: "scene-vanity-max",
      areaId: "area-vanity",
      name: "MAX",
      settings: [{ circuitId: "tp-08", percentage: "On" }],
    },
  ]);
  const sw = switchRow({
    buttonSetting: {
      sceneId: "",
      sceneIds: ["scene-bedroom-bright", "scene-vanity-max"],
      circuitSettings: [{ circuitId: "tp-08", percentage: "Off" }],
    },
  });

  expect(sceneRawValuesForCircuit(sw, target, scenes)).toEqual(["On"]);
});

test("matches blank target area with the Other Area Scene sentinel", () => {
  const target = circuit({ id: "other-circuit", area: "" });
  const scenes = scenesById([
    {
      id: "scene-other",
      areaId: OTHER_AREA_ID,
      name: "Other Scene",
      settings: [{ circuitId: "other-circuit", percentage: "On" }],
    },
  ]);
  const sw = switchRow({
    buttonSetting: {
      sceneId: "",
      sceneIds: ["scene-other"],
      circuitSettings: [],
    },
  });

  expect(sceneMatchesArea(scenes.get("scene-other")!, "")).toBe(true);
  expect(cellValues(sw, target, scenes)).toEqual([`${SCENE_NAME_LINE_PREFIX}Other Scene`, "On"]);
  expect(sceneRawValuesForCircuit(sw, target, scenes)).toEqual(["On"]);
  expect(switchUsesAreaSceneValue(sw, target.id, target.area, scenes)).toBe(true);
});

test("applies the same area guard to HVAC-style targets", () => {
  const targetId = "hvac:assignment-1:On/Off";
  const scenes = scenesById([
    {
      id: "scene-bedroom-bright",
      areaId: "area-bedroom",
      name: "Bright",
      settings: [],
    },
    {
      id: "scene-vanity-max",
      areaId: "area-vanity",
      name: "MAX",
      settings: [{ circuitId: targetId, percentage: "Off" }],
    },
  ]);
  const sw = switchRow();

  expect(sceneRawValuesForTarget(sw, targetId, "area-bedroom", scenes)).toEqual([]);
});
