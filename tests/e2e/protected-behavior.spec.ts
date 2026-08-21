import { test, expect, type Page } from "@playwright/test";
import {
  APP_SETTINGS_KEY,
  createDefaultBacklightLevels,
  createDefaultDevices,
  createDefaultLocations,
  createEmptySwitchEntry,
  createNewRoomType,
  REMOVED_DEFAULT_DEVICE_MODELS,
} from "../../app/lib/constants";
import { OTHER_AREA_ID } from "../../app/lib/cfsTableModel";
import { formatProgrammingName, normalizeProgrammingNameSettings } from "../../app/lib/programmingNameSettings";
import { ensureRoomScenes, isPmsScene } from "../../app/lib/roomScenes";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

function projectNameInput(page: Page) {
  return page.locator('input[placeholder="New project name"], input[placeholder*="プロジェクト名"]').first();
}

function createProjectButton(page: Page) {
  return page.getByRole("button", { name: /Create Project|作成|追加|新規/ }).first();
}

function roomTypeNameInput(page: Page) {
  return page.locator('input[placeholder="New room type name"], input[placeholder*="ルームタイプ名"]').first();
}

function createRoomTypeButton(page: Page) {
  return page.getByRole("button", { name: /Create Room Type|ルームタイプ作成|作成/ }).first();
}

function saveRevisionTopButton(page: Page) {
  return page.getByRole("button", { name: /Save all room types as new revisions|Save Revision/ }).first();
}

function saveCurrentProjectTopButton(page: Page) {
  return page.getByRole("button", { name: "Save current project without a new revision", exact: true }).first();
}

function revisionManagementTopButton(page: Page) {
  return page.getByRole("button", { name: /Open revision management|Revision Management/ }).first();
}

async function addCircuitRowWithDesigner(page: Page, designerNumber: string): Promise<void> {
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
  await page.locator(".btn-add-row").filter({ hasText: /Add Row/ }).first().click();
  const lastRow = page.locator(".circuits-table tbody tr").last();
  const designerInput = lastRow.locator(".device-cell textarea").first();
  await expect(designerInput).toBeVisible({ timeout: 10000 });
  await designerInput.fill(designerNumber);
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "load" });

  const input = projectNameInput(page);
  await expect(input).toBeVisible({ timeout: 10000 });
  await expect(input).toBeEnabled();
  await input.fill(name);
  await createProjectButton(page).click();

  const roomTypeTab = page.getByRole("tab", { name: /Room Type|Rooms/ }).first();
  try {
    await expect(roomTypeTab).toBeVisible({ timeout: 10000 });
  } catch {
    await page.locator("button.screen-card").filter({ hasText: name }).first().click();
    await expect(roomTypeTab).toBeVisible({ timeout: 10000 });
  }
}

async function createRoomType(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: /Room Type|Rooms/ }).first().click();
  const manageTab = page.getByRole("tab", { name: "+ Manage", exact: true }).first();
  if (await manageTab.isVisible().catch(() => false)) {
    await manageTab.click();
  }
  const input = roomTypeNameInput(page);
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(name);
  await createRoomTypeButton(page).click();
  await expect(page.getByRole("tab", { name: "Circuit" }).first()).toBeVisible({ timeout: 10000 });
}

function makeInspectionPercentProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: "inspection-area-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const roomType = {
    ...createNewRoomType(roomName),
    id: "inspection-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: ["inspection-circuit-1"],
    rows: [],
    deviceAssignments: [
      {
        id: "inspection-assignment-1",
        deviceGroupId: "inspection-device-group-1",
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zone1",
        circuitNumber: "1",
        detail: "Inspection DL",
        group: "",
      },
    ],
  };

  return {
    id: "inspection-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits: [
      {
        id: "inspection-circuit-1",
        circuitGroupId: "inspection-circuit-group-1",
        daliFixtureGroupId: "",
        designerNumber: "1",
        internalNumber: "1",
        dimmingType: "PWM",
        fixture: "",
        pcs: "1",
        detail: "Inspection DL",
        area: location.id,
        ffe: false,
        energySaving: false,
      },
    ],
    roomTypes: [roomType],
  };
}

function makeAreaSceneDragProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: "area-scene-drag-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const circuits = [1, 2, 3].map((index) => ({
    id: `area-scene-drag-circuit-${index}`,
    circuitGroupId: `area-scene-drag-circuit-group-${index}`,
    daliFixtureGroupId: "",
    designerNumber: `${index}`,
    internalNumber: `${index}`,
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail: `Scene Drag DL ${index}`,
    area: location.id,
    ffe: false,
    energySaving: false,
  }));
  const roomType = {
    ...createNewRoomType(roomName),
    id: "area-scene-drag-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: circuits.map((circuit) => circuit.id),
    rows: [],
    deviceAssignments: circuits.map((circuit, index) => ({
      id: `area-scene-drag-assignment-${index + 1}`,
      deviceGroupId: "area-scene-drag-device-group-1",
      device: "QSN-4P20-D",
      deviceNum: "1",
      zoneAddress: `Zone${index + 1}`,
      circuitNumber: circuit.designerNumber,
      detail: circuit.detail,
      group: "",
    })),
  };

  return {
    id: "area-scene-drag-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits,
    roomTypes: [roomType],
  };
}

function makeSceneCfsLinkProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: "scene-cfs-link-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const circuits = [1, 2, 3].map((index) => ({
    id: `scene-cfs-link-circuit-${index}`,
    circuitGroupId: `scene-cfs-link-circuit-group-${index}`,
    daliFixtureGroupId: "",
    designerNumber: `${index}`,
    internalNumber: `${index}`,
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail: `Scene Link DL ${index}`,
    area: location.id,
    ffe: false,
    energySaving: false,
  }));
  const areaScene = {
    id: "scene-cfs-link-area-scene-arrival",
    areaId: location.id,
    name: "Arrival",
    settings: [{ circuitId: circuits[0].id, percentage: "55" }],
  };
  const roomType = {
    ...createNewRoomType(roomName),
    id: "scene-cfs-link-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: circuits.map((circuit) => circuit.id),
    rows: [],
    deviceAssignments: circuits.map((circuit, index) => ({
      id: `scene-cfs-link-assignment-${index + 1}`,
      deviceGroupId: "scene-cfs-link-device-group-1",
      device: "QSN-4P20-D",
      deviceNum: "1",
      zoneAddress: `Zone${index + 1}`,
      circuitNumber: circuit.designerNumber,
      detail: circuit.detail,
      group: "",
    })),
    scenes: [areaScene],
    roomScenes: [
      {
        id: "scene-cfs-link-pms-room-scene",
        kind: "pms" as const,
        phase: "Check In" as const,
        sceneType: "From PMS PMS VAR: Enable",
        detail: "",
        triggerCondition: "Check-in/Day",
        backlightCondition: "",
        backlightAssignment: "",
        areaSceneSelections: [{ areaId: location.id, sceneId: areaScene.id }],
        settings: [{ circuitId: circuits[1].id, percentage: "66" }],
      },
    ],
  };

  return {
    id: "scene-cfs-link-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits,
    roomTypes: [roomType],
  };
}

function makeCurtainCfsProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: "curtain-cfs-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const circuit = {
    id: "curtain-cfs-lighting-circuit-1",
    circuitGroupId: "curtain-cfs-lighting-circuit-group-1",
    daliFixtureGroupId: "",
    designerNumber: "1",
    internalNumber: "1",
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail: "Curtain CFS DL",
    area: location.id,
    ffe: false,
    energySaving: false,
  };
  const targetSwitch = {
    ...createEmptySwitchEntry("lutronPd"),
    id: "curtain-cfs-backlight-target",
    switchGroupId: "curtain-cfs-backlight-target-group",
    switchNumber: "SW1",
    switchName: "Entrance",
    buttonCount: "1",
    buttonLabel: "B1",
    buttonFunction: "Scene",
    condition: "Press",
    backlightCondition: "",
    backlightAssignment: "",
  };
  const sourceSwitch = {
    ...createEmptySwitchEntry("lutronPd"),
    id: "curtain-cfs-backlight-source",
    switchGroupId: "curtain-cfs-backlight-source-group",
    switchNumber: "SW2",
    switchName: "Bedside",
    buttonCount: "1",
    buttonLabel: "B1",
    buttonFunction: "Backlight",
    condition: "Press",
    backlightTarget: targetSwitch.switchGroupId,
    backlightCondition: "masterOn",
    backlightAssignment: "",
  };
  const roomType = {
    ...createNewRoomType(roomName),
    id: "curtain-cfs-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: [circuit.id],
    rows: [],
    dryContacts: [
      {
        id: "curtain-cfs-dry-contact-1",
        area: location.id,
        circuit: "Curtain Relay",
        detail: "Relay Output",
      },
    ],
    deviceAssignments: [
      {
        id: "curtain-cfs-lighting-assignment-1",
        deviceGroupId: "curtain-cfs-lighting-group-1",
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zone1",
        circuitNumber: "1",
        detail: circuit.detail,
        group: "",
      },
      {
        id: "curtain-cfs-cco-assignment-1",
        deviceGroupId: "curtain-cfs-cco-group-1",
        device: "QSE-IO",
        deviceNum: "1",
        zoneAddress: "CCO1",
        circuitNumber: "Curtain Relay",
        area: location.id,
        detail: "Relay Output",
        group: "",
      },
    ],
    hvacAssignments: [
      {
        id: "curtain-cfs-hvac-1",
        protocol: "FCU" as const,
        thermostatRole: "Master" as const,
        area: location.id,
        lowEnd: "18",
        highEnd: "28",
        summerWinterChange: false,
        note: "",
      },
    ],
    curtainAssignments: [
      {
        id: "curtain-cfs-curtain-1",
        area: location.id,
        detail: "Blackout",
        action: "Open" as const,
      },
    ],
    roomScenes: [
      {
        id: "curtain-cfs-room-scene-1",
        kind: "standard" as const,
        phase: "Check In" as const,
        sceneType: "Welcome",
        detail: "Curtain Close",
        triggerCondition: "Check In",
        backlightCondition: "",
        backlightAssignment: "",
        areaSceneSelections: [],
        settings: [{ circuitId: "curtain:curtain-cfs-curtain-1", percentage: "Close" }],
      },
    ],
    switches: [targetSwitch, sourceSwitch],
  };

  return {
    id: "curtain-cfs-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits: [circuit],
    roomTypes: [roomType],
  };
}

function makeCorridorPicoCfsProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const roomType = {
    ...createNewRoomType(roomName),
    id: "corridor-pico-cfs-room-type",
    name: roomName,
    updatedAt: now,
    rows: [],
    scenes: [
      {
        id: "corridor-pico-cfs-area-scene-1",
        areaId: OTHER_AREA_ID,
        name: "Corridor Pico Area Scene",
        settings: [
          { circuitId: "pico-led:corridor-pico-cfs-group-1:mur", percentage: "On" },
          { circuitId: "pico-led:corridor-pico-cfs-group-1:dnd", percentage: "Off" },
        ],
      },
    ],
    roomScenes: [
      {
        id: "corridor-pico-cfs-room-scene-1",
        kind: "standard" as const,
        phase: "Check In" as const,
        sceneType: "Welcome",
        detail: "Corridor Pico",
        triggerCondition: "Check In",
        backlightCondition: "",
        backlightAssignment: "",
        areaSceneSelections: [{ areaId: OTHER_AREA_ID, sceneId: "corridor-pico-cfs-area-scene-1" }],
        settings: [],
      },
    ],
    switches: [
      {
        ...createEmptySwitchEntry("lutronPico"),
        id: "corridor-pico-cfs-switch-1",
        switchGroupId: "corridor-pico-cfs-group-1",
        switchNumber: "SW-0",
        switchName: "Entrance",
        buttonCount: "Corridor",
        buttonLabel: "Chime Button",
        allocation: "CorridorPico",
        buttonFunction: "Chime Button",
        condition: "Press4sec",
      },
    ],
  };

  return {
    id: "corridor-pico-cfs-project",
    name,
    updatedAt: now,
    settings: {
      programmingName: normalizeProgrammingNameSettings({
        tokens: ["area", "device"],
        bracketStyle: "square",
        tokenSeparator: "",
        detailSeparator: " ",
      }),
    },
    locations: createDefaultLocations(),
    fixtures: [],
    circuits: [],
    roomTypes: [roomType],
  };
}

