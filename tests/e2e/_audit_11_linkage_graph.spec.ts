import { expect, test } from "@playwright/test";
import type { CircuitEntry, HvacAssignment, LocationMaster, RoomType, SwitchEntry } from "../../app/types";
import { BY_SCENE_VALUE } from "../../app/lib/cfsTableModel";
import { buildCfsLinkageGraph } from "../../app/lib/cfsLinkageGraph";
import { isBacklightTargetCondition, isPalladiomBacklightTarget, normalizeBacklightCondition } from "../../app/lib/useCfsZoneRows";

const locations: LocationMaster[] = [
  { id: "area-bedroom", name: "Bedroom", number: "1", code: "BE", color: "#dbeafe" },
];

const circuits: CircuitEntry[] = [
  {
    id: "circuit-visible",
    circuitGroupId: "cg-visible",
    daliFixtureGroupId: "",
    designerNumber: "1",
    internalNumber: "",
    dimmingType: "On/Off",
    fixture: "",
    pcs: "",
    detail: "Desk",
    area: "area-bedroom",
    ffe: false,
    energySaving: false,
  },
  {
    id: "circuit-setting-only",
    circuitGroupId: "cg-setting-only",
    daliFixtureGroupId: "",
    designerNumber: "2",
    internalNumber: "",
    dimmingType: "1D",
    fixture: "",
    pcs: "",
    detail: "Decorative",
    area: "area-bedroom",
    ffe: false,
    energySaving: false,
  },
];

const hvacAssignments: HvacAssignment[] = [
  {
    id: "hvac-1",
    protocol: "Modbus",
    thermostatRole: "Master",
    area: "area-bedroom",
    lowEnd: "",
    highEnd: "",
    summerWinterChange: false,
    note: "",
  },
];

function switchRow(overrides: Partial<SwitchEntry>): SwitchEntry {
  return {
    id: "switch-base",
    switchGroupId: "switch-base-group",
    kind: "contact",
    switchNumber: "",
    switchName: "",
    cciAssignment: "",
    buttonCount: "",
    buttonLabel: "",
    allocation: "",
    buttonFunction: "",
    buttonType: "single",
    condition: "",
    buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [] },
    backlightTarget: "",
    backlightCondition: "",
    backlightLevels: [],
    ...overrides,
  };
}

function roomTypeFixture(): RoomType {
  return {
    id: "room-1",
    name: "Audit",
    updatedAt: "2026-06-26T00:00:00.000Z",
    revision: "A",
    revisions: [],
    rows: [],
    deviceAssignments: [
      {
        id: "assign-visible",
        deviceGroupId: "device-visible",
        device: "MQSE-4S1-D",
        deviceNum: "1",
        zoneAddress: "Zn1",
        circuitNumber: "1",
        detail: "Desk",
        group: "",
      },
      {
        id: "assign-cco",
        deviceGroupId: "device-cco",
        device: "QSE-IO",
        deviceNum: "1",
        zoneAddress: "CCO1",
        circuitNumber: "Chime",
        detail: "Chime",
        group: "",
      },
    ],
    hvacAssignments,
    hvacSeasons: [],
    scenes: [
      {
        id: "area-scene-1",
        areaId: "area-bedroom",
        name: "Welcome Day",
        settings: [
          { circuitId: "circuit-setting-only", percentage: "40%" },
          { circuitId: "cco:assign-cco", percentage: "On" },
          { circuitId: "missing-circuit", percentage: "80%" },
        ],
      },
    ],
    roomScenes: [],
    switches: [
      switchRow({
        id: "command-1",
        switchGroupId: "command-1",
        kind: "command",
        switchNumber: "Command",
        switchName: "Desk Command",
        buttonFunction: "On",
        buttonSetting: {
          sceneId: "",
          sceneIds: [],
          circuitSettings: [{ circuitId: "missing-command-target", percentage: "On" }],
        },
      }),
      switchRow({
        id: "palladiom-target",
        switchGroupId: "pd-group",
        kind: "lutronPd",
        switchNumber: "SW1",
        switchName: "Bedside",
        backlightCondition: BY_SCENE_VALUE,
      }),
      switchRow({
        id: "palladiom-base-target",
        switchGroupId: "pd-base-group",
        kind: "lutronPd",
        switchNumber: "SW1B",
        switchName: "Bedside Base",
        backlightCondition: "base",
      }),
      switchRow({
        id: "palladiom-default-target",
        switchGroupId: "pd-default-group",
        kind: "lutronPd",
        switchNumber: "SW1C",
        switchName: "Bedside Default",
        backlightCondition: "",
      }),
      switchRow({
        id: "backlight-good",
        switchGroupId: "backlight-good",
        kind: "lutronPd",
        switchNumber: "SW2",
        switchName: "Backlight Good",
        backlightTarget: "pd-group",
        backlightCondition: "base",
      }),
      switchRow({
        id: "backlight-base-good",
        switchGroupId: "backlight-base-good",
        kind: "lutronPd",
        switchNumber: "SW2B",
        switchName: "Backlight Base Good",
        backlightTarget: "pd-base-group",
        backlightCondition: "base",
      }),
      switchRow({
        id: "backlight-default-target-good",
        switchGroupId: "backlight-default-target-good",
        kind: "lutronPd",
        switchNumber: "SW2C",
        switchName: "Backlight Default Target Good",
        backlightTarget: "pd-default-group",
        backlightCondition: "base",
      }),
      switchRow({
        id: "backlight-no-condition",
        switchGroupId: "backlight-no-condition",
        kind: "lutronPd",
        switchNumber: "SW3",
        switchName: "Backlight No Condition",
        backlightTarget: "pd-group",
        backlightCondition: "",
      }),
      switchRow({
        id: "backlight-missing-target",
        switchGroupId: "backlight-missing-target",
        kind: "lutronPd",
        switchNumber: "SW4",
        switchName: "Backlight Missing",
        backlightTarget: "missing-pd-group",
        backlightCondition: "base",
      }),
      switchRow({
        id: "blank-backlight-placeholder",
        switchGroupId: "blank-backlight-placeholder",
        kind: "contact",
        backlightTarget: "pd-group",
        backlightCondition: "base",
      }),
    ],
    pduDeviceCounts: [],
    inspectionMarks: [],
  };
}

