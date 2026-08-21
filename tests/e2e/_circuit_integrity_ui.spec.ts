import { expect, test, type Page } from "@playwright/test";
import { STORAGE_KEY, createDefaultLocations, createNewRoomType } from "../../app/lib/constants";
import type { CircuitEntry, ProjectData } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

type PersistedSceneSnapshot = {
  settings?: Array<{ circuitId?: string; percentage?: string }>;
};

type PersistedRoomTypeSnapshot = {
  id?: string;
  circuitIds?: string[];
  scenes?: PersistedSceneSnapshot[];
};

function makeCircuit(overrides: Partial<CircuitEntry>): CircuitEntry {
  return {
    id: "",
    circuitGroupId: "",
    daliFixtureGroupId: "",
    designerNumber: "",
    internalNumber: "",
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail: "",
    area: "",
    ffe: false,
    energySaving: false,
    ...overrides,
  };
}

function makeProject(): ProjectData {
  const now = new Date().toISOString();
  const [bedroom, vanity, ...otherLocations] = createDefaultLocations();
  const locations = [
    { ...bedroom, id: "area-bedroom", name: "Bedroom", number: "1", code: "BD" },
    { ...vanity, id: "area-vanity", name: "Vanity", number: "2", code: "VN" },
    ...otherLocations,
  ];
  const circuits = [
    makeCircuit({
      id: "circuit-a1",
      circuitGroupId: "group-a",
      designerNumber: "TP-01",
      internalNumber: "A",
      fixture: "GR-LL02",
      pcs: "3.2",
      detail: "Bedframe Indirect",
      area: "area-bedroom",
    }),
    makeCircuit({
      id: "circuit-a2",
      circuitGroupId: "group-a",
      designerNumber: "TP-01",
      internalNumber: "B",
      fixture: "GR-LL02",
      pcs: "7.9",
      detail: "Window Indirect",
      area: "area-bedroom",
    }),
    makeCircuit({
      id: "circuit-b1",
      circuitGroupId: "group-b",
      designerNumber: "TP-02",
      internalNumber: "C",
      fixture: "GR-DL01",
      pcs: "1",
      detail: "Bedside Pendant",
      area: "area-bedroom",
    }),
  ];
  const roomType = {
    ...createNewRoomType("T2T"),
    id: "room-type-t2t",
    updatedAt: now,
    circuitIds: circuits.map((circuit) => circuit.id),
    scenes: [
      {
        id: "scene-bright",
        areaId: "area-bedroom",
        name: "Bright",
        settings: [
          { circuitId: "circuit-a1", percentage: "90" },
          { circuitId: "circuit-a2", percentage: "70" },
          { circuitId: "circuit-b1", percentage: "50" },
        ],
      },
    ],
  };
  return {
    id: "project-circuit-integrity-ui",
    name: "Circuit Integrity UI",
    updatedAt: now,
    locations,
    fixtures: [
      { id: "fixture-indirect", fixture: "GR-LL02", fixtureType: "Indirect", powerMode: "VA", watt: "10", powerFactor: "0.7" },
      { id: "fixture-dl", fixture: "GR-DL01", fixtureType: "DL", powerMode: "VA", watt: "12", powerFactor: "0.7" },
    ],
    circuits,
    roomTypes: [roomType],
  };
}

async function openRoomTypeSubTab(page: Page, subTab: string): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await selectRoomTypeSubTab(page, subTab);
}

async function selectRoomTypeSubTab(page: Page, subTab: string): Promise<void> {
  const projectCard = page.locator("button.screen-card").filter({ hasText: "Circuit Integrity UI" }).first();
  const inProject = await page
    .getByRole("button", { name: "Back to Project List" })
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(async () => {
      await projectCard.waitFor({ state: "visible", timeout: 10_000 });
      return false;
    });
  if (!inProject) {
    await projectCard.click();
  }
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.getByRole("tab", { name: "T2T", exact: true }).click();
  await page.getByRole("tab", { name: subTab, exact: true }).click();
}

