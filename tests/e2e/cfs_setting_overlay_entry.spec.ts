/**
 * T-79/T-93: CFS Edit mode name cells open the existing setting
 * overlays. /api/projects is fully mocked by installLocalEditingMocks; the
 * shared data/projects.json file must not be mutated by this spec.
 */
import { expect, test, type Locator, type Page } from "./support/safe-test";
import { writeFile } from "node:fs/promises";
import { createDefaultLocations, createEmptyHvacAssignment, createEmptyRoomScene, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { createNewProject } from "../../app/lib/storage";
import type { ProjectData, Scene, SwitchEntry } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { readNativeDraftProject } from './support/native-project-drafts';

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  mockState = await installLocalEditingMocks(page);
});

test.setTimeout(180_000);

function makeT79Project(projectId: string, projectName: string): ProjectData {
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
        settings: [{ circuitId: circuit.id, percentage: "100" }],
      },
      {
        id: `${projectId}-scene-relax`,
        areaId: bedroom.id,
        name: "Relax",
        settings: [{ circuitId: circuit.id, percentage: "70" }],
      },
    ],
    switches: [
      {
        ...createEmptySwitchEntry("lutronPd"),
        id: `${projectId}-switch-bedside`,
        switchGroupId: `${projectId}-switch-group-bedside`,
        switchNumber: "SW1",
        switchName: "Bedside",
        buttonCount: "2",
        buttonLabel: "B1",
        buttonFunction: "Scene",
        condition: "Press",
      },
      {
        ...createEmptySwitchEntry("command"),
        id: `${projectId}-command-recall`,
        switchGroupId: `${projectId}-command-group-recall`,
        switchNumber: "SW1",
        switchName: "Command Recall",
        buttonCount: "1",
        buttonLabel: "B1",
        buttonFunction: "Scene",
        condition: "Press",
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

function makeT80Project(projectId: string, projectName: string): ProjectData {
  const project = makeT79Project(projectId, projectName);
  const roomType = project.roomTypes[0];
  if (roomType) {
    roomType.roomScenes = [
      {
        ...createEmptyRoomScene("Check In", "Welcome Scene", "", "Door open"),
        id: `${projectId}-room-scene-welcome`,
        areaSceneSelections: [{ areaId: `${projectId}-area`, sceneId: `${projectId}-scene-welcome` }],
        settings: [],
      },
    ];
  }
  return project;
}

function seedProject(project: ProjectData): void {
  mockState.projects = [project as unknown as Record<string, unknown>];
}

async function storedSwitch(page: Page, projectId: string, switchId: string): Promise<SwitchEntry | undefined> {
  return (await readNativeDraftProject(page, projectId))?.roomTypes?.[0]?.switches?.find(sw => sw.id === switchId);
}

async function storedScene(page: Page, projectId: string, sceneId: string): Promise<Scene | undefined> {
  return (await readNativeDraftProject(page, projectId))?.roomTypes?.[0]?.scenes?.find(scene => scene.id === sceneId);
}

async function openProjectCfs(page: Page, projectName: string, activateEdit = true): Promise<void> {
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
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".cfs-setting-edit-button, .cfs-setting-name-button, .cfs-low-high-cell-trigger, .cfs-setting-link-select-grid")).toHaveCount(0);
  if (activateEdit && await toggle.isEnabled()) await toggle.click();
  await page.getByRole("button", { name: "Base Columns", exact: true }).click();
  const base = page.locator(".cfs-filter-list-portal");
  await base.getByRole("button", { name: "Hide all", exact: true }).click();
  await page.keyboard.press("Escape");
}

