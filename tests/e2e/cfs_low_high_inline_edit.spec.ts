/**
 * T-82/T-92: CFS Low End / High End editing alongside InspectionMode.
 *
 * The CFS cells draft locally until the top confirmation bar is confirmed, then
 * save through the same Device Assignment lowEnd/highEnd fields as the Device
 * Assign tab. /api/projects is fully mocked; shared data/projects.json is not
 * mutated by this spec.
 */
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createDefaultLocations, createEmptyRoomScene, createNewRoomType } from "../../app/lib/constants";
import type { DeviceAssignment, RoomType } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

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

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const storage = await page.evaluate(() => ({
    drafts: localStorage.getItem("cfs-project-drafts-v2"),
    projects: localStorage.getItem("cfs-projects-v14"),
  }));
  await writeFile(testInfo.outputPath("mock-project-state.json"), JSON.stringify({ storage, projects: mockState.projects }, null, 2));
});

function makeProject(projectId: string, projectName: string) {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: `${projectId}-area`, name: "Bedroom", number: "1", code: "BR" };
  const makeCircuit = (
    id: string,
    groupId: string,
    designer: string,
    dimmingType: string,
    fixture: string,
    pcs: string,
    detail: string,
  ) => ({
    id,
    circuitGroupId: groupId,
    daliFixtureGroupId: "",
    designerNumber: designer,
    internalNumber: designer,
    dimmingType,
    fixture,
    pcs,
    detail,
    area: bedroom.id,
    ffe: false,
    energySaving: false,
  });
  const makeAssignment = (
    suffix: string,
    zone: string,
    circuitNumber: string,
    extra: Partial<DeviceAssignment> = {},
  ): DeviceAssignment => ({
    id: `${projectId}-assignment-${suffix}`,
    deviceGroupId: `${projectId}-device-group-1`,
    device: "QSN-4P20-D",
    deviceNum: "1",
    zoneAddress: zone,
    circuitNumber,
    detail: "",
    group: "",
    ...extra,
  });
  const roomType = {
    ...createNewRoomType("RT-A"),
    id: `${projectId}-room-a`,
    name: "RT-A",
    updatedAt: now,
    circuitIds: [`${projectId}-circuit-1a`, `${projectId}-circuit-1b`, `${projectId}-circuit-2`],
    rows: [],
    deviceAssignments: [
      makeAssignment("zn1", "Zn1", "1"),
      makeAssignment("zn2", "Zn2", "2"),
      makeAssignment("zn3", "Zn3", "Reserved", { lowEnd: "77" }),
    ],
  };
  return {
    id: projectId,
    name: projectName,
    updatedAt: now,
    locations: [bedroom, ...otherLocations],
    fixtures: [
      { id: `${projectId}-fixture-a`, fixture: "FX-A", fixtureType: "DL", powerMode: "VA", watt: "10", powerFactor: "0.7" },
      { id: `${projectId}-fixture-b`, fixture: "FX-B", fixtureType: "Indirect", powerMode: "W", watt: "7", powerFactor: "0.7" },
    ],
    circuits: [
      makeCircuit(`${projectId}-circuit-1a`, `${projectId}-cg-1`, "1", "PWM", "FX-A", "2", "Load PWM"),
      makeCircuit(`${projectId}-circuit-1b`, `${projectId}-cg-1`, "1", "PWM", "FX-B", "1", "Load PWM"),
      makeCircuit(`${projectId}-circuit-2`, `${projectId}-cg-2`, "2", "On/Off", "FX-A", "1", "Load OnOff"),
    ],
    roomTypes: [roomType],
  };
}

function seedProject(project: ReturnType<typeof makeProject>): void {
  mockState.projects = [project as unknown as Record<string, unknown>];
}