function makeBacklightLegacyProject(name: string, roomName: string) {
  const project = makeCurtainCfsProject(name, roomName);
  const roomType = project.roomTypes[0] as ReturnType<typeof createNewRoomType> & {
    roomScenes: Array<{ backlightCondition: string }>;
    switches: Array<{ backlightCondition: string }>;
  };
  roomType.roomScenes = roomType.roomScenes.map((scene) => ({
    ...scene,
    backlightCondition: "Light",
    backlightAssignment: "",
  }));
  roomType.switches = roomType.switches.map((sw) => ({
    ...sw,
    backlightCondition: sw.backlightTarget ? "Light" : "",
    backlightAssignment: "",
  }));
  roomType.switches.push({
    ...createEmptySwitchEntry("lutronPd"),
    id: "legacy-backlight-master-source",
    switchGroupId: "legacy-backlight-master-source-group",
    switchNumber: "SW3",
    switchName: "Master Source",
    buttonCount: "1",
    buttonLabel: "B1",
    buttonFunction: "Backlight",
    condition: "Press",
    backlightTarget: "curtain-cfs-backlight-target-group",
    backlightCondition: "Master On",
    backlightAssignment: "",
  });
  return project;
}

function makeBacklightDeleteCascadeProject(name: string, roomName: string) {
  const project = makeCurtainCfsProject(name, roomName);
  const roomType = project.roomTypes[0] as ReturnType<typeof createNewRoomType> & {
    roomScenes: Array<{ backlightCondition: string }>;
    switches: Array<ReturnType<typeof createEmptySwitchEntry>>;
  };
  const customLevel = {
    key: "custom-night",
    name: "Custom Night",
    mode: "Manual" as const,
    active: "65",
    inactive: "15",
  };
  const targetGroupId = "curtain-cfs-backlight-target-group";
  const nextBacklightLevels = [...createDefaultBacklightLevels(), customLevel];
  roomType.backlightLevels = nextBacklightLevels;
  roomType.switches = roomType.switches.map((sw) => {
    if (sw.switchGroupId === targetGroupId) {
      return { ...sw, backlightLevels: nextBacklightLevels, backlightCondition: "" };
    }
    if (sw.backlightTarget === targetGroupId) {
      return { ...sw, backlightCondition: customLevel.key };
    }
    return sw;
  });
  roomType.switches.push({
    ...createEmptySwitchEntry("contact"),
    id: "custom-backlight-contact-source",
    switchGroupId: "custom-backlight-contact-source-group",
    switchNumber: "CCI1",
    switchName: "Contact Backlight",
    buttonCount: "1",
    buttonLabel: "B1",
    buttonFunction: "Backlight",
    condition: "Press",
    backlightTarget: targetGroupId,
    backlightCondition: customLevel.key,
    backlightAssignment: "",
  });
  roomType.roomScenes = roomType.roomScenes.map((scene, index) => ({
    ...scene,
    backlightCondition: index === 0 ? customLevel.key : scene.backlightCondition,
    backlightAssignment: "",
  }));
  return project;
}

function makeInspectionMultiRoomProject(name: string, roomNames: string[]) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: "inspection-multi-area-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const circuits = roomNames.map((roomName, index) => ({
    id: `inspection-multi-circuit-${index + 1}`,
    circuitGroupId: `inspection-multi-circuit-group-${index + 1}`,
    daliFixtureGroupId: "",
    designerNumber: `${index + 1}`,
    internalNumber: `${index + 1}`,
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail: `${roomName} DL`,
    area: location.id,
    ffe: false,
    energySaving: false,
  }));
  const roomTypes = roomNames.map((roomName, index) => ({
    ...createNewRoomType(roomName),
    id: `inspection-multi-room-type-${index + 1}`,
    name: roomName,
    updatedAt: now,
    circuitIds: [circuits[index].id],
    rows: [],
    deviceAssignments: [
      {
        id: `inspection-multi-assignment-${index + 1}`,
        deviceGroupId: `inspection-multi-device-group-${index + 1}`,
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zone1",
        circuitNumber: `${index + 1}`,
        detail: `${roomName} DL`,
        group: "",
      },
    ],
  }));

  return {
    id: "inspection-multi-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits,
    roomTypes,
  };
}

function makePriorityFunctionProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: "priority-area-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const roomType = {
    ...createNewRoomType(roomName),
    id: "priority-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: ["priority-circuit-1"],
    rows: [],
    deviceAssignments: [
      {
        id: "priority-assignment-1",
        deviceGroupId: "priority-device-group-1",
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zone1",
        circuitNumber: "1",
        detail: "Priority DL",
        group: "",
      },
    ],
    switches: (() => {
      const groupId = "priority-switch-group-1";
      const first = {
        ...createEmptySwitchEntry("lutronPd"),
        id: "priority-switch-relax",
        switchGroupId: groupId,
        switchNumber: "SW1",
        switchName: "Entrance",
        buttonCount: "1",
        buttonLabel: "M1",
        buttonFunction: "Relax",
        condition: "Press",
      };
      const second = {
        ...createEmptySwitchEntry("lutronPd"),
        id: "priority-switch-welcome",
        switchGroupId: groupId,
        switchNumber: "SW1",
        switchName: "Entrance",
        buttonCount: "1",
        buttonLabel: "M1",
        buttonFunction: "Welcome",
        condition: "Press",
      };
      return [first, second];
    })(),
  };

  return {
    id: "priority-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits: [
      {
        id: "priority-circuit-1",
        circuitGroupId: "priority-circuit-group-1",
        daliFixtureGroupId: "",
        designerNumber: "1",
        internalNumber: "1",
        dimmingType: "PWM",
        fixture: "",
        pcs: "1",
        detail: "Priority DL",
        area: location.id,
        ffe: false,
        energySaving: false,
      },
    ],
    roomTypes: [roomType],
  };
}

function makeRevisionHighlightProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const pduDeviceId = "revision-pdu-qse-io";
  const location = { ...bedroom, id: "revision-area-bedroom", name: "Bedroom", number: "1", code: "BM" };
  const otherLocation = { ...otherLocations[0], id: "revision-area-vanity", name: "Vanity", number: "2", code: "VA" };
  const circuitBefore = {
    id: "revision-circuit-1",
    circuitGroupId: "revision-circuit-group-1",
    daliFixtureGroupId: "",
    designerNumber: "1",
    internalNumber: "1",
    dimmingType: "Phase",
    fixture: "",
    pcs: "1",
    detail: "Old DL",
    area: location.id,
    ffe: false,
    energySaving: false,
  };
  const circuitAfter = {
    ...circuitBefore,
    designerNumber: "2",
    internalNumber: "2",
    dimmingType: "PWM",
    detail: "Revision DL",
  };
  const dryContactBefore = {
    id: "revision-dry-contact-1",
    area: location.id,
    circuit: "CCO1",
    detail: "Sheer Open",
  };
  const dryContactAfter = {
    ...dryContactBefore,
    detail: "Sheer Close",
  };
  const assignmentBefore = {
    id: "revision-assignment-1",
    deviceGroupId: "revision-device-group-1",
    device: "QSN-4P20-D",
    deviceNum: "1",
    zoneAddress: "Zone1",
    circuitNumber: "1",
    detail: "Old DL",
    group: "",
  };
  const assignmentAfter = {
    ...assignmentBefore,
    circuitNumber: "2",
    detail: "Revision DL",
  };
  const ccoAssignmentBefore = {
    id: "revision-cco-assignment-1",
    deviceGroupId: "revision-cco-group-1",
    device: "QSE-IO",
    deviceNum: "1",
    zoneAddress: "CCO1",
    circuitNumber: "Sheer Open",
    area: location.id,
    detail: "Sheer Open",
    group: "",
  };
  const ccoAssignmentAfter = {
    ...ccoAssignmentBefore,
    circuitNumber: "Sheer Close",
    detail: "Sheer Close",
  };
  const sceneBefore = {
    id: "revision-scene-1",
    areaId: location.id,
    name: "Refresh",
    settings: [{ circuitId: circuitBefore.id, percentage: "0" }],
  };
  const sceneAfter = {
    ...sceneBefore,
    settings: [{ circuitId: circuitBefore.id, percentage: "100" }],
  };
  const roomSceneBefore = {
    id: "revision-room-scene-1",
    kind: "standard",
    phase: "Check In",
    sceneType: "Welcome",
    detail: "Day",
    triggerCondition: "Check In",
    backlightCondition: "",
    backlightAssignment: "",
    areaSceneSelections: [{ areaId: location.id, sceneId: sceneBefore.id }],
    settings: [],
  };
  const roomSceneAfter = {
    ...roomSceneBefore,
    triggerCondition: "PMS VAR: Enable",
    areaSceneSelections: [{ areaId: location.id, sceneId: sceneAfter.id }],
  };
  const switchBefore = {
    ...createEmptySwitchEntry("lutronPd"),
    id: "revision-switch-1",
    switchGroupId: "revision-switch-group-1",
    switchNumber: "SW1",
    switchName: "Entrance",
    buttonCount: "1",
    buttonLabel: "M1",
    buttonFunction: "Refresh",
    condition: "Press",
    buttonSetting: { sceneId: sceneBefore.id, sceneIds: [sceneBefore.id], circuitSettings: [] },
    backlightLevels: [{ key: "welcome", name: "Welcome", mode: "Manual", active: "80", inactive: "10" }],
  };
  const switchAfter = {
    ...switchBefore,
    condition: "Hold 4sec.",
    buttonSetting: { sceneId: sceneAfter.id, sceneIds: [sceneAfter.id], circuitSettings: [] },
    backlightLevels: [{ key: "welcome", name: "Welcome", mode: "Manual", active: "70", inactive: "5" }],
  };
  const commandBefore = {
    ...createEmptySwitchEntry("command"),
    id: "revision-command-1",
    switchGroupId: "revision-command-group-1",
    switchNumber: "SW2",
    switchName: "Command",
    buttonCount: "1",
    buttonLabel: "-",
    buttonFunction: "Welcome Reset",
    condition: "Hold 4sec.",
    buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: circuitBefore.id, percentage: "0" }] },
  };
  const commandAfter = {
    ...commandBefore,
    buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: circuitAfter.id, percentage: "100" }] },
  };
  const beforeSnapshot = {
    circuits: [circuitBefore],
    dryContacts: [dryContactBefore],
    rows: [],
    deviceAssignments: [assignmentBefore, ccoAssignmentBefore],
    hvacAssignments: [],
    hvacSeasons: [],
    scenes: [sceneBefore],
    roomScenes: [roomSceneBefore],
    switches: [switchBefore, commandBefore],
    pduDeviceCounts: [{ deviceId: pduDeviceId, quantity: 1 }],
    inspectionMarks: [],
  };
  const roomType = {
    ...createNewRoomType(roomName),
    id: "revision-room-type",
    name: roomName,
    updatedAt: now,
    revision: "1.00",
    revisions: [
      {
        id: "revision-snapshot-1",
        revision: "1.00",
        savedAt: now,
        snapshot: JSON.stringify(beforeSnapshot),
        note: "Before highlight test",
      },
    ],
    circuitIds: [circuitAfter.id],
    rows: [],
    dryContacts: [dryContactAfter],
    deviceAssignments: [assignmentAfter, ccoAssignmentAfter],
    hvacAssignments: [],
    hvacSeasons: [],
    scenes: [sceneAfter],
    roomScenes: [roomSceneAfter],
    switches: [switchAfter, commandAfter],
    pduDeviceCounts: [{ deviceId: pduDeviceId, quantity: 2 }],
    inspectionMarks: [],
  };

  return {
    id: "revision-highlight-project",
    name,
    updatedAt: now,
    locations: [location, otherLocation, ...otherLocations.slice(1)],
    fixtures: [],
    circuits: [circuitAfter],
    roomTypes: [roomType],
  };
}

