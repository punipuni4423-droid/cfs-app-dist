import { test, expect, type Page } from "@playwright/test";
import { createDefaultLocations, createNewRoomType } from "../../app/lib/constants";
import { canonicalJson, valuesDiffer } from "../../app/lib/canonicalJson";
import { ensureRoomScenes } from "../../app/lib/roomScenes";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

const AREA_ID = "revision-diff-bedroom";

function circuit(id: string, designerNumber: string, detail: string) {
  return {
    id,
    circuitGroupId: `${id}-group`,
    daliFixtureGroupId: "",
    designerNumber,
    internalNumber: designerNumber,
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail,
    area: AREA_ID,
    ffe: false,
    energySaving: false,
  };
}

function snapshot(circuits: unknown[], scenes: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    circuits,
    dryContacts: [],
    rows: [],
    deviceAssignments: [],
    hvacAssignments: [],
    hvacSeasons: [],
    curtainAssignments: [],
    backlightLevels: [],
    scenes,
    roomScenes: [],
    switches: [],
    pduDeviceCounts: [],
    inspectionMarks: [],
    ...extra,
  });
}

/**
 * Room-type level settings (Backlight Logic, CFS row display) are not rows, so
 * they need their own coverage to stay visible in the change list.
 */
function makeRoomLevelSettingsProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: AREA_ID, name: "Bedroom", number: "1", code: "BM" };
  const circuits = [circuit("room-level-circuit-1", "RL-A", "Downlight")];

  const before = {
    backlightLevels: [{ key: "masterOn", name: "masterOn", mode: "Manual", active: "100", inactive: "20" }],
    cfsRowDisplay: { order: ["lighting", "cco", "curtain", "hvac", "backlight"], hidden: [] },
  };
  const after = {
    backlightLevels: [{ key: "masterOn", name: "masterOn", mode: "Manual", active: "80", inactive: "20" }],
    cfsRowDisplay: { order: ["lighting", "cco", "curtain", "hvac", "backlight"], hidden: ["curtain"] },
  };

  const roomType = {
    ...createNewRoomType(roomName),
    id: "room-level-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: circuits.map((row) => row.id),
    rows: [],
    deviceAssignments: [],
    scenes: [],
    revision: "2.01",
    revisions: [
      {
        id: "room-level-rev-1",
        revision: "2.00",
        savedAt: "2026-08-20T01:00:00.000Z",
        savedBy: "Tester",
        snapshot: snapshot(circuits, [], before),
        note: "",
      },
      {
        id: "room-level-rev-2",
        revision: "2.01",
        savedAt: "2026-08-21T01:00:00.000Z",
        savedBy: "Tester",
        snapshot: snapshot(circuits, [], after),
        note: "",
      },
    ],
  };

  return {
    id: "room-level-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits,
    roomTypes: [roomType],
  };
}

function makeKeyOrderOnlyProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: AREA_ID, name: "Bedroom", number: "1", code: "BM" };
  const circuits = [circuit("key-order-circuit-1", "KO-A", "Downlight")];
  const baseRoomType = createNewRoomType(roomName);
  const roomScenes = ensureRoomScenes(baseRoomType.roomScenes);
  const backlightLevels = [{ key: "base", name: "Base", mode: "Manual", active: "100", inactive: "20" }];
  const cfsRowDisplay = { order: ["lighting", "cco", "curtain", "hvac", "backlight"], hidden: [] };
  const normalSnapshot = snapshot(circuits, [], { backlightLevels, cfsRowDisplay, roomScenes });
  const reorderedSnapshot = JSON.stringify({
    switches: [],
    scenes: [],
    roomScenes,
    backlightLevels: [{ key: "base", mode: "Manual", name: "Base", active: "100", inactive: "20" }],
    cfsRowDisplay: { hidden: [], order: ["lighting", "cco", "curtain", "hvac", "backlight"] },
    inspectionMarks: [],
    pduDeviceCounts: [],
    curtainAssignments: [],
    hvacSeasons: [],
    hvacAssignments: [],
    deviceAssignments: [],
    rows: [],
    dryContacts: [],
    circuits,
  });

  const roomType = {
    ...baseRoomType,
    id: "key-order-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: circuits.map((row) => row.id),
    dryContacts: [],
    rows: [],
    deviceAssignments: [],
    hvacAssignments: [],
    hvacSeasons: [],
    curtainAssignments: [],
    backlightLevels,
    cfsRowDisplay,
    scenes: [],
    roomScenes,
    switches: [],
    pduDeviceCounts: [],
    inspectionMarks: [],
    revision: "1.01",
    revisions: [
      {
        id: "key-order-rev-1",
        revision: "1.00",
        savedAt: "2026-08-20T01:00:00.000Z",
        savedBy: "Tester",
        snapshot: normalSnapshot,
        note: "",
      },
      {
        id: "key-order-rev-2",
        revision: "1.01",
        savedAt: "2026-08-21T01:00:00.000Z",
        savedBy: "Tester",
        snapshot: reorderedSnapshot,
        note: "",
      },
    ],
  };

  return {
    id: "key-order-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits,
    roomTypes: [roomType],
  };
}

/**
 * Three revisions so the panel can be checked for: cell-level before/after,
 * tab grouping, a non-adjacent comparison base, and legacy notes that stored
 * the generated change list inside the editable memo.
 */
function makeRevisionDiffProject(name: string, roomName: string) {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const location = { ...bedroom, id: AREA_ID, name: "Bedroom", number: "1", code: "BM" };

  const circuitsV1 = [circuit("revision-diff-circuit-1", "DIFF-A", "Downlight")];
  const circuitsV2 = [circuit("revision-diff-circuit-1", "DIFF-B", "Downlight")];
  const circuitsV3 = [
    circuit("revision-diff-circuit-1", "DIFF-B", "Downlight Renamed"),
    circuit("revision-diff-circuit-2", "DIFF-C", "Cove"),
  ];
  const scenesV1 = [{ id: "revision-diff-scene-1", areaId: AREA_ID, name: "Welcome Scene", settings: [] }];
  const scenesV3 = [{ id: "revision-diff-scene-1", areaId: AREA_ID, name: "Turn Down", settings: [] }];

  const roomType = {
    ...createNewRoomType(roomName),
    id: "revision-diff-room-type",
    name: roomName,
    updatedAt: now,
    circuitIds: circuitsV3.map((row) => row.id),
    rows: [],
    deviceAssignments: [],
    scenes: scenesV3,
    revision: "1.02",
    revisions: [
      {
        id: "revision-diff-rev-1",
        revision: "1.00",
        savedAt: "2026-08-20T01:00:00.000Z",
        savedBy: "Tester",
        snapshot: snapshot(circuitsV1, scenesV1),
        note: "Initial revision snapshot.",
      },
      {
        id: "revision-diff-rev-2",
        revision: "1.01",
        savedAt: "2026-08-21T01:00:00.000Z",
        savedBy: "Tester",
        // Legacy shape: generated change list persisted into the memo field.
        snapshot: snapshot(circuitsV2, scenesV1),
        note: "Circuit tab\tDIFF-A / Downlight: Designer #: DIFF-A -> DIFF-B",
      },
      {
        id: "revision-diff-rev-3",
        revision: "1.02",
        savedAt: "2026-08-22T01:00:00.000Z",
        savedBy: "Tester",
        snapshot: snapshot(circuitsV3, scenesV3),
        // Legacy shape: user memo carrying the old "Note" prefix.
        note: "Note\tChecked with the lighting designer",
      },
    ],
  };

  return {
    id: "revision-diff-project",
    name,
    updatedAt: now,
    locations: [location, ...otherLocations],
    fixtures: [],
    circuits: circuitsV3,
    roomTypes: [roomType],
  };
}

