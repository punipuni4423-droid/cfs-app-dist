import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const rawUser = window.localStorage.getItem("cfs-collaboration-user-v1");
    const sessionId = window.sessionStorage.getItem("cfs-collaboration-session-v1");
    const user = rawUser ? (JSON.parse(rawUser) as { id?: string }) : null;
    if (!user?.id || !sessionId) return;
    await fetch("/api/collaboration/lock/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, sessionId }),
    });
  });
});

test("captures InspectionMode documentation states without changing project data", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  const testProject = page.locator("button.screen-card").filter({ hasText: "Test" });
  await expect(testProject).toHaveCount(1);
  await testProject.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.getByRole("tab", { name: "A", exact: true }).click();

  const userButton = page.getByRole("button", { name: /^(User|Unregistered)$/ });
  await expect(userButton).toHaveCount(1);
  await userButton.click();
  await page.getByLabel(/Display name/i).fill("Manual QA");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  const editButton = page.getByRole("button", { name: "Edit", exact: true });
  await expect(editButton).toHaveCount(1);
  await editButton.click();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "CFS", exact: true }).click();
  const inspectionMode = page.getByRole("button", { name: "InspectionMode", exact: true });
  await expect(inspectionMode).toHaveCount(1);
  await inspectionMode.click();
  await expect(page.getByRole("dialog", { name: "Start InspectionMode", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inspection-start-dialog.png"), fullPage: false });

  await page.getByRole("button", { name: "Start Current Revision", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revert", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inspection-active.png"), fullPage: false });

  const editableCells = page.locator('button[aria-label^="Edit Inspection value"]');
  const editableCount = await editableCells.count();
  if (editableCount > 0) {
    await editableCells.nth(0).click();
    await expect(page.locator(".cfs-inspection-popover")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("inspection-cell-overlay.png"), fullPage: false });
    await page.getByRole("button", { name: "OK", exact: true }).click();
  }

  const onOffCell = editableCells.filter({ hasText: /^(On|Off)$/ }).first();
  await expect(onOffCell).toHaveCount(1);
  await onOffCell.click();
  await expect(page.locator(".cfs-inspection-popover")).toBeVisible();
  await expect(page.getByRole("button", { name: "Blinking (Short)", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inspection-on-off-overlay.png"), fullPage: false });
  await page.getByRole("button", { name: "OK", exact: true }).click();

  await inspectionMode.click();
  await expect(page.getByRole("dialog", { name: "Finish InspectionMode", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inspection-finish-dialog.png"), fullPage: false });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(page.getByRole("button", { name: "InspectionMode", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
});