async function seedProjects(projects: unknown[]): Promise<void> {
  mockState.projects = projects as Record<string, unknown>[];
}

async function forceViewOnlyCollaboration(page: Page): Promise<void> {
  await page.unroute("**/api/collaboration/status**").catch(() => undefined);
  await page.route("**/api/collaboration/status**", async (route) => {
    const requestUrl = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        mode: "view",
        projectId: requestUrl.searchParams.get("projectId") ?? "",
        lock: null,
        locks: [],
        lastUpdatedBy: null,
        leaseSeconds: 90,
        heartbeatMs: 20_000,
        idleMs: 15 * 60 * 1000,
      }),
    });
  });
}

async function enableLocalCollaboration(page: Page, options: { idleMs?: number } = {}): Promise<void> {
  const idleMs = options.idleMs ?? 15 * 60 * 1000;
  const user = {
    id: "test-editor",
    displayName: "Test Editor",
    email: "test-editor@example.com",
    role: "admin" as const,
    createdAt: null,
    lastSeenAt: null,
  };
  const membership = {
    ...user,
    active: true,
    updatedAt: null,
  };
  let mode: "view" | "edit" = "view";

  const buildStatus = (projectId = "") => {
    const now = new Date().toISOString();
    const lock = mode === "edit"
      ? {
          scopeId: projectId || "global",
          projectId,
          userId: user.id,
          userName: user.displayName,
          sessionId: "test-session",
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
        }
      : null;
    return {
      enabled: true,
      mode,
      ownsLock: mode === "edit",
      scopeId: projectId || "global",
      projectId,
      lock,
      locks: lock ? [lock] : [],
      lastUpdatedBy: null,
      membership,
      leaseSeconds: 90,
      heartbeatMs: 20_000,
      idleMs,
    };
  };

  await page.evaluate((storedUser) => {
    window.localStorage.setItem("cfs-collaboration-user-v1", JSON.stringify(storedUser));
    window.sessionStorage.setItem("cfs-collaboration-session-v1", "test-session");
  }, user);

  await page.unroute("**/api/collaboration/status**").catch(() => undefined);
  await page.route("**/api/collaboration/status**", async (route) => {
    const requestUrl = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildStatus(requestUrl.searchParams.get("projectId") ?? "")),
    });
  });

  await page.route("**/api/collaboration/lock/acquire", async (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string };
    mode = "edit";
    const status = buildStatus(payload.projectId ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ acquired: true, lock: status.lock, status }),
    });
  });

  await page.route("**/api/collaboration/lock/heartbeat", async (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string };
    const status = buildStatus(payload.projectId ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ acquired: mode === "edit", lock: status.lock, status }),
    });
  });

  await page.route("**/api/collaboration/lock/release", async (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string };
    mode = "view";
    const status = buildStatus(payload.projectId ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, released: true, status }),
    });
  });
}

