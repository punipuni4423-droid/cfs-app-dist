import ExcelJS from "exceljs";
import { test, expect, type Page } from "./support/safe-test";
import { createDefaultLocations, createEmptyCircuitEntry, createEmptyDeviceAssignment, createEmptyScene, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import type { ProjectData } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

function colorProject(): ProjectData {
  const locations = createDefaultLocations();
  const areaId = locations[0].id;
  const circuits = ["PWM", "On/Off"].map((dimmingType, index) => ({
    ...createEmptyCircuitEntry(String(index + 1)), internalNumber: String(index + 1),
    area: areaId, dimmingType, detail: `Color load ${index + 1}`,
  }));
  const roomTypes = ["Room A", "Room B"].map((name, index) => {
    const room = createNewRoomType(name);
    room.circuitIds = circuits.map((circuit) => circuit.id);
    room.deviceAssignments = circuits.map((circuit, i) => ({
      ...createEmptyDeviceAssignment(), device: "QSN-4P20-D", deviceNum: "1",
      deviceGroupId: `color-device-${index}`, zoneAddress: `Zn${i + 1}`, circuitNumber: circuit.designerNumber,
    }));
    room.scenes = (index === 0 ? ["Bright", "Relax", "Off"] : ["Relax", "Bright", "Off"]).map((sceneName) => ({
      ...createEmptyScene(areaId), name: sceneName,
      settings: circuits.map((circuit) => ({ circuitId: circuit.id,
        percentage: circuit.dimmingType === "On/Off" ? (sceneName === "Bright" ? "On" : "Off") : (sceneName === "Bright" ? "100" : "0"),
      })),
    }));
    room.roomScenes = [];
    room.switches = [{
      ...createEmptySwitchEntry("lutronPico"), switchNumber: "SW1", switchName: "Color scenes",
      buttonCount: "1", buttonLabel: "Scenes", buttonFunction: "Scene",
      buttonSetting: { sceneId: room.scenes[0].id, sceneIds: room.scenes.map((scene) => scene.id), circuitSettings: [] },
    }];
    return room;
  });
  return { id: "excel-color-project", name: "Excel Color Test", updatedAt: "2026-10-27T00:00:00Z", locations, fixtures: [], circuits, roomTypes };
}

async function download(page: Page, scope: "This Room Type" | "All Rooms", file: string): Promise<ExcelJS.Workbook> {
  await page.getByRole("button", { name: "Excel Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("menu", { name: "Excel export scope" }).getByRole("menuitem", { name: scope, exact: true }).click();
  await (await pending).saveAs(file);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  return book;
}

function coloredRuns(sheet: ExcelJS.Worksheet): ExcelJS.RichText[] {
  const runs: ExcelJS.RichText[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.master.address === cell.address && cell.value && typeof cell.value === "object" && "richText" in cell.value) {
      runs.push(...cell.value.richText);
    }
  }));
  return runs;
}

test("Excel Export keeps CFS scene line colors and Off blue in this room and all rooms", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 2600, height: 1100 });
  await page.context().route("**/api/**", (route) => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page);
  state.projects = [colorProject() as unknown as Record<string, unknown>];
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("button.screen-card").filter({ hasText: "Excel Color Test" }).click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const card = page.locator("button.screen-card").filter({ hasText: "Room A" }).first();
  if (await card.isVisible()) await card.click();
  else await page.getByRole("tab", { name: "Room A", exact: true }).click();
  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  const table = page.locator("table.cfs-matrix-table");
  await expect(table).toBeVisible();
  await expect(table.locator(".cfs-scene-name-line").filter({ hasText: /^Bright$/ }).first()).toHaveCSS("color", "rgb(180, 83, 9)");
  await expect(table.locator(".cfs-scene-name-line").filter({ hasText: /^Relax$/ }).first()).toHaveCSS("color", "rgb(15, 118, 110)");
  await expect(table.locator(".cfs-off-value-line").first()).toHaveCSS("color", "rgb(37, 99, 235)");
  await table.locator(".cfs-scene-name-line").filter({ hasText: /^Bright$/ }).first().scrollIntoViewIfNeeded();
  await table.locator("td.cfs-function-cell").filter({ hasText: "Bright" }).first().screenshot({ path: testInfo.outputPath("cfs-scene-colors.png") });

  const single = await download(page, "This Room Type", testInfo.outputPath("room-colors.xlsx"));
  const all = await download(page, "All Rooms", testInfo.outputPath("all-room-colors.xlsx"));
  expect(all.worksheets.map((sheet) => sheet.name)).toEqual(["Room A R1.00", "Room B R1.00"]);
  for (const [sheet, bright, relax] of [[single.worksheets[0], "FFB45309", "FF0F766E"], [all.worksheets[0], "FFB45309", "FF0F766E"], [all.worksheets[1], "FF0F766E", "FFB45309"]] as const) {
    const runs = coloredRuns(sheet);
    expect(runs.filter((run) => run.text.trim() === "Bright").map((run) => run.font?.color?.argb)).toContain(bright);
    expect(runs.filter((run) => run.text.trim() === "Relax").map((run) => run.font?.color?.argb)).toContain(relax);
    const off = runs.filter((run) => ["Off", "0%"].includes(run.text.trim()));
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((run) => run.font?.color?.argb === "FF2563EB")).toBe(true);
    expect(runs.filter((run) => ["Bright", "Relax"].includes(run.text.trim())).every((run) => run.font?.bold)).toBe(true);
    expect(sheet.views[0].state).toBe("frozen");
    expect(sheet.getCell("A1").master.address).toBe(sheet.getCell("A4").master.address);
    expect(sheet.getCell("A1").border.top?.style).toBe("medium");
  }
});