function makeInspectionProject(projectId: string, projectName: string) {
  const project = makeProject(projectId, projectName);
  project.roomTypes[0].roomScenes = [{
    ...createEmptyRoomScene("Check In", "Welcome Scene"),
    id: `${projectId}-welcome`,
    settings: [
      { circuitId: `${projectId}-circuit-1a`, percentage: "20" },
      { circuitId: `${projectId}-circuit-1b`, percentage: "20" },
    ],
  }];
  return project;
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

async function openProjectCfs(page: Page, projectName: string): Promise<void> {
  const backOrCard = page.locator('button:has-text("Back to Project List"), button.screen-card').first();
  await expect(backOrCard).toBeVisible({ timeout: 20_000 });
  const back = page.getByRole("button", { name: /Back to Project List/i }).first();
  if (await back.isVisible().catch(() => false)) {
    await back.click();
  }
  const card = page.locator("button.screen-card").filter({ hasText: projectName }).first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const roomCard = page.locator("button.screen-card").filter({ hasText: "RT-A" }).first();
  if (await roomCard.isVisible({ timeout: 2500 }).catch(() => false)) {
    await roomCard.click();
  } else {
    await page.getByRole("tab", { name: "RT-A", exact: true }).first().click();
  }
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
  const editToggle = page.getByRole("button", { name: "Edit", exact: true });
  await expect(editToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".cfs-low-high-cell-trigger")).toHaveCount(0);
  if (await editToggle.isEnabled()) await editToggle.click();
}

function cfsRow(page: Page, zoneText: string) {
  return page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: zoneText }).first();
}

function deviceAssignRow(page: Page, zoneText: string) {
  return page
    .locator("table.device-assign-table tbody tr")
    .filter({ has: page.locator(".cell-readonly", { hasText: new RegExp(`^${zoneText}$`) }) })
    .first();
}

async function storedAssignment(page: Page, projectId: string, assignmentId: string): Promise<DeviceAssignment | undefined> {
  return (await storedRoomType(page, projectId))?.deviceAssignments.find((assignment) => assignment.id === assignmentId);
}

async function storedRoomType(page: Page, projectId: string): Promise<RoomType | undefined> {
  return page.evaluate(
    ({ projectId, storageKey }) => {
      try {
        const projects = JSON.parse(localStorage.getItem(storageKey) || "[]") as Array<{
          id?: string;
          roomTypes?: RoomType[];
        }>;
        const project = projects.find((candidate) => candidate.id === projectId);
        return project?.roomTypes?.[0];
      } catch {
        return undefined;
      }
    },
    { projectId, storageKey: PROJECT_DRAFT_STORAGE_KEY },
  );
}

async function editEnd(page: Page, field: "Low" | "High", value: string): Promise<void> {
  await cfsRow(page, "Zn1").getByRole("button", { name: new RegExp(`Edit ${field} End`) }).click();
  const popover = page.getByRole("dialog", { name: `Low High End editor ${field} End`, exact: true });
  await popover.getByRole("textbox", { name: `${field} End draft value`, exact: true }).fill(value);
  await popover.getByRole("button", { name: "OK", exact: true }).click();
}

async function startInspection(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "InspectionMode", exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
  await expect(page.locator('[aria-label="Inspection draft controls"]')).toBeVisible();
}

function inspectionCell(page: Page) {
  return cfsRow(page, "Zn1").getByRole("button", { name: /Edit Inspection value.*Welcome Scene/ });
}

async function editInspection(page: Page, value: string): Promise<void> {
  await inspectionCell(page).click();
  const popover = page.locator(".cfs-inspection-popover:not(.cfs-low-high-popover)");
  await expect(popover).toBeVisible();
  await popover.locator(".cfs-inspection-popover-input").fill(value);
  await popover.getByRole("button", { name: "OK", exact: true }).click();
}

async function finishInspection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("dialog", { name: "Finish InspectionMode", exact: true })
    .getByRole("button", { name: "Finish Current Revision", exact: true }).click();
  await expect(page.locator('[aria-label="Inspection draft controls"]')).toHaveCount(0);
}