async function seedRevisionHighlightSettings(page: Page): Promise<void> {
  const payload = {
    devices: [{
      id: "revision-pdu-qse-io",
      model: "QSE-IO",
      control: "Input/Output",
      abbrev: "IO",
      programmingCode: "IO",
      lowEnd: "",
      highEnd: "",
      isDefault: true,
      addressMode: "fixed",
      pdu: "-3",
      watts: "",
    }],
    inputMasters: [],
    triggerMasters: [],
    displayScale: 1,
    wattPerPdu: 3.3,
    adminMode: false,
    cfsLinkedValueHighlightEnabled: false,
    cfsLinkMapEnabled: false,
  };
  await page.addInitScript(({ settingsKey, settings }) => {
    window.localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, { settingsKey: APP_SETTINGS_KEY, settings: payload });
  await page.evaluate(({ settingsKey, settings }) => {
    window.localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, { settingsKey: APP_SETTINGS_KEY, settings: payload }).catch(() => undefined);
}

test.describe("Protected CFS behaviors", () => {
  test("removed default device models are not restored", () => {
    const defaultModels = new Set(createDefaultDevices().map((device) => device.model));

    for (const removedModel of REMOVED_DEFAULT_DEVICE_MODELS) {
      expect(defaultModels.has(removedModel)).toBe(false);
    }
  });

  test("room type migration defaults keep room scenes and HVAC seasons", () => {
    const roomType = createNewRoomType("Protected Room");

    expect(roomType.roomScenes.length).toBeGreaterThan(0);
    expect(roomType.hvacSeasons.length).toBeGreaterThan(0);
    expect(roomType.backlightLevels?.map((level) => level.name)).toEqual(["Base", "Bright", "Relax", "Mood", "Sleep"]);
    expect(roomType.scenes).toEqual([]);
    expect(roomType.switches).toEqual([]);
  });

  test("room type rename uses an in-app dialog and updates the room type name", async ({ page }) => {
    const projectName = `Protected-RoomRename-${Date.now()}`;
    const firstRoomType = `Room-Rename-A-${Date.now()}`;
    const secondRoomType = `Room-Rename-B-${Date.now()}`;
    const renamedRoomType = `${secondRoomType}-Updated`;
    await createProject(page, projectName);
    await createRoomType(page, firstRoomType);
    await createRoomType(page, secondRoomType);

    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.getByRole("tab", { name: "+ Manage", exact: true }).click();

    const targetCard = page.locator(".screen-card-wrap").filter({ hasText: secondRoomType });
    await targetCard.getByRole("button", { name: "Rename Room Type", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Rename Room Type", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Room Type Name", { exact: true })).toHaveValue(secondRoomType);

    await dialog.getByLabel("Room Type Name", { exact: true }).fill(firstRoomType);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toContainText("A room type with the same name already exists.");

    await dialog.getByLabel("Room Type Name", { exact: true }).fill(renamedRoomType);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".screen-card-title").filter({ hasText: renamedRoomType })).toBeVisible();
    await expect(page.getByRole("tab", { name: renamedRoomType, exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: secondRoomType, exact: true })).toHaveCount(0);
  });

  test("PMS room scene classification survives visible name edits", () => {
    const [pmsScene] = ensureRoomScenes([
      {
        id: "protected-pms",
        phase: "Check In",
        sceneType: "From PMS",
        detail: "",
        triggerCondition: "Check In",
        backlightCondition: "",
        areaSceneSelections: [],
        settings: [],
      },
    ]);

    expect(pmsScene.kind).toBe("pms");
    expect(isPmsScene({ ...pmsScene, sceneType: "From PM" })).toBe(true);
    expect(isPmsScene({ ...pmsScene, sceneType: "" })).toBe(true);
  });

  test("PMS scene editing keeps spaces and add-row keeps the setting panel closed", async ({ page }) => {
    await createProject(page, `Protected-Scene-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "Scene", exact: true }).click();
    await expect(page.getByText("From PMS Scene")).toBeVisible({ timeout: 10000 });

    const pmsTable = page.locator("table.room-scene-table").first();
    await expect(pmsTable.locator("tbody tr")).toHaveCount(2, { timeout: 10000 });

    const firstPmsName = pmsTable.locator("tbody tr").first().locator("textarea").first();
    await firstPmsName.fill("Check In From PMS");
    await expect(firstPmsName).toHaveValue("Check In From PMS");

    await pmsTable.getByRole("button", { name: /\+ Add PMS Row/ }).click();
    await expect(page.locator(".setting-overlay")).toHaveCount(0);
    await expect(pmsTable.locator("tbody tr")).toHaveCount(3);

    const pmsNumbers = await pmsTable.locator("tbody tr").evaluateAll((rows) =>
      rows.map((row) => row.children[1]?.textContent?.trim()),
    );
    expect(pmsNumbers).toEqual(["1", "2", "3"]);

    const doorMagnetTable = page.locator("table.room-scene-table").nth(1);
    await expect(doorMagnetTable.locator("tbody tr").first().locator("td").nth(1)).toHaveText("1");
  });

  test("CFS PMS scene headers use the Scene tab cell values", async ({ page }) => {
    await createProject(page, `Protected-PmsCfs-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "Scene", exact: true }).click();
    const pmsRow = page.locator("table.room-scene-pms-table tbody tr").first();
    await expect(pmsRow.locator("textarea").first()).toHaveValue("From PMS");
    await pmsRow.locator("textarea").first().fill("Cell Value / Exact");
    await pmsRow.locator("input.combobox-input").first().fill("PMS VAR: Enable / Day");

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsHeaderRows = page.locator("table.cfs-matrix-table thead tr");
    await expect(cfsHeaderRows.nth(1).locator("th").first()).toContainText("From PMS");
    await expect(cfsHeaderRows.nth(2).locator("th").first()).toContainText("Cell Value");
    await expect(cfsHeaderRows.nth(2).locator("th").first()).toContainText("Exact");
    await expect(cfsHeaderRows.nth(2).locator("th").first().locator(".cfs-header-stack span")).toHaveCount(2);
    await expect(cfsHeaderRows.nth(3).locator("th").first()).toContainText("PMS VAR: Enable");
    await expect(cfsHeaderRows.nth(3).locator("th").first()).toContainText("Day");
  });

  test("Scene tab PMS names and empty values flow into CFS without blank cells", async ({ page }) => {
    const projectName = `Protected-SceneCfsLink-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await seedProjects([makeSceneCfsLinkProject(projectName, roomName)]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "Scene", exact: true }).click();
    const pmsRow = page.locator("table.room-scene-pms-table tbody tr").first();
    await expect(pmsRow.locator("textarea").first()).toHaveValue("From PMS PMS VAR: Enable");

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsHeaderRows = page.locator("table.cfs-matrix-table thead tr");
    await expect(cfsHeaderRows.nth(1).locator("th").first()).toContainText("From PMS");
    await expect(cfsHeaderRows.nth(2).locator("th").first()).toContainText("From PMS PMS VAR: Enable");
    await expect(cfsHeaderRows.nth(3).locator("th").first()).toContainText("Check-in/Day");

    const cfsRows = page.locator("table.cfs-matrix-table tbody tr.cfs-fixture-row");
    await expect(cfsRows).toHaveCount(3);
    const firstCircuitCell = cfsRows.filter({ hasText: "Scene Link DL 1" }).first().locator("td.cfs-function-cell").first();
    await expect(firstCircuitCell).toContainText("Arrival");
    await expect(firstCircuitCell).toContainText("55%");
    await expect(cfsRows.filter({ hasText: "Scene Link DL 2" }).first().locator("td.cfs-function-cell").first()).toContainText("66%");
    // From PMS scenes leave untouched zones as "Uneffected" (2026-08-21
    // display change), not "-".
    await expect(cfsRows.filter({ hasText: "Scene Link DL 3" }).first().locator("td.cfs-function-cell").first()).toHaveText("Uneffected");

    const functionCellTexts = await cfsRows.locator("td.cfs-function-cell").evaluateAll((cells) =>
      cells.map((cell) => cell.textContent?.trim() ?? ""),
    );
    expect(functionCellTexts.every((text) => text.length > 0)).toBe(true);
  });

  test("save revision keeps a user note with the automatic update memo", async ({ page }) => {
    const projectName = `Protected-Revision-${Date.now()}`;
    await createProject(page, projectName);
    const firstRoomType = `Room-A-${Date.now()}`;
    const secondRoomType = `Room-B-${Date.now()}`;
    await createRoomType(page, firstRoomType);
    await createRoomType(page, secondRoomType);

    await saveRevisionTopButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".revision-batch-table tbody tr")).toHaveCount(2);
    await expect(dialog.locator(".revision-batch-summary")).toContainText("2 / 2 room types selected");
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.width ?? 0).toBeGreaterThan(900);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => {
      const dialogElement = document.querySelector('[role="dialog"]');
      return !!dialogElement && dialogElement.contains(document.activeElement);
    })).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");

    await saveRevisionTopButton(page).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(dialog.locator(".revision-batch-summary")).toContainText("0 / 2 room types selected");
    await expect(dialog.getByRole("button", { name: "Save Revision", exact: true })).toBeDisabled();

    await dialog.getByLabel(`Save revision for ${firstRoomType}`).check();
    await expect(dialog.locator(".revision-batch-summary")).toContainText("1 / 2 room types selected");
    await expect(dialog.locator(".revision-batch-select-heading input")).toHaveJSProperty("indeterminate", true);
    await dialog.getByLabel(`Update revision for ${firstRoomType}`).fill("1.00");
    await dialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(dialog).toContainText(`Update Revision for ${firstRoomType} must be different from the current revision.`);

    await dialog.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(dialog.locator(".revision-batch-summary")).toContainText("2 / 2 room types selected");
    await expect(dialog.locator(".revision-batch-select-heading input")).toHaveJSProperty("indeterminate", false);
    await dialog.getByLabel(`Update revision for ${firstRoomType}`).fill("2.10");
    await dialog.getByLabel(`Update revision for ${secondRoomType}`).fill("2.20");
    await dialog.getByLabel(`Memo for ${firstRoomType}`).fill("Area remap checked against A Type");
    await dialog.getByLabel(`Memo for ${secondRoomType}`).fill("Second room type checked");
    await dialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("tab", { name: firstRoomType, exact: true }).click();
    await expect(page.locator(".revision-top-controls")).toContainText(`${firstRoomType} Revision 2.10`);
    await revisionManagementTopButton(page).click();
    const revisionPanel = page.locator(".revision-manager-panel");
    await expect(revisionPanel.locator(".revision-metadata-input").first()).toHaveValue("2.10");
    await expect(revisionPanel).toContainText("Area remap checked against A Type");
    await expect(revisionPanel).toContainText("Initial revision snapshot.");

    await page.getByRole("tab", { name: secondRoomType, exact: true }).click();
    await expect(page.locator(".revision-top-controls")).toContainText(`${secondRoomType} Revision 2.20`);
    await expect(revisionPanel.locator(".revision-metadata-input").first()).toHaveValue("2.20");
    await expect(revisionPanel).toContainText("Second room type checked");
    await expect(revisionPanel).toContainText("Initial revision snapshot.");

    const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
    const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
    const firstSaved = roomTypes.find((rt) => rt.name === firstRoomType) as Record<string, unknown> | undefined;
    const secondSaved = roomTypes.find((rt) => rt.name === secondRoomType) as Record<string, unknown> | undefined;
    expect(firstSaved?.revision).toBe("2.10");
    expect(secondSaved?.revision).toBe("2.20");
    expect(firstSaved?.revisions).toHaveLength(1);
    expect(secondSaved?.revisions).toHaveLength(1);
    expect(String((firstSaved?.revisions as Record<string, unknown>[])[0]?.snapshot ?? "")).toContain("deviceAssignments");
    expect(String((secondSaved?.revisions as Record<string, unknown>[])[0]?.snapshot ?? "")).toContain("deviceAssignments");
  });

  test("save revision skips unchecked room types", async ({ page }) => {
    const projectName = `Protected-RevisionSkip-${Date.now()}`;
    await createProject(page, projectName);
    const firstRoomType = `Room-A-${Date.now()}`;
    const secondRoomType = `Room-B-${Date.now()}`;
    await createRoomType(page, firstRoomType);
    await createRoomType(page, secondRoomType);

    await saveRevisionTopButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(`Save revision for ${secondRoomType}`).uncheck();
    await expect(dialog.locator(".revision-batch-summary")).toContainText("1 / 2 room types selected");
    await expect(dialog.locator(".revision-batch-select-heading input")).toHaveJSProperty("indeterminate", true);
    await expect(dialog.getByLabel(`Update revision for ${secondRoomType}`)).toBeDisabled();
    await dialog.getByLabel(`Update revision for ${firstRoomType}`).fill("2.30");
    await dialog.getByLabel(`Memo for ${firstRoomType}`).fill("Only first room type updated");
    await dialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(dialog).toBeHidden();

    const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
    const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
    const firstSaved = roomTypes.find((rt) => rt.name === firstRoomType) as Record<string, unknown> | undefined;
    const secondSaved = roomTypes.find((rt) => rt.name === secondRoomType) as Record<string, unknown> | undefined;
    expect(firstSaved?.revision).toBe("2.30");
    expect(firstSaved?.revisions).toHaveLength(1);
    expect(secondSaved?.revision).toBe("1.00");
    expect((secondSaved?.revisions as unknown[] | undefined)?.length ?? 0).toBe(0);
  });

  test("save current project persists changes without creating a revision", async ({ page }) => {
    const projectName = `Protected-NoRevisionSave-${Date.now()}`;
    const roomTypeName = `Room-NoRevision-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomTypeName);

    await addCircuitRowWithDesigner(page, "NO-REV-A");
    await expect(saveCurrentProjectTopButton(page)).toBeEnabled();
    await saveCurrentProjectTopButton(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });

    await expect.poll(() => {
      const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
      const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
      const savedRoomType = roomTypes.find((rt) => rt.name === roomTypeName) as Record<string, unknown> | undefined;
      const circuitIds = Array.isArray(savedRoomType?.circuitIds) ? savedRoomType.circuitIds as unknown[] : [];
      const revisions = Array.isArray(savedRoomType?.revisions) ? savedRoomType.revisions as unknown[] : [];
      const circuits = Array.isArray(savedProject?.circuits) ? savedProject.circuits as Record<string, unknown>[] : [];
      const hasCircuit = circuits.some((circuit) => circuit.designerNumber === "NO-REV-A");
      return `${savedRoomType?.revision}|${revisions.length}|${circuitIds.length}|${circuits.length}|${hasCircuit}`;
    }).toBe("1.00|0|1|1|true");
  });

  test("revision manager edits saved metadata and save current keeps the snapshot intact", async ({ page }) => {
    const projectName = `Protected-RevisionMetadata-${Date.now()}`;
    const roomTypeName = `Room-Metadata-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomTypeName);
    await addCircuitRowWithDesigner(page, "META-A");

    await saveRevisionTopButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(`Memo for ${roomTypeName}`).fill("Initial memo");
    await dialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(dialog).toBeHidden();

    const savedBefore = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
    const beforeRoomTypes = Array.isArray(savedBefore?.roomTypes) ? savedBefore.roomTypes as Record<string, unknown>[] : [];
    const beforeRoomType = beforeRoomTypes.find((rt) => rt.name === roomTypeName) as Record<string, unknown> | undefined;
    const beforeRevisions = Array.isArray(beforeRoomType?.revisions) ? beforeRoomType.revisions as Record<string, unknown>[] : [];
    const snapshotBefore = String(beforeRevisions[0]?.snapshot ?? "");
    expect(snapshotBefore).toContain("META-A");

    await revisionManagementTopButton(page).click();
    const revisionRow = page.locator(".revision-table tbody tr").first();
    await expect(revisionRow).toBeVisible();
    await revisionRow.locator(".revision-metadata-input").first().fill("2026-08-18");
    await revisionRow.locator('input[type="datetime-local"]').fill("2026-08-18T09:30");
    await revisionRow.locator(".revision-metadata-note-input").fill("Managed over multiple days");
    const expectedSavedAt = new Date("2026-08-18T09:30").toISOString();

    await saveCurrentProjectTopButton(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });

    await expect.poll(() => {
      const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
      const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
      const savedRoomType = roomTypes.find((rt) => rt.name === roomTypeName) as Record<string, unknown> | undefined;
      const revisions = Array.isArray(savedRoomType?.revisions) ? savedRoomType.revisions as Record<string, unknown>[] : [];
      const revision = revisions[0];
      return [
        savedRoomType?.revision,
        revision?.revision,
        revision?.savedAt,
        revision?.note,
        revision?.snapshot === snapshotBefore,
      ].join("|");
    }).toBe(`2026-08-18|2026-08-18|${expectedSavedAt}|Managed over multiple days|true`);
  });

  test("room type circuit edits stay scoped to the active room type", async ({ page }) => {
    const projectName = `Protected-CircuitScope-${Date.now()}`;
    const firstRoomType = `Room-Circuit-A-${Date.now()}`;
    const secondRoomType = `Room-Circuit-B-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, firstRoomType);
    await addCircuitRowWithDesigner(page, "CKT-A");

    await createRoomType(page, secondRoomType);
    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await expect(page.locator(".circuits-table")).toContainText("No circuits are registered yet");
    await expect(page.locator(".circuits-table")).not.toContainText("CKT-A");

    await addCircuitRowWithDesigner(page, "CKT-B");
    await page.getByRole("tab", { name: firstRoomType, exact: true }).click();
    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await expect(page.locator(".circuits-table")).toContainText("CKT-A");
    await expect(page.locator(".circuits-table")).not.toContainText("CKT-B");

    await page.getByRole("tab", { name: secondRoomType, exact: true }).click();
    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await expect(page.locator(".circuits-table")).toContainText("CKT-B");
    await expect(page.locator(".circuits-table")).not.toContainText("CKT-A");

    await saveCurrentProjectTopButton(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });

    await expect.poll(() => {
      const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
      const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
      const firstSaved = roomTypes.find((rt) => rt.name === firstRoomType) as Record<string, unknown> | undefined;
      const secondSaved = roomTypes.find((rt) => rt.name === secondRoomType) as Record<string, unknown> | undefined;
      const firstIds = Array.isArray(firstSaved?.circuitIds) ? firstSaved.circuitIds as string[] : [];
      const secondIds = Array.isArray(secondSaved?.circuitIds) ? secondSaved.circuitIds as string[] : [];
      const circuits = Array.isArray(savedProject?.circuits) ? savedProject.circuits as Record<string, unknown>[] : [];
      const firstCircuit = circuits.find((circuit) => circuit.designerNumber === "CKT-A");
      const secondCircuit = circuits.find((circuit) => circuit.designerNumber === "CKT-B");
      return [
        circuits.length,
        firstIds.length,
        secondIds.length,
        firstCircuit ? firstIds.includes(String(firstCircuit.id)) : false,
        secondCircuit ? secondIds.includes(String(secondCircuit.id)) : false,
        firstCircuit ? secondIds.includes(String(firstCircuit.id)) : true,
        secondCircuit ? firstIds.includes(String(secondCircuit.id)) : true,
      ].join("|");
    }).toBe("2|1|1|true|true|false|false");
  });

  test("project restore persists both project list and trash state", async ({ page }) => {
    const projectName = `Protected-RestoreProject-${Date.now()}`;
    await createProject(page, projectName);
    await page.getByRole("button", { name: "Back to Project List", exact: true }).click();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator(".screen-card-wrap").filter({ hasText: projectName }).getByRole("button", { name: "Delete Project", exact: true }).click();

    await expect(page.locator(".trash-row").filter({ hasText: projectName })).toBeVisible();
    await expect.poll(() => `${mockState.projects.length}|${mockState.trash.projects.length}`).toBe("0|1");

    await page.locator(".trash-row").filter({ hasText: projectName }).getByRole("button", { name: "Restore Project", exact: true }).click();

    await expect.poll(() => {
      const restored = mockState.projects.some((project) => project.name === projectName);
      return `${restored}|${mockState.trash.projects.length}`;
    }).toBe("true|0");
  });

  test("save revision conflict keeps the visible revision on the last saved value", async ({ page }) => {
    const projectName = `Protected-RevisionConflict-${Date.now()}`;
    await createProject(page, projectName);
    const roomTypeName = `Room-Conflict-${Date.now()}`;
    await createRoomType(page, roomTypeName);

    await page.route("**/api/projects**", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Project was updated by another user. Reload before saving." }),
        });
        return;
      }
      await route.fallback();
    }, { times: 1 });

    await saveRevisionTopButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(`Update revision for ${roomTypeName}`)).toHaveValue("1.01");
    const conflictPrompt = page.waitForEvent("dialog");
    await dialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    const prompt = await conflictPrompt;
    expect(prompt.type()).toBe("prompt");
    expect(prompt.message()).toContain("This project was saved elsewhere after this screen loaded.");
    await prompt.accept("B");

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The revisions could not be saved. Keep editing and try again.");
    await expect(page.locator(".revision-top-controls")).toContainText(`${roomTypeName} Revision 1.00`);

    const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
    const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
    const savedRoomType = roomTypes.find((rt) => rt.name === roomTypeName) as Record<string, unknown> | undefined;
    expect(savedRoomType?.revision).not.toBe("1.01");
    expect((savedRoomType?.revisions as unknown[] | undefined)?.length ?? 0).toBe(0);
  });

  test("save current project conflict can overwrite the confirmed server version", async ({ page }) => {
    const projectName = `Protected-ConflictOverwrite-${Date.now()}`;
    await createProject(page, projectName);
    const roomTypeName = `Room-Overwrite-${Date.now()}`;
    await createRoomType(page, roomTypeName);

    await page.unroute("**/api/projects**").catch(() => undefined);
    const serverUpdatedAt = "2099-01-01T00:00:00.000Z";
    let firstSave = true;
    let retryPayload: Record<string, unknown> | null = null;

    await page.route("**/api/projects**", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ projects: mockState.projects }),
        });
        return;
      }

      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const project = payload.project as Record<string, unknown> | undefined;
      if (!project) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, projects: mockState.projects }),
        });
        return;
      }

      if (firstSave) {
        firstSave = false;
        const serverProject = { ...mockState.projects[0], updatedAt: serverUpdatedAt };
        mockState.projects = [serverProject];
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            code: "PROJECT_CONFLICT",
            error: "Project was updated by another user. Reload before saving.",
            project: serverProject,
            serverUpdatedAt,
          }),
        });
        return;
      }

      retryPayload = payload;
      mockState.projects = [project];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, project, projects: mockState.projects }),
      });
    });

    const conflictPrompt = page.waitForEvent("dialog");
    const downloadPromise = page.waitForEvent("download");
    await saveCurrentProjectTopButton(page).click();
    const prompt = await conflictPrompt;
    expect(prompt.type()).toBe("prompt");
    await prompt.accept("O");
    const download = await downloadPromise;
    await download.delete().catch(() => undefined);

    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });
    const savedRetryPayload = retryPayload as Record<string, unknown> | null;
    expect(savedRetryPayload?.forceOverwrite).toBe(true);
    expect(savedRetryPayload?.forceOverwriteUpdatedAt).toBe(serverUpdatedAt);
    const savedProject = mockState.projects[0] as Record<string, unknown>;
    const roomTypes = Array.isArray(savedProject.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
    expect(roomTypes.some((roomType) => roomType.name === roomTypeName)).toBe(true);
  });

  test("project creation stays available while another project is locked", async ({ page }) => {
    const now = new Date().toISOString();
    const lockedProject = {
      id: "locked-by-other-project",
      name: "Locked Elsewhere",
      updatedAt: now,
      locations: [],
      fixtures: [],
      circuits: [],
      roomTypes: [],
    };
    mockState.projects = [lockedProject];

    await page.addInitScript(() => {
      window.localStorage.setItem(
        "cfs-collaboration-user-v1",
        JSON.stringify({
          id: "test-editor",
          displayName: "Test Editor",
          email: "test-editor@example.com",
          role: "admin",
          createdAt: null,
          lastSeenAt: null,
        }),
      );
      window.sessionStorage.setItem("cfs-collaboration-session-v1", "test-session");
    });

    await page.unroute("**/api/collaboration/status**").catch(() => undefined);
    await page.route("**/api/collaboration/status**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const requestedProjectId = requestUrl.searchParams.get("projectId") ?? "";
      const lock = {
        scopeId: "project:locked-by-other-project",
        projectId: "locked-by-other-project",
        userId: "gaku",
        userName: "Gaku",
        sessionId: "gaku-session",
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          mode: "view",
          ownsLock: false,
          scopeId: requestedProjectId ? `project:${requestedProjectId}` : "cfs-projects",
          projectId: requestedProjectId,
          lock: requestedProjectId === lockedProject.id ? lock : null,
          locks: [lock],
          lastUpdatedBy: null,
          membership: {
            id: "test-editor",
            email: "test-editor@example.com",
            displayName: "Test Editor",
            role: "admin",
            active: true,
            createdAt: null,
            updatedAt: null,
            lastSeenAt: null,
          },
          leaseSeconds: 90,
          heartbeatMs: 20_000,
          idleMs: 15 * 60 * 1000,
        }),
      });
    });

    let createRequestCount = 0;
    let createOnly = false;
    let requireLockHeader = "";
    let scopedProjectId = "";
    await page.unroute("**/api/projects**").catch(() => undefined);
    await page.route("**/api/projects**", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ projects: mockState.projects }),
        });
        return;
      }
      createRequestCount += 1;
      const payload = route.request().postDataJSON() as { createOnly?: boolean; project?: Record<string, unknown> };
      createOnly = payload.createOnly === true;
      requireLockHeader = route.request().headers()["x-cfs-require-edit-lock"] ?? "";
      scopedProjectId = route.request().headers()["x-cfs-project-id"] ?? "";
      const project = payload.project || {};
      mockState.projects = [project, ...mockState.projects];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, project, projects: mockState.projects }),
      });
    });

    let lockAcquireCount = 0;
    await page.route("**/api/collaboration/lock/acquire", async (route) => {
      lockAcquireCount += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Project creation should not acquire an edit lock." }),
      });
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "CFS Project Selection", exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".screen-card-wrap").filter({ hasText: "Locked Elsewhere" })).toContainText("Locked by Gaku");
    await expect(page.locator(".screen-card-wrap").filter({ hasText: "Locked Elsewhere" }).getByRole("button", { name: "Rename Project", exact: true })).toBeDisabled();
    await expect(projectNameInput(page)).toBeEnabled();
    await expect(createProjectButton(page)).toBeEnabled();

    const createdName = `Create-Without-Edit-${Date.now()}`;
    await projectNameInput(page).fill(createdName);
    await createProjectButton(page).click();

    await expect.poll(() => createRequestCount).toBe(1);
    expect(createOnly).toBe(true);
    expect(requireLockHeader).toBe("");
    expect(scopedProjectId).toBeTruthy();
    expect(lockAcquireCount).toBe(0);
    expect(mockState.projects.some((project) => project.name === createdName)).toBe(true);
    await expect(page.getByRole("tab", { name: /Room Type|Rooms/ }).first()).toBeVisible({ timeout: 10000 });
  });

  test("new project does not create a Default room type", async ({ page }) => {
    await createProject(page, `Protected-${Date.now()}`);
    await page.getByRole("tab", { name: /Room Type|Rooms/ }).first().click();

    await expect(page.locator("button.screen-card").filter({ hasText: /^Default$/i })).toHaveCount(0);
  });

  test("PDU stays first visually while new room types open on Circuit", async ({ page }) => {
    await createProject(page, `Protected-PDU-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    const subTabList = page
      .getByRole("tablist")
      .filter({ has: page.getByRole("tab", { name: "PDU" }) })
      .first();
    const labels = (await subTabList.getByRole("tab").allTextContents()).map((label) => label.trim());

    expect(labels.indexOf("PDU")).toBe(0);
    expect(labels.indexOf("PDU")).toBeLessThan(labels.indexOf("CFS"));
    await expect(subTabList.getByRole("tab", { name: "Circuit" })).toHaveAttribute("aria-selected", "true");
  });

  test("active project and CFS sub tab survive a reload", async ({ page }) => {
    const projectName = `Protected-Reload-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeInspectionPercentProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await expect(page.getByRole("tab", { name: "CFS", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(1600);

    await page.reload({ waitUntil: "load" });
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("tab", { name: "CFS", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("CFS toolbar uses the compact visual menu order", async ({ page }) => {
    await createProject(page, `Protected-CfsToolbar-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const visualLabels = await page.locator(".cfs-matrix-controls .cfs-filter-menu-trigger").evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            text: button.textContent?.trim() ?? "",
            top: Math.round(rect.top),
            left: Math.round(rect.left),
          };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .map((button) => button.text),
    );

    // "Rows" was added ahead of the visual menus by the CFS revision
    // workflows update (row-level revision filter) and is part of the
    // approved compact order.
    expect(visualLabels).toEqual(["Rows", "Base", "Function", "Device", "Area", "Display", "Programming Name", "Highlights"]);

    await page.locator(".cfs-matrix-controls .cfs-filter-menu-trigger").filter({ hasText: /^Base$/ }).click();
    const basePanel = page.locator(".cfs-filter-list-portal").last();
    const detailCheckbox = basePanel
      .locator(".cfs-base-column-row")
      .filter({ hasText: "Detail" })
      .locator('input[type="checkbox"]')
      .first();
    await detailCheckbox.uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cfs-hidden-column-label").filter({ hasText: "Base" })).toHaveCount(0);
    await expect(page.locator(".cfs-hidden-column-button").filter({ hasText: "Detail" })).toHaveCount(0);

    await page.getByRole("button", { name: "Devices", exact: true }).click();
    const deviceActionMetrics = await page
      .locator(".cfs-filter-list-portal")
      .last()
      .locator(".cfs-column-actions button")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        }),
      );
    expect(deviceActionMetrics.length).toBe(3);
    expect(new Set(deviceActionMetrics.map((metric) => metric.height)).size).toBe(1);
    expect(Math.max(...deviceActionMetrics.map((metric) => metric.width)) - Math.min(...deviceActionMetrics.map((metric) => metric.width))).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const programmingNameFits = await page
      .locator('.cfs-segmented[aria-label="CFS sort mode"] button')
      .filter({ hasText: "Programming Name" })
      .evaluate((button) => button.scrollWidth <= button.clientWidth + 1);
    expect(programmingNameFits).toBe(true);
  });

  test("Draft status shows only Draft and the widest time without clipping", async ({ page }) => {
    await page.setViewportSize({ width: 1365, height: 760 });
    await createProject(page, `Protected-DraftStatus-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    const statusPill = page.locator(".revision-save-status");
    await expect(statusPill).toBeVisible();
    await statusPill.evaluate((element) => {
      element.innerHTML =
        '<span class="revision-save-status-label">Draft</span><span class="revision-save-status-time">23:59:59</span>';
    });

    await expect(statusPill.locator(".revision-save-status-label")).toHaveText("Draft");
    await expect(statusPill.locator(".revision-save-status-time")).toHaveText("23:59:59");
    const metrics = await statusPill.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
  });

  test("revision update highlights reach CFS base cells, function headers, function values, and changed tabs", async ({ page }) => {
    const projectName = `Protected-RevisionHighlight-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedRevisionHighlightSettings(page);
    await seedProjects([makeRevisionHighlightProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("button", { name: "Turn on update highlights", exact: true }).click();
    for (const label of ["PDU", "Circuit", "Device Assign", "Area Scene", "Scene", "Switch", "Command", "Backlight", "CFS"]) {
      await expect(page.getByRole("tab", { name: label, exact: true })).toHaveClass(/tab-highlighted/);
    }

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const table = page.locator(".cfs-matrix-table");
    await expect(table).toContainText("Revision DL");
    await expect(table.locator("td.cfs-base-dimmingType.revision-changed-cell").filter({ hasText: "PWM" }).first()).toBeVisible();
    await expect(table.locator("td.cfs-base-detail.revision-changed-cell").filter({ hasText: "Revision DL" }).first()).toBeVisible();
    await expect(table.locator("td.cfs-base-detail.revision-changed-cell").filter({ hasText: "Sheer Close" }).first()).toBeVisible();
    await expect(table.locator("th.cfs-condition-head.revision-changed-cell").filter({ hasText: "PMS VAR: Enable" }).first()).toBeVisible();
    await expect(table.locator("th.cfs-condition-head.revision-changed-cell").filter({ hasText: "Hold 4sec." }).first()).toBeVisible();
    await expect(table.locator("td.cfs-function-cell.revision-changed-cell").filter({ hasText: "100%" }).first()).toBeVisible();

    for (const tabName of ["PDU", "Circuit", "Device Assign", "Area Scene", "Scene", "Switch", "Command", "Backlight"]) {
      await page.getByRole("tab", { name: tabName, exact: true }).click();
      if (tabName === "Switch") {
        await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
      }
      await expect(page.locator(".revision-changed-cell").first()).toBeVisible();
    }
  });

  test("Switch priority function is single-choice and highlights only the selected CFS trigger", async ({ page }) => {
    const projectName = `Protected-Priority-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makePriorityFunctionProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "Switch", exact: true }).click();
    await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
    const priorityChecks = page.locator(".switch-priority-check input");
    await expect(priorityChecks).toHaveCount(2);
    await expect(priorityChecks.nth(0)).toBeEnabled();
    await expect(priorityChecks.nth(1)).toBeEnabled();

    await priorityChecks.nth(0).check();
    await expect(priorityChecks.nth(0)).toBeChecked();
    await expect(priorityChecks.nth(1)).not.toBeChecked();

    await priorityChecks.nth(1).check();
    await expect(priorityChecks.nth(0)).not.toBeChecked();
    await expect(priorityChecks.nth(1)).toBeChecked();

    await priorityChecks.nth(1).uncheck();
    await expect(priorityChecks.nth(0)).not.toBeChecked();
    await expect(priorityChecks.nth(1)).not.toBeChecked();

    await priorityChecks.nth(1).check();
    await expect(priorityChecks.nth(0)).not.toBeChecked();
    await expect(priorityChecks.nth(1)).toBeChecked();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const highlightedTriggerCells = page.locator(".cfs-matrix-table thead th.cfs-priority-trigger-cell");
    await expect(highlightedTriggerCells).toHaveCount(1);
    await expect(highlightedTriggerCells.first()).toContainText("Press");
    await expect(page.locator(".cfs-filter-menu-trigger").filter({ hasText: "Highlights" })).toBeVisible();
    await page.locator(".cfs-filter-menu-trigger").filter({ hasText: "Highlights" }).click();
    await expect(page.locator(".cfs-filter-list-portal").last()).not.toContainText("Priority");
  });

  test("InspectionMode percent editor exposes 0 and 100 percent presets above step controls", async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    const projectName = `Protected-InspectionPercent-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeInspectionPercentProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await expect(page.locator(".cfs-matrix-table")).toContainText("Inspection DL");
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();

    await page.locator(".cfs-matrix-scroll").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const editableCell = page.locator('button[aria-label^="Edit Inspection value"]').first();
    await expect(editableCell).toBeVisible();
    await editableCell.click();
    const popover = page.locator(".cfs-inspection-popover");
    if (!(await popover.isVisible().catch(() => false))) {
      await editableCell.click();
    }
    await expect(popover).toBeVisible();

    const presetTop = await popover.locator(".cfs-inspection-percent-preset-grid").evaluate((element) =>
      element.getBoundingClientRect().top,
    );
    const stepTop = await popover.locator(".cfs-inspection-step-grid").evaluate((element) =>
      element.getBoundingClientRect().top,
    );
    expect(presetTop).toBeLessThan(stepTop);

    await popover.getByRole("button", { name: "100%", exact: true }).click();
    await expect(popover.locator(".cfs-inspection-popover-input")).toHaveValue("100");
    await popover.getByRole("button", { name: "0%", exact: true }).click();
    await expect(popover.locator(".cfs-inspection-popover-input")).toHaveValue("0");
  });

  test("InspectionMode edits can use the top Undo and Redo commands", async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    const projectName = `Protected-InspectionUndo-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeInspectionPercentProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();

    await page.locator(".cfs-matrix-scroll").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const editableCell = page.locator('button[aria-label^="Edit Inspection value"]').first();
    await expect(editableCell).toBeVisible();
    await editableCell.scrollIntoViewIfNeeded();
    await editableCell.click();
    const popover = page.locator(".cfs-inspection-popover");
    if (!(await popover.isVisible().catch(() => false))) {
      await editableCell.click();
    }
    await expect(popover).toBeVisible();
    await popover.locator(".cfs-inspection-popover-input").fill("37");
    await popover.getByRole("button", { name: "OK", exact: true }).click();

    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    await expect(page.locator(".cfs-inspection-draft-count")).toContainText("1 draft");
    await expect(editableCell).toContainText("37%");
    await expect(undo).toBeEnabled();

    await undo.click();
    await expect(page.locator(".cfs-inspection-draft-count")).toContainText("0 draft");
    await expect(editableCell).not.toContainText("37%");
    await expect(redo).toBeEnabled();

    await redo.click();
    await expect(page.locator(".cfs-inspection-draft-count")).toContainText("1 draft");
    await expect(editableCell).toContainText("37%");
  });

  test("InspectionMode revision finish saves every selected edited room type through the project API", async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1800, height: 900 });
    const projectName = `Protected-InspectionMulti-${Date.now()}`;
    const firstRoomName = `Room-A-${Date.now()}`;
    const secondRoomName = `Room-B-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeInspectionMultiRoomProject(projectName, [firstRoomName, secondRoomName])]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: firstRoomName }).first().click();
    await page.getByRole("tab", { name: "CFS", exact: true }).click();

    async function setFirstInspectionValue(value: string): Promise<void> {
      await page.locator(".cfs-matrix-scroll").evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      const popover = page.locator(".cfs-inspection-popover");
      const input = popover.locator(".cfs-inspection-popover-input");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const editableCell = page.locator('button[aria-label^="Edit Inspection value"]').first();
        try {
          await expect(editableCell).toBeVisible({ timeout: 5000 });
          await editableCell.scrollIntoViewIfNeeded();
          await editableCell.click();
          if (!(await popover.isVisible().catch(() => false))) {
            await editableCell.click();
          }
          await expect(input).toBeVisible({ timeout: 5000 });
          await input.fill(value, { timeout: 5000 });
          const okButton = popover.getByRole("button", { name: "OK", exact: true });
          await expect(okButton).toBeEnabled({ timeout: 5000 });
          await okButton.click({ force: true });
          await expect(editableCell).toContainText(`${value}%`, { timeout: 5000 });
          return;
        } catch (error) {
          if (attempt === 4) throw error;
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(100);
        }
      }
      throw new Error("Inspection popover input did not become editable.");
    }

    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
    await setFirstInspectionValue("37");

    await page.getByRole("tab", { name: secondRoomName, exact: true }).click();
    await expect(page.locator(".cfs-matrix-table")).toContainText(`${secondRoomName} DL`);
    await setFirstInspectionValue("63");

    await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
    const finishDialog = page.getByRole("dialog", { name: "Finish InspectionMode", exact: true });
    await expect(finishDialog).toBeVisible();
    await expect(finishDialog).toContainText(firstRoomName);
    await expect(finishDialog).toContainText(secondRoomName);
    await expect(finishDialog.locator('input[type="checkbox"]:checked')).toHaveCount(2);

    await finishDialog.getByRole("button", { name: "Save New Revision & Finish", exact: true }).click();

    await expect.poll(() => {
      const savedProject = mockState.projects.find((project) => project.name === projectName) as Record<string, unknown> | undefined;
      const roomTypes = Array.isArray(savedProject?.roomTypes) ? savedProject.roomTypes as Record<string, unknown>[] : [];
      return roomTypes.map((roomType) => Array.isArray(roomType.revisions) ? roomType.revisions.length : 0).join(",");
    }).toBe("1,1");
  });

  test("Circuit copy duplicates a group with new visible identifiers", async ({ page }) => {
    await createProject(page, `Protected-CircuitCopy-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("button", { name: /Add Row/ }).click();
    const firstRow = page.locator("tbody tr").first();
    await firstRow.locator(".device-cell textarea").first().fill("2");
    await firstRow.locator("textarea").nth(1).fill("2");

    await firstRow.getByRole("button", { name: "Copy Circuit" }).click();

    const designerInputs = page.locator("tbody .device-cell textarea");
    await expect(designerInputs).toHaveCount(2);
    await expect(designerInputs.nth(0)).toHaveValue("2");
    await expect(designerInputs.nth(1)).toHaveValue("2 Copy");

    const copiedRow = page.locator("tbody tr").nth(1);
    await expect(copiedRow.locator("textarea").nth(1)).toHaveValue("");
  });

  test("Device Assign detail is locked while Circuit#/Input is blank", async ({ page }) => {
    await createProject(page, `Protected-DetailLock-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    await page.locator(".btn-add-row").filter({ hasText: /Add Device/ }).first().click();
    await page.locator("button").filter({ hasText: /QSE-IO/ }).first().click();

    const firstDetail = page.locator("tbody textarea").first();
    await expect(firstDetail).toBeVisible({ timeout: 10000 });
    await expect(firstDetail).toBeDisabled();
  });

  test("Dry Contact entries feed QSE-IO CCO assignment and CFS rows", async ({ page }) => {
    await createProject(page, `Protected-DryContact-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await page.getByRole("tab", { name: "Dry Contact", exact: true }).click();
    await page.getByRole("button", { name: /Add Row/ }).click();
    const dryContactRow = page.locator("tbody tr").first();
    await dryContactRow.locator("select").selectOption({ label: "Bedroom" });
    await dryContactRow.locator("input.combobox-input").first().fill("Window Motor");
    await dryContactRow.locator("textarea").first().fill("Left Curtain");

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    await page.locator(".btn-add-row").filter({ hasText: /Add Device/ }).first().click();
    await page.locator("button").filter({ hasText: /QSE-IO/ }).first().click();

    const ccoRow = page.locator("tbody tr").filter({ hasText: "CCO1" }).first();
    await expect(ccoRow).toBeVisible({ timeout: 10000 });
    await ccoRow.locator("input.combobox-input").first().fill("Window Motor");
    await expect(ccoRow.locator("textarea").first()).toHaveValue("Left Curtain");

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).toContainText("CCO1");
    await expect(cfsTable).toContainText("Bedroom");
    await expect(cfsTable).toContainText("Window Motor");
    await expect(cfsTable).toContainText("Left Curtain");

    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await page.getByRole("tab", { name: "Dry Contact", exact: true }).click();
    await dryContactRow.locator("textarea").first().fill("Right Curtain");

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    await expect(ccoRow.locator("textarea").first()).toHaveValue("Right Curtain");

    await ccoRow.locator("input.combobox-input").first().fill("Custom CCO");
    await expect(ccoRow.locator("textarea").first()).toHaveValue("");

    const ccoRow2 = page.locator("tbody tr").filter({ hasText: "CCO2" }).first();
    await ccoRow2.locator("input.combobox-input").first().fill("Custom CCO");
    await expect(page.getByText(/used in multiple rows/)).toHaveCount(0);

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await expect(cfsTable).toContainText("Custom CCO");
    await expect(cfsTable).not.toContainText("Right Curtain");
  });

  test("Dry Contact rows can be reordered with the drag column", async ({ page }) => {
    await createProject(page, `Protected-DryContactDrag-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await page.getByRole("tab", { name: "Dry Contact", exact: true }).click();
    for (const value of ["Relay A", "Relay B", "Relay C"]) {
      await page.getByRole("button", { name: /Add Row/ }).click();
      const row = page.locator("tbody tr").last();
      await row.locator("select").selectOption({ label: "Bedroom" });
      await row.locator("input.combobox-input").first().fill(value);
    }

    const rows = page.locator("tbody tr");
    await expect(rows.first().locator(".drag-handle")).toHaveText("::");
    await rows.nth(2).locator(".drag-handle").dragTo(rows.nth(0));
    await expect.poll(async () =>
      rows.evaluateAll((rowEls) =>
        rowEls.map((row) => (row.querySelector("input.combobox-input") as HTMLInputElement | null)?.value ?? ""),
      ),
    ).toEqual(["Relay C", "Relay A", "Relay B"]);
    await expect(rows.nth(0).locator("td").nth(1)).toHaveText("1");
    await expect(rows.nth(1).locator("td").nth(1)).toHaveText("2");
    await expect(rows.nth(2).locator("td").nth(1)).toHaveText("3");
  });

  test("Area Scene add button is in the scene toolbar and row checkboxes support drag selection", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const projectName = `Protected-AreaSceneDrag-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeAreaSceneDragProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "Area Scene", exact: true }).click();
    const toolbarButtons = await page.locator(".scene-toolbar-actions button").evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") || button.textContent?.trim() || ""),
    );
    expect(toolbarButtons.indexOf("Add Scene")).toBeLessThan(toolbarButtons.indexOf("Copy Scene"));
    await expect(page.locator(".scene-add-row")).toHaveCount(0);

    await page.getByRole("button", { name: "Add Scene", exact: true }).click();
    const rowChecks = page.locator('.scene-table tbody input[type="checkbox"].scene-check');
    await expect(rowChecks).toHaveCount(3);

    const firstBox = await rowChecks.nth(0).boundingBox();
    const lastBox = await rowChecks.nth(2).boundingBox();
    if (!firstBox || !lastBox) throw new Error("Scene checkbox bounds were not available.");
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () =>
      rowChecks.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).checked)),
    ).toEqual([true, true, true]);

    await rowChecks.first().uncheck();
    await rowChecks.nth(1).uncheck();
    await rowChecks.nth(2).uncheck();
    const firstLevel = page.locator(".scene-table tbody .scene-level-input").first();
    const levelBox = await firstLevel.boundingBox();
    if (!levelBox) throw new Error("Scene level input bounds were not available.");
    await page.mouse.move(levelBox.x + levelBox.width / 2, levelBox.y + levelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(levelBox.x + levelBox.width / 2 + 120, levelBox.y + levelBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () =>
      rowChecks.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).checked)),
    ).toEqual([false, false, false]);
  });

  test("Backlight default scenes can be deleted before Palladiom is registered", async ({ page }) => {
    const projectName = `Protected-BacklightNoPalladiom-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomName);

    await page.getByRole("tab", { name: "Backlight", exact: true }).click();
    const backlightTable = page.locator(".matrix-table").filter({ hasText: "Backlight Scene" }).first();
    await expect(backlightTable).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Palladiom switches are not registered.")).toBeVisible();
    const sceneNames = () =>
      backlightTable.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) => {
          const tableRow = row as HTMLTableRowElement;
          const input = tableRow.cells[2]?.querySelector("textarea, input") as HTMLInputElement | HTMLTextAreaElement | null;
          return input?.value.trim() || tableRow.cells[2]?.textContent?.trim() || "";
        }),
      );

    await expect.poll(sceneNames).toEqual(["Base", "Bright", "Relax", "Mood", "Sleep"]);
    const deleteButtons = backlightTable.getByRole("button", { name: "Delete Backlight Scene", exact: true });
    await expect(deleteButtons.first()).toBeEnabled();
    await deleteButtons.first().click();
    await expect.poll(sceneNames).toEqual(["Bright", "Relax", "Mood", "Sleep"]);

    await saveCurrentProjectTopButton(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });
    const persistedProject = mockState.projects.find((project) => String(project.name ?? "") === projectName) as
      | { roomTypes?: Array<{ name?: string; backlightLevels?: Array<{ name: string }> }> }
      | undefined;
    const persistedRoom = persistedProject?.roomTypes?.find((roomType) => roomType.name === roomName);
    expect(persistedRoom?.backlightLevels?.map((level) => level.name)).toEqual(["Bright", "Relax", "Mood", "Sleep"]);

    await page.getByRole("tab", { name: "Switch", exact: true }).click();
    await page.locator(".btn-add-row").filter({ hasText: /Add Row/ }).first().click();
    await page.getByRole("tab", { name: "Backlight", exact: true }).click();
    await expect.poll(sceneNames).toEqual(["Bright", "Relax", "Mood", "Sleep"]);
  });

  test("Switch opens Palladiom by default and Backlight defaults are five deletable scenes", async ({ page }) => {
    await createProject(page, `Protected-BacklightDefaults-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "Switch", exact: true }).click();
    const palladiomTab = page.getByRole("tab", { name: "Palladiom", exact: true });
    await expect(palladiomTab).toHaveAttribute("aria-selected", "true");
    await page.locator(".btn-add-row").filter({ hasText: /Add Row/ }).first().click();

    await page.getByRole("tab", { name: "Backlight", exact: true }).click();
    const backlightTable = page.locator(".matrix-table").filter({ hasText: "Backlight Scene" }).first();
    await expect(backlightTable).toBeVisible({ timeout: 10000 });
    const sceneNames = () =>
      backlightTable.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) => {
          const tableRow = row as HTMLTableRowElement;
          const input = tableRow.cells[2]?.querySelector("textarea, input") as HTMLInputElement | HTMLTextAreaElement | null;
          return input?.value.trim() || tableRow.cells[2]?.textContent?.trim() || "";
        }),
      );

    await expect.poll(sceneNames).toEqual(["Base", "Bright", "Relax", "Mood", "Sleep"]);
    const deleteButtons = backlightTable.getByRole("button", { name: "Delete Backlight Scene", exact: true });
    await expect(deleteButtons.first()).toBeEnabled();
    await deleteButtons.first().click();
    await expect.poll(sceneNames).toEqual(["Bright", "Relax", "Mood", "Sleep"]);
  });

  test("Switch tab keeps the selected switch type when switching room types", async ({ page }) => {
    const projectName = `Protected-SwitchRoomKind-${Date.now()}`;
    const roomA = `Room-A-${Date.now()}`;
    const roomB = `Room-B-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomA);
    await createRoomType(page, roomB);

    await page.getByRole("tab", { name: roomA, exact: true }).click();
    await page.getByRole("tab", { name: "Switch", exact: true }).click();
    await page.getByRole("tab", { name: "Pico", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Pico", exact: true })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: roomB, exact: true }).click();
    await expect(page.getByRole("tab", { name: "Pico", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("Legacy Backlight Light condition is migrated away from CFS display", async ({ page }) => {
    const projectName = `Protected-BacklightLegacy-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeBacklightLegacyProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    await page.getByRole("tab", { name: "Lutron Curtain", exact: true }).click();
    const curtainAssignTable = page.locator("table.curtain-assign-table").first();
    await expect(curtainAssignTable.getByRole("columnheader", { name: "Action", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("columnheader", { name: "Detail", exact: true })).toBeVisible();
    await expect(curtainAssignTable.locator("select.cell-input").first()).toBeEnabled();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).not.toContainText("Light");
    await expect(cfsTable).toContainText("Bright");
  });

  test("Deleting a Backlight scene clears Room Scene and all switch references", async ({ page }) => {
    const projectName = `Protected-BacklightCascade-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeBacklightDeleteCascadeProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).toContainText("Custom Night");

    await page.getByRole("tab", { name: "Backlight", exact: true }).click();
    const backlightTable = page.locator(".matrix-table").filter({ hasText: "Backlight Scene" }).first();
    await expect(backlightTable).toBeVisible({ timeout: 10000 });
    const customIndex = await backlightTable.locator("tbody tr").evaluateAll((rows) =>
      rows.findIndex((row) => {
        const cell = (row as HTMLTableRowElement).cells[2];
        const input = cell?.querySelector("textarea, input") as HTMLInputElement | HTMLTextAreaElement | null;
        return input?.value.trim() === "Custom Night";
      }),
    );
    expect(customIndex).toBeGreaterThanOrEqual(0);
    await backlightTable.getByRole("button", { name: "Delete Backlight Scene", exact: true }).nth(customIndex).click();
    await expect.poll(async () =>
      backlightTable.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) => {
          const cell = (row as HTMLTableRowElement).cells[2];
          const input = cell?.querySelector("textarea, input") as HTMLInputElement | HTMLTextAreaElement | null;
          return input?.value.trim() || "";
        }),
      ),
    ).not.toContain("Custom Night");

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await expect(cfsTable).not.toContainText("Custom Night");

    await saveCurrentProjectTopButton(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });
    const persistedText = JSON.stringify(mockState.projects);
    expect(persistedText).not.toContain("custom-night");
    expect(persistedText).not.toContain("Custom Night");
  });

  test("Curtain assignments appear in CFS and the CFS row menu controls order and visibility", async ({ page }) => {
    const projectName = `Protected-CurtainCfs-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeCurtainCfsProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    await page.getByRole("tab", { name: "Lutron Curtain", exact: true }).click();
    const curtainAssignTable = page.locator("table.curtain-assign-table").first();
    await expect(curtainAssignTable.getByRole("columnheader", { name: "Action", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(curtainAssignTable.getByRole("columnheader", { name: "Detail", exact: true })).toBeVisible();
    await expect(curtainAssignTable.locator("select.cell-input").first()).toBeEnabled();
    await expect(curtainAssignTable.getByLabel("Lutron Curtain Detail").first()).toHaveValue("Blackout");

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).toContainText("QSN-4P20-D");
    await expect(cfsTable).toContainText("QSE-IO");
    await expect(cfsTable).toContainText("Lutron Curtain");
    await expect(cfsTable).toContainText("Blackout");
    await expect(cfsTable).toContainText("Close");
    await expect(cfsTable).toContainText("HVAC");
    await expect(cfsTable).toContainText("Backlight Logic");

    const visibleRows = await cfsTable.locator("tbody tr").evaluateAll((rows) =>
      rows.map((row) => row.textContent || ""),
    );
    const rowIndex = (needle: string) => visibleRows.findIndex((row) => row.includes(needle));
    expect(rowIndex("QSN-4P20-D")).toBeLessThan(rowIndex("QSE-IO"));
    expect(rowIndex("QSE-IO")).toBeLessThan(rowIndex("Lutron Curtain"));
    expect(rowIndex("Lutron Curtain")).toBeLessThan(rowIndex("HVAC"));
    expect(rowIndex("HVAC")).toBeLessThan(rowIndex("Backlight Logic"));

    await page.getByRole("button", { name: "Rows", exact: true }).click();
    const rowsPanel = page.locator(".cfs-filter-list-portal").filter({ hasText: "Curtain" }).last();
    await expect(rowsPanel.locator(".cfs-base-column-label")).toHaveText([
      "Lighting",
      "CCO",
      "Curtain",
      "HVAC",
      "Backlight",
    ]);

    const curtainOption = rowsPanel.locator(".cfs-base-column-row").filter({ hasText: "Curtain" }).first();
    await curtainOption.locator('input[type="checkbox"]').uncheck();
    await expect(cfsTable).not.toContainText("Lutron Curtain");
    await rowsPanel.getByRole("button", { name: "Show all", exact: true }).click();
    await expect(cfsTable).toContainText("Lutron Curtain");
  });

  test("Lutron Curtain detail is editable and feeds CFS", async ({ page }) => {
    const projectName = `Protected-CurtainDetail-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeCurtainCfsProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    await page.getByRole("tab", { name: "Lutron Curtain", exact: true }).click();
    const curtainAssignTable = page.locator("table.curtain-assign-table").first();
    const detailInput = curtainAssignTable.getByLabel("Lutron Curtain Detail").first();
    await expect(detailInput).toBeVisible({ timeout: 10000 });
    await expect(detailInput).toHaveValue("Blackout");
    await detailInput.fill("Sheer");

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).toContainText("Lutron Curtain");
    await expect(cfsTable).toContainText("Sheer");
    await expect(cfsTable).not.toContainText("Blackout");

    await saveCurrentProjectTopButton(page).click();
    await expect(page.locator(".revision-save-status-label")).toHaveText("Saved", { timeout: 10000 });
    await expect.poll(() => {
      const savedProject = mockState.projects.find((project) => String(project.name ?? "") === projectName) as
        | { roomTypes?: Array<{ name?: string; curtainAssignments?: Array<{ detail?: string }> }> }
        | undefined;
      const savedRoomType = savedProject?.roomTypes?.find((roomType) => roomType.name === roomName);
      return savedRoomType?.curtainAssignments?.[0]?.detail ?? "";
    }).toBe("Sheer");
  });

  test("Corridor Pico CFS rows use the device model, switch number zone, and Other programming fallback", async ({ page }) => {
    const projectName = `Protected-CorridorPicoCfs-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await seedProjects([makeCorridorPicoCfsProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).toContainText("CorridorPico");
    await expect(cfsTable).toContainText("SW-0");
    await expect(cfsTable).toContainText("MUR LED");
    await expect(cfsTable).toContainText("DND LED");
    await expect(cfsTable).toContainText("[99][CP1-SW0] MUR LED");
    await expect(cfsTable).toContainText("[99][CP1-SW0] DND LED");
    await expect(cfsTable).toContainText("Corridor Pico Area Scene");

    const mergedCells = await cfsTable.locator("tbody td").evaluateAll((cells) =>
      cells.map((cell) => ({
        text: (cell.textContent || "").replace(/\s+/g, " ").trim(),
        rowSpan: cell.getAttribute("rowspan") || "1",
      })),
    );
    expect(mergedCells).toContainEqual({ text: "CorridorPico", rowSpan: "2" });
    expect(mergedCells).toContainEqual({ text: "1", rowSpan: "2" });
    expect(mergedCells).toContainEqual({ text: "SW-0", rowSpan: "2" });
    expect(mergedCells.map((cell) => cell.text)).not.toContain("Entrance");
    const rowTexts = await cfsTable.locator("tbody tr").evaluateAll((rows) =>
      rows.map((row) => (row.textContent || "").replace(/\s+/g, " ").trim()),
    );
    expect(rowTexts.find((text) => text.includes("MUR LED"))).toContain("On");
    expect(rowTexts.find((text) => text.includes("DND LED"))).toContain("Off");
  });

  test("Device Assign, HVAC, and Curtain controls are disabled in view-only mode", async ({ page }) => {
    const projectName = `Protected-ViewOnlyDevice-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await forceViewOnlyCollaboration(page);
    await seedProjects([makeCurtainCfsProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();
    await expect(page.locator("main.project-screen-shell.is-view-only")).toBeVisible({ timeout: 10000 });

    await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
    const deviceTable = page.locator("table.device-assign-table").first();
    await expect(deviceTable.locator("select.cell-input").first()).toBeDisabled();
    await expect(deviceTable.getByRole("button", { name: /Delete Device|Delete Assignment/ }).first()).toBeDisabled();
    await expect(deviceTable.getByRole("button", { name: /Add Device/ }).first()).toBeDisabled();

    await page.getByRole("tab", { name: "HVAC", exact: true }).click();
    await expect(page.locator('label.checkbox-label input[type="checkbox"]').first()).toBeDisabled();
    await expect(page.locator("table.master-table").first().locator("select.cell-input").first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "+ HVAC Add", exact: true })).toBeDisabled();

    await page.getByRole("tab", { name: "Lutron Curtain", exact: true }).click();
    const curtainTable = page.locator("table.curtain-assign-table").first();
    await expect(curtainTable.locator("select.cell-input").first()).toBeDisabled();
    await expect(curtainTable.getByRole("columnheader", { name: "Action", exact: true })).toHaveCount(0);
    await expect(curtainTable.getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
    await expect(curtainTable.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(curtainTable.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(curtainTable.getByLabel("Lutron Curtain Detail").first()).toBeDisabled();
    await expect(curtainTable.getByRole("button", { name: "Copy Lutron Curtain", exact: true })).toBeDisabled();
    await expect(curtainTable.getByRole("button", { name: "Delete Lutron Curtain", exact: true })).toBeDisabled();
    await expect(curtainTable.getByRole("button", { name: "+ Add Row", exact: true })).toBeDisabled();
  });

  test("CFS Rows menu can change row visibility in view-only mode without saving project data", async ({ page }) => {
    const projectName = `Protected-ViewOnlyRows-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await page.goto("about:blank");
    await forceViewOnlyCollaboration(page);
    await seedProjects([makeCurtainCfsProject(projectName, roomName)]);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    await page.getByRole("tab", { name: "Room Type", exact: true }).click();
    await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();
    await expect(page.locator("main.project-screen-shell.is-view-only")).toBeVisible({ timeout: 10000 });

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    const cfsTable = page.locator(".cfs-matrix-table").first();
    await expect(cfsTable).toContainText("Backlight Logic");
    const persistedProjectBeforeRowsChange = JSON.stringify(mockState.projects.find((project) => project.name === projectName));
    const rowsButton = page.getByRole("button", { name: "Rows", exact: true });
    await expect(rowsButton).toBeEnabled();
    await rowsButton.click();
    const rowsPanel = page.locator(".cfs-filter-list-portal").filter({ hasText: "Backlight" }).last();
    const backlightRow = rowsPanel.locator(".cfs-base-column-row").filter({ hasText: "Backlight" }).first();
    const backlightCheckbox = backlightRow.locator('input[type="checkbox"]');
    await expect(backlightCheckbox).toBeEnabled();
    await expect(backlightRow.getByRole("button", { name: "Move Backlight row up", exact: true })).toBeEnabled();
    await backlightCheckbox.uncheck();
    await expect(cfsTable).not.toContainText("Backlight Logic");
    expect(JSON.stringify(mockState.projects.find((project) => project.name === projectName))).toBe(persistedProjectBeforeRowsChange);
  });

  test("Back to Project List prompts for a draft and can restore the latest revision", async ({ page }) => {
    const projectName = `Protected-DraftBack-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomName);

    await saveRevisionTopButton(page).click();
    const saveDialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(saveDialog).toBeVisible({ timeout: 10000 });
    await saveDialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(saveDialog).toBeHidden({ timeout: 10000 });

    await enableLocalCollaboration(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Start editing/i }).click();
    await addCircuitRowWithDesigner(page, "DRAFT-BACK");
    await expect(page.locator(".revision-save-status-label")).toHaveText("Draft", { timeout: 10000 });

    await page.getByRole("button", { name: "Back to Project List", exact: true }).click();
    const finishDialog = page.getByRole("dialog", { name: "Finish editing with draft changes?" });
    await expect(finishDialog).toBeVisible({ timeout: 10000 });
    await finishDialog.getByRole("button", { name: "Discard Draft & Restore Latest Rev", exact: true }).click();
    await expect(page.getByRole("heading", { name: "CFS Project Selection", exact: true })).toBeVisible({ timeout: 10000 });
    const persistedProjectText = JSON.stringify(mockState.projects.find((candidate) => candidate.name === projectName));
    expect(persistedProjectText).not.toContain("DRAFT-BACK");

    await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
    const roomTypeTab = page.getByRole("tab", { name: roomName, exact: true });
    if (await roomTypeTab.isVisible().catch(() => false)) {
      await roomTypeTab.click();
    } else {
      await page.getByRole("tab", { name: "Room Type", exact: true }).click();
      await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();
    }
    await page.getByRole("tab", { name: "Circuit", exact: true }).click();
    await expect(page.locator(".circuits-table")).not.toContainText("DRAFT-BACK");
  });

  test("Back to Project List detects a draft in another room type", async ({ page }) => {
    const projectName = `Protected-DraftBackMulti-${Date.now()}`;
    const roomA = `Room-A-${Date.now()}`;
    const roomB = `Room-B-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomA);
    await createRoomType(page, roomB);

    await saveRevisionTopButton(page).click();
    const saveDialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(saveDialog).toBeVisible({ timeout: 10000 });
    await saveDialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(saveDialog).toBeHidden({ timeout: 10000 });

    await enableLocalCollaboration(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Start editing/i }).click();
    await page.getByRole("tab", { name: roomA, exact: true }).click();
    await addCircuitRowWithDesigner(page, "DRAFT-OTHER-ROOM");
    await page.getByRole("tab", { name: roomB, exact: true }).click();

    await page.getByRole("button", { name: "Back to Project List", exact: true }).click();
    const finishDialog = page.getByRole("dialog", { name: "Finish editing with draft changes?" });
    await expect(finishDialog).toBeVisible({ timeout: 10000 });
    await finishDialog.getByRole("button", { name: "Discard Draft & Restore Latest Rev", exact: true }).click();
    await expect(page.getByRole("heading", { name: "CFS Project Selection", exact: true })).toBeVisible({ timeout: 10000 });

    const persistedProjectText = JSON.stringify(mockState.projects.find((candidate) => candidate.name === projectName));
    expect(persistedProjectText).not.toContain("DRAFT-OTHER-ROOM");
  });

  test("idle editing auto-saves the draft as a new revision and returns to view mode", async ({ page }) => {
    const projectName = `Protected-IdleAutoSave-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await createProject(page, projectName);
    await createRoomType(page, roomName);

    await saveRevisionTopButton(page).click();
    const saveDialog = page.getByRole("dialog", { name: "Save Revision" });
    await expect(saveDialog).toBeVisible({ timeout: 10000 });
    await saveDialog.getByRole("button", { name: "Save Revision", exact: true }).click();
    await expect(saveDialog).toBeHidden({ timeout: 10000 });

    await enableLocalCollaboration(page, { idleMs: 250 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Start editing/i }).click();
    await addCircuitRowWithDesigner(page, "IDLE-AUTO");
    await expect(page.locator(".revision-save-status-label")).toHaveText("Draft", { timeout: 10000 });

    await expect.poll(async () => {
      const project = mockState.projects.find((candidate) => candidate.name === projectName) as {
        roomTypes?: Array<{ name?: string; revisions?: Array<{ note?: string; snapshot?: unknown }> }>;
      } | undefined;
      const roomType = project?.roomTypes?.find((candidate) => candidate.name === roomName);
      return roomType?.revisions?.length ?? 0;
    }, { timeout: 12000 }).toBe(2);

    const persistedProject = mockState.projects.find((candidate) => candidate.name === projectName) as {
      roomTypes?: Array<{ name?: string; revisions?: Array<{ note?: string; snapshot?: unknown }> }>;
    } | undefined;
    const persistedRoomType = persistedProject?.roomTypes?.find((candidate) => candidate.name === roomName);
    expect(persistedRoomType?.revisions?.at(-1)?.note).toContain("Auto-saved draft after 15 minutes idle.");
    expect(JSON.stringify(persistedRoomType?.revisions?.at(-1)?.snapshot)).toContain("IDLE-AUTO");
    await expect(page.locator("section.collaboration-bar")).toContainText("View Only", { timeout: 12000 });
  });

  test("programming name settings preserve the legacy default and custom separators", () => {
    const values = {
      locationNumber: "16",
      designerNumber: "2",
      area: "BM",
      address: "1",
      device: "A1-ZN1",
    };

    expect(formatProgrammingName(values, "Foyer DL", normalizeProgrammingNameSettings(undefined))).toBe(
      "[16][2][BM][1][A1-ZN1] Foyer DL",
    );
    expect(
      formatProgrammingName(
        values,
        "Foyer DL",
        normalizeProgrammingNameSettings({
          tokens: ["areaAddress", "designerNumber"],
          bracketStyle: "round",
          tokenSeparator: "-",
          detailSeparator: "-",
        }),
      ),
    ).toBe("(BM)-(1)-(2)-Foyer DL");
    expect(
      formatProgrammingName(
        values,
        "Foyer DL",
        normalizeProgrammingNameSettings({
          tokens: [],
          bracketStyle: "square",
          tokenSeparator: "",
          detailSeparator: " ",
        }),
      ),
    ).toBe("Foyer DL");
  });

  test("programming name UI keeps explicit order and an empty token set", async ({ page }) => {
    await createProject(page, `Protected-Programming-${Date.now()}`);
    await createRoomType(page, `Room-${Date.now()}`);

    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await page.getByRole("button", { name: "Programming Name", exact: true }).click();

    const rows = page.locator(".cfs-programming-token-row");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText("Location Number");
    await expect(rows.nth(1)).toContainText("Designer Number");
    await expect(rows.nth(2)).toContainText("Area");
    await expect(rows.nth(3)).toContainText("Address");
    await expect(rows.nth(4)).toContainText("Device");

    await rows.nth(0).getByRole("button", { name: "↓" }).click();
    await expect(rows.nth(0)).toContainText("Designer Number");
    await expect(rows.nth(1)).toContainText("Location Number");
    await expect(rows.nth(0).locator(".cfs-programming-token-position")).toHaveText("1");
    await expect(rows.nth(1).locator(".cfs-programming-token-position")).toHaveText("2");

    const checkboxes = rows.locator('input[type="checkbox"]');
    for (let index = 0; index < 5; index += 1) {
      const checked = rows.locator('input[type="checkbox"]:checked');
      if ((await checked.count()) === 0) break;
      await checked.first().click();
    }

    await expect(checkboxes).toHaveCount(5);
    await expect
      .poll(async () => checkboxes.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).checked)))
      .toEqual([false, false, false, false, false]);
    await expect(page.locator(".cfs-programming-preview strong")).toHaveText("Foyer DL");
  });
});
