/**
 * T-83/T-84/T-93: CFS Edit -> Link / Unlink for switch/command/scene setting columns.
 *
 * /api/projects is fully mocked by installLocalEditingMocks; the shared
 * data/projects.json file must not be mutated by this spec.
 */
import { expect, test, type Page } from "@playwright/test";
import { STORAGE_KEY, createDefaultLocations, createEmptyRoomScene, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { createNewProject } from "../../app/lib/storage";
import type { ProjectData, RoomScene, SwitchEntry } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  mockState = await installLocalEditingMocks(page);
});

test.setTimeout(180_000);

function makeSwitch(
  projectId: string,
  index: number,
  options: Partial<SwitchEntry> = {},
): SwitchEntry {
  return {
    ...createEmptySwitchEntry("lutronPd"),
    id: `${projectId}-sw${index}`,
    switchGroupId: `${projectId}-sw${index}-group`,
    switchNumber: `${index}`,
    switchName: `PD-${index}`,
    buttonCount: "1",
    buttonLabel: "B1",
    buttonFunction: "Scene",
    condition: "Press",
    ...options,
  };
}

function makeProject(projectId: string, projectName: string): ProjectData {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: `${projectId}-area`, name: "Bedroom", number: "1", code: "BR" };
  const circuit = {
    id: `${projectId}-circuit-1`,
    circuitGroupId: `${projectId}-circuit-group-1`,
    daliFixtureGroupId: "",
    designerNumber: "1",
    internalNumber: "1",
    dimmingType: "PWM",
    fixture: "FX-A",
    pcs: "1",
    detail: "Bedside Downlight",
    area: bedroom.id,
    ffe: false,
    energySaving: false,
  };
  const roomType = {
    ...createNewRoomType("RT-A"),
    id: `${projectId}-room-a`,
    name: "RT-A",
    updatedAt: now,
    circuitIds: [circuit.id],
    rows: [],
    deviceAssignments: [
      {
        id: `${projectId}-assignment-zn1`,
        deviceGroupId: `${projectId}-device-group-1`,
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zn1",
        circuitNumber: "1",
        detail: "Bedside Downlight",
        group: "",
      },
    ],
    scenes: [
      {
        id: `${projectId}-scene-welcome`,
        areaId: bedroom.id,
        name: "Welcome",
        settings: [{ circuitId: circuit.id, percentage: "80" }],
      },
      {
        id: `${projectId}-scene-relax`,
        areaId: bedroom.id,
        name: "Relax",
        settings: [{ circuitId: circuit.id, percentage: "35" }],
      },
    ],
    roomScenes: [
      {
        ...createEmptyRoomScene("Check In", "Welcome Scene", "", "Door open"),
        id: `${projectId}-room-scene-welcome`,
        backlightCondition: "base",
        areaSceneSelections: [{ areaId: bedroom.id, sceneId: `${projectId}-scene-welcome` }],
        settings: [{ circuitId: circuit.id, percentage: "65" }],
      },
      {
        ...createEmptyRoomScene("Check Out", "Relax Scene", "", "Card removed"),
        id: `${projectId}-room-scene-relax`,
        backlightCondition: "masterOn",
        areaSceneSelections: [{ areaId: bedroom.id, sceneId: `${projectId}-scene-relax` }],
        settings: [{ circuitId: circuit.id, percentage: "25" }],
      },
    ],
    switches: [
      makeSwitch(projectId, 1, {
        backlightTarget: "wire-only-sw1",
        backlightCondition: "base",
        buttonSetting: { sceneId: "", sceneIds: [`${projectId}-scene-welcome`], circuitSettings: [] },
      }),
      makeSwitch(projectId, 2),
      makeSwitch(projectId, 3, { settingLinkGroupId: `${projectId}-link-b` }),
      makeSwitch(projectId, 4, { settingLinkGroupId: `${projectId}-link-b` }),
      makeSwitch(projectId, 5),
      {
        ...createEmptySwitchEntry("command"),
        id: `${projectId}-command-1`,
        switchGroupId: `${projectId}-command-group-1`,
        switchNumber: "1",
        switchName: "Command Recall",
        buttonCount: "1",
        buttonLabel: "B1",
        buttonFunction: "Scene",
        condition: "Double Tap",
        backlightTarget: "command-wire-target",
        backlightCondition: "command-only",
      },
    ],
  };

  return {
    ...createNewProject(projectName),
    id: projectId,
    name: projectName,
    updatedAt: now,
    locations: [bedroom, ...otherLocations],
    fixtures: [
      { id: `${projectId}-fixture-a`, fixture: "FX-A", fixtureType: "DL", powerMode: "VA", watt: "10", powerFactor: "0.7" },
    ],
    circuits: [circuit],
    roomTypes: [roomType],
  };
}