async function checkNameEntry(entry: Locator): Promise<void> {
  await expect(entry).toHaveClass("cfs-setting-name-button");
  await expect(entry.locator("svg")).toHaveCount(0);
  await entry.hover();
  await expect(entry).toHaveCSS("text-decoration-line", "underline");
  await expect(entry).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

async function closeOverlay(page: Page): Promise<void> {
  await page.locator(".setting-overlay-actions button").filter({ hasText: /^Close$/ }).click();
  await expect(page.locator(".setting-overlay-panel")).toBeHidden({ timeout: 5000 });
}

async function forceViewOnlyCollaboration(page: Page): Promise<void> {
  await page.context().unroute("**/api/collaboration/status**").catch(() => undefined);
  await page.context().route("**/api/collaboration/status**", async (route) => {
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

for (const kind of ["Switch", "Command"] as const) {
  test(`T99 ${kind} Edit override stays yellow while revision highlighting is active`, async ({ page }, testInfo) => {
    const projectId = `t99-${kind.toLowerCase()}`;
    const project = makeT80Project(projectId, `T99 ${kind} Override`);
    const room = project.roomTypes[0]!;
    const switchId = `${projectId}-${kind === "Switch" ? "switch-bedside" : "command-recall"}`;
    const target = room.switches.find((sw) => sw.id === switchId)!;
    target.buttonSetting.sceneIds = [`${projectId}-scene-welcome`];
    room.revisions = [{ id: `${projectId}-revision`, revision: "1.00", savedAt: project.updatedAt, savedBy: "Tester", note: "", snapshot: JSON.stringify({ ...room, circuits: project.circuits }) }];
    seedProject(project);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, project.name);
    await page.getByRole("button", { name: "Turn on update highlights", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`Open ${kind} Setting Overlay for`) }).first().click();
    const overlay = page.locator(".setting-overlay-panel");
    const areaToggle = overlay.locator(".switch-area-toggle").filter({ hasText: "Bedroom" });
    if (await areaToggle.getAttribute("aria-expanded") !== "true") await areaToggle.click();
    await overlay.locator(".switch-individual-table .scene-level-input").first().fill("55");
    await expect.poll(async () => (await storedSwitch(page, projectId, switchId))?.buttonSetting.circuitSettings[0]?.percentage).toBe("55");
    await closeOverlay(page);
    const cell = page.locator("td.cfs-function-cell").filter({ hasText: /^55%$/ }).first();
    await expect(cell).toHaveClass(/cfs-individual-override-cell/);
    await expect(cell).toHaveClass(/revision-changed-cell/);
    await page.screenshot({ path: testInfo.outputPath("override-after-edit.png"), fullPage: false });
    await writeFile(testInfo.outputPath("override-cell.json"), JSON.stringify(await cell.evaluate((el) => ({
      className: el.className, text: el.textContent, background: getComputedStyle(el).backgroundColor,
    })), null, 2));
    await expect(cell).toHaveCSS("background-color", "rgb(253, 224, 71)");
    await page.getByRole("button", { name: "Turn off update highlights", exact: true }).click();
    await expect(cell).toHaveCSS("background-color", "rgb(253, 224, 71)");
    await page.getByRole("button", { name: "Turn on update highlights", exact: true }).click();
    await page.getByRole("button", { name: "Highlights", exact: true }).click();
    await page.getByRole("checkbox", { name: "Individual Override", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await expect(cell).not.toHaveClass(/cfs-individual-override-cell/);
    await expect(cell).toHaveCSS("background-color", "rgb(255, 243, 176)");
    await page.getByRole("button", { name: "Highlights", exact: true }).click();
    await page.getByRole("checkbox", { name: "Individual Override", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(cell).toHaveCSS("background-color", "rgb(253, 224, 71)");

    await page.getByRole("tab", { name: kind, exact: true }).click();
    await page.locator(".switch-table").getByRole("button", { name: "Setting", exact: true }).first().click();
    const traditionalArea = overlay.locator(".switch-area-toggle").filter({ hasText: "Bedroom" });
    if (await traditionalArea.getAttribute("aria-expanded") !== "true") await traditionalArea.click();
    await overlay.locator(".switch-individual-table .scene-level-input").first().fill("35");
    await closeOverlay(page);
    await page.getByRole("tab", { name: "CFS", exact: true }).click();
    await expect(page.locator("td.cfs-function-cell").filter({ hasText: /^35%$/ }).first()).toHaveCSS("background-color", "rgb(253, 224, 71)");
    await page.screenshot({ path: testInfo.outputPath("override-after-traditional-tab.png"), fullPage: false });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    for (const value of ["0", "100", "", "45"]) {
      await page.getByRole("button", { name: new RegExp(`Open ${kind} Setting Overlay for`) }).first().click();
      if (await areaToggle.getAttribute("aria-expanded") !== "true") await areaToggle.click();
      await overlay.locator(".switch-individual-table .scene-level-input").first().fill(value);
      await expect.poll(async () => (await storedSwitch(page, projectId, switchId))?.buttonSetting.circuitSettings[0]?.percentage ?? "").toBe(value);
      await closeOverlay(page);
      const overrides = page.locator("td.cfs-individual-override-cell");
      await expect(overrides).toHaveCount(value === "0" || value === "45" ? 1 : 0);
      if (value === "0" || value === "45") await expect(overrides).toHaveCSS("background-color", "rgb(253, 224, 71)");
    }
    await expect.poll(async () => (await storedScene(page, projectId, `${projectId}-scene-welcome`))?.settings[0]?.percentage).toBe("100");
  });
}

test("T99 Room Scene individual override keeps its color after Area Scene overlay editing", async ({ page }, testInfo) => {
  const projectId = "t99-room-scene";
  const project = makeT80Project(projectId, "T99 Room Scene Override");
  const room = project.roomTypes[0]!;
  room.revisions = [{ id: `${projectId}-revision`, revision: "1.00", savedAt: project.updatedAt, savedBy: "Tester", note: "", snapshot: JSON.stringify({ ...room, circuits: project.circuits }) }];
  seedProject(project);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, project.name);
  await page.getByRole("button", { name: "Turn on update highlights", exact: true }).click();
  await page.getByRole("tab", { name: "Scene", exact: true }).click();
  await page.locator(".room-scene-table tr").filter({ has: page.locator("textarea").filter({ hasText: "Welcome Scene" }) }).getByRole("button", { name: "Setting", exact: true }).first().click();
  const overlay = page.locator(".setting-overlay-panel");
  const areaToggle = overlay.locator(".switch-area-toggle").filter({ hasText: "Bedroom" });
  if (await areaToggle.getAttribute("aria-expanded") !== "true") await areaToggle.click();
  await overlay.locator(".switch-individual-table .scene-level-input").first().fill("55");
  await closeOverlay(page);
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Open Area Scene Setting Overlay for Scene.*Welcome Scene/i }).first().click();
  await overlay.locator(".scene-table tbody .scene-level-input").first().fill("70");
  await closeOverlay(page);
  const cell = page.locator("td.cfs-function-cell").filter({ hasText: /^55%$/ }).first();
  await expect(cell).toHaveClass(/cfs-individual-override-cell/);
  await expect(cell).toHaveClass(/revision-changed-cell/);
  await expect.poll(async () => (await storedScene(page, projectId, `${projectId}-scene-welcome`))?.settings[0]?.percentage).toBe("70");
  await page.screenshot({ path: testInfo.outputPath("room-scene-override-after-edit.png"), fullPage: false });
  await expect(cell).toHaveCSS("background-color", "rgb(253, 224, 71)");
});

test("T99 linked overrides stay highlighted in CFS and both Excel scopes", async ({ page }, testInfo) => {
  const projectId = "t99-linked-export";
  const project = makeT80Project(projectId, "T99 Linked Export");
  const room = project.roomTypes[0]!;
  for (const sw of room.switches) {
    sw.buttonSetting.sceneIds = [`${projectId}-scene-welcome`];
    sw.settingLinkGroupId = `${projectId}-link`;
  }
  room.revisions = [{ id: `${projectId}-revision`, revision: "1.00", savedAt: project.updatedAt, savedBy: "Tester", note: "", snapshot: JSON.stringify({ ...room, circuits: project.circuits }) }];
  room.roomScenes[0]!.settings = [{ circuitId: `${projectId}-circuit-1`, percentage: "55" }];
  seedProject(project);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, project.name);
  await page.getByRole("button", { name: "Turn on update highlights", exact: true }).click();
  await page.getByRole("button", { name: /Open Switch Setting Overlay for/ }).first().click();
  const overlay = page.locator(".setting-overlay-panel");
  await overlay.locator(".switch-area-toggle").filter({ hasText: "Bedroom" }).click();
  await overlay.locator(".switch-individual-table .scene-level-input").first().fill("55");
  await closeOverlay(page);
  for (const sw of room.switches) {
    await expect.poll(async () => (await storedSwitch(page, projectId, sw.id))?.buttonSetting.circuitSettings[0]?.percentage).toBe("55");
  }
  const cells = page.locator("td.cfs-individual-override-cell.revision-changed-cell");
  await expect(cells).toHaveCount(3);
  for (const cell of await cells.all()) await expect(cell).toHaveCSS("background-color", "rgb(253, 224, 71)");
  await page.screenshot({ path: testInfo.outputPath("linked-overrides.png"), fullPage: false });
  const ExcelJS = (await import("exceljs")).default;
  for (const scope of ["This Room Type", "All Rooms"]) {
    await page.getByRole("button", { name: "Excel Export", exact: true }).click();
    const pending = page.waitForEvent("download");
    await page.getByRole("menu", { name: "Excel export scope" }).getByRole("menuitem", { name: scope, exact: true }).click();
    const download = await pending;
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const fills: unknown[] = [];
    workbook.worksheets[0]!.eachRow((row) => row.eachCell((cell) => {
      if (cell.text === "55%" && (!cell.isMerged || cell.master.address === cell.address)) fills.push(cell.fill);
    }));
    expect(fills, scope).toHaveLength(3);
    // T-111: the approved export highlight now matches the on-screen yellow.
    for (const fill of fills) expect(fill, scope).toEqual({ type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE047" } });
  }
});

test("Switch column Edit opens the reused overlay and saves Function/Backlight via the existing path", async ({ page }, testInfo) => {
  const projectId = "t79-switch-entry";
  const switchId = `${projectId}-switch-bedside`;
  const sceneId = `${projectId}-scene-relax`;
  seedProject(makeT79Project(projectId, "T79 Switch Overlay"));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T79 Switch Overlay");

  const editButton = page.getByRole("button", { name: /Open Switch Setting Overlay for SW1.*Bedside/i }).first();
  await checkNameEntry(editButton);
  await expect(editButton).toBeEnabled();
  await editButton.click();

  const overlay = page.locator(".setting-overlay-panel");
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay).toContainText("Bedside");
  await expect(overlay.getByRole("button", { name: "Scene Value", exact: true })).toHaveClass(/is-active/);
  await expect(overlay.getByRole("button", { name: "Backlight", exact: true })).toBeVisible();

  await overlay.locator(".switch-scene-table select").first().selectOption(sceneId);
  await expect.poll(async () => (await storedSwitch(page, projectId, switchId))?.buttonSetting.sceneIds.join("|") ?? "").toBe(sceneId);

  await overlay.getByRole("button", { name: "Backlight", exact: true }).click();
  await expect(overlay).toContainText("Target");
  await expect(overlay).toContainText("Condition");
  await overlay.locator(".switch-backlight-setting-layout select.cell-input").first().selectOption("base");
  await expect.poll(async () => (await storedSwitch(page, projectId, switchId))?.backlightCondition ?? "").toBe("base");
  await page.screenshot({ path: testInfo.outputPath("switch-overlay-from-cfs.png"), fullPage: false });

  await closeOverlay(page);
  await expect(page.locator("table.cfs-matrix-table")).toContainText("Relax");
});

test("Command column Edit opens the reused command overlay and saves Scene Value via the existing path", async ({ page }, testInfo) => {
  const projectId = "t79-command-entry";
  const commandId = `${projectId}-command-recall`;
  const sceneId = `${projectId}-scene-welcome`;
  seedProject(makeT79Project(projectId, "T79 Command Overlay"));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T79 Command Overlay");

  const editButton = page.getByRole("button", { name: /Open Command Setting Overlay for Command.*Command Recall/i }).first();
  await checkNameEntry(editButton);
  await expect(editButton).toBeEnabled();
  await editButton.click();

  const overlay = page.locator(".setting-overlay-panel");
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay).toContainText("Command Recall");
  await expect(overlay.getByRole("button", { name: "Scene Value", exact: true })).toHaveClass(/is-active/);
  await overlay.locator(".switch-scene-table select").first().selectOption(sceneId);
  await expect.poll(async () => (await storedSwitch(page, projectId, commandId))?.buttonSetting.sceneIds.join("|") ?? "").toBe(sceneId);
  await page.screenshot({ path: testInfo.outputPath("command-overlay-from-cfs.png"), fullPage: false });

  await closeOverlay(page);
  await expect(page.locator("table.cfs-matrix-table")).toContainText("Welcome");
});

test("Area Scene-backed Scene column Edit opens the reused area scene overlay and saves through the existing Scene path", async ({ page }, testInfo) => {
  const projectId = "t80-area-scene-entry";
  const sceneId = `${projectId}-scene-welcome`;
  const circuitId = `${projectId}-circuit-1`;
  seedProject(makeT80Project(projectId, "T80 Area Scene Overlay"));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T80 Area Scene Overlay");

  const editButton = page.getByRole("button", { name: /Open Area Scene Setting Overlay for Scene.*Welcome Scene/i }).first();
  await checkNameEntry(editButton);
  await expect(editButton).toBeEnabled();
  await editButton.click();

  const overlay = page.locator(".setting-overlay-panel");
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay).toContainText("Area Scene Setting / Welcome");
  await expect(overlay.locator(".scene-view-setting-overlay-content")).toBeVisible();
  const bulkPanel = overlay.locator(".scene-bulk-panel");
  await expect(bulkPanel).toBeVisible();

  const levelInput = overlay.locator(".scene-table tbody .scene-level-input").first();
  await expect(levelInput).toHaveValue("100");
  await levelInput.fill("55");
  await expect.poll(async () => {
    const scene = await storedScene(page, projectId, sceneId);
    return scene?.settings.find((setting) => setting.circuitId === circuitId)?.percentage ?? "";
  }).toBe("55");

  const bulkInput = bulkPanel.locator(".scene-bulk-control .scene-level-input").first();
  await bulkInput.fill("65");
  await bulkPanel.getByRole("button", { name: "Apply Bulk", exact: true }).click();
  const confirmOverlay = page.locator(".scene-bulk-confirm-overlay");
  await expect(confirmOverlay).toBeVisible({ timeout: 5000 });
  await expect(confirmOverlay).toContainText("Target: All");
  await expect(confirmOverlay).toContainText("1 targets");
  await expect(confirmOverlay).toContainText("55%");
  await expect(confirmOverlay).toContainText("65%");
  await confirmOverlay.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmOverlay).toHaveCount(0);
  await expect.poll(async () => {
    const scene = await storedScene(page, projectId, sceneId);
    return scene?.settings.find((setting) => setting.circuitId === circuitId)?.percentage ?? "";
  }).toBe("55");

  await bulkPanel.getByRole("button", { name: "Apply Bulk", exact: true }).click();
  await expect(confirmOverlay).toBeVisible({ timeout: 5000 });
  await confirmOverlay.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirmOverlay).toHaveCount(0);
  await expect.poll(async () => {
    const scene = await storedScene(page, projectId, sceneId);
    return scene?.settings.find((setting) => setting.circuitId === circuitId)?.percentage ?? "";
  }).toBe("65");
  await page.screenshot({ path: testInfo.outputPath("area-scene-overlay-from-cfs.png"), fullPage: false });

  await closeOverlay(page);
  await expect(page.locator("table.cfs-matrix-table")).toContainText("65%");
  await page.getByRole("tab", { name: "Area Scene", exact: true }).click();
  await expect(page.locator(".scene-table tbody .scene-level-input").first()).toHaveValue("65");
});

