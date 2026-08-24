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
      id: "circuit-bed-3",
      circuitGroupId: "group-bed-2",
      designerNumber: "B-02",
      internalNumber: "INT-Z",
      dimmingType: "PWM",
      fixture: "FX-DL",
      detail: "Bed Downlight",
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
    deviceAssignments: [
      {
        id: "assignment-ent",
        deviceGroupId: "device-ent",
        device: "LQSE-4A5-230-D",
        deviceNum: "1",
        zoneAddress: "ZN1",
        circuitNumber: "E-01",
        detail: "Entrance Downlight",
        group: "",
      },
      {
        id: "assignment-bed-2",
        deviceGroupId: "device-bed-2",
        device: "LQSE-4A5-230-D",
        deviceNum: "1",
        zoneAddress: "ZN1",
        circuitNumber: "B-02",
        detail: "Bed Downlight",
        group: "",
      },
      {
        id: "assignment-bed-1",
        deviceGroupId: "device-bed-1",
        device: "LQSE-4A5-230-D",
        deviceNum: "2",
        zoneAddress: "ZN2",
        circuitNumber: "B-01",
        detail: "Bed Cove A",
        group: "",
      },
      {
        id: "assignment-vanity",
        deviceGroupId: "device-vanity",
        device: "LQSE-4A5-230-D",
        deviceNum: "3",
        zoneAddress: "ZN3",
        circuitNumber: "V-01",
        detail: "Vanity Downlight",
        group: "",
      },
    ],
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
        settings: [
          { circuitId: "circuit-bed-1", percentage: "60" },
          { circuitId: "circuit-bed-3", percentage: "40" },
        ],
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
    await page.addInitScript(() => window.localStorage.removeItem("cfs-area-scene-overview-prefs-v1"));

    await openRoomTypeSubTab(page, "Area Scene");

    await expect(page.getByTestId("area-scene-mode-edit")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("area-scene-mode-edit")).toHaveText("Edit");
    await expect(page.getByTestId("area-scene-mode-overview")).toHaveText("Overview");
    await expect(page.locator(".scene-table")).toBeVisible();

    await page.getByTestId("area-scene-mode-overview").click();
    const table = page.getByTestId("area-scene-overview-table");
    await expect(table).toBeVisible();
    await expect(page.getByTestId("area-scene-mode-overview")).toHaveAttribute("aria-selected", "true");

    const sceneHeaders = table.locator("thead th:not([data-base-column])");
    await expect(sceneHeaders.nth(0)).toContainText("Welcome Day");
    await expect(sceneHeaders.nth(1)).toContainText("Off");
    await expect(sceneHeaders.nth(2)).toContainText("Une-Uno");
    await expect(sceneHeaders.nth(3)).toContainText("Unr-Uno");
    await expect(sceneHeaders.nth(4)).toContainText("Check-in");

    await expect(table.locator('thead th[data-base-column="area"]')).toHaveCount(0);
    await expect(table.locator('thead th[data-base-column="number"]')).toHaveText("No");
    await expect(table.locator('thead th[data-base-column="device"]')).toHaveText("Device");
    await expect(table.locator('thead th[data-base-column="programmingName"]')).toHaveText("Programming Name");

    const baseMenu = page.getByTestId("area-scene-base-menu");
    await baseMenu.locator("summary").click();
    await expect(baseMenu.locator(".cfs-base-column-label")).toHaveText([
      "No",
      "Device",
      "Device #",
      "Type",
      "Group",
      "Zone / Address",
      "Designer #",
      "Area",
      "Area Address",
      "Detail",
      "Programming Name",
    ]);
    await expect(baseMenu.getByLabel("Show Area column")).not.toBeChecked();
    await baseMenu.getByRole("button", { name: "Show all" }).click();
    await expect(table.locator('thead th[data-base-column="area"]')).toHaveText("Area");
    await expect(table.locator("colgroup col").evaluateAll((columns) => columns.slice(0, 11).map((column) => (column as HTMLElement).style.width))).resolves.toEqual([
      "44px",
      "150px",
      "82px",
      "102px",
      "92px",
      "116px",
      "96px",
      "130px",
      "112px",
      "170px",
      "240px",
    ]);
    await baseMenu.getByRole("button", { name: "Move Device right" }).click();
    await expect(table.locator("thead th[data-base-column]").evaluateAll((headers) => headers.slice(0, 3).map((header) => header.textContent?.trim()))).resolves.toEqual([
      "No",
      "Device #",
      "Device",
    ]);
    await baseMenu.getByRole("button", { name: "Move Device left" }).click();
    await baseMenu.getByLabel("Show Area column").uncheck();
    await expect(table.locator('thead th[data-base-column="area"]')).toHaveCount(0);

    await expect(table.locator('tbody tr:not(.area-scene-overview-group-row)').filter({ hasText: "B-01" })).toHaveCount(1);
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-0")).toHaveText("80%");
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-1")).toHaveText("0%");
    await expect(page.getByTestId("area-scene-cell-circuit-ent-1-1")).toHaveClass(/area-scene-overview-off/);
    const offStyle = await page.getByTestId("area-scene-cell-circuit-ent-1-1").evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, fontWeight: style.fontWeight };
    });
    expect(offStyle.color).toBe("rgb(37, 99, 235)");
    expect(offStyle.fontWeight).not.toBe("700");
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
    const displayMenu = page.getByTestId("area-scene-display-menu");
    await displayMenu.locator("summary").click();
    await displayMenu.getByLabel("Hide Unset Rows").check();
    await expect(table.locator('tbody tr:not(.area-scene-overview-group-row)').filter({ hasText: "V-01" })).toHaveCount(0);

    await displayMenu.getByLabel("Hide Unset Rows").uncheck();
    const bedroomRows = table.locator('tbody tr[data-area-id="area-bedroom"]');
    await displayMenu.getByLabel("Area Scene sort mode").getByRole("button", { name: "Device" }).click();
    await expect(bedroomRows.first()).toHaveAttribute("data-target-id", "circuit-bed-3");
    await displayMenu.getByLabel("Area Scene sort mode").getByRole("button", { name: "Internal #" }).click();
    await expect(bedroomRows.first()).toHaveAttribute("data-target-id", "circuit-bed-1");
    await displayMenu.getByLabel("Area Scene number display").getByRole("button", { name: "Internal #" }).click();
    await expect(table.locator('thead th[data-base-column="designerNumber"]')).toHaveText("Internal #");
    await expect(table.locator('tr[data-target-id="circuit-bed-1"] td[data-base-column="designerNumber"]')).toContainText("INT-B1");

    await page.getByTestId("area-scene-mode-edit").click();
    await expect(page.locator(".scene-table")).toBeVisible();
  });

  test("keeps CFS base columns sticky when scene columns grow", async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    const project = makeProject();
    const roomType = project.roomTypes[0];
    roomType.scenes.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `scene-extra-${index + 1}`,
        areaId: "area-entrance",
        name: `Extended Scene ${String(index + 1).padStart(2, "0")}`,
        settings: [{ circuitId: "circuit-ent-1", percentage: String((index * 5) % 100) }],
      })),
    );
    state.projects = [project as unknown as Record<string, unknown>];
    await page.addInitScript(() => window.localStorage.removeItem("cfs-area-scene-overview-prefs-v1"));
    await page.setViewportSize({ width: 1365, height: 760 });

    await openRoomTypeSubTab(page, "Area Scene");
    await page.getByTestId("area-scene-mode-overview").click();
    const scroll = page.getByTestId("area-scene-overview-scroll");
    const metrics = await scroll.evaluate((element) => {
      const sticky = element.querySelector<HTMLElement>('thead th[data-base-column="number"]');
      if (!sticky) return null;
      const before = sticky.getBoundingClientRect().left;
      element.scrollLeft = element.scrollWidth;
      const after = sticky.getBoundingClientRect().left;
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        stickyDelta: Math.abs(after - before),
      };
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.scrollWidth).toBeGreaterThan(metrics!.clientWidth);
    expect(metrics!.stickyDelta).toBeLessThan(1);
    await expect(page.getByTestId("area-scene-overview-table")).toContainText("Extended Scene 20");
  });
});