test("CFS Low/High End cells draft, undo/redo, confirm to Device Assign, and clear to master", async ({ page }) => {
  const projectId = "t82-low-high-inline";
  seedProject(makeProject(projectId, "T82 Low High Inline"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T82 Low High Inline");

  const zn1 = cfsRow(page, "Zn1");
  const lowCell = zn1.locator("td.cfs-base-zoneLowEnd");
  const highCell = zn1.locator("td.cfs-base-zoneHighEnd");
  await expect(lowCell).toHaveText("5");
  await expect(highCell).toHaveText("90");
  await lowCell.getByRole("button", { name: /Edit Low End/i }).click();

  const popover = page.getByRole("dialog", { name: /Low High End editor Low End/i });
  await expect(popover).toBeVisible();
  await expect(popover.locator(".cfs-inspection-popover-input")).toHaveValue("5");
  await popover.getByRole("button", { name: "+10", exact: true }).click();
  await expect(popover.locator(".cfs-inspection-popover-input")).toHaveValue("15");
  await popover.getByRole("button", { name: "OK", exact: true }).click();

  const draftBar = page.locator('[aria-label="Low/High End draft controls"]');
  await expect(draftBar).toContainText("1 draft");
  await expect(lowCell).toContainText("15");
  await expect(lowCell).toHaveClass(/cfs-low-high-draft-cell/);
  await expect(page.getByRole("button", { name: "InspectionMode", exact: true })).toBeEnabled();

  await draftBar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(draftBar).toContainText("0 draft");
  await expect(lowCell).toHaveText("5");
  await expect(draftBar.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();

  await draftBar.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(draftBar).toContainText("1 draft");
  await expect(lowCell).toContainText("15");

  await draftBar.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(draftBar).toHaveCount(0);
  await expect(lowCell).toHaveText("15");
  await expect
    .poll(async () => (await storedAssignment(page, projectId, `${projectId}-assignment-zn1`))?.lowEnd, { timeout: 8000 })
    .toBe("15");

  await page.getByRole("tab", { name: "Device Assign", exact: true }).click();
  await expect(deviceAssignRow(page, "Zn1").locator('input[aria-label="Low End"]')).toHaveValue("15");
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  await lowCell.getByRole("button", { name: /Edit Low End/i }).click();
  const clearPopover = page.getByRole("dialog", { name: /Low High End editor Low End/i });
  await clearPopover.locator(".cfs-inspection-popover-input").fill("");
  await clearPopover.getByRole("button", { name: "OK", exact: true }).click();
  await expect(lowCell).toHaveText("5");
  await expect(draftBar).toContainText("1 draft");
  await draftBar.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect
    .poll(async () => {
      const assignment = await storedAssignment(page, projectId, `${projectId}-assignment-zn1`);
      return assignment ? "lowEnd" in assignment : "missing";
    }, { timeout: 8000 })
    .toBe(false);
  await expect(lowCell).toHaveText("5");

  const zn2 = cfsRow(page, "Zn2");
  await expect(zn2.locator("td.cfs-base-zoneLowEnd")).toHaveText("-");
  await expect(zn2.getByRole("button", { name: /Edit Low End/i })).toHaveCount(0);
  const zn3 = cfsRow(page, "Zn3");
  await expect(zn3.locator("td.cfs-base-zoneLowEnd")).toHaveText("-");
  await expect(zn3.getByRole("button", { name: /Edit Low End/i })).toHaveCount(0);
});

test("CFS Low/High End editing stays disabled in view-only but is available in InspectionMode", async ({ page }) => {
  seedProject(makeProject("t82-readonly", "T82 View Only"));
  await forceViewOnlyCollaboration(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T82 View Only");
  const readonlyLowCell = cfsRow(page, "Zn1").locator("td.cfs-base-zoneLowEnd");
  await expect(readonlyLowCell).toHaveText("5");
  await expect(readonlyLowCell.getByRole("button", { name: /Edit Low End/i })).toHaveCount(0);

  mockState = await installLocalEditingMocks(page);
  seedProject(makeProject("t82-inspection", "T82 Inspection"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T82 Inspection");
  await page.getByRole("button", { name: "InspectionMode", exact: true }).click();
  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
  const inspectionLowCell = cfsRow(page, "Zn1").locator("td.cfs-base-zoneLowEnd");
  await expect(inspectionLowCell).toHaveText("5");
  await expect(inspectionLowCell.getByRole("button", { name: /Edit Low End/i })).toBeVisible();
  await editEnd(page, "Low", "15");
  const draftBar = page.locator('[aria-label="Low/High End draft controls"]');
  await draftBar.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(inspectionLowCell).toHaveText("5");
  await expect(page.locator('[aria-label="Inspection draft controls"]')).toContainText("0 draft");
});

test("CFS Edit OFF retains Low/High drafts and redo history without retaining editing entrances", async ({ page }) => {
  const projectId = "t93-low-high-toggle";
  seedProject(makeProject(projectId, "T93 Low High Toggle"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T93 Low High Toggle");
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  const bar = page.locator('[aria-label="Low/High End draft controls"]');
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await editEnd(page, "Low", "17");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".cfs-low-high-cell-trigger, .cfs-setting-name-button, .cfs-setting-link-select-grid")).toHaveCount(0);
    await expect(cfsRow(page, "Zn1").locator("td.cfs-base-zoneLowEnd")).toHaveText("17");
    await bar.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(bar).toContainText("0 draft");
    await toggle.click();
    await expect(bar.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    await bar.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(bar).toContainText("1 draft");
    await toggle.click();
    await bar.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(bar).toHaveCount(0);
    await expect(cfsRow(page, "Zn1").locator("td.cfs-base-zoneLowEnd")).toHaveText("5");
    await toggle.click();
  }
  await editEnd(page, "High", "81");
  await toggle.click();
  await bar.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(async () => (await storedAssignment(page, projectId, `${projectId}-assignment-zn1`))?.highEnd).toBe("81");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("Inspection and Low/High drafts keep independent histories, selection, marks, and saves", async ({ page }, testInfo) => {
  const projectId = "t92-independent";
  seedProject(makeInspectionProject(projectId, "T92 Independent"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openProjectCfs(page, "T92 Independent");
  await startInspection(page);
  await editInspection(page, "37");
  const sceneCell = inspectionCell(page);
  await expect(sceneCell).toContainText("37%");
  await expect.poll(async () => (await storedRoomType(page, projectId))?.inspectionMarks?.length ?? 0).toBeGreaterThan(0);
  const inspectionBeforeEnds = await storedRoomType(page, projectId);
  const inspectionBar = page.locator('[aria-label="Inspection draft controls"]');
  const inspectionCount = await inspectionBar.locator(".cfs-inspection-draft-count").innerText();

  await editEnd(page, "Low", "15");
  await editEnd(page, "High", "80");
  const draftBar = page.locator('[aria-label="Low/High End draft controls"]');
  const lowCell = cfsRow(page, "Zn1").locator("td.cfs-base-zoneLowEnd");
  const highCell = cfsRow(page, "Zn1").locator("td.cfs-base-zoneHighEnd");
  await expect(draftBar).toContainText("2 draft");
  await expect(inspectionBar.locator(".cfs-inspection-draft-count")).toHaveText(inspectionCount);
  expect((await storedRoomType(page, projectId))?.inspectionMarks).toEqual(inspectionBeforeEnds?.inspectionMarks);
  expect((await storedAssignment(page, projectId, `${projectId}-assignment-zn1`))?.lowEnd).toBeUndefined();

  await draftBar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(highCell).toHaveText("90");
  await expect(sceneCell).toContainText("37%");
  await draftBar.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(highCell).toHaveText("80");

  const inspectionUndo = page.getByRole("button", { name: "Undo", exact: true }).first();
  const inspectionRedo = page.getByRole("button", { name: "Redo", exact: true }).first();
  await inspectionUndo.click();
  await expect(sceneCell).toContainText("20%");
  await expect(lowCell).toHaveText("15");
  await expect(highCell).toHaveText("80");
  await expect.poll(async () => (await storedRoomType(page, projectId))?.inspectionMarks).toEqual([]);
  await inspectionRedo.click();
  await expect(sceneCell).toContainText("37%");
  await expect(draftBar).toContainText("2 draft");
  await expect.poll(async () => (await storedRoomType(page, projectId))?.roomScenes
    .find((scene) => scene.id === `${projectId}-welcome`)?.settings.map((setting) => setting.percentage)).toEqual(["37", "37"]);
  const inspectionAfterRedo = await storedRoomType(page, projectId);

  await inspectionBar.getByRole("button", { name: "Select", exact: true }).click();
  await sceneCell.click();
  await expect(inspectionBar).toContainText("1 selected");
  await editEnd(page, "Low", "16");
  await expect(inspectionBar).toContainText("1 selected");
  await expect(inspectionBar.locator(".cfs-inspection-draft-count")).toHaveText(inspectionCount);
  await inspectionBar.getByRole("button", { name: "Clear", exact: true }).click();

  for (const width of [1800, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    const lowBounds = await draftBar.boundingBox();
    const inspectionBounds = await inspectionBar.boundingBox();
    expect(lowBounds).not.toBeNull();
    expect(inspectionBounds).not.toBeNull();
    expect(lowBounds!.y + lowBounds!.height).toBeLessThanOrEqual(inspectionBounds!.y);
    await page.screenshot({ path: testInfo.outputPath(`independent-draft-bars-${width}.png`) });
  }
  await page.setViewportSize({ width: 1800, height: 900 });
  await draftBar.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(async () => (await storedAssignment(page, projectId, `${projectId}-assignment-zn1`))?.lowEnd).toBe("16");
  expect((await storedAssignment(page, projectId, `${projectId}-assignment-zn1`))?.highEnd).toBe("80");
  await expect(inspectionBar.locator(".cfs-inspection-draft-count")).toHaveText(inspectionCount);
  expect((await storedRoomType(page, projectId))?.inspectionMarks).toEqual(inspectionAfterRedo?.inspectionMarks);
  await expect(inspectionUndo).toBeEnabled();
  await finishInspection(page);
  expect((await storedRoomType(page, projectId))?.roomScenes.find((scene) => scene.id === `${projectId}-welcome`)?.settings)
    .toEqual(inspectionBeforeEnds?.roomScenes.find((scene) => scene.id === `${projectId}-welcome`)?.settings);
  await expect(lowCell).toHaveText("16");
  await expect(highCell).toHaveText("80");
  const inspectionAfterFinish = await storedRoomType(page, projectId);

  await startInspection(page);
  await editInspection(page, "48");
  await editEnd(page, "Low", "17");
  await draftBar.getByRole("button", { name: "Confirm", exact: true }).click();
  await inspectionBar.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(lowCell).toHaveText("17");
  await expect.poll(async () => (await storedRoomType(page, projectId))?.inspectionMarks).toEqual(inspectionAfterFinish?.inspectionMarks);
});

for (const endAction of ["finish", "revert"] as const) {
  test(`Low/High pending edits and redo survive InspectionMode start and ${endAction}`, async ({ page }) => {
    const projectId = `t92-retain-${endAction}`;
    seedProject(makeInspectionProject(projectId, `T92 Retain ${endAction}`));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, `T92 Retain ${endAction}`);
    const draftBar = page.locator('[aria-label="Low/High End draft controls"]');
    const lowCell = cfsRow(page, "Zn1").locator("td.cfs-base-zoneLowEnd");

    for (const redoOnly of [false, true]) {
      await editEnd(page, "Low", "18");
      if (redoOnly) await draftBar.getByRole("button", { name: "Undo", exact: true }).click();
      await startInspection(page);
      await expect(draftBar).toContainText(`${redoOnly ? 0 : 1} draft`);
      await editInspection(page, redoOnly ? "49" : "39");
      if (endAction === "finish") {
        await finishInspection(page);
      } else {
        await page.locator('[aria-label="Inspection draft controls"]').getByRole("button", { name: "Revert", exact: true }).click();
      }
      await expect(draftBar).toContainText(`${redoOnly ? 0 : 1} draft`);
      if (redoOnly) {
        await expect(draftBar.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
        await draftBar.getByRole("button", { name: "Redo", exact: true }).click();
      }
      await expect(lowCell).toHaveText("18");
      expect((await storedAssignment(page, projectId, `${projectId}-assignment-zn1`))?.lowEnd).toBeUndefined();
      await draftBar.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(lowCell).toHaveText("5");
      const expectedValue = endAction === "finish" ? (redoOnly ? "49" : "39") : "20";
      await expect.poll(async () => (await storedRoomType(page, projectId))?.roomScenes
        .find((scene) => scene.id === `${projectId}-welcome`)?.settings.map((setting) => setting.percentage))
        .toEqual([expectedValue, expectedValue]);
    }
  });
}