test("linkage graph separates valid setting targets from CFS-visible targets", () => {
  const graph = buildCfsLinkageGraph({ roomType: roomTypeFixture(), circuits, locations });

  expect(graph.issues).toContainEqual(expect.objectContaining({ code: "missing_target", targetId: "missing-circuit" }));
  expect(graph.issues).not.toContainEqual(expect.objectContaining({ code: "missing_target", targetId: "circuit-setting-only" }));
  expect(graph.issues).not.toContainEqual(expect.objectContaining({ code: "missing_target", targetId: "cco:assign-cco" }));

  expect(graph.edges).toContainEqual(
    expect.objectContaining({ label: "Area Scene setting", to: "target:circuit-setting-only", risk: "ok" }),
  );
  expect(graph.edges).not.toContainEqual(
    expect.objectContaining({ label: "CFS value", to: "cfs:circuit-setting-only" }),
  );
});

test("linkage graph classifies Command and Backlight issues precisely", () => {
  const graph = buildCfsLinkageGraph({ roomType: roomTypeFixture(), circuits, locations });

  expect(graph.issues).toContainEqual(
    expect.objectContaining({
      code: "missing_target",
      group: "Command",
      sourceIds: ["command-1"],
      targetId: "missing-command-target",
    }),
  );
  expect(graph.issues).toContainEqual(
    expect.objectContaining({ code: "missing_backlight_condition", sourceIds: ["backlight-no-condition"] }),
  );
  expect(graph.issues).toContainEqual(
    expect.objectContaining({ code: "missing_backlight_target", sourceIds: ["backlight-missing-target"] }),
  );
  expect(graph.issues).not.toContainEqual(
    expect.objectContaining({ sourceIds: ["blank-backlight-placeholder"] }),
  );
  expect(graph.edges).toContainEqual(
    expect.objectContaining({ label: "Backlight Logic row", from: "backlight:pd-group", risk: "ok" }),
  );
  expect(graph.edges).toContainEqual(
    expect.objectContaining({ label: "Backlight Logic row", from: "backlight:pd-base-group", risk: "ok" }),
  );
  expect(graph.edges).toContainEqual(
    expect.objectContaining({ label: "Backlight Logic row", from: "backlight:pd-default-group", risk: "ok" }),
  );
  expect(graph.issues).not.toContainEqual(
    expect.objectContaining({ code: "backlight_target_not_by_scene", targetId: "backlight:pd-base-group" }),
  );
  expect(graph.issues).not.toContainEqual(
    expect.objectContaining({ code: "backlight_target_not_by_scene", targetId: "backlight:pd-default-group" }),
  );
});

test("backlight base is a valid target and by-scene sentinel is not displayed as a CFS value", () => {
  expect(isBacklightTargetCondition("base")).toBe(true);
  expect(isBacklightTargetCondition("Base")).toBe(true);
  expect(isBacklightTargetCondition(BY_SCENE_VALUE)).toBe(true);
  expect(isPalladiomBacklightTarget(switchRow({ kind: "lutronPd", switchNumber: "SW1", backlightCondition: "" }))).toBe(true);
  expect(isPalladiomBacklightTarget(switchRow({ kind: "lutronPd", switchNumber: "", switchName: "", backlightCondition: "" }))).toBe(false);
  expect(normalizeBacklightCondition("base")).toBe("Base");
  expect(normalizeBacklightCondition(BY_SCENE_VALUE)).toBe("");
});