function seedProject(project: ProjectData): void {
  mockState.projects = [project as unknown as Record<string, unknown>];
}

async function openProjectCfs(page: Page, projectName: string): Promise<void> {
  const backOrCard = page.locator('button:has-text("Back to Project List"), button.screen-card').first();
  await expect(backOrCard).toBeVisible({ timeout: 20_000 });
  const back = page.getByRole("button", { name: /Back to Project List/i }).first();
  if (await back.isVisible().catch(() => false)) {
    await back.click();
  }
  const projectCard = page.locator("button.screen-card").filter({ hasText: projectName }).first();
  await expect(projectCard).toBeVisible({ timeout: 10_000 });
  await projectCard.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const roomCard = page.locator("button.screen-card").filter({ hasText: "RT-A" }).first();
  if (await roomCard.isVisible({ timeout: 2500 }).catch(() => false)) {
    await roomCard.click();
  } else {
    await page.getByRole("tab", { name: "RT-A", exact: true }).first().click();
  }
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
}

async function storedSwitches(page: Page, projectId: string): Promise<SwitchEntry[]> {
  await page.waitForTimeout(500);
  return page.evaluate(({ draftKey, projectId, storageKey }) => {
    for (const key of [draftKey, storageKey]) {
      try {
        const projects = JSON.parse(localStorage.getItem(key) || "[]") as ProjectData[];
        const project = projects.find((candidate) => candidate.id === projectId);
        const switches = project?.roomTypes?.[0]?.switches;
        if (Array.isArray(switches) && switches.length > 0) return switches;
      } catch {
        // Try the next storage key.
      }
    }
    return [];
  }, { draftKey: PROJECT_DRAFT_STORAGE_KEY, projectId, storageKey: STORAGE_KEY });
}

async function storedRoomScenes(page: Page, projectId: string): Promise<RoomScene[]> {
  await page.waitForTimeout(500);
  return page.evaluate(({ draftKey, projectId, storageKey }) => {
    for (const key of [draftKey, storageKey]) {
      try {
        const projects = JSON.parse(localStorage.getItem(key) || "[]") as ProjectData[];
        const project = projects.find((candidate) => candidate.id === projectId);
        const roomScenes = project?.roomTypes?.[0]?.roomScenes;
        if (Array.isArray(roomScenes) && roomScenes.length > 0) return roomScenes;
      } catch {
        // Try the next storage key.
      }
    }
    return [];
  }, { draftKey: PROJECT_DRAFT_STORAGE_KEY, projectId, storageKey: STORAGE_KEY });
}

function selectToolbarButton(page: Page) {
  return page.locator(".cfs-setting-link-select-actions").getByRole("button", { name: "Edit", exact: true });
}

function linkToolbarButton(page: Page) {
  return page.locator(".cfs-setting-link-select-actions").getByRole("button", { name: "Link", exact: true });
}

function unlinkToolbarButton(page: Page) {
  return page.locator(".cfs-setting-link-select-actions").getByRole("button", { name: "Unlink", exact: true });
}

