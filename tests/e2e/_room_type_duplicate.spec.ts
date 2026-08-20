import { expect, test } from "@playwright/test";
import { circuitsToCsv, csvToCircuits } from "../../app/lib/csv";
import { normalizeSceneSettingsByCircuitGroup, sceneSettingValueForCircuitGroup, setSceneSettingValueForCircuitGroup, uniqueCircuitGroupHeads } from "../../app/lib/circuitGroups";
import { buildCircuitRunInfo } from "../../app/lib/circuitRunInfo";
import { duplicateRoomType } from "../../app/lib/roomTypeCopy";
import { circuitsForRoomType, isolateSharedRoomTypeCircuits, normalizeProjectRoomTypeCircuitIds, syncProjectRoomTypeLinks } from "../../app/lib/roomTypeSync";
import type { CircuitEntry, ProjectData, RoomType, SwitchEntry } from "../../app/types";

const now = "2026-08-19T00:00:00.000Z";

const circuits: CircuitEntry[] = [
  {
    id: "circuit-1",
    circuitGroupId: "circuit-group-1",
    daliFixtureGroupId: "dali-group-1",
    designerNumber: "1",
    internalNumber: "",
    dimmingType: "On/Off",
    fixture: "Downlight",
    pcs: "",
    detail: "Entry",
    area: "area-1",
    ffe: false,
    energySaving: false,
  },
  {
    id: "circuit-2",
    circuitGroupId: "circuit-group-2",
    daliFixtureGroupId: "dali-group-1",
    designerNumber: "2",
    internalNumber: "",
    dimmingType: "1D",
    fixture: "Cove",
    pcs: "",
    detail: "Bed",
    area: "area-1",
    ffe: false,
    energySaving: false,
  },
];

function nextIdFactory(): () => string {
  let index = 0;
  return () => `copy-id-${++index}`;
}

function switchRow(overrides: Partial<SwitchEntry> = {}): SwitchEntry {
  return {
    id: "switch-1",
    switchGroupId: "switch-group-1",
    kind: "lutronPico",
    switchNumber: "Pico 1",
    switchName: "Corridor",
    cciAssignment: "",
    buttonCount: "Corridor",
    buttonLabel: "Chime Button",
    allocation: "CorridorPico",
    buttonFunction: "Chime Button",
    buttonType: "single",
    condition: "",
    buttonSetting: {
      sceneId: "scene-1",
      sceneIds: ["scene-1"],
      circuitSettings: [{ circuitId: "pico-led:switch-group-1:dnd", percentage: "Off" }],
    },
    backlightTarget: "switch-group-1",
    backlightCondition: "On",
    backlightLevels: [],
    ...overrides,
  };
}

function switchTargetRow(): SwitchEntry {
  return switchRow({
    id: "switch-2",
    switchGroupId: "switch-group-2",
    switchNumber: "Pico 2",
    switchName: "Privacy",
    buttonCount: "Privacy",
    buttonLabel: "M1",
    allocation: "",
    buttonFunction: "MUR",
    buttonSetting: {
      sceneId: "",
      sceneIds: [],
      circuitSettings: [],
    },
    backlightTarget: "",
    backlightCondition: "",
  });
}

