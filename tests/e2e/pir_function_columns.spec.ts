import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { createDefaultLocations, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { pirInstanceValue } from "../../app/lib/switchSync";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

test.setTimeout(90_000);

function kindChip(label: string): string {
  return `.scene-area-chip:has-text("${label}")`;
}

function excelRowTextValues(row: ExcelJS.Row): string[] {
  const values: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell) => {
    values.push(String(cell.value ?? ""));
  });
  return values;
}

function makePirFunctionProject(projectName: string, roomName: string) {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: "pir-area-bedroom", name: "Bedroom", number: "1", code: "BR" };
  const pirValue = pirInstanceValue(bedroom.id, 1);
  const pirGroupId = "pir-function-group";
  const roomType = {
    ...createNewRoomType(roomName),
    id: "pir-function-room",
    name: roomName,
    updatedAt: now,
    circuitIds: ["pir-circuit-1"],
    rows: [],
    deviceAssignments: [
      {
        id: "pir-assignment-1",
        deviceGroupId: "pir-device-group-1",
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zone1",
        circuitNumber: "1",
        detail: "PIR Test Load",
        group: "",
      },
    ],
    switches: [
      {
        ...createEmptySwitchEntry("pir"),
        id: "pir-function-row-1",
        switchGroupId: pirGroupId,
        switchNumber: bedroom.id,
        switchName: "",
        allocation: JSON.stringify({ [bedroom.id]: "1" }),
        buttonLabel: JSON.stringify([pirValue]),
        buttonFunction: "PIR",
        condition: "Motion",
      },
    ],
  };

  return {
    id: "pir-function-project",
    name: projectName,
    updatedAt: now,
    locations: [bedroom, ...otherLocations],
    fixtures: [],
    circuits: [
      {
        id: "pir-circuit-1",
        circuitGroupId: "pir-circuit-group-1",
        daliFixtureGroupId: "",
        designerNumber: "1",
        internalNumber: "1",
        dimmingType: "Switch",
        fixture: "",
        pcs: "1",
        detail: "PIR Test Load",
        area: bedroom.id,
        ffe: false,
        energySaving: false,
      },
    ],
    roomTypes: [roomType],
  };
}

async function openSeededRoom(page: Page, projectName: string, roomName: string): Promise<void> {
  mockState.projects = [makePirFunctionProject(projectName, roomName)];
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("button.screen-card").filter({ hasText: projectName }).first().click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.locator("button.screen-card").filter({ hasText: roomName }).first().click();
}

test("PIR supports additional Function rows through Switch, CFS, and Excel export", async ({ page }) => {
  const projectName = `PIR-Functions-${Date.now()}`;
  const roomName = `Room-${Date.now()}`;
  await openSeededRoom(page, projectName, roomName);

  await page.getByRole("tab", { name: "Switch", exact: true }).click();
  await page.locator(kindChip("PIR")).first().click();
  const switchTable = page.locator("table.switch-table").last();
  await expect(switchTable.locator("thead")).toContainText("+");
  await expect(switchTable.locator("thead")).toContainText("Function");
  await expect(switchTable.locator("thead")).not.toContainText("Priority");

  const firstRow = switchTable.locator("tbody tr").first();
  await expect(firstRow.locator("textarea").first()).toHaveValue("");

  await switchTable.getByRole("button", { name: "+" }).first().click();
  await expect(switchTable.locator("tbody tr")).toHaveCount(2);
  const secondRow = switchTable.locator("tbody tr").nth(1);
  await secondRow.locator("textarea").first().fill("Vacancy Hold");

  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  const cfsHeaderRows = page.locator("table.cfs-matrix-table thead tr");
  await expect(cfsHeaderRows.nth(0)).toContainText("PIR");
  const pirButtonHeader = cfsHeaderRows.nth(1).locator("th").filter({ hasText: "PIR1" }).filter({ hasText: "Bedroom" }).last();
  await expect(pirButtonHeader).toBeVisible();
  await expect(pirButtonHeader).toHaveAttribute("colspan", "2");
  await expect(cfsHeaderRows.nth(2)).toContainText("Vacancy Hold");
  await expect(cfsHeaderRows.nth(2)).not.toContainText("PIR1");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Excel Export/ }).click();
  const download = await downloadPromise;
  const workbookPath = await download.path();
  expect(workbookPath).toBeTruthy();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath as string);
  const worksheet = workbook.worksheets[0];
  const row2 = excelRowTextValues(worksheet.getRow(2));
  const row3 = excelRowTextValues(worksheet.getRow(3));

  expect(row2.some((value) => value.includes("PIR1") && value.includes("Bedroom"))).toBeTruthy();
  expect(row3.some((value) => value.includes("Vacancy Hold"))).toBeTruthy();
  expect(row3.some((value) => value.includes("PIR1"))).toBeFalsy();
});
