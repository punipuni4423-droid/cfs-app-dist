import { expect, test } from "@playwright/test";
import type { ProjectData, RoomType } from "../../app/types";
import { createDefaultDevices } from "../../app/lib/constants";
import { buildCfsLutronBridgeExport, validateCfsLutronBridgeExport } from "../../app/lib/lutronBridgeExport";
import { buildLutronAutomationSpec } from "../../app/lib/lutronSpec";

function sampleRoomType(): RoomType {
  return {
    id: "room-a",
    name: "A",
    updatedAt: "2026-07-10T00:00:00.000Z",
    revision: "1.00",
    revisions: [],
    rows: [],
    deviceAssignments: [
      {
        id: "assignment-1",
        deviceGroupId: "device-group-1",
        device: "MQSE-4A1-D",
        deviceNum: "1",
        zoneAddress: "Zn1",
        circuitNumber: "1",
        detail: "Bed Downlight",
        group: "",
      },
    ],
    hvacAssignments: [],
    hvacSeasons: [],
    scenes: [
      {
        id: "scene-relax",
        areaId: "area-bedroom",
        name: "Relax",
        settings: [{ circuitId: "circuit-1", percentage: "60" }],
      },
    ],
    roomScenes: [],
    switches: [
      {
        id: "switch-row-1",
        switchGroupId: "switch-group-1",
        kind: "lutronPd",
        switchNumber: "SW1",
        switchName: "Bedside",
        cciAssignment: "",
        buttonCount: "4",
        buttonLabel: "M1",
        allocation: "",
        buttonFunction: "Relax",
        buttonType: "single",
        condition: "",
        buttonSetting: {
          sceneId: "scene-relax",
          sceneIds: ["scene-relax"],
          circuitSettings: [],
        },
        backlightTarget: "",
        backlightCondition: "",
        backlightAssignment: "",
        backlightLevels: [],
      },
    ],
    pduDeviceCounts: [],
    inspectionMarks: [],
  };
}

function sampleProject(): ProjectData {
  return {
    id: "project-1",
    name: "Spec Test",
    updatedAt: "2026-07-10T00:00:00.000Z",
    locations: [
      {
        id: "area-bedroom",
        name: "Bedroom",
        number: "1",
        code: "BE",
        color: "",
      },
    ],
    fixtures: [
      {
        id: "fixture-1",
        fixture: "DL-1",
        fixtureType: "DL",
        powerMode: "VA",
        watt: "10",
        powerFactor: "1",
      },
    ],
    circuits: [
      {
        id: "circuit-1",
        circuitGroupId: "circuit-group-1",
        daliFixtureGroupId: "",
        designerNumber: "1",
        internalNumber: "",
        dimmingType: "Phase",
        fixture: "DL-1",
        pcs: "1",
        detail: "Bed Downlight",
        area: "area-bedroom",
        ffe: false,
        energySaving: false,
      },
    ],
    roomTypes: [sampleRoomType()],
  };
}

test("builds a Lutron automation spec from CFS project data", () => {
  const spec = buildLutronAutomationSpec({
    project: sampleProject(),
    roomTypeId: "room-a",
    devices: createDefaultDevices(),
    generatedAt: "2026-07-10T00:00:00.000Z",
  });

  expect(spec.format).toBe("cfs-lutron-automation-spec");
  expect(spec.source.projectName).toBe("Spec Test");
  expect(spec.summary).toMatchObject({
    areas: 1,
    circuits: 1,
    lightingZones: 1,
    areaScenes: 1,
    switches: 1,
    warnings: 0,
  });
  expect(spec.zones[0]).toMatchObject({
    kind: "lighting",
    device: "MQSE-4A1-D",
    zone: "Zn1",
    areaName: "Bedroom",
    areaAddresses: ["BE1"],
    programmingNames: ["[1][1][BE][1][A1-1] Bed Downlight"],
  });
  expect(spec.areaScenes[0]).toMatchObject({
    name: "Relax",
    areaName: "Bedroom",
    levels: [{ circuitId: "circuit-1", value: "60" }],
  });
  expect(spec.switches[0]).toMatchObject({
    kind: "lutronPd",
    switchNumber: "SW1",
    switchName: "Bedside",
    selectedScenes: [{ sceneId: "scene-relax", sceneName: "Relax", areaName: "Bedroom" }],
  });
});

test("builds an LD bridge export JSON from a CFS room type", () => {
  const bridge = buildCfsLutronBridgeExport({
    project: sampleProject(),
    roomTypeIds: ["room-a"],
    generatedAt: "2026-07-10T00:00:00.000Z",
    defaultFloorName: "1F",
  });
  const validation = validateCfsLutronBridgeExport(bridge);

  expect(validation.errors).toEqual([]);
  expect(bridge).toMatchObject({
    schemaVersion: "1.0",
    exportedBy: "CFS",
    mode: "additive",
    unknownTemplatePolicy: "error",
    placeName: "Spec Test",
    reassignTemplates: false,
  });
  expect(bridge.templateMappings).toMatchObject({
    _default: "A",
    a: "A",
  });
  expect(bridge.rooms).toHaveLength(1);
  expect(bridge.rooms[0]).toMatchObject({
    floorName: "1F",
    name: "A",
    roomType: "a",
    sourceRoomTypeId: "room-a",
    sourceRoomTypeRevision: "1.00",
  });
});