function roomType(overrides: Partial<RoomType> = {}): RoomType {
  return {
    id: "rt-source",
    name: "A",
    updatedAt: now,
    revision: "2.00",
    revisions: [{ id: "revision-1", revision: "2.00", savedAt: now, snapshot: "{}", note: "source" }],
    rows: [
      {
        id: "cfs-row-1",
        deviceGroupId: "cfs-row-group-1",
        device: "QSE-IO",
        deviceNum: "1",
        deviceAuto: "CFS_ONLY",
        control: "CCO",
        fixture: "Chime",
        pcs: "",
        watt: "",
        lowEnd: "",
        highEnd: "",
        area: "area-1",
        note: "CFS only chime",
        designerNumber: "",
        group: "",
        sequenceNo: "",
        addressZone: "CCO1",
      },
    ],
    dryContacts: [{ id: "dry-contact-1", area: "area-1", circuit: "DC1", detail: "Doorbell" }],
    deviceAssignments: [
      {
        id: "assignment-1",
        deviceGroupId: "assignment-group-1",
        device: "QSE-IO",
        deviceNum: "1",
        zoneAddress: "CCO1",
        circuitNumber: "Chime",
        area: "area-1",
        detail: "Chime",
        group: "",
      },
    ],
    hvacAssignments: [
      {
        id: "hvac-1",
        protocol: "Modbus",
        thermostatRole: "Master",
        area: "area-1",
        lowEnd: "",
        highEnd: "",
        summerWinterChange: false,
        note: "",
      },
    ],
    hvacSeasons: [{ id: "season-1", name: "Summer", startMonth: "6", startDay: "1", endMonth: "9", endDay: "30" }],
    curtainAssignments: [{ id: "curtain-1", area: "area-1", detail: "Blackout", action: "Open" }],
    scenes: [
      {
        id: "scene-1",
        areaId: "area-1",
        name: "Welcome",
        settings: [
          { circuitId: "circuit-1", percentage: "70" },
          { circuitId: "cco:assignment-1", percentage: "On" },
          { circuitId: "cco:cfs-row-1", percentage: "On" },
          { circuitId: "hvac:hvac-1:On/Off", percentage: "On" },
          { circuitId: "curtain:curtain-1", percentage: "Open" },
          { circuitId: "pico-led:switch-group-1:mur", percentage: "On" },
        ],
      },
    ],
    roomScenes: [
      {
        id: "room-scene-1",
        kind: "standard",
        phase: "Check In",
        sceneType: "Welcome Scene",
        detail: "Day",
        triggerCondition: "",
        backlightCondition: "",
        areaSceneSelections: [{ areaId: "area-1", sceneId: "scene-1" }],
        settings: [{ circuitId: "circuit-2", percentage: "50" }],
      },
    ],
    switches: [switchRow()],
    pduDeviceCounts: [],
    inspectionMarks: [
      {
        id: "mark-1",
        sourceType: "areaScene",
        sourceId: "scene-1",
        targetId: "circuit-1",
        scope: "areaScene",
        label: "Area Scene / Entry",
        previousValue: "",
        value: "70",
        markedAt: now,
      },
      {
        id: "mark-2",
        sourceType: "roomScene",
        sourceId: "room-scene-1",
        targetId: "circuit-2",
        scope: "override",
        label: "Room Scene / Bed",
        previousValue: "",
        value: "50",
        markedAt: now,
      },
      {
        id: "mark-3",
        sourceType: "switch",
        sourceId: "switch-1",
        targetId: "pico-led:switch-group-1:mur",
        scope: "override",
        label: "Switch / MUR LED",
        previousValue: "",
        value: "On",
        markedAt: now,
      },
    ],
    ...overrides,
  };
}

function projectWithRoomTypes(roomTypes: RoomType[]): ProjectData {
  return {
    id: "project-1",
    name: "Project",
    updatedAt: now,
    locations: [{ id: "area-1", name: "Bedroom", number: "1", code: "BR", color: "#dbeafe" }],
    fixtures: [],
    circuits,
    roomTypes,
  };
}