test("CFS setting Edit is disabled in view-only and InspectionMode states", async ({ page }) => {
  const viewProjectId = "t79-readonly-entry";
  seedProject(makeT80Project(viewProjectId, "T79 Readonly Overlay"));
  await forceViewOnlyCollaboration(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T79 Readonly Overlay");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await expect(page.locator(".cfs-setting-name-button, .cfs-setting-icon-button")).toHaveCount(0);
  await expect(page.locator(".setting-overlay-panel")).toHaveCount(0);

  mockState = await installLocalEditingMocks(page);
  const inspectProjectId = "t79-inspection-entry";
  seedProject(makeT80Project(inspectProjectId, "T79 Inspection Overlay"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T79 Inspection Overlay");
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();

  await expect(page.getByRole("button", { name: /Open Area Scene Setting Overlay/i }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: /Open Switch Setting Overlay/i }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: /Open Command Setting Overlay/i }).first()).toBeDisabled();
  for (const kind of ["Area Scene", "Switch", "Command"]) {
    await expect(page.getByRole("button", { name: new RegExp(`Edit ${kind} Setting Overlay`, "i") }).first()).toBeDisabled();
  }
  await expect(page.locator(".setting-overlay-panel")).toHaveCount(0);
});

test("CFS Edit names and link checkboxes stay separate and disappear on OFF", async ({ page }, testInfo) => {
  seedProject(makeT80Project("t93-entrances", "T93 Entrances"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T93 Entrances", false);
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  for (const width of [1800, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await toggle.click();
    const entry = page.getByRole("button", { name: /Open Switch Setting Overlay for SW1.*Bedside/i });
    const check = page.locator(".cfs-setting-link-select-grid").getByRole("checkbox", { name: /Select SW1.*Bedside/ });
    await check.check();
    await expect(page.locator(".setting-overlay-panel")).toHaveCount(0);
    await expect(page.locator(".cfs-setting-link-selected-count")).toHaveText("1 selected");
    await checkNameEntry(entry);
    const boxes = [await entry.boundingBox(), await check.boundingBox()];
    expect(boxes[0]!.y + boxes[0]!.height).toBeLessThanOrEqual(boxes[1]!.y);
    await page.screenshot({ path: testInfo.outputPath(`edit-name-entrances-${width}.png`), fullPage: false });
    await entry.click();
    await expect(page.locator(".setting-overlay-panel")).toBeVisible();
    await closeOverlay(page);
    await expect(check).toBeChecked();
    await expect(page.locator(".cfs-setting-link-selected-count")).toHaveText("1 selected");
    await expect(page.locator(".cfs-setting-edit-button")).toHaveCount(0);
    await toggle.click();
    await expect(page.locator(".cfs-setting-name-button, .cfs-setting-icon-button, .cfs-setting-link-select-grid")).toHaveCount(0);
  }
});

test("CFS merged name menu reaches both independent conditions and cancels without changes", async ({ page }, testInfo) => {
  const projectId = "t93-condition-menu";
  const project = makeT79Project(projectId, "T93 Condition Menu");
  const first = project.roomTypes[0].switches[0];
  first.buttonSetting.sceneId = `${projectId}-scene-welcome`;
  first.buttonSetting.sceneIds = [`${projectId}-scene-welcome`];
  const second: SwitchEntry = {
    ...structuredClone(first), id: `${projectId}-switch-double`, condition: "Double Tap",
    buttonSetting: { ...structuredClone(first.buttonSetting), sceneId: `${projectId}-scene-relax`, sceneIds: [`${projectId}-scene-relax`] },
  };
  project.roomTypes[0].switches.splice(1, 0, second);
  seedProject(project);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T93 Condition Menu");
  const entry = page.getByRole("button", { name: /Open Switch Setting Overlay for SW1.*Bedside/i });
  const menu = page.getByRole("menu", { name: "Choose setting condition", exact: true });
  await expect(entry).toHaveCount(1);
  await expect(entry.locator("..")).toHaveAttribute("colspan", "2");
  await entry.click();
  await expect(menu.getByRole("menuitem", { name: "Press", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(entry).toBeFocused();
  await entry.click();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".setting-overlay-panel")).toHaveCount(0);
  await expect.poll(async () => (await storedSwitch(page, projectId, first.id))?.buttonSetting.sceneIds).toEqual([`${projectId}-scene-welcome`]);
  await expect.poll(async () => (await storedSwitch(page, projectId, second.id))?.buttonSetting.sceneIds).toEqual([`${projectId}-scene-relax`]);
  await entry.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Double Tap", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("merged-setting-condition-menu.png"), fullPage: false });
  await page.keyboard.press("Enter");
  const overlay = page.locator(".setting-overlay-panel");
  await expect(overlay.locator(".switch-scene-table select").first()).toHaveValue(`${projectId}-scene-relax`);
  await overlay.locator(".switch-scene-table select").first().selectOption("");
  await expect.poll(async () => (await storedSwitch(page, projectId, second.id))?.buttonSetting.sceneIds).toEqual([]);
  await expect.poll(async () => (await storedSwitch(page, projectId, first.id))?.buttonSetting.sceneIds).toEqual([`${projectId}-scene-welcome`]);
  await closeOverlay(page);
  await entry.click();
  await menu.getByRole("menuitem", { name: "Press", exact: true }).click();
  await expect(overlay.locator(".switch-scene-table select").first()).toHaveValue(`${projectId}-scene-welcome`);
  await overlay.locator(".switch-scene-table select").first().selectOption(`${projectId}-scene-relax`);
  await expect.poll(async () => (await storedSwitch(page, projectId, first.id))?.buttonSetting.sceneIds).toEqual([`${projectId}-scene-relax`]);
  await expect.poll(async () => (await storedSwitch(page, projectId, second.id))?.buttonSetting.sceneIds).toEqual([]);
});

function makeT98Project(): ProjectData {
  const project = makeT80Project("t98-controls", "T98 Controls");
  const room = project.roomTypes[0];
  const first = room.switches[0];
  first.settingLinkGroupId = "t98-link-a";
  room.switches[1].settingLinkGroupId = "t98-link-a";
  room.switches.splice(1, 0,
    { ...structuredClone(first), id: "t98-double", condition: "Double Tap", settingLinkGroupId: "t98-link-b" },
    { ...structuredClone(first), id: "t98-button-2", buttonLabel: "B2", settingLinkGroupId: "t98-link-b" },
  );
  room.roomScenes[0].settingLinkGroupId = "t98-link-c";
  room.roomScenes.push({ ...structuredClone(room.roomScenes[0]), id: "t98-scene-2", sceneType: "Relax Scene", settingLinkGroupId: "t98-link-c" });
  return project;
}

async function showLowHighBaseColumns(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Base Columns", exact: true }).click();
  const menu = page.locator(".cfs-filter-list-portal");
  for (const name of ["Low End", "High End"]) await menu.getByRole("checkbox", { name: `Show ${name} column`, exact: true }).check();
  await page.keyboard.press("Escape");
}

async function headerControlMetrics(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector<HTMLTableElement>("table.cfs-matrix-table")!;
    const lines = Array.from(table.querySelectorAll<HTMLElement>(".cfs-link-col-line")).map((line) => {
      const cell = line.closest<HTMLTableCellElement>("th,td")!;
      const box = line.getBoundingClientRect();
      const parent = cell.getBoundingClientRect();
      const leftGap = box.left - parent.left;
      const rightGap = parent.right - box.right;
      return { cell: cell.className, row: cell.closest("tr")?.className, colSpan: cell.colSpan, width: box.width, cssWidth: getComputedStyle(line).width,
        leftGap, rightGap, interior: leftGap > 3 && rightGap > 3 };
    });
    const controls = Array.from(table.querySelectorAll<HTMLElement>(".cfs-header-link-label,.cfs-setting-icon-button,.cfs-setting-link-select-cell")).map((element) => {
      const box = element.getBoundingClientRect();
      return { className: element.className, lastRow: element.closest("th")?.classList.contains("cfs-condition-head"), y: box.y, centerY: box.y + box.height / 2 };
    });
    const slots = Array.from(table.querySelectorAll<HTMLElement>(".cfs-header-column-controls")).map((slot) => {
      const box = slot.getBoundingClientRect();
      const children = Array.from(slot.children).map((child) => child.getBoundingClientRect());
      return { centerY: box.y + box.height / 2, overflow: slot.scrollWidth - slot.clientWidth,
        overlaps: children.slice(1).filter((child, index) => children[index].right > child.left + 0.5).length };
    });
    const lowHigh = Array.from(table.querySelectorAll<HTMLButtonElement>(".cfs-low-high-cell-trigger")).map((button) => ({ label: button.getAttribute("aria-label"), icons: button.querySelectorAll("svg").length, overflow: button.scrollWidth - button.clientWidth }));
    return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, lines, controls, slots, lowHigh,
      mergedButtonHeads: table.querySelectorAll(".cfs-button-head[colspan='2']").length,
      mergedFunctionHeads: table.querySelectorAll(".cfs-function-name-head[colspan='2']").length,
      nameCellIcons: table.querySelectorAll(".cfs-function-name-head svg").length };
  });
}

test("T98 header controls align on the last row, link lines avoid merged interiors, and Low/High pencils stay in Edit", async ({ page }, testInfo) => {
  seedProject(makeT98Project());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T98 Controls");
  await showLowHighBaseColumns(page);
  const measurements = [];
  for (const width of [1800, 1100, 720, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const scroll = page.locator(".cfs-matrix-scroll");
    await scroll.scrollIntoViewIfNeeded();
    await scroll.evaluate((element) => { element.scrollLeft = 0; });
    await page.screenshot({ path: testInfo.outputPath(`t98-controls-${width}.png`), fullPage: false });
    measurements.push(await headerControlMetrics(page));
    await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await page.screenshot({ path: testInfo.outputPath(`t98-controls-${width}-scrolled.png`), fullPage: false });
    measurements.push(await headerControlMetrics(page));
  }
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.getByRole("button", { name: "Maximize", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("t98-controls-maximized.png"), fullPage: false });
  measurements.push(await headerControlMetrics(page));
  await page.getByRole("button", { name: "Exit Maximize", exact: true }).click();
  await writeFile(testInfo.outputPath("t98-control-metrics.json"), JSON.stringify(measurements, null, 2));
  for (const metrics of measurements) {
    expect.soft(metrics.mergedButtonHeads).toBeGreaterThan(0);
    expect.soft(metrics.mergedFunctionHeads).toBeGreaterThan(0);
    expect.soft(metrics.lines.length).toBeGreaterThan(0);
    expect.soft(metrics.lines.filter((line) => line.interior)).toEqual([]);
    expect.soft(metrics.lines.filter((line) => Math.abs(line.width - 4) > 0.05)).toEqual([]);
    expect.soft(metrics.controls.length).toBeGreaterThan(0);
    expect.soft(metrics.controls.filter((control) => !control.lastRow)).toEqual([]);
    expect.soft(Math.max(...metrics.controls.map((control) => control.centerY)) - Math.min(...metrics.controls.map((control) => control.centerY))).toBeLessThanOrEqual(1);
    expect.soft(metrics.slots.length).toBeGreaterThan(0);
    expect.soft(Math.max(...metrics.slots.map((slot) => slot.centerY)) - Math.min(...metrics.slots.map((slot) => slot.centerY))).toBeLessThanOrEqual(1);
    expect.soft(metrics.slots.filter((slot) => slot.overflow > 1 || slot.overlaps)).toEqual([]);
    expect.soft(metrics.lowHigh.length).toBeGreaterThan(0);
    expect.soft(metrics.lowHigh.every((cell) => cell.icons === 1 && cell.overflow <= 1)).toBe(true);
    expect.soft(metrics.nameCellIcons).toBe(0);
  }
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cfs-setting-icon-button,.cfs-low-high-cell-trigger,.cfs-setting-link-select-cell")).toHaveCount(0);
  await expect(page.locator(".cfs-condition-head .cfs-header-link-label")).not.toHaveCount(0);
});

test("T98 last-row pencils open each setting independently of link selection and merged-name menus", async ({ page }, testInfo) => {
  const project = makeT80Project("t98-pencil", "T98 Pencil");
  const first = project.roomTypes[0].switches[0];
  first.buttonSetting.sceneId = "t98-pencil-scene-welcome";
  first.buttonSetting.sceneIds = ["t98-pencil-scene-welcome"];
  const second = { ...structuredClone(first), id: "t98-pencil-double", condition: "Double Tap" };
  second.buttonSetting.sceneId = "t98-pencil-scene-relax";
  second.buttonSetting.sceneIds = ["t98-pencil-scene-relax"];
  project.roomTypes[0].switches.splice(1, 0, second);
  seedProject(project);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T98 Pencil");
  const overlay = page.locator(".setting-overlay-panel");
  const targets = [
    { name: /Edit Switch Setting Overlay for SW1.*Bedside.*Press/i, sceneId: first.buttonSetting.sceneId, title: "Bedside" },
    { name: /Edit Switch Setting Overlay for SW1.*Bedside.*Double Tap/i, sceneId: second.buttonSetting.sceneId, title: "Bedside" },
    { name: /Edit Command Setting Overlay for Command.*Command Recall/i, sceneId: "", title: "Command Recall" },
    { name: /Edit Area Scene Setting Overlay for Scene.*Welcome Scene/i, sceneId: null, title: "Area Scene Setting / Welcome" },
  ];
  for (const key of ["Enter", "Space"]) {
    for (const target of targets) {
      const pencil = page.getByRole("button", { name: target.name });
      await expect(pencil).toHaveCount(1);
      await expect(pencil.locator("svg")).toBeVisible();
      expect(await pencil.getAttribute("title")).toBeTruthy();
      const slot = pencil.locator("..");
      const check = slot.getByRole("checkbox");
      await check.check();
      await expect(overlay).toHaveCount(0);
      await pencil.focus();
      await page.keyboard.press(key);
      await expect(overlay).toBeVisible();
      await expect(overlay).toContainText(target.title);
      await expect(page.getByRole("menu", { name: "Choose setting condition", exact: true })).toHaveCount(0);
      if (target.sceneId !== null) {
        await expect(overlay.locator(".switch-scene-table select").first()).toHaveValue(target.sceneId);
      } else {
        await expect(overlay.locator(".scene-table tbody .scene-level-input").first()).toHaveValue("100");
      }
      await closeOverlay(page);
      await expect(check).toBeChecked();
      await check.uncheck();
    }
  }
  await page.screenshot({ path: testInfo.outputPath("t98-pencil-controls.png"), fullPage: false });
  await expect.poll(async () => (await storedSwitch(page, project.id, first.id))?.buttonSetting.sceneIds).toEqual([first.buttonSetting.sceneId]);
  await expect.poll(async () => (await storedSwitch(page, project.id, second.id))?.buttonSetting.sceneIds).toEqual([second.buttonSetting.sceneId]);
});

test("T98 controls retain column widths through hover, linking, label toggles and Edit OFF", async ({ page }, testInfo) => {
  const project = makeT80Project("t98-guide", "CFS Edit Example");
  const first = project.roomTypes[0].switches[0];
  project.roomTypes[0].switches.splice(1, 0, { ...structuredClone(first), id: "t98-guide-double", condition: "Double Tap" });
  seedProject(project);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, project.name);
  await showLowHighBaseColumns(page);
  const widths = () => page.locator(".cfs-condition-head").evaluateAll((heads) => heads.map((head) => head.getBoundingClientRect().width));
  const initialWidths = await widths();
  const captures: { file: string; pins: { x: number; y: number }[] }[] = [];
  const capture = async (file: string, locators: Locator[]) => {
    await page.screenshot({ path: testInfo.outputPath(file), fullPage: false });
    const size = page.viewportSize()!;
    const pins = [];
    for (const locator of locators) {
      const box = (await locator.boundingBox())!;
      expect(box).toBeTruthy();
      pins.push({ x: (box.x + box.width / 2) / size.width * 100, y: (box.y + box.height / 2) / size.height * 100 });
    }
    captures.push({ file, pins });
  };
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  const link = page.locator(".cfs-setting-link-select-actions").getByRole("button", { name: "Link", exact: true });
  const name = page.getByRole("button", { name: /Open Switch Setting Overlay for SW1.*Bedside/i });
  const pencil = page.getByRole("button", { name: /Edit Switch Setting Overlay for SW1.*Bedside.*Press/i });
  const press = pencil.locator("..").getByRole("checkbox");
  const command = page.getByRole("button", { name: /Edit Command Setting Overlay/i }).locator("..").getByRole("checkbox");
  await name.hover();
  expect(await widths()).toEqual(initialWidths);
  await capture("manual-edit.png", [edit, press, name, link]);
  await name.click();
  const menu = page.getByRole("menu", { name: "Choose setting condition", exact: true });
  await expect(menu).toBeVisible();
  await capture("manual-condition-menu.png", [name, menu]);
  await page.keyboard.press("Escape");
  await press.check();
  await command.check();
  await expect(link).toBeEnabled();
  expect(await widths()).toEqual(initialWidths);
  await capture("manual-link-selection.png", [command, press, link]);
  await link.click();
  const pills = page.locator(".cfs-condition-head .cfs-header-link-label");
  await expect(pills).toHaveCount(2);
  expect(await widths()).toEqual(initialWidths);
  await capture("manual-link-created.png", [pills.nth(0), pills.nth(1)]);
  await page.locator(".cfs-matrix-controls .cfs-filter-menu-trigger").filter({ hasText: /^Link$/ }).click();
  const labels = page.locator(".cfs-filter-list-portal .cfs-link-menu-badge-toggle input");
  await labels.uncheck();
  expect(await widths()).toEqual(initialWidths);
  await labels.check();
  await page.keyboard.press("Escape");
  await edit.click();
  expect(await widths()).toEqual(initialWidths);
  await edit.click();
  const low = page.locator(".cfs-low-high-cell-trigger").filter({ has: page.locator("svg") }).first();
  await low.click();
  const popover = page.getByRole("dialog", { name: /Low High End editor Low End/i });
  await popover.locator(".cfs-inspection-popover-input").fill("15");
  await popover.getByRole("button", { name: "OK", exact: true }).click();
  const draft = page.locator('[aria-label="Low/High End draft controls"]');
  await expect(draft).toContainText("1 draft");
  await low.click();
  await capture("manual-low-high.png", [low, popover, draft]);
  await writeFile(testInfo.outputPath("manual-captures.json"), JSON.stringify(captures, null, 2));
});

test("T98 Reserved, HVAC and Backlight rows share the same link line width through filtering", async ({ page }, testInfo) => {
  const project = makeT98Project();
  const room = project.roomTypes[0];
  room.deviceAssignments.push({ ...room.deviceAssignments[0], id: "t98-reserved", zoneAddress: "Zn2", circuitNumber: "", detail: "" });
  room.hvacAssignments = [{ ...createEmptyHvacAssignment(), id: "t98-hvac", area: project.locations[0].id }];
  room.switches[0].backlightTarget = room.switches[0].switchGroupId;
  room.switches[0].backlightCondition = "base";
  seedProject(project);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, project.name);
  for (const kind of ["reserved", "hvac", "backlight"]) {
    await expect(page.locator(`tr.cfs-${kind}-row .cfs-link-col-line`).first()).toBeAttached();
  }
  const measurements = [await headerControlMetrics(page)];
  await page.getByRole("button", { name: "Display", exact: true }).click();
  const reserved = page.locator(".cfs-filter-list-portal").getByRole("checkbox", { name: "Hide Reserved", exact: true });
  await reserved.check();
  await expect(page.locator("tr.cfs-reserved-row")).toHaveCount(0);
  measurements.push(await headerControlMetrics(page));
  await reserved.uncheck();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("t98-all-row-kinds.png"), fullPage: false });
  await writeFile(testInfo.outputPath("t98-all-row-metrics.json"), JSON.stringify(measurements, null, 2));
  for (const metrics of measurements) {
    expect(metrics.lines.length).toBeGreaterThan(30);
    expect(metrics.lines.filter((line) => Math.abs(line.width - 4) > 0.05 || line.interior)).toEqual([]);
  }
});
