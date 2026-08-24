import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { STORAGE_KEY } from "../../app/lib/constants";

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

// Room scene group order (2026-08-24): PMS scenes always stay before the Door
// Magnet scenes in the stored array (matching the Scene tab layout), even when
// a PMS row is added after Door Magnet rows already exist. CFS columns follow
// the stored order, so this keeps the CFS Scene section grouped.

interface ApiRoomScene {
  id: string;
  kind?: string;
  sceneType: string;
}

interface ApiProject {
  id: string;
  roomTypes?: Array<{ roomScenes?: ApiRoomScene[] }>;
  [key: string]: unknown;
}

async function apiGetProjects(page: Page): Promise<ApiProject[]> {
  return await page.evaluate(async ({ storageKey, draftKey }) => {
    for (const key of [draftKey, storageKey]) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* ignore */ }
    }
    const response = await fetch("/api/projects", { cache: "no-store" });
    const body = await response.json();
    return body.projects ?? [];
  }, { storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY });
}

async function apiPutProjects(page: Page, projects: unknown[]): Promise<void> {
  if (page.url() === "about:blank") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await page.evaluate(async ({ nextProjects, storageKey, draftKey }) => {
    localStorage.setItem(storageKey, JSON.stringify(nextProjects));
    localStorage.setItem(draftKey, JSON.stringify(nextProjects));
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: nextProjects }),
    });
  }, { nextProjects: projects, storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY });
}

async function isolate(page: Page): Promise<void> {
  await page.goto("about:blank");
  await page.waitForTimeout(1800);
  await apiPutProjects(page, []);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  await page.goto("about:blank");
  await page.waitForTimeout(1800);
  await apiPutProjects(page, []);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Loading projects"),
    { timeout: 20000 },
  );
}

async function readRoomScenes(page: Page): Promise<ApiRoomScene[]> {
  const projects = await apiGetProjects(page);
  return projects[0]?.roomTypes?.[0]?.roomScenes ?? [];
}

function isPms(scene: ApiRoomScene): boolean {
  return scene.kind === "pms";
}

test.describe("Room scene group order", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("a PMS row added after Door Magnet rows stays in the PMS group", async ({ page }) => {
    await isolate(page);

    const nameInput = page.locator('input[placeholder="New project name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(`SCN-ORD-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
    await page.waitForTimeout(500);
    await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
    await page.waitForTimeout(300);
    const roomInput = page.locator('input[placeholder="New room type name"]').first();
    await expect(roomInput).toBeVisible({ timeout: 5000 });
    await roomInput.fill(`SCN-Room-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
    await page.waitForTimeout(500);

    await page.locator('[role="tab"]').filter({ hasText: /^Scene$/ }).first().click();
    await page.waitForTimeout(600);

    // Add a Door Magnet row first, then a PMS row afterwards.
    await page.locator("button").filter({ hasText: /^\+ Add row$/i }).first().click().catch(() => {});
    const addStandard = page.locator('button[title="Add row"]').first();
    if (await addStandard.isVisible().catch(() => false)) {
      await addStandard.click();
    }
    await page.waitForTimeout(600);
    await page.locator('button[title="Add PMS row"]').first().click();
    await page.waitForTimeout(1800);

    const scenes = await readRoomScenes(page);
    expect(scenes.length).toBeGreaterThan(2);
    const lastPmsIndex = scenes.map(isPms).lastIndexOf(true);
    const firstStandardIndex = scenes.map(isPms).indexOf(false);
    // Every PMS scene (including the one added last) comes before every
    // Door Magnet scene.
    expect(lastPmsIndex).toBeLessThan(firstStandardIndex);
  });
});