test("duplicating a legacy room type scopes the source and remaps copied internal links", () => {
  const source = roomType();
  const peer = roomType({ id: "rt-peer", name: "B", scenes: [], roomScenes: [], switches: [], inspectionMarks: [] });
  const result = duplicateRoomType(projectWithRoomTypes([source, peer]), source.id, {
    createId: nextIdFactory(),
    now,
  });

  expect(result).not.toBeNull();
  const nextProject = result!.project;
  const copy = result!.copy;
  const sourceAfter = nextProject.roomTypes.find((rt) => rt.id === source.id);
  const peerAfter = nextProject.roomTypes.find((rt) => rt.id === peer.id);

  expect(sourceAfter?.circuitIds).toEqual(["circuit-1", "circuit-2"]);
  expect(peerAfter).not.toHaveProperty("circuitIds");
  expect(nextProject.circuits).toHaveLength(4);
  expect(copy.name).toBe("A Copy");
  expect(copy.revision).toBe("1.00");
  expect(copy.revisions).toEqual([]);
  const copyCircuitIds = copy.circuitIds ?? [];
  expect(copyCircuitIds).toHaveLength(2);
  expect(copyCircuitIds).not.toContain("circuit-1");
  expect(copyCircuitIds).not.toContain("circuit-2");
  const copiedCircuits = nextProject.circuits.filter((circuit) => copyCircuitIds.includes(circuit.id));
  expect(copiedCircuits).toHaveLength(2);
  expect(copiedCircuits[0].circuitGroupId).not.toBe("circuit-group-1");
  expect(copiedCircuits[1].circuitGroupId).not.toBe("circuit-group-2");
  const copiedDaliGroupIds = new Set(copiedCircuits.map((circuit) => circuit.daliFixtureGroupId));
  expect(copiedDaliGroupIds.size).toBe(1);
  expect(copiedCircuits[0].daliFixtureGroupId).not.toBe("dali-group-1");

  expect(copy.rows[0].id).not.toBe("cfs-row-1");
  expect(copy.rows[0].deviceGroupId).not.toBe("cfs-row-group-1");
  expect(copy.dryContacts?.[0].id).not.toBe("dry-contact-1");
  expect(copy.deviceAssignments[0].id).not.toBe("assignment-1");
  expect(copy.deviceAssignments[0].deviceGroupId).not.toBe("assignment-group-1");
  expect(copy.hvacAssignments[0].id).not.toBe("hvac-1");
  expect(copy.hvacSeasons[0].id).not.toBe("season-1");
  expect(copy.curtainAssignments?.[0].id).not.toBe("curtain-1");
  expect(copy.scenes[0].id).not.toBe("scene-1");
  expect(copy.roomScenes[0].id).not.toBe("room-scene-1");
  expect(copy.switches[0].id).not.toBe("switch-1");

  expect(copy.roomScenes[0].areaSceneSelections[0].sceneId).toBe(copy.scenes[0].id);
  expect(copy.roomScenes[0].settings[0].circuitId).toBe(copyCircuitIds[1]);
  expect(copy.switches[0].buttonSetting.sceneId).toBe(copy.scenes[0].id);
  expect(copy.switches[0].buttonSetting.sceneIds).toEqual([copy.scenes[0].id]);
  expect(copy.switches[0].backlightTarget).toBe(copy.switches[0].switchGroupId);

  const copiedTargets = copy.scenes[0].settings.map((setting) => setting.circuitId);
  expect(copiedTargets).toEqual(expect.arrayContaining([
    copyCircuitIds[0],
    `cco:${copy.deviceAssignments[0].id}`,
    `cco:${copy.rows[0].id}`,
    `hvac:${copy.hvacAssignments[0].id}:On/Off`,
    `curtain:${copy.curtainAssignments?.[0].id}`,
    `pico-led:${copy.switches[0].switchGroupId}:mur`,
  ]));
  expect(copy.switches[0].buttonSetting.circuitSettings[0].circuitId).toBe(
    `pico-led:${copy.switches[0].switchGroupId}:dnd`,
  );

  expect(copy.inspectionMarks[0].id).not.toBe("mark-1");
  expect(copy.inspectionMarks[0].sourceId).toBe(copy.scenes[0].id);
  expect(copy.inspectionMarks[0].targetId).toBe(copyCircuitIds[0]);
  expect(copy.inspectionMarks[1].sourceId).toBe(copy.roomScenes[0].id);
  expect(copy.inspectionMarks[1].targetId).toBe(copyCircuitIds[1]);
  expect(copy.inspectionMarks[2].sourceId).toBe(copy.switches[0].id);
  expect(copy.inspectionMarks[2].targetId).toBe(`pico-led:${copy.switches[0].switchGroupId}:mur`);
});

test("duplicating remaps comma separated backlight targets", () => {
  const source = roomType({
    switches: [
      switchRow({ backlightTarget: "switch-group-1,switch-group-2" }),
      switchTargetRow(),
    ],
  });
  const result = duplicateRoomType(projectWithRoomTypes([source]), source.id, {
    createId: nextIdFactory(),
    now,
  });

  expect(result).not.toBeNull();
  const copy = result!.copy;
  const targetGroups = copy.switches.map((sw) => sw.switchGroupId);
  expect(copy.switches[0].backlightTarget).toBe(targetGroups.join(","));
  expect(copy.switches[0].backlightTarget).not.toContain("switch-group-1");
  expect(copy.switches[0].backlightTarget).not.toContain("switch-group-2");
});

test("duplicating remaps switch id fallback targets when switchGroupId is empty", () => {
  const source = roomType({
    scenes: [
      {
        id: "scene-1",
        areaId: "area-1",
        name: "Welcome",
        settings: [{ circuitId: "pico-led:switch-1:mur", percentage: "On" }],
      },
    ],
    switches: [
      switchRow({
        switchGroupId: "",
        buttonSetting: {
          sceneId: "scene-1",
          sceneIds: ["scene-1"],
          circuitSettings: [{ circuitId: "pico-led:switch-1:dnd", percentage: "Off" }],
        },
        backlightTarget: "switch-1",
      }),
    ],
    inspectionMarks: [
      {
        id: "mark-switch-fallback",
        sourceType: "switch",
        sourceId: "switch-1",
        targetId: "pico-led:switch-1:mur",
        scope: "override",
        label: "Switch / MUR LED",
        previousValue: "",
        value: "On",
        markedAt: now,
      },
    ],
  });
  const result = duplicateRoomType(projectWithRoomTypes([source]), source.id, {
    createId: nextIdFactory(),
    now,
  });

  expect(result).not.toBeNull();
  const copy = result!.copy;
  const copiedSwitchId = copy.switches[0].id;
  expect(copy.switches[0].switchGroupId).toBe("");
  expect(copiedSwitchId).not.toBe("switch-1");
  expect(copy.scenes[0].settings[0].circuitId).toBe(`pico-led:${copiedSwitchId}:mur`);
  expect(copy.switches[0].buttonSetting.circuitSettings[0].circuitId).toBe(`pico-led:${copiedSwitchId}:dnd`);
  expect(copy.switches[0].backlightTarget).toBe(copiedSwitchId);
  expect(copy.inspectionMarks[0].sourceId).toBe(copiedSwitchId);
  expect(copy.inspectionMarks[0].targetId).toBe(`pico-led:${copiedSwitchId}:mur`);
});