async function openRevisionManager(
  page: Page,
  projectName: string,
  roomName: string,
  makeProject: (name: string, room: string) => unknown = makeRevisionDiffProject,
): Promise<void> {
  await page.goto("/");
  // Drop any navigation/draft state left by an earlier spec so the project list
  // renders instead of reopening the previously active project.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  mockState.projects = [makeProject(projectName, roomName)] as Record<string, unknown>[];
  await page.reload({ waitUntil: "load" });
  await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();
  await page.getByRole("button", { name: /Open revision management|Revision Management/ }).first().click();
  await expect(page.locator(".revision-manager-panel")).toBeVisible();
}

test.describe("Revision diff panel", () => {
  test("canonical JSON comparisons ignore object key order and keep array order meaningful", () => {
    expect(valuesDiffer({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(false);
    expect(valuesDiffer([1, 2], [2, 1])).toBe(true);
    expect(canonicalJson(undefined)).toBeUndefined();
  });

  test("shows the memo and a cell-level diff grouped by tab", async ({ page }) => {
    const projectName = `RevisionDiff-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await openRevisionManager(page, projectName, roomName);

    // Newest revision first.
    const latestRow = page.locator(".revision-table > tbody > tr").first();
    await expect(latestRow.locator(".revision-metadata-input").first()).toHaveValue("1.02");

    // The legacy "Note" prefix is unwrapped, and the memo stays editable.
    await expect(latestRow.locator(".revision-metadata-note-input")).toHaveValue("Checked with the lighting designer");

    const panel = latestRow.locator(".revision-diff-panel");
    await expect(panel).toBeVisible();

    // Tab-level grouping with per-tab counts.
    const groupLabels = panel.locator(".revision-diff-group-label");
    await expect(groupLabels).toHaveText(["Circuit tab", "Area Scene tab"]);

    const circuitGroup = panel.locator(".revision-diff-group").filter({ hasText: "Circuit tab" });
    const detailRow = circuitGroup.locator("tbody tr").filter({ hasText: "Detail" }).first();
    await expect(detailRow.locator(".revision-diff-before")).toHaveText("Downlight");
    await expect(detailRow.locator(".revision-diff-after")).toHaveText("Downlight Renamed");

    // A newly added circuit is reported as an added row, not a field edit.
    const addedRow = circuitGroup.locator("tbody tr.is-added").first();
    await expect(addedRow.locator(".revision-diff-badge.added")).toHaveText("Added");
    await expect(addedRow.locator(".revision-diff-target-cell")).toContainText("DIFF-C");
    await expect(addedRow.locator(".revision-diff-rowchange")).toHaveText("Row added in this revision");

    // Scene rename lands in its own tab group as a single cell change.
    const sceneGroup = panel.locator(".revision-diff-group").filter({ hasText: "Area Scene tab" });
    const sceneRow = sceneGroup.locator("tbody tr").first();
    await expect(sceneRow.locator(".revision-diff-field-cell")).toHaveText("Name");
    await expect(sceneRow.locator(".revision-diff-before")).toHaveText("Welcome Scene");
    await expect(sceneRow.locator(".revision-diff-after")).toHaveText("Turn Down");
  });

  test("filters by change type and compares against any earlier revision", async ({ page }) => {
    const projectName = `RevisionDiffFilter-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await openRevisionManager(page, projectName, roomName);

    const panel = page.locator(".revision-table > tbody > tr").first().locator(".revision-diff-panel");

    await panel.getByRole("button", { name: "Added", exact: true }).click();
    await expect(panel.locator("tbody tr")).toHaveCount(1);
    await expect(panel.locator("tbody tr.is-added")).toHaveCount(1);

    await panel.getByRole("button", { name: "Removed", exact: true }).click();
    await expect(panel.locator(".revision-diff-empty")).toHaveText("No changes match this filter.");

    await panel.getByRole("button", { name: "All", exact: true }).click();
    await expect(panel.locator(".revision-diff-group")).toHaveCount(2);

    // 1.02 vs 1.01 (default) reports only the second edit; 1.02 vs 1.00 also
    // reports the Designer # change that happened in 1.01.
    const baseSelect = panel.locator(".revision-diff-select");
    await expect(baseSelect.locator("option")).toHaveText(["1.01 (previous)", "1.00"]);
    await expect(panel.locator("tbody tr").filter({ hasText: "Designer #" })).toHaveCount(0);

    await baseSelect.selectOption({ label: "1.00" });
    const designerRow = panel.locator("tbody tr").filter({ hasText: "Designer #" }).first();
    await expect(designerRow.locator(".revision-diff-before")).toHaveText("DIFF-A");
    await expect(designerRow.locator(".revision-diff-after")).toHaveText("DIFF-B");
  });

  test("hides legacy generated memos from the editable memo field", async ({ page }) => {
    const projectName = `RevisionDiffLegacy-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await openRevisionManager(page, projectName, roomName);

    const rows = page.locator(".revision-table > tbody > tr");
    const middleRow = rows.nth(1);
    await expect(middleRow.locator(".revision-metadata-input").first()).toHaveValue("1.01");
    // The generated change list used to fill this textarea as raw tab text.
    await expect(middleRow.locator(".revision-metadata-note-input")).toHaveValue("");
    await expect(middleRow.locator(".revision-diff-panel tbody tr").filter({ hasText: "Designer #" })).toHaveCount(1);

    const oldestRow = rows.nth(2);
    await expect(oldestRow.locator(".revision-metadata-note-input")).toHaveValue("");
    await expect(oldestRow.locator(".revision-diff-empty")).toHaveText("Initial revision snapshot.");
  });

  test("reports room-type level Backlight Logic and CFS row display changes", async ({ page }) => {
    const projectName = `RevisionDiffRoomLevel-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await openRevisionManager(page, projectName, roomName, makeRoomLevelSettingsProject);

    const panel = page.locator(".revision-table > tbody > tr").first().locator(".revision-diff-panel");
    await expect(panel.locator(".revision-diff-group-label")).toHaveText([
      "Backlight tab / Backlight Logic",
      "CFS tab",
    ]);

    const backlightRow = panel.locator("tbody tr").filter({ hasText: "Active" }).first();
    await expect(backlightRow.locator(".revision-diff-target-cell")).toHaveText("masterOn");
    await expect(backlightRow.locator(".revision-diff-before")).toHaveText("100");
    await expect(backlightRow.locator(".revision-diff-after")).toHaveText("80");

    const hiddenRow = panel.locator("tbody tr").filter({ hasText: "Hidden rows" }).first();
    await expect(hiddenRow.locator(".revision-diff-before")).toHaveText("None");
    await expect(hiddenRow.locator(".revision-diff-after")).toHaveText("curtain");
  });

  test("does not report revision changes when only JSON object key order differs", async ({ page }) => {
    const projectName = `RevisionDiffKeyOrder-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await openRevisionManager(page, projectName, roomName, makeKeyOrderOnlyProject);

    const latestRow = page.locator(".revision-table > tbody > tr").first();
    await expect(latestRow.locator(".revision-metadata-input").first()).toHaveValue("1.01");
    await expect(latestRow.locator(".revision-diff-empty")).toHaveText("No data changes from the previous revision.");
    await expect(latestRow.locator(".revision-diff-group")).toHaveCount(0);

    await page.getByRole("button", { name: "Turn on update highlights" }).click();
    await expect(page.locator(".revision-changed-cell")).toHaveCount(0);
  });

  test("jumps to the tab a change belongs to", async ({ page }) => {
    const projectName = `RevisionDiffJump-${Date.now()}`;
    const roomName = `Room-${Date.now()}`;
    await openRevisionManager(page, projectName, roomName);

    const sceneGroup = page
      .locator(".revision-table > tbody > tr")
      .first()
      .locator(".revision-diff-group")
      .filter({ hasText: "Area Scene tab" });
    await sceneGroup.getByRole("button", { name: "Open tab" }).click();

    await expect(page.getByRole("tab", { name: "Area Scene", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".revision-manager-panel")).toHaveCount(0);
  });
});
