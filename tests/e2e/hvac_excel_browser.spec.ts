import ExcelJS from "exceljs";
import { test, expect, type Page } from "./support/safe-test";
import { createNewProject } from "../../app/lib/storage";
import { createEmptyHvacAssignment, createNewRoomType } from "../../app/lib/constants";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

function makeProject(empty: boolean) {
  const project = createNewProject("TSTAT Export Test");
  const room = createNewRoomType("TSTAT Room");
  room.revision = empty ? "1.00" : "1.02";
  const area = project.locations[0];
  room.hvacAssignments = empty ? [] : [
    { ...createEmptyHvacAssignment(), protocol: "BACnet", thermostatRole: "Master", area: area.id, lowEnd: "18", highEnd: "30", summerWinterChange: true, note: "=Literal note " + "長い注記 ".repeat(25) },
    { ...createEmptyHvacAssignment(), protocol: "FCU", thermostatRole: "Slave", area: area.id, lowEnd: "20", highEnd: "28", summerWinterChange: false, note: "+Keep literal" },
  ];
  room.hvacSeasons = [{ id: "test-season", name: "Custom Season", startMonth: "4", startDay: "15", endMonth: "11", endDay: "5" }];
  project.roomTypes = [room];
  return project;
}

async function openHvac(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("button.screen-card").filter({ hasText: "TSTAT Export Test" }).click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const room = page.locator("button.screen-card").filter({ hasText: "TSTAT Room" }).first();
  if (await room.isVisible()) await room.click();
  else await page.getByRole("tab", { name: "TSTAT Room", exact: true }).click();
  await page.getByRole("tab", { name: "Switch", exact: true }).click();
  await page.getByRole("tab", { name: "Thermostat", exact: true }).click();
  await expect(page.getByText("Season Schedule", { exact: true })).toBeVisible();
}

for (const viewOnly of [false, true]) {
  test(`TSTAT Excel Export is available with canEdit=${!viewOnly} and preserves its snapshot`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.context().route("**/api/**", (route) => route.fulfill({ json: {} }));
    const state = await installLocalEditingMocks(page);
    const project = makeProject(false);
    state.projects = [project as unknown as Record<string, unknown>];
    if (viewOnly) {
      await page.context().route("**/api/collaboration/status**", (route) => route.fulfill({ json: {
        enabled: true, mode: "view", projectId: new URL(route.request().url()).searchParams.get("projectId") ?? "",
        lock: null, locks: [], lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20_000, idleMs: 900_000,
      } }));
    }
    await openHvac(page);
    if (viewOnly) await expect(page.getByRole("button", { name: "Add Row (Thermostat)", exact: true })).toBeDisabled();
    const button = page.getByRole("button", { name: "Excel Export", exact: true });
    await expect(button).toBeEnabled();
    await page.waitForTimeout(1300);
    const before = JSON.stringify(state.projects);
    const pending = page.waitForEvent("download");
    await button.click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("TSTAT_Export_Test_TSTAT_Room_Rev1.02_TSTAT.xlsx");
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(file);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(["TSTAT", "TSTAT Seasons"]);
    expect(book.worksheets[0].getCell("B2").value).toBe("BACnet");
    expect(book.worksheets[0].getCell("C3").value).toBe("Slave");
    expect(book.worksheets[0].getCell("D2").value).toBe(project.locations[0].name);
    expect(book.worksheets[0].getCell("E2").value).toBe("18 C");
    expect(book.worksheets[0].getCell("H2").value).toBe(project.roomTypes[0].hvacAssignments[0].note);
    expect(book.worksheets[0].getCell("H2").type).toBe(ExcelJS.ValueType.String);
    expect(book.worksheets[1].getRow(2).values).toEqual([undefined, "Custom Season", "4/15", "11/5"]);
    expect(JSON.stringify(state.projects)).toBe(before);
    await expect(button).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("hvac-export.png"), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(button).toBeVisible();
    const viewport = await button.boundingBox();
    expect(viewport!.x + viewport!.width).toBeLessThanOrEqual(390);
  });
}

test("TSTAT Excel Export handles no assignments and recovers from a failed download", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.context().route("**/api/**", (route) => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page);
  state.projects = [makeProject(true) as unknown as Record<string, unknown>];
  await openHvac(page);
  const button = page.getByRole("button", { name: "Excel Export", exact: true });
  const pending = page.waitForEvent("download");
  await button.click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("TSTAT_Export_Test_TSTAT_Room_Rev1.00_TSTAT.xlsx");
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  expect(book.worksheets[0].getCell("A2").value).toBe("No HVAC assignments are registered.");
  expect(book.worksheets[0].getCell("H2").master.address).toBe("A2");
  await expect(button).toBeEnabled();
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error("Synthetic download failure"); }; });
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "Excel export failed. Please try again." })).toHaveText("Excel export failed. Please try again.");
  await expect(button).toBeEnabled();
});