function enabledSettingLinkChecks(page: Page) {
  return page.locator(".cfs-setting-link-select-grid input[type=checkbox]:not(:disabled)");
}

function settingLinkCheck(page: Page, name: RegExp | string) {
  return page.locator(".cfs-setting-link-select-grid").getByRole("checkbox", { name });
}

async function selectSwitchColumns(page: Page, switchNumbers: number[]): Promise<void> {
  for (const switchNumber of switchNumbers) {
    await settingLinkCheck(page, new RegExp(`^Select ${switchNumber} / PD-${switchNumber} /`)).check();
  }
}

async function selectSceneColumns(page: Page, names: RegExp[]): Promise<void> {
  for (const name of names) {
    await settingLinkCheck(page, name).check();
  }
}

async function closeSettingOverlay(page: Page): Promise<void> {
  const overlay = page.locator(".setting-overlay-panel");
  await overlay.getByRole("button", { name: "Close", exact: true }).click();
  await expect(overlay).toHaveCount(0);
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

test("CFS Select links physical switch columns and keeps the Link panel display in sync", async ({ page }, testInfo) => {
  const projectId = "t83-link-create";
  seedProject(makeProject(projectId, "T83 Link Create"));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T83 Link Create");

  await expect(selectToolbarButton(page)).toBeEnabled();
  await selectToolbarButton(page).click();
  await expect(page.locator(".cfs-setting-link-selected-count")).toHaveText("0 selected");

  const allChecks = page.locator(".cfs-setting-link-select-grid input[type=checkbox]");
  await expect(enabledSettingLinkChecks(page)).toHaveCount(10);
  const disabledCount = await allChecks.evaluateAll((els) =>
    els.filter((el) => (el as HTMLInputElement).disabled).length,
  );
  expect(disabledCount).toBe(0);

  await selectSwitchColumns(page, [1, 2]);
  await expect(page.locator(".cfs-setting-link-selected-count")).toHaveText("2 selected");
  await expect(linkToolbarButton(page)).toBeEnabled();
  await expect(unlinkToolbarButton(page)).toBeDisabled();
  await linkToolbarButton(page).click();

  await expect.poll(async () => {
    const switches = await storedSwitches(page, projectId);
    return Boolean(
      switches[0]?.settingLinkGroupId &&
      switches[1]?.settingLinkGroupId === switches[0].settingLinkGroupId &&
      (switches[1].backlightTarget ?? "") === "",
    );
  }).toBe(true);

  const linked = await storedSwitches(page, projectId);
  expect(linked[0].settingLinkGroupId).toBeTruthy();
  expect(linked[1].settingLinkGroupId).toBe(linked[0].settingLinkGroupId);
  expect(linked[1].backlightTarget ?? "").toBe("");
  await expect(page.locator("table.cfs-matrix-table thead .cfs-header-link-label")).toHaveCount(4);

  await page.locator(".cfs-matrix-controls .cfs-filter-menu-trigger").filter({ hasText: /^Link$/ }).click();
  const panel = page.locator(".cfs-filter-list-portal").last();
  await expect(panel).toContainText("Link A");
  await expect(panel).toContainText("PD-1 − B1");
  await expect(panel).toContainText("PD-2 − B1");
  await page.screenshot({ path: testInfo.outputPath("cfs-link-select-created.png"), fullPage: false });
});

test("CFS Select links Switch and Command columns and Command saves propagate through the link", async ({ page }, testInfo) => {
  const projectId = "t84-link-command";
  const switchId = `${projectId}-sw1`;
  const commandId = `${projectId}-command-1`;
  seedProject(makeProject(projectId, "T84 Link Command"));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T84 Link Command");

  await selectToolbarButton(page).click();
  await selectSwitchColumns(page, [1]);
  await settingLinkCheck(page, /^Select Command .*Command Recall/).check();
  await expect(page.locator(".cfs-setting-link-selected-count")).toHaveText("2 selected");
  await linkToolbarButton(page).click();

  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    const source = rows.find((row) => row.id === switchId);
    const command = rows.find((row) => row.id === commandId);
    return Boolean(
      source?.settingLinkGroupId &&
      command?.settingLinkGroupId === source.settingLinkGroupId &&
      command.buttonSetting.sceneIds.join("|") === `${projectId}-scene-welcome` &&
      command.backlightCondition === "base" &&
      command.backlightTarget === "command-wire-target" &&
      command.switchName === "Command Recall" &&
      command.switchNumber === "1" &&
      command.buttonLabel === "B1" &&
      command.condition === "Double Tap",
    );
  }).toBe(true);

  await page.locator(".cfs-matrix-controls .cfs-filter-menu-trigger").filter({ hasText: /^Link$/ }).click();
  const panel = page.locator(".cfs-filter-list-portal").last();
  await expect(panel).toContainText("Link A");
  await expect(panel).toContainText("PD-1 \u2212 B1");
  await expect(panel).toContainText("Command Recall \u2212 B1");
  await expect.poll(async () => page.locator("table.cfs-matrix-table thead .cfs-header-link-label").count())
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Open Command Setting Overlay for Command.*Command Recall/i }).first().click();
  const overlay = page.locator(".setting-overlay-panel");
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await overlay.locator(".switch-scene-table select").first().selectOption(`${projectId}-scene-relax`);
  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    return [
      rows.find((row) => row.id === switchId)?.buttonSetting.sceneIds.join("|") ?? "",
      rows.find((row) => row.id === commandId)?.buttonSetting.sceneIds.join("|") ?? "",
    ];
  }).toEqual([`${projectId}-scene-relax`, `${projectId}-scene-relax`]);

  await overlay.getByRole("button", { name: "Backlight", exact: true }).click();
  await overlay.locator(".switch-backlight-setting-layout select.cell-input").first().selectOption("masterOn");
  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    const source = rows.find((row) => row.id === switchId);
    const command = rows.find((row) => row.id === commandId);
    return {
      commandCondition: command?.backlightCondition ?? "",
      commandTarget: command?.backlightTarget ?? "",
      sourceCondition: source?.backlightCondition ?? "",
      sourceTarget: source?.backlightTarget ?? "",
    };
  }).toEqual({
    commandCondition: "masterOn",
    commandTarget: "command-wire-target",
    sourceCondition: "masterOn",
    sourceTarget: "wire-only-sw1",
  });

  await page.screenshot({ path: testInfo.outputPath("cfs-link-select-command.png"), fullPage: false });
  await closeSettingOverlay(page);

  await page.getByRole("tab", { name: "Command", exact: true }).click();
  await page.getByRole("button", { name: "Copy Command", exact: true }).first().click();
  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    const commands = rows.filter((row) => row.kind === "command");
    const original = commands.find((row) => row.id === commandId);
    const copy = commands.find((row) => row.id !== commandId);
    return Boolean(
      original?.settingLinkGroupId &&
      copy &&
      !copy.settingLinkGroupId &&
      copy.buttonSetting.sceneIds.join("|") === `${projectId}-scene-relax` &&
      copy.backlightCondition === "masterOn",
    );
  }).toBe(true);
});