test("duplicating tolerates current-storage room types missing legacy optional arrays", () => {
  const legacySource = roomType();
  const rawLegacySource = legacySource as unknown as Record<string, unknown>;
  delete rawLegacySource.roomScenes;
  delete rawLegacySource.inspectionMarks;
  const rawLegacySwitch = legacySource.switches[0] as unknown as Record<string, unknown>;
  const rawLegacyButtonSetting = rawLegacySwitch.buttonSetting as Record<string, unknown>;
  delete rawLegacyButtonSetting.sceneIds;
  delete rawLegacySwitch.backlightTarget;

  const result = duplicateRoomType(projectWithRoomTypes([legacySource]), legacySource.id, {
    createId: nextIdFactory(),
    now,
  });

  expect(result).not.toBeNull();
  expect(result!.copy.roomScenes).toEqual([]);
  expect(result!.copy.inspectionMarks).toEqual([]);
  expect(result!.copy.switches[0].buttonSetting.sceneIds).toEqual([]);
  expect(result!.copy.switches[0].backlightTarget).toBe("");
});

test("duplicating a scoped room type copies only that room type's circuits", () => {
  const source = roomType({ circuitIds: ["circuit-1"] });
  const result = duplicateRoomType(projectWithRoomTypes([source]), source.id, {
    createId: nextIdFactory(),
    now,
  });

  expect(result).not.toBeNull();
  const copyCircuitIds = result!.copy.circuitIds ?? [];
  expect(result!.project.circuits).toHaveLength(3);
  expect(copyCircuitIds).toHaveLength(1);
  expect(copyCircuitIds[0]).not.toBe("circuit-1");
});

test("legacy single-room projects keep all circuits visible when scoped", () => {
  const source = roomType({ scenes: [], roomScenes: [], switches: [], inspectionMarks: [] });
  const project = normalizeProjectRoomTypeCircuitIds(projectWithRoomTypes([source]));
  const scoped = project.roomTypes[0];

  expect(scoped.circuitIds).toEqual(["circuit-1", "circuit-2"]);
  expect(circuitsForRoomType(project, scoped).map((circuit) => circuit.id)).toEqual(["circuit-1", "circuit-2"]);
});

test("circuitsForRoomType preserves scoped circuitIds order", () => {
  const source = roomType({ circuitIds: ["circuit-2", "circuit-1"] });
  const project = projectWithRoomTypes([source]);

  expect(circuitsForRoomType(project, source).map((circuit) => circuit.id)).toEqual(["circuit-2", "circuit-1"]);
});

test("legacy copied projects scope an unscoped source to circuits not claimed by the copy", () => {
  const source = roomType({ scenes: [], roomScenes: [], switches: [], inspectionMarks: [] });
  const copy = roomType({
    id: "rt-copy",
    name: "A Copy",
    circuitIds: ["circuit-2"],
    scenes: [],
    roomScenes: [],
    switches: [],
    inspectionMarks: [],
  });
  const project = normalizeProjectRoomTypeCircuitIds(projectWithRoomTypes([source, copy]));
  const sourceAfter = project.roomTypes.find((rt) => rt.id === source.id);
  const copyAfter = project.roomTypes.find((rt) => rt.id === copy.id);

  expect(sourceAfter?.circuitIds).toEqual(["circuit-1"]);
  expect(copyAfter?.circuitIds).toEqual(["circuit-2"]);
  expect(circuitsForRoomType(project, sourceAfter).map((circuit) => circuit.id)).toEqual(["circuit-1"]);
  expect(circuitsForRoomType(project, copyAfter).map((circuit) => circuit.id)).toEqual(["circuit-2"]);
});

