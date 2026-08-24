import { expect, test, type Page } from "@playwright/test";
import { createDefaultLocations, createEmptyHvacAssignment, createNewRoomType } from "../../app/lib/constants";
import { HVAC_AREA_ID } from "../../app/lib/areaSceneMatrix";
import type { CircuitEntry, ProjectData } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

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
  const [bedroomBase, vanityBase, entranceBase, ...rest] = createDefaultLocations();
  const locations = [
    { ...entranceBase, id: "area-entrance", name: "Entrance", number: "1", code: "EN" },
    { ...bedroomBase, id: "area-bedroom", name: "Bedroom", number: "2", code: "BD" },
    { ...vanityBase, id: "area-vanity", name: "Vanity", number: "3", code: "VN" },
    ...rest,
  ];
  const circuits = [
    makeCircuit({
      id: "circuit-ent-1",
      circuitGroupId: "group-ent",
      designerNumber: "E-01",
      internalNumber: "INT-E",
      dimmingType: "PWM",
      fixture: "FX-DL",
      detail: "Entrance Downlight",
      area: "area-entrance",
    }),
    makeCircuit({
      id: "circuit-bed-1",
      circuitGroupId: "group-bed",
      designerNumber: "B-01",
      internalNumber: "INT-B1",
      dimmingType: "PWM",
      fixture: "FX-COVE",
      detail: "Bed Cove A",
      area: "area-bedroom",
    }),
    makeCircuit({
      id: "circuit-bed-2",
      circuitGroupId: "group-bed",
      designerNumber: "B-01",
      internalNumber: "INT-B2",
      dimmingType: "PWM",
      fixture: "FX-COVE",
      detail: "Bed Cove B",
      area: "area-bedroom",
    }),
    makeCircuit({
      id: "circuit-vanity-1",
      circuitGroupId: "group-vanity",
      designerNumber: "V-01",
      internalNumber: "INT-V",
      dimmingType: "On/Off",
      fixture: "FX-DL",
      detail: "Vanity Downlight",
      area: "area-vanity",
    }),
  ];
  const hvac = {
    ...createEmptyHvacAssignment(),
    id: "hvac-bedroom",
    area: "area-bedroom",
  };
  const roomType = {
    ...createNewRoomType("RT A"),
    id: "room-type-a",
    updatedAt: now,
    circuitIds: circuits.map((circuit) => circuit.id),
    hvacAssignments: [hvac],
    scenes: [
      {
        id: "scene-ent-welcome",
        areaId: "area-entrance",
        name: "Welcome Day",
        settings: [{ circuitId: "circuit-ent-1", percentage: "80" }],
      },
      {
        id: "scene-bed-welcome",
        areaId: "area-bedroom",
        name: "Welcome Day",
        settings: [{ circuitId: "circuit-bed-1", percentage: "60" }],
      },
      {
        id: "scene-ent-off",
        areaId: "area-entrance",
        name: "Off",
        settings: [{ circuitId: "circuit-ent-1", percentage: "0" }],
      },
      {
        id: "scene-bed-off",
        areaId: "area-bedroom",
        name: "Off",
        settings: [],
      },
      {
        id: "scene-ent-une",
        areaId: "area-entrance",
        name: "Une-Uno",
        settings: [{ circuitId: "circuit-ent-1", percentage: "100" }],
      },
      {
        id: "scene-bed-unr",
        areaId: "area-bedroom",
        name: "Unr-Uno",
        settings: [{ circuitId: "circuit-bed-1", percentage: "100" }],
      },
      {
        id: "scene-hvac-checkin",
        areaId: HVAC_AREA_ID,
        name: "Check-in",
        settings: [
          { circuitId: "hvac:hvac-bedroom:On/Off", percentage: "On" },
          { circuitId: "hvac:hvac-bedroom:Setpoint", percentage: "Summer: 24 / Winter: 22" },
        ],
      },
    ],
  };

  return {
    id: "project-area-scene-overview",
    name: "Area Scene Overview",
    updatedAt: now,
    locations,
    fixtures: [
      { id: "fixture-dl", fixture: "FX-DL", fixtureType: "DL", powerMode: "VA", watt: "10", powerFactor: "0.7" },
      { id: "fixture-cove", fixture: "FX-COVE", fixtureType: "Indirect", powerMode: "VA", watt: "8", powerFactor: "0.7" },
    ],
    circuits,
    roomTypes: [roomType],
  };
}

async function openRoomTypeSubTab(page: Page, subTab: string): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const projectCard = page.locator("button.screen-card").filter({ hasText: "Area Scene Overview" }).first();
  const inProject = await page
    .getByRole("button", { name: "Back to Project List" })
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(async () => {
      await projectCard.waitFor({ state: "visible", timeout: 10_000 });
      return false;
    });
  if (!inProject) await projectCard.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.getByRole("tab", { name: "RT A", exact: true }).click();
  await page.getByRole("tab", { name: subTab, exact: true }).click();
}

test.describe("Area Scene overview", () => {
  test.setTimeout(90_000);

  test("shows a read-only all-area Area Scene matrix", async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    state.projects = [makeProject() as unknown as Record<string, unknown>];

    await openRoomTypeSubTab(page, "Area Scene");

    await expect(page.getByTestId("area-scene-mode-edit")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".scene-table")).toBeVisible();

    await page.getByTestId("area-scene-mode-overview").click();
    const table = page.getByTestId("area-scene-overview-table");
    await expect(table).toBeVisible();
    await expect(page.getByTestId("area-scene-mode-overview")).toHaveAttribute("aria-selected", "true");

    const headers = table.locator("thead th");
    await expect(headers.nth(4)).toContainText("Welcome Day");
    await expect(headers.nth(5)).toContainText("Off");
    await expect(headers.nth(6)).toContainText("Une-Uno");
    await expect(headers.nth(7)).toContainText("Unr-Uno");
    await expect(headers.nth(8)).toContainText("Check-in");

    await expect(table.locator('tbody tr:not(.area-scene-overview-group-row)').filter({ hasText: "B-01" })).toHaveCount(1);
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-0")).toHaveText("80%");
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-1")).toHaveText("0%");
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-1")).toHaveClass(/area-scene-overview-off/);
    await expect(page.getByTestId("area-scene-cell-circuit-bed-1-1")).toHaveText("-");
    await expect(page.getByTestId("area-scene-cell-circuit-bed-1-1")).toHaveClass(/area-scene-overview-empty/);
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-3")).toHaveClass(/area-scene-overview-na/);
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-3")).toHaveAttribute("aria-label", "not applicable");

    await expect(table.locator("input, select")).toHaveCount(0);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^AreaScene_RT_A_\d{8}\.csv$/);

    await expect(table.locator('tr[data-area-id="area-bedroom"][data-target-id^="hvac:"]')).toHaveCount(0);
    await expect(table.locator(`tr[data-area-id="${HVAC_AREA_ID}"][data-target-id^="hvac:"]`)).toHaveCount(4);
    await expect(table).toContainText("Summer: 24°C / Winter: 22°C");

    await expect(table.locator('tbody tr:not(.area-scene-overview-group-row)').filter({ hasText: "V-01" })).toHaveCount(1);
    await page.getByRole("button", { name: "未設定行を隠す" }).click();
    await expect(table.locator('tbody tr:not(.area-scene-overview-group-row)').filter({ hasText: "V-01" })).toHaveCount(0);

    await page.getByTestId("area-scene-mode-edit").click();
    await expect(page.locator(".scene-table")).toBeVisible();
  });
});
