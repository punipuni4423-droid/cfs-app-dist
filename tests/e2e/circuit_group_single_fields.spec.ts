import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { STORAGE_KEY } from "../../app/lib/constants";

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

// Circuit group single-value fields (2026-08-24): one circuit (Designer #)
// carries exactly one Designer #, Internal #, Dimming Type, Area, FFE,
// Energy Save, and Detail. Editing any of them on a multi-row group updates
// every row of the group.

interface ApiCircuit {
  id: string;
  circuitGroupId: string;
  designerNumber: string;
  internalNumber: string;
  dimmingType: string;
  area: string;
  detail: string;
  ffe: boolean;
  energySaving: boolean;
}

interface ApiProject {
  id: string;
  circuits?: ApiCircuit[];
  roomTypes?: unknown[];
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

async function waitForCircuits(
  page: Page,
  predicate: (circuits: ApiCircuit[]) => boolean,
): Promise<ApiCircuit[]> {
  let latest: ApiCircuit[] = [];
  for (let i = 0; i < 30; i += 1) {
    const projects = await apiGetProjects(page);
    latest = (projects[0]?.circuits ?? []) as ApiCircuit[];
    if (predicate(latest)) return latest;
    await page.waitForTimeout(400);
  }
  return latest;
}

test.describe("Circuit group single-value fields", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("editing internal #, detail, and FFE on a two-row group updates both rows", async ({ page }) => {
    await isolate(page);

    const nameInput = page.locator('input[placeholder="New project name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15000 });
    await nameInput.fill(`CIR-GRP-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
    await page.waitForTimeout(500);
    await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
    await page.waitForTimeout(300);
    const roomInput = page.locator('input[placeholder="New room type name"]').first();
    await expect(roomInput).toBeVisible({ timeout: 5000 });
    await roomInput.fill(`CIR-Room-${Date.now()}`);
    await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
    await page.waitForTimeout(500);

    await page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first().click();
    await page.waitForTimeout(400);

    // One group with two load rows.
    await page.locator("button").filter({ hasText: /Add Row/ }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".btn-add-circuit").first().click();
    await page.waitForTimeout(400);

    await waitForCircuits(page, (rows) => rows.length === 2);

    // Internal # renders once per group (single input) and syncs to both rows.
    const table = page.locator(".matrix-table").first();
    const internalCell = table.locator("tbody tr").first().locator("td").nth(3);
    await internalCell.locator("textarea").fill("IN-01");
    let circuits = await waitForCircuits(page, (rows) =>
      rows.length === 2 && rows.every((c) => c.internalNumber === "IN-01"),
    );
    expect(circuits.map((c) => c.internalNumber)).toEqual(["IN-01", "IN-01"]);

    // FFE checkbox appears once per group and syncs to both rows.
    const ffeBoxes = table.locator('input[aria-label="FFE"]');
    await expect(ffeBoxes).toHaveCount(1);
    await ffeBoxes.first().check();
    circuits = await waitForCircuits(page, (rows) =>
      rows.length === 2 && rows.every((c) => c.ffe),
    );
    expect(circuits.every((c) => c.ffe)).toBe(true);

    // Detail combobox appears once per group and syncs to both rows.
    const detailInputs = table.locator('[aria-label="Detail"] input, input[aria-label="Detail"]');
    await expect(detailInputs).toHaveCount(1);
    await detailInputs.first().fill("Ceiling Indirect");
    await detailInputs.first().blur();
    circuits = await waitForCircuits(page, (rows) =>
      rows.length === 2 && rows.every((c) => c.detail === "Ceiling Indirect"),
    );
    expect(circuits.map((c) => c.detail)).toEqual(["Ceiling Indirect", "Ceiling Indirect"]);

    // Energy Save also renders once per group.
    await expect(table.locator('input[aria-label="Energy Save"]')).toHaveCount(1);
  });
});