test("legacy multi-room projects infer scopes from direct scene circuit references", () => {
  const first = roomType({
    scenes: [
      {
        id: "scene-first",
        areaId: "area-1",
        name: "First",
        settings: [{ circuitId: "circuit-1", percentage: "70" }],
      },
    ],
    roomScenes: [],
    switches: [],
    inspectionMarks: [],
  });
  const second = roomType({
    id: "rt-second",
    name: "B",
    scenes: [],
    roomScenes: [
      {
        id: "room-scene-second",
        kind: "standard",
        phase: "Check In",
        sceneType: "Welcome Scene",
        detail: "Day",
        triggerCondition: "",
        backlightCondition: "",
        areaSceneSelections: [],
        settings: [{ circuitId: "circuit-2", percentage: "50" }],
      },
    ],
    switches: [],
    inspectionMarks: [],
  });
  const project = normalizeProjectRoomTypeCircuitIds(projectWithRoomTypes([first, second]));

  expect(project.roomTypes.find((rt) => rt.id === first.id)?.circuitIds).toEqual(["circuit-1"]);
  expect(project.roomTypes.find((rt) => rt.id === second.id)?.circuitIds).toEqual(["circuit-2"]);
});

test("scoped room types never keep the same circuit id shared", () => {
  const first = roomType({
    id: "rt-first",
    name: "A",
    circuitIds: ["circuit-1", "circuit-2"],
    scenes: [
      {
        id: "scene-first",
        areaId: "area-1",
        name: "First",
        settings: [{ circuitId: "circuit-1", percentage: "70" }],
      },
    ],
    roomScenes: [],
    switches: [switchRow({ buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: "circuit-2", percentage: "50" }] } })],
    inspectionMarks: [],
  });
  const second = roomType({
    id: "rt-second",
    name: "B",
    circuitIds: ["circuit-1", "circuit-2"],
    scenes: [
      {
        id: "scene-second",
        areaId: "area-1",
        name: "Second",
        settings: [{ circuitId: "circuit-1", percentage: "80" }],
      },
    ],
    roomScenes: [
      {
        id: "room-scene-second",
        kind: "standard",
        phase: "Check In",
        sceneType: "Welcome Scene",
        detail: "Day",
        triggerCondition: "",
        backlightCondition: "",
        areaSceneSelections: [],
        settings: [{ circuitId: "circuit-2", percentage: "60" }],
      },
    ],
    switches: [switchRow({ id: "switch-second", buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: "circuit-2", percentage: "65" }] } })],
    inspectionMarks: [
      {
        id: "mark-second",
        sourceType: "areaScene",
        sourceId: "scene-second",
        targetId: "circuit-1",
        scope: "areaScene",
        label: "Second",
        previousValue: "",
        value: "80",
        markedAt: now,
      },
    ],
  });

  const project = isolateSharedRoomTypeCircuits(projectWithRoomTypes([first, second]), nextIdFactory());
  const firstAfter = project.roomTypes.find((rt) => rt.id === first.id);
  const secondAfter = project.roomTypes.find((rt) => rt.id === second.id);
  const copiedIds = secondAfter?.circuitIds ?? [];
  const copiedFirstId = copiedIds[0];
  const copiedSecondId = copiedIds[1];

  expect(firstAfter?.circuitIds).toEqual(["circuit-1", "circuit-2"]);
  expect(copiedIds).toHaveLength(2);
  expect(copiedIds).not.toContain("circuit-1");
  expect(copiedIds).not.toContain("circuit-2");
  const firstIds = new Set(firstAfter?.circuitIds ?? []);
  expect(copiedIds.filter((id) => firstIds.has(id))).toEqual([]);
  expect(project.circuits).toHaveLength(4);
  expect(project.circuits.find((circuit) => circuit.id === copiedFirstId)?.circuitGroupId).not.toBe("circuit-group-1");
  expect(project.circuits.find((circuit) => circuit.id === copiedSecondId)?.circuitGroupId).not.toBe("circuit-group-2");
  expect(secondAfter?.scenes[0].settings[0].circuitId).toBe(copiedFirstId);
  expect(secondAfter?.roomScenes[0].settings[0].circuitId).toBe(copiedSecondId);
  expect(secondAfter?.switches[0].buttonSetting.circuitSettings[0].circuitId).toBe(copiedSecondId);
  expect(secondAfter?.inspectionMarks[0].targetId).toBe(copiedFirstId);
});