test("CFS Select links Scene columns and Room Scene saves propagate through the link", async ({ page }, testInfo) => {
  const projectId = "t84-link-scene";
  const welcomeId = `${projectId}-room-scene-welcome`;
  const relaxId = `${projectId}-room-scene-relax`;
  seedProject(makeProject(projectId, "T84 Link Scene"));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T84 Link Scene");

  await selectToolbarButton(page).click();
  await settingLinkCheck(page, /^Select Scene \/ Check In \/ Welcome Scene/).check();
  await expect(page.locator(".cfs-setting-link-select-grid input[type=checkbox]:disabled")).toHaveCount(6);
  await selectSceneColumns(page, [/^Select Scene \/ Check Out \/ Relax Scene/]);
  await expect(page.locator(".cfs-setting-link-selected-count")).toHaveText("2 selected");
  await expect(linkToolbarButton(page)).toBeEnabled();
  await linkToolbarButton(page).click();

  await expect.poll(async () => {
    const roomScenes = await storedRoomScenes(page, projectId);
    const welcome = roomScenes.find((scene) => scene.id === welcomeId);
    const relax = roomScenes.find((scene) => scene.id === relaxId);
    return {
      groupEqual: Boolean(welcome?.settingLinkGroupId && relax?.settingLinkGroupId === welcome.settingLinkGroupId),
      welcomeSelection: welcome?.areaSceneSelections?.[0]?.sceneId ?? "",
      relaxSelection: relax?.areaSceneSelections?.[0]?.sceneId ?? "",
      welcomeSetting: welcome?.settings?.[0]?.percentage ?? "",
      relaxSetting: relax?.settings?.[0]?.percentage ?? "",
      welcomeCondition: welcome?.backlightCondition ?? "",
      relaxCondition: relax?.backlightCondition ?? "",
      relaxIdentity: [relax?.phase, relax?.sceneType, relax?.triggerCondition].join("|"),
    };
  }).toEqual({
    groupEqual: true,
    welcomeSelection: `${projectId}-scene-welcome`,
    relaxSelection: `${projectId}-scene-welcome`,
    welcomeSetting: "65",
    relaxSetting: "65",
    welcomeCondition: "base",
    relaxCondition: "base",
    relaxIdentity: "Check Out|Relax Scene|Card removed",
  });

  await page.locator(".cfs-matrix-controls .cfs-filter-menu-trigger").filter({ hasText: /^Link$/ }).click();
  const panel = page.locator(".cfs-filter-list-portal").last();
  await expect(panel).toContainText("Link A");
  await expect(panel).toContainText("Scene Check In / Door open \u2212 Welcome Scene");
  await expect(panel).toContainText("Scene Check Out / Card removed \u2212 Relax Scene");
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Scene", exact: true }).click();
  const standardSceneTable = page.locator("table.room-scene-table").last();
  const relaxRow = standardSceneTable.locator("tbody tr").filter({ hasText: "Relax Scene" }).first();
  await relaxRow.getByRole("button", { name: "Setting", exact: true }).click();
  const overlay = page.locator(".setting-overlay-panel");
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await overlay.locator(".switch-scene-table select").first().selectOption(`${projectId}-scene-relax`);
  await overlay.locator(".switch-individual-table textarea.scene-level-input").first().fill("42");
  await expect.poll(async () => {
    const roomScenes = await storedRoomScenes(page, projectId);
    const welcome = roomScenes.find((scene) => scene.id === welcomeId);
    const relax = roomScenes.find((scene) => scene.id === relaxId);
    return {
      welcomeSelection: welcome?.areaSceneSelections?.[0]?.sceneId ?? "",
      relaxSelection: relax?.areaSceneSelections?.[0]?.sceneId ?? "",
      welcomeSetting: welcome?.settings?.[0]?.percentage ?? "",
      relaxSetting: relax?.settings?.[0]?.percentage ?? "",
    };
  }).toEqual({
    welcomeSelection: `${projectId}-scene-relax`,
    relaxSelection: `${projectId}-scene-relax`,
    welcomeSetting: "42",
    relaxSetting: "42",
  });

  await overlay.getByRole("button", { name: "Backlight", exact: true }).click();
  await overlay.locator(".switch-backlight-setting-layout select.cell-input").first().selectOption("masterOn");
  await expect.poll(async () => {
    const roomScenes = await storedRoomScenes(page, projectId);
    return roomScenes
      .filter((scene) => scene.id === welcomeId || scene.id === relaxId)
      .map((scene) => scene.backlightCondition);
  }).toEqual(["masterOn", "masterOn"]);
  await page.screenshot({ path: testInfo.outputPath("cfs-link-select-scene.png"), fullPage: false });
  await closeSettingOverlay(page);

  await relaxRow.getByRole("button", { name: "Copy Scene", exact: true }).click();
  await expect.poll(async () => {
    const roomScenes = await storedRoomScenes(page, projectId);
    const copies = roomScenes.filter((scene) => scene.sceneType === "Relax Scene");
    return Boolean(
      copies.length >= 2 &&
      copies.some((scene) => scene.id !== relaxId && !scene.settingLinkGroupId && scene.settings[0]?.percentage === "42"),
    );
  }).toBe(true);
});