async function readPersistedRoomType(page: Page): Promise<PersistedRoomTypeSnapshot | null> {
  return page.evaluate(
    ({ storageKey, draftKey }) => {
      function parseProjects(raw: string | null): Array<{
        id?: string;
        roomTypes?: PersistedRoomTypeSnapshot[];
      }> {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw) as unknown;
          return Array.isArray(parsed) ? parsed as Array<{ id?: string; roomTypes?: PersistedRoomTypeSnapshot[] }> : [];
        } catch {
          return [];
        }
      }

      for (const key of [draftKey, storageKey]) {
        const project = parseProjects(window.localStorage.getItem(key))
          .find((candidate) => candidate.id === "project-circuit-integrity-ui");
        const roomType = project?.roomTypes?.find((candidate) => candidate.id === "room-type-t2t");
        if (roomType) return roomType;
      }
      return null;
    },
    { storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY },
  );
}

async function persistedGroupPercentages(page: Page): Promise<string[]> {
  const roomType = await readPersistedRoomType(page);
  const settings = roomType?.scenes?.[0]?.settings ?? [];
  return settings
    .filter((setting) => setting.circuitId === "circuit-a1" || setting.circuitId === "circuit-a2")
    .map((setting) => String(setting.percentage ?? ""))
    .sort();
}

async function persistedCircuitIds(page: Page): Promise<string[]> {
  const roomType = await readPersistedRoomType(page);
  return roomType?.circuitIds ?? [];
}

test.describe("Circuit integrity UI", () => {
  test("Area Scene shows one row per circuit group and saves one shared group value", async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    state.projects = [makeProject() as unknown as Record<string, unknown>];

    await openRoomTypeSubTab(page, "Area Scene");

    const rows = page.locator(".scene-table tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "TP-01" })).toHaveCount(1);

    const firstLevel = rows.filter({ hasText: "TP-01" }).locator(".scene-level-input").first();
    await expect(firstLevel).toHaveValue("90");
    await firstLevel.fill("80");
    await firstLevel.blur();
    await expect(firstLevel).toHaveValue("80");

    await expect.poll(() => persistedGroupPercentages(page), { timeout: 5_000 }).toEqual(["80", "80"]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await selectRoomTypeSubTab(page, "Area Scene");
    const reloadedRows = page.locator(".scene-table tbody tr");
    await expect(reloadedRows).toHaveCount(2);
    await expect(reloadedRows.filter({ hasText: "TP-01" }).locator(".scene-level-input").first()).toHaveValue("80");
  });

  test("Circuit drag handle reorders circuit groups and continuation cells stay under Internal column", async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    state.projects = [makeProject() as unknown as Record<string, unknown>];

    await openRoomTypeSubTab(page, "Circuit");

    const table = page.locator("table.lighting-circuits-table");
    await expect(table).toBeVisible();
    const continuationFirstCellBox = await table.locator("tbody tr").nth(1).locator("td").first().boundingBox();
    const internalHeaderBox = await table.getByRole("columnheader", { name: "Internal #" }).boundingBox();
    if (!continuationFirstCellBox || !internalHeaderBox) throw new Error("Circuit table bounds were unavailable.");
    expect(Math.abs(continuationFirstCellBox.x - internalHeaderBox.x)).toBeLessThan(4);

    const handles = table.locator("tbody .drag-handle");
    await expect(handles).toHaveCount(2);
    const fromBox = await handles.nth(1).boundingBox();
    const targetBox = await table.locator("tbody tr").first().boundingBox();
    if (!fromBox || !targetBox) throw new Error("Circuit drag bounds were unavailable.");
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 2, { steps: 12 });
    await page.mouse.up();

    await expect(table.locator("tbody tr").first()).toContainText("TP-02");
    await expect.poll(() => persistedCircuitIds(page), { timeout: 5_000 }).toEqual([
      "circuit-b1",
      "circuit-a1",
      "circuit-a2",
    ]);
  });
});