test("shared circuit isolation remaps revision snapshot circuit references", () => {
  const first = roomType({
    id: "rt-first",
    name: "A",
    circuitIds: ["circuit-1"],
    scenes: [],
    roomScenes: [],
    switches: [],
    inspectionMarks: [],
  });
  const secondScene = {
    id: "scene-second",
    areaId: "area-1",
    name: "Second",
    settings: [{ circuitId: "circuit-1", percentage: "80" }],
  };
  const secondSwitch = switchRow({
    id: "switch-second",
    buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: "circuit-1", percentage: "65" }] },
  });
  const secondRoomScene = {
    id: "room-scene-second",
    kind: "standard" as const,
    phase: "Check In" as const,
    sceneType: "Welcome Scene",
    detail: "Day",
    triggerCondition: "",
    backlightCondition: "",
    areaSceneSelections: [],
    settings: [{ circuitId: "circuit-1", percentage: "75" }],
  };
  const second = roomType({
    id: "rt-second",
    name: "B",
    circuitIds: ["circuit-1"],
    scenes: [secondScene],
    roomScenes: [secondRoomScene],
    switches: [secondSwitch],
    inspectionMarks: [
      {
        id: "mark-second",
        sourceType: "areaScene",
        sourceId: "scene-second",
        targetId: "circuit-1",
        scope: "areaScene",
        label: "Second",
        previousValue: "",
        value: "80",
        markedAt: now,
      },
    ],
    revisions: [
      {
        id: "revision-second",
        revision: "1.00",
        savedAt: now,
        note: "snapshot",
        snapshot: JSON.stringify({
          circuits: [circuits[0]],
          scenes: [secondScene],
          roomScenes: [secondRoomScene],
          switches: [secondSwitch],
          inspectionMarks: [
            {
              id: "mark-second",
              sourceType: "areaScene",
              sourceId: "scene-second",
              targetId: "circuit-1",
              scope: "areaScene",
              label: "Second",
              previousValue: "",
              value: "80",
              markedAt: now,
            },
          ],
        }),
      },
    ],
  });

  const project = isolateSharedRoomTypeCircuits(projectWithRoomTypes([first, second]), nextIdFactory());
  const secondAfter = project.roomTypes.find((rt) => rt.id === second.id);
  const copiedId = secondAfter?.circuitIds?.[0] ?? "";
  const snapshot = JSON.parse(secondAfter?.revisions[0].snapshot ?? "{}");

  expect(copiedId).not.toBe("circuit-1");
  expect(snapshot.circuits[0].id).toBe(copiedId);
  expect(snapshot.circuits[0].circuitGroupId).not.toBe("circuit-group-1");
  expect(snapshot.scenes[0].settings[0].circuitId).toBe(copiedId);
  expect(snapshot.roomScenes[0].settings[0].circuitId).toBe(copiedId);
  expect(snapshot.switches[0].buttonSetting.circuitSettings[0].circuitId).toBe(copiedId);
  expect(snapshot.inspectionMarks[0].targetId).toBe(copiedId);
});

test("shared circuit isolation keeps cloned rows in the same circuit group", () => {
  const groupedCircuits: CircuitEntry[] = [
    { ...circuits[0], id: "grouped-1", circuitGroupId: "shared-group", designerNumber: "TP-06", detail: "Bedframe" },
    { ...circuits[1], id: "grouped-2", circuitGroupId: "shared-group", designerNumber: "TP-06", detail: "Window" },
  ];
  const first = roomType({
    id: "rt-first",
    name: "A",
    circuitIds: ["grouped-1", "grouped-2"],
    scenes: [],
    roomScenes: [],
    switches: [],
    inspectionMarks: [],
  });
  const second = roomType({
    id: "rt-second",
    name: "B",
    circuitIds: ["grouped-1", "grouped-2"],
    scenes: [],
    roomScenes: [],
    switches: [],
    inspectionMarks: [],
  });

  const project = isolateSharedRoomTypeCircuits(
    { ...projectWithRoomTypes([first, second]), circuits: groupedCircuits },
    nextIdFactory(),
  );
  const secondAfter = project.roomTypes.find((rt) => rt.id === second.id);
  const clonedRows = project.circuits.filter((circuit) => secondAfter?.circuitIds?.includes(circuit.id));

  expect(clonedRows).toHaveLength(2);
  expect(clonedRows.map((circuit) => circuit.id)).not.toContain("grouped-1");
  expect(clonedRows.map((circuit) => circuit.id)).not.toContain("grouped-2");
  expect(new Set(clonedRows.map((circuit) => circuit.circuitGroupId)).size).toBe(1);
  expect(clonedRows[0].circuitGroupId).not.toBe("shared-group");
});

