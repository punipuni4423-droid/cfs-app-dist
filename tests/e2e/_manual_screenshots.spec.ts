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

test("captures read-only CFS manual screenshots", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const testProject = page.locator("button.screen-card").filter({ hasText: "Test" });
  await expect(testProject).toHaveCount(1);
  await expect(testProject).toBeVisible();
  const userButton = page.getByRole("button", { name: /^(User|Unregistered)$/ });
  await expect(userButton).toHaveCount(1);
  await userButton.click();
  await page.getByLabel(/Display name/i).fill("Manual QA");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const startEditing = page.getByRole("button", { name: "Start Editing", exact: true });
  await expect(startEditing).toHaveCount(1);
  await startEditing.click();
  await expect(page.getByRole("button", { name: "Finish Editing", exact: true })).toBeVisible();
  const newProjectName = page.getByPlaceholder("New project name", { exact: true });
  await expect(newProjectName).toBeVisible();
  await newProjectName.fill("Manual sample");
  await expect(page.getByRole("button", { name: "Create Project", exact: true })).toBeEnabled();
  const tabletUrl = page.getByLabel("Tablet URL", { exact: true });
  await expect(tabletUrl).toBeVisible();
  await expect(tabletUrl).not.toHaveValue("Loading...");
  await tabletUrl.evaluate((node) => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(node, "http://[PC-IP]:3014");
  });
  await page.screenshot({ path: testInfo.outputPath("01-project-selection.png"), fullPage: true });
  await testProject.click();
  await expect(page.getByText(/Room Type List/i)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath("02-project-overview.png"), fullPage: false });
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeVisible();

  const areaTab = page.getByRole("tab", { name: "Area", exact: true });
  await expect(areaTab).toHaveCount(1);
  await areaTab.click();
  await expect(areaTab).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(120);
  await page.screenshot({ path: testInfo.outputPath("tab-area.png"), fullPage: false });

  const fixtureTab = page.getByRole("tab", { name: "Fixture", exact: true });
  await expect(fixtureTab).toHaveCount(1);
  await fixtureTab.click();
  await expect(fixtureTab).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(120);
  await page.screenshot({ path: testInfo.outputPath("tab-fixture.png"), fullPage: false });

  const roomTypeTab = page.getByRole("tab", { name: "Room Type", exact: true });
  await expect(roomTypeTab).toHaveCount(1);
  await roomTypeTab.click();
  await expect(roomTypeTab).toHaveAttribute("aria-selected", "true");
  const roomTypeA = page.getByRole("tab", { name: "A", exact: true });
  await expect(roomTypeA).toHaveCount(1);
  await roomTypeA.click();
  await expect(roomTypeA).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(120);
  await page.screenshot({ path: testInfo.outputPath("03-room-type-workspace.png"), fullPage: false });

  for (const tabName of ["PDU", "Circuit", "Device Assign", "Area Scene", "Scene", "Switch", "Command", "Backlight", "CFS"]) {
    const subTab = page.getByRole("tab", { name: tabName, exact: true });
    await expect(subTab).toHaveCount(1);
    await subTab.click();
    await expect(subTab).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(120);
    await page.screenshot({ path: testInfo.outputPath(`tab-${tabName.toLowerCase().replace(/\s+/g, "-")}.png`), fullPage: false });
  }

  const revisionManagement = page.getByRole("button", { name: "Revision Management", exact: true });
  await expect(revisionManagement).toHaveCount(1);
  await revisionManagement.click();
  await page.screenshot({ path: testInfo.outputPath("04-revision-management.png"), fullPage: false });

  await page.getByRole("button", { name: "Finish", exact: true }).click();

  await page.goto("/settings/devices");
  await page.screenshot({ path: testInfo.outputPath("05-device-and-pdu-settings.png"), fullPage: true });
});
