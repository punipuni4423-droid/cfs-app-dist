import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";

test("shows LD export preview and downloads bridge JSON", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.locator("button.screen-card").filter({ hasText: "Test" }).first().click();
  await page.getByRole("tab", { name: "Room Type" }).click();

  await page.getByRole("button", { name: "Export Room Type" }).first().click();
  await page.getByRole("menuitem", { name: "LD Export" }).click();
  await expect(page.getByRole("heading", { name: "LD Export JSON" })).toBeVisible();
  await expect(page.locator(".lutron-spec-kpi").filter({ hasText: "Rooms" })).toBeVisible();
  await expect(page.locator(".lutron-spec-table").first()).toContainText("CFS Room Types");

  await page.getByRole("tab", { name: "JSON" }).click();
  const preview = page.getByTestId("lutron-json-preview");
  await expect(preview).toContainText('"schemaVersion": "1.0"');
  await expect(preview).toContainText('"mode": "additive"');
  await expect(preview).toContainText('"reassignTemplates": false');
  await expect(preview).toContainText('"sourceRoomTypeName": "A"');

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download LD JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/Test_A_ld-export\.json$/);

  const tempPath = await download.path();
  expect(tempPath).toBeTruthy();
  const body = await fs.readFile(tempPath as string, "utf8");
  const parsed = JSON.parse(body) as {
    schemaVersion?: string;
    templateMappings?: Record<string, string>;
    rooms?: Array<{ floorName?: string; name?: string; roomType?: string }>;
  };
  expect(parsed.schemaVersion).toBe("1.0");
  expect(parsed.templateMappings?._default).toBe("A");
  expect(parsed.rooms?.[0]).toMatchObject({ floorName: "CFS Room Types", name: "A", roomType: "a" });
});