test("room type sync clears stale area scene references after scene deletion", () => {
  const source = roomType({
    scenes: [],
    roomScenes: [
      {
        id: "room-scene-stale",
        kind: "standard",
        phase: "Check In",
        sceneType: "Welcome Scene",
        detail: "Day",
        triggerCondition: "",
        backlightCondition: "",
        areaSceneSelections: [
          { areaId: "area-1", sceneId: "deleted-scene" },
          { areaId: "area-1", sceneId: "" },
        ],
        settings: [],
      },
    ],
    switches: [
      switchRow({
        buttonSetting: {
          sceneId: "deleted-scene",
          sceneIds: ["deleted-scene"],
          circuitSettings: [],
        },
      }),
    ],
  });

  const project = syncProjectRoomTypeLinks(projectWithRoomTypes([source]), {
    devices: [],
    createId: nextIdFactory(),
  });
  const synced = project.roomTypes[0];

  expect(synced.switches[0].buttonSetting.sceneId).toBe("");
  expect(synced.switches[0].buttonSetting.sceneIds).toEqual([]);
  const staleScene = synced.roomScenes.find((scene) => scene.id === "room-scene-stale");
  expect(staleScene?.areaSceneSelections).toEqual([{ areaId: "area-1", sceneId: "" }]);
});

test("room type sync clears area scene selections pointing to another area", () => {
  const source = roomType({
    scenes: [
      { id: "scene-area-1", areaId: "area-1", name: "Area 1 Scene", settings: [] },
      { id: "scene-area-2", areaId: "area-2", name: "Area 2 Scene", settings: [] },
    ],
    roomScenes: [
      {
        id: "room-scene-area-check",
        kind: "standard",
        phase: "Check In",
        sceneType: "Welcome Scene",
        detail: "Day",
        triggerCondition: "",
        backlightCondition: "",
        areaSceneSelections: [
          { areaId: "area-1", sceneId: "scene-area-2" },
          { areaId: "area-1", sceneId: "scene-area-1" },
        ],
        settings: [],
      },
    ],
    switches: [],
  });

  const project = syncProjectRoomTypeLinks(projectWithRoomTypes([source]), {
    devices: [],
    createId: nextIdFactory(),
  });
  const syncedScene = project.roomTypes[0].roomScenes.find((scene) => scene.id === "room-scene-area-check");

  expect(syncedScene?.areaSceneSelections).toEqual([{ areaId: "area-1", sceneId: "scene-area-1" }]);
});

test("circuit CSV roundtrip preserves circuit group identity", async () => {
  const groupedCircuits: CircuitEntry[] = [
    { ...circuits[0], id: "csv-circuit-1", circuitGroupId: "csv-group-a", daliFixtureGroupId: "", designerNumber: "TP-06", internalNumber: "11", fixture: "DL", detail: "Toilet DL" },
    { ...circuits[1], id: "csv-circuit-2", circuitGroupId: "csv-group-a", daliFixtureGroupId: "", designerNumber: "TP-06", internalNumber: "12", fixture: "DL", detail: "Vanity DL" },
    { ...circuits[0], id: "csv-circuit-3", circuitGroupId: "csv-group-b", daliFixtureGroupId: "csv-dali-a", designerNumber: "TP-07", internalNumber: "15", dimmingType: "DALI", fixture: "DL", detail: "DALI Head" },
  ];

  const csv = circuitsToCsv(groupedCircuits);
  expect(csv.split(/\r?\n/)[0]).toContain("Circuit Group ID");
  expect(csv.split(/\r?\n/)[0]).toContain("DALI Fixture Group ID");

  const parsed = await csvToCircuits(csv);
  expect(parsed.map((circuit) => circuit.circuitGroupId)).toEqual(["csv-group-a", "csv-group-a", "csv-group-b"]);
  expect(parsed[2].daliFixtureGroupId).toBe("csv-dali-a");
});

test("legacy circuit CSV without group columns keeps same Designer# in one group", async () => {
  const parsed = await csvToCircuits(
    [
      "Designer #,Internal #,Dimming Type,Area,Fixture,pcs,Detail",
      "TP-06,11,On/Off,Vanity,GR-DL01,1,Toilet DL",
      "TP-06,12,On/Off,Vanity,GR-AJ02,1,Vanity DL",
    ].join("\r\n"),
  );

  expect(parsed).toHaveLength(2);
  expect(parsed[0].circuitGroupId).toBe(parsed[1].circuitGroupId);
  expect(parsed[0].internalNumber).toBe("11");
  expect(parsed[1].internalNumber).toBe("12");
});

test("circuit run info treats split same-group rows as separate rowSpan runs", () => {
  const runInfo = buildCircuitRunInfo([
    { id: "a1", circuitGroupId: "group-a" },
    { id: "a2", circuitGroupId: "group-a" },
    { id: "b1", circuitGroupId: "group-b" },
    { id: "a3", circuitGroupId: "group-a" },
  ]);

  expect(runInfo.get("a1")).toEqual({ isHead: true, isTail: false, rowSpan: 2 });
  expect(runInfo.get("a2")).toEqual({ isHead: false, isTail: true, rowSpan: 2 });
  expect(runInfo.get("b1")).toEqual({ isHead: true, isTail: true, rowSpan: 1 });
  expect(runInfo.get("a3")).toEqual({ isHead: true, isTail: true, rowSpan: 1 });
});

