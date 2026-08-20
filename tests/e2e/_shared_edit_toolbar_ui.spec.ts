import { expect, test } from "@playwright/test";
import { createNewRoomType } from "../../app/lib/constants";
import type { ProjectData, RoomType } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

function revisionSnapshot(roomType: RoomType): string {
  return JSON.stringify({
    circuits: [],
    rows: roomType.rows,
    deviceAssignments: roomType.deviceAssignments,
    hvacAssignments: roomType.hvacAssignments,
    hvacSeasons: roomType.hvacSeasons,
    scenes: roomType.scenes,
    roomScenes: roomType.roomScenes,
    switches: roomType.switches,
    pduDeviceCounts: roomType.pduDeviceCounts,
    inspectionMarks: roomType.inspectionMarks,
  });
}

function makeSharedToolbarProject(): ProjectData {
  const now = new Date().toISOString();
  const roomType = createNewRoomType("A");
  roomType.revision = "1.02";
  roomType.revisions = [
    { id: "shared-toolbar-rev-1", revision: "1.01", savedAt: now, snapshot: revisionSnapshot(roomType), note: "" },
    { id: "shared-toolbar-rev-2", revision: "1.02", savedAt: now, snapshot: revisionSnapshot(roomType), note: "" },
  ];
  return {
    id: "shared-toolbar-project",
    name: "Shared Toolbar Test",
    updatedAt: now,
    locations: [],
    fixtures: [],
    circuits: [],
    roomTypes: [roomType],
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const mockState = await installLocalEditingMocks(page);
  mockState.projects = [makeSharedToolbarProject() as any];
  await page.route("**/api/collaboration/status**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        mode: "view",
        lock: null,
        lastUpdatedBy: null,
        leaseSeconds: 90,
        heartbeatMs: 20_000,
        idleMs: 15 * 60 * 1000,
        membership: {
          id: "shared-toolbar-user",
          email: "viewer@example.com",
          displayName: "Viewer",
          role: "viewer",
          active: true,
          createdAt: "2026-07-18T00:00:00.000Z",
          lastSeenAt: "2026-07-18T00:00:00.000Z",
        },
        members: [],
      }),
    });
  });
});

test("shows the compact shared-edit tile and dedicated update highlight control", async ({ page }, testInfo) => {
  await page.goto("/");

  await page.locator("button.screen-card").filter({ hasText: "Shared Toolbar Test" }).first().click();
  await page.getByRole("tab", { name: "Room Type" }).click();
  await page.getByRole("tab", { name: "A", exact: true }).click();

  const collaborationTile = page.locator(".project-screen-shell > .collaboration-bar.is-compact");
  await expect(collaborationTile).toBeVisible();
  await expect.poll(() => collaborationTile.evaluate((element) => getComputedStyle(element).position)).toBe("absolute");

  const highlightButton = page.getByRole("button", { name: /Highlight Updates/ });
  await expect(highlightButton).toBeVisible();
  await expect(highlightButton).toHaveAttribute("aria-pressed", "false");
  const highlightOffBox = await highlightButton.boundingBox();
  const historyOffBox = await page.locator(".history-controls").boundingBox();
  if (!highlightOffBox || !historyOffBox) throw new Error("Toolbar controls are not measurable");
  await highlightButton.click();
  await expect(highlightButton).toHaveAttribute("aria-pressed", "true");
  await expect(highlightButton).toContainText("On");
  const highlightOnBox = await highlightButton.boundingBox();
  const historyOnBox = await page.locator(".history-controls").boundingBox();
  if (!highlightOnBox || !historyOnBox) throw new Error("Toolbar controls are not measurable after toggling");
  expect(highlightOnBox.x).toBeCloseTo(highlightOffBox.x, 4);
  expect(highlightOnBox.width).toBeCloseTo(highlightOffBox.width, 4);
  expect(historyOnBox.x).toBeCloseTo(historyOffBox.x, 4);
  expect(historyOnBox.width).toBeCloseTo(historyOffBox.width, 4);

  const saveRevisionButton = page.getByRole("button", { name: "Save Revision", exact: true });
  await expect(saveRevisionButton).toBeVisible();
  await expect(saveRevisionButton).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Revision Management", exact: true }).click();
  const revisionPanel = page.locator(".revision-manager-panel");
  await expect(revisionPanel).toBeVisible();
  await expect(revisionPanel).not.toContainText(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i);

  await page.setViewportSize({ width: 1600, height: 900 });
  const wideTile = await collaborationTile.boundingBox();
  const wideHistory = await page.locator(".history-controls").boundingBox();
  expect(wideTile).not.toBeNull();
  expect(wideHistory).not.toBeNull();
  expect((wideTile?.x ?? 0) + (wideTile?.width ?? 0)).toBeLessThanOrEqual(wideHistory?.x ?? 0);
  await page.screenshot({ path: testInfo.outputPath("shared-edit-toolbar-wide.png"), fullPage: false });

  await page.setViewportSize({ width: 1024, height: 768 });
  const tabletTile = await collaborationTile.boundingBox();
  const tabletHistory = await page.locator(".history-controls").boundingBox();
  expect(tabletTile).not.toBeNull();
  expect(tabletHistory).not.toBeNull();
  expect((tabletTile?.y ?? 0) + (tabletTile?.height ?? 0)).toBeLessThanOrEqual(tabletHistory?.y ?? 0);
  await page.screenshot({ path: testInfo.outputPath("shared-edit-toolbar-tablet.png"), fullPage: false });
});
