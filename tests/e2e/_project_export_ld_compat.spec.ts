import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import type { ProjectData } from "../../app/types";
import { buildCfsLutronBridgeExport, validateCfsLutronBridgeExport } from "../../app/lib/lutronBridgeExport";
import { migrateProjectsPayload, type ProjectBackupPayload } from "../../app/lib/storage";

async function readDownloadJson<T>(downloadPath: string | null): Promise<T> {
  expect(downloadPath).toBeTruthy();
  const body = await fs.readFile(downloadPath as string, "utf8");
  return JSON.parse(body) as T;
}

function expectImportableLdBridge(payload: unknown): ProjectData {
  const imported = migrateProjectsPayload(payload);
  expect(imported.length).toBeGreaterThan(0);
  const project = imported[0];
  expect(project.roomTypes.length).toBeGreaterThan(0);

  const bridge = buildCfsLutronBridgeExport({
    project,
    roomTypeIds: [project.roomTypes[0].id],
    generatedAt: "2026-07-11T00:00:00.000Z",
  });
  const validation = validateCfsLutronBridgeExport(bridge);
  expect(validation.errors).toEqual([]);
  expect(bridge.schemaVersion).toBe("1.0");
  expect(bridge.mode).toBe("additive");
  expect(bridge.reassignTemplates).toBe(false);
  expect(bridge.templateMappings._default).toBe(project.roomTypes[0].name);
  return project;
}

test("project export and room type share export remain importable for LD bridge export", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await expect(page.locator("button.screen-card").filter({ hasText: "Test" }).first()).toBeVisible();

  const exportAllPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export All" }).click();
  const exportAll = await exportAllPromise;
  expect(exportAll.suggestedFilename()).toMatch(/^cfs-projects_/);
  const exportAllPayload = await readDownloadJson<ProjectBackupPayload>(await exportAll.path());
  expect(exportAllPayload.format).toBe("cfs-project-backup");
  expect(exportAllPayload.projects.some((project) => project.name === "Test")).toBe(true);
  const exportedAllProject = expectImportableLdBridge(exportAllPayload.projects.filter((project) => project.name === "Test"));
  expect(exportedAllProject.name).toBe("Test");

  const projectExportPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Project" }).first().click();
  const projectExport = await projectExportPromise;
  expect(projectExport.suggestedFilename()).toMatch(/^Test_/);
  const projectPayload = await readDownloadJson<ProjectBackupPayload>(await projectExport.path());
  expect(projectPayload.projects).toHaveLength(1);
  expect(projectPayload.projects[0].name).toBe("Test");
  expectImportableLdBridge(projectPayload);

  await page.locator("button.screen-card").filter({ hasText: "Test" }).first().click();
  await page.getByRole("tab", { name: "Room Type" }).click();
  await page.getByRole("button", { name: "Export Room Type" }).first().click();
  const shareExportPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Share Export" }).click();
  const shareExport = await shareExportPromise;
  expect(shareExport.suggestedFilename()).toMatch(/^Test_A_share_/);
  const sharePayload = await readDownloadJson<ProjectBackupPayload>(await shareExport.path());
  expect(sharePayload.projects).toHaveLength(1);
  expect(sharePayload.projects[0].name).toBe("Test - A");
  expect(sharePayload.projects[0].roomTypes).toHaveLength(1);
  const sharedProject = expectImportableLdBridge(sharePayload);
  expect(sharedProject.roomTypes[0].name).toBe("A");
});
