import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const PROJECT_NAME = `AUDIT-08-CCI-Link-${Date.now()}`;
const ROOM_NAME = "CCI Link Room";
type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

function makeProject() {
  const now = new Date().toISOString();
  const circuitId = "cci-link-circuit-1";
  return {
    id: "cci-link-project",
    name: PROJECT_NAME,
    updatedAt: now,
    locations: [
      { id: "area-entry", name: "Entry", number: "1", color: "#C7D2FE" },
    ],
    fixtures: [],
    circuits: [
      {
        id: circuitId,
        circuitGroupId: "circuit-group-1",
        daliFixtureGroupId: "",
        designerNumber: "L-1",
        internalNumber: "IL-1",
        dimmingType: "On/Off",
        fixture: "",
        pcs: "1",
        detail: "Entry Light",
        area: "area-entry",
        ffe: false,
        energySaving: false,
      },
      {
        id: "cci-link-circuit-2",
        circuitGroupId: "circuit-group-1",
        daliFixtureGroupId: "",
        designerNumber: "L-1",
        internalNumber: "IL-2",
        dimmingType: "On/Off",
        fixture: "",
        pcs: "1",
        detail: "Entry Light Aux",
        area: "area-entry",
        ffe: false,
        energySaving: false,
      },
    ],
    roomTypes: [
      {
        id: "cci-link-room",
        name: ROOM_NAME,
        updatedAt: now,
        revision: "1.00",
        revisions: [],
        rows: [],
        deviceAssignments: [
          {
            id: "assign-zone-1",
            deviceGroupId: "device-group-1",
            device: "MQSE-4S1-D",
            deviceNum: "1",
            zoneAddress: "Zn1",
            circuitNumber: "L-1",
            detail: "Entry Light",
            group: "",
          },
          {
            id: "assign-cci-1",
            deviceGroupId: "device-group-1",
            device: "MQSE-4S1-D",
            deviceNum: "1",
            zoneAddress: "CCI",
            circuitNumber: "Door Magnet",
            detail: "Entry Door",
            group: "",
          },
        ],
        hvacAssignments: [],
        hvacSeasons: [],
        scenes: [],
        roomScenes: [],
        switches: [
          {
            id: "switch-contact-1",
            switchGroupId: "switch-group-1",
            kind: "contact",
            switchNumber: "Stale Input",
            switchName: "Stale Detail",
            cciAssignment: "MQSE-4S1-D #1",
            buttonCount: "",
            buttonLabel: "",
            allocation: "CCI",
            buttonFunction: "Welcome",
            buttonType: "single",
            condition: "Less 4 Second",
            buttonSetting: {
              sceneId: "",
              sceneIds: [],
              circuitSettings: [{ circuitId, percentage: "100" }],
            },
            backlightTarget: "",
            backlightCondition: "",
            backlightLevels: [],
          },
          {
            id: "switch-pir-1",
            switchGroupId: "switch-pir-group-1",
            kind: "pir",
            switchNumber: "area-entry",
            switchName: "",
            cciAssignment: "",
            buttonCount: "",
            buttonLabel: JSON.stringify(["area-entry::1"]),
            allocation: JSON.stringify({ "area-entry": "2" }),
            buttonFunction: "PIR",
            buttonType: "single",
            condition: "",
            buttonSetting: {
              sceneId: "",
              sceneIds: [],
              circuitSettings: [],
            },
            backlightTarget: "",
            backlightCondition: "",
            backlightLevels: [],
          },
          {
            id: "switch-qsm-1",
            switchGroupId: "switch-qsm-group-1",
            kind: "qsm",
            switchNumber: "QSM1",
            switchName: "",
            cciAssignment: "",
            buttonCount: "",
            buttonLabel: "",
            allocation: JSON.stringify(["invalid", "area-entry::2"]),
            buttonFunction: "",
            buttonType: "single",
            condition: "",
            buttonSetting: {
              sceneId: "",
              sceneIds: [],
              circuitSettings: [],
            },
            backlightTarget: "",
            backlightCondition: "",
            backlightLevels: [],
          },
          {
            id: "switch-qsm-2",
            switchGroupId: "switch-qsm-group-2",
            kind: "qsm",
            switchNumber: "QSM2",
            switchName: "",
            cciAssignment: "",
            buttonCount: "",
            buttonLabel: "",
            allocation: JSON.stringify(["area-entry::1", "area-entry::2"]),
            buttonFunction: "",
            buttonType: "single",
            condition: "",
            buttonSetting: {
              sceneId: "",
              sceneIds: [],
              circuitSettings: [],
            },
            backlightTarget: "",
            backlightCondition: "",
            backlightLevels: [],
          },
        ],
        pduDeviceCounts: [],
        inspectionMarks: [],
      },
    ],
  };
}

async function currentProjects(state: LocalEditingMockState): Promise<any[]> {
  return Array.isArray(state.projects) ? state.projects : [];
}

async function saveProjects(state: LocalEditingMockState, projects: any[]): Promise<void> {
  state.projects = projects;
}

async function seedProject(page: Page, state: LocalEditingMockState): Promise<any[]> {
  const previousProjects = await currentProjects(state);
  await page.goto("about:blank");
  await saveProjects(state, []);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await saveProjects(state, [makeProject()]);
  return previousProjects;
}

async function openCfs(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const projectCard = page.locator("button.screen-card").filter({ hasText: PROJECT_NAME }).first();
  await expect(projectCard).toBeVisible({ timeout: 15000 });
  await projectCard.click();

  await page.locator('[role="tab"]').filter({ hasText: /^Room Type$/ }).first().click();
  const roomCard = page.locator("button.screen-card").filter({ hasText: ROOM_NAME }).first();
  await expect(roomCard).toBeVisible({ timeout: 8000 });
  await roomCard.click();

  const cfsTab = page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first();
  await expect(cfsTab).toBeVisible({ timeout: 8000 });
  await cfsTab.click();
  await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
}

test.describe("AUDIT-08 CFS CCI linkage", () => {
  let mockState: LocalEditingMockState;

  test.beforeEach(async ({ page }) => {
    mockState = await installLocalEditingMocks(page);
  });

  test("linked tab data updates CFS without opening source tabs", async ({ page }) => {
    const previousProjects = await seedProject(page, mockState);
    try {
      await openCfs(page);

      const cfsTable = page.locator("table.cfs-matrix-table");
      await expect(cfsTable.locator("thead")).toContainText("Door Magnet");
      await expect(cfsTable.locator("thead")).toContainText("Entry Door");
      await expect(cfsTable.locator("thead")).toContainText("From PMS");
      await expect(cfsTable.locator("thead")).toContainText("Check In");

      await page.getByRole("button", { name: "Devices", exact: true }).click();
      await page.getByRole("button", { name: "Show CCI", exact: true }).click();

      const cciRow = cfsTable.locator("tbody tr").filter({ hasText: "Door Magnet" }).filter({ hasText: "Entry Door" }).first();
      await expect(cciRow).toBeVisible();
      await expect(cciRow).toContainText("CCI");
      await expect(cciRow).not.toHaveClass(/cfs-reserved-row/);
    } finally {
      await saveProjects(mockState, previousProjects);
    }
  });
});