test("CFS Link merges existing groups and Unlink removes only selected columns", async ({ page }, testInfo) => {
  const projectId = "t83-link-merge";
  const project = makeProject(projectId, "T83 Link Merge");
  const switches = project.roomTypes[0]?.switches ?? [];
  switches[0].settingLinkGroupId = `${projectId}-link-a`;
  switches[1].settingLinkGroupId = `${projectId}-link-a`;
  seedProject(project);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T83 Link Merge");

  await selectToolbarButton(page).click();
  await selectSwitchColumns(page, [1, 3]);
  await linkToolbarButton(page).click();

  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    const groupIds = rows.slice(0, 5).map((row) => row.settingLinkGroupId ?? "");
    return new Set(groupIds.slice(0, 4)).size === 1 && groupIds[4] === "";
  }).toBe(true);

  const merged = await storedSwitches(page, projectId);
  const mergedGroupId = merged[0].settingLinkGroupId;
  expect(mergedGroupId).toBeTruthy();
  expect(merged.slice(0, 4).map((row) => row.settingLinkGroupId)).toEqual([
    mergedGroupId,
    mergedGroupId,
    mergedGroupId,
    mergedGroupId,
  ]);
  await expect(page.locator("table.cfs-matrix-table thead .cfs-header-link-label")).toHaveCount(4);

  await selectSwitchColumns(page, [1, 2]);
  await unlinkToolbarButton(page).click();
  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    return rows.slice(0, 4).map((row) => row.settingLinkGroupId ?? "");
  }).toEqual(["", "", mergedGroupId, mergedGroupId]);
  await expect(page.locator("table.cfs-matrix-table thead .cfs-header-link-label")).toHaveCount(2);

  await selectSwitchColumns(page, [3]);
  await unlinkToolbarButton(page).click();
  await expect.poll(async () => {
    const rows = await storedSwitches(page, projectId);
    return rows.slice(0, 4).map((row) => row.settingLinkGroupId ?? "");
  }).toEqual(["", "", "", ""]);
  await expect(page.locator("table.cfs-matrix-table thead .cfs-header-link-label")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("cfs-link-select-unlinked.png"), fullPage: false });
});

test("CFS Edit is disabled in view-only and linking stays disabled in InspectionMode", async ({ page }) => {
  const viewProjectId = "t83-readonly";
  seedProject(makeProject(viewProjectId, "T83 Readonly"));
  await forceViewOnlyCollaboration(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T83 Readonly");
  await expect(selectToolbarButton(page)).toBeDisabled();
  await expect(page.locator(".cfs-setting-link-select-grid input[type=checkbox]")).toHaveCount(0);

  mockState = await installLocalEditingMocks(page);
  const inspectProjectId = "t83-inspection";
  seedProject(makeProject(inspectProjectId, "T83 Inspection"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T83 Inspection");
  await expect(selectToolbarButton(page)).toBeEnabled();
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
  await expect(selectToolbarButton(page)).toBeEnabled();
  await selectToolbarButton(page).click();
  const checks = page.locator(".cfs-setting-link-select-grid input[type=checkbox]");
  expect(await checks.count()).toBeGreaterThan(0);
  for (const check of await checks.all()) await expect(check).toBeDisabled();
  await expect(linkToolbarButton(page)).toBeDisabled();
});