test("area scene settings normalize same circuit group to one shared value", () => {
  const groupedCircuits: CircuitEntry[] = [
    { ...circuits[0], id: "scene-circuit-1", circuitGroupId: "scene-group-a", designerNumber: "TP-04", detail: "Mini Bar DL" },
    { ...circuits[1], id: "scene-circuit-2", circuitGroupId: "scene-group-a", designerNumber: "TP-04", detail: "TV DL" },
    { ...circuits[0], id: "scene-circuit-3", circuitGroupId: "scene-group-b", designerNumber: "TP-05", detail: "Entrance DL" },
  ];

  expect(uniqueCircuitGroupHeads(groupedCircuits).map((circuit) => circuit.id)).toEqual([
    "scene-circuit-1",
    "scene-circuit-3",
  ]);

  const normalized = normalizeSceneSettingsByCircuitGroup(
    [
      { circuitId: "scene-circuit-1", percentage: "90" },
      { circuitId: "scene-circuit-2", percentage: "70" },
      { circuitId: "pico-led:switch-1:mur", percentage: "On" },
    ],
    groupedCircuits,
  );

  expect(normalized).toEqual([
    { circuitId: "pico-led:switch-1:mur", percentage: "On" },
    { circuitId: "scene-circuit-1", percentage: "90" },
    { circuitId: "scene-circuit-2", percentage: "90" },
  ]);
  expect(sceneSettingValueForCircuitGroup(normalized, groupedCircuits, groupedCircuits[1])).toBe("90");
});

test("area scene setting writes update and clear every member in a circuit group", () => {
  const groupedCircuits: CircuitEntry[] = [
    { ...circuits[0], id: "write-circuit-1", circuitGroupId: "write-group-a", designerNumber: "TP-08" },
    { ...circuits[1], id: "write-circuit-2", circuitGroupId: "write-group-a", designerNumber: "TP-08" },
    { ...circuits[0], id: "write-circuit-3", circuitGroupId: "", designerNumber: "TP-09" },
  ];
  const settings = [
    { circuitId: "write-circuit-1", percentage: "40" },
    { circuitId: "write-circuit-3", percentage: "55" },
    { circuitId: "pico-led:switch-1:mur", percentage: "On" },
  ];

  const updated = setSceneSettingValueForCircuitGroup(settings, groupedCircuits, groupedCircuits[1], " 80 ");
  expect(updated).toEqual([
    { circuitId: "write-circuit-3", percentage: "55" },
    { circuitId: "pico-led:switch-1:mur", percentage: "On" },
    { circuitId: "write-circuit-1", percentage: "80" },
    { circuitId: "write-circuit-2", percentage: "80" },
  ]);

  const cleared = setSceneSettingValueForCircuitGroup(updated, groupedCircuits, groupedCircuits[0], "");
  expect(cleared).toEqual([
    { circuitId: "write-circuit-3", percentage: "55" },
    { circuitId: "pico-led:switch-1:mur", percentage: "On" },
  ]);

  const fallbackUpdated = setSceneSettingValueForCircuitGroup(cleared, groupedCircuits, groupedCircuits[2], "20");
  expect(fallbackUpdated).toContainEqual({ circuitId: "write-circuit-3", percentage: "20" });
});

test("room type sync normalizes area scene values across same circuit group", () => {
  const sourceCircuits: CircuitEntry[] = [
    { ...circuits[0], id: "sync-group-1", circuitGroupId: "sync-group", designerNumber: "TP-04", detail: "Mini Bar DL" },
    { ...circuits[1], id: "sync-group-2", circuitGroupId: "sync-group", designerNumber: "TP-04", detail: "TV DL" },
  ];
  const source = roomType({
    circuitIds: sourceCircuits.map((circuit) => circuit.id),
    scenes: [
      {
        id: "sync-scene",
        areaId: "area-1",
        name: "Bright",
        settings: [
          { circuitId: "sync-group-1", percentage: "90" },
          { circuitId: "sync-group-2", percentage: "70" },
        ],
      },
    ],
  });

  const project = syncProjectRoomTypeLinks(
    { ...projectWithRoomTypes([source]), circuits: sourceCircuits },
    { devices: [], createId: nextIdFactory() },
  );

  expect(project.roomTypes[0].scenes[0].settings).toEqual([
    { circuitId: "sync-group-1", percentage: "90" },
    { circuitId: "sync-group-2", percentage: "90" },
  ]);
});
