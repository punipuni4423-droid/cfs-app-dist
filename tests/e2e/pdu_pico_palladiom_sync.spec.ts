import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { STORAGE_KEY } from "../../app/lib/constants";

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";

// PDU tab pico/Palladiom linkage (2026-08-24):
// - PrivacyPico is a PDU device row (-1 PDU) linked two-way with Privacy picos
//   on the Switch tab (M1 MUR / M2 DND group).
// - CorridorPico counts only non-privacy pico groups (also -1 PDU).
// - Palladiom quantity counts physical keypads (per switch number), not
//   switch groups, so upper/lower halves sharing a number count once.

interface ApiSwitchEntry {
  id: string;
  switchGroupId?: string;
  kind: string;
  switchNumber: string;
  buttonCount: string;
  buttonLabel: string;
  buttonFunction: string;
}

interface ApiRoomType {
  switches?: ApiSwitchEntry[];
  [key: string]: unknown;
}

interface ApiProject {
  id: string;
  roomTypes?: ApiRoomType[];
  [key: string]: unknown;
}

// In local mock mode the app persists to localStorage first; read it before
// falling back to /api/projects (same approach as _audit_07_switches.spec.ts).
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

async function createProjectAndRoomType(page: Page): Promise<void> {
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(`PDU-SYNC-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
  await page.waitForTimeout(500);
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(`PDU-Room-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  await page.waitForTimeout(500);
}

async function goToPduTab(page: Page): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /^PDU$/ }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator(".pdu-view")).toBeVisible({ timeout: 8000 });
  const showReserved = page.locator("button").filter({ hasText: /^Show Reserved$/ }).first();
  if (await showReserved.isVisible().catch(() => false)) {
    await showReserved.click();
    await page.waitForTimeout(200);
  }
}

function pduRow(page: Page, model: string) {
  return page.locator(".pdu-table tbody tr").filter({ hasText: model }).first();
}

async function readSwitches(page: Page): Promise<ApiSwitchEntry[]> {
  const projects = await apiGetProjects(page);
  return projects[0]?.roomTypes?.[0]?.switches ?? [];
}

// UI edits reach /api/projects via a 1200ms debounced autosave; poll instead
// of guessing the flush timing.
async function waitForSwitches(
  page: Page,
  predicate: (switches: ApiSwitchEntry[]) => boolean,
): Promise<ApiSwitchEntry[]> {
  let latest: ApiSwitchEntry[] = [];
  for (let i = 0; i < 30; i += 1) {
    latest = await readSwitches(page);
    if (predicate(latest)) return latest;
    await page.waitForTimeout(400);
  }
  return latest;
}

async function waitForApiProjectWithRoom(page: Page): Promise<ApiProject[]> {
  for (let i = 0; i < 30; i += 1) {
    const projects = await apiGetProjects(page);
    if (projects[0]?.roomTypes?.[0]) return projects;
    await page.waitForTimeout(400);
  }
  throw new Error("room type never reached /api/projects");
}

test.describe("PDU pico / Palladiom sync", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(180000);

  test("PrivacyPico row syncs two-way with Privacy picos and stays apart from CorridorPico", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoomType(page);
    await waitForApiProjectWithRoom(page);
    await goToPduTab(page);

    // Both special picos are listed at -1 PDU per unit.
    const privacyRow = pduRow(page, "PrivacyPico");
    const corridorRow = pduRow(page, "CorridorPico");
    await expect(privacyRow).toBeVisible({ timeout: 8000 });
    await expect(privacyRow.locator("td").nth(1)).toHaveText("-1");
    await expect(corridorRow.locator("td").nth(1)).toHaveText("-1");

    // PDU -> Switch: quantity 1 creates one Privacy pico group (M1 MUR / M2 DND).
    await privacyRow.locator(".pdu-qty-input").fill("1");
    let switches = await waitForSwitches(page, (rows) =>
      rows.some((sw) => sw.kind === "lutronPico" && sw.buttonCount === "Privacy"),
    );
    const privacyRows = switches.filter((sw) => sw.kind === "lutronPico" && sw.buttonCount === "Privacy");
    expect(privacyRows).toHaveLength(2);
    expect(privacyRows.map((sw) => sw.buttonLabel).sort()).toEqual(["M1", "M2"]);
    expect(privacyRows.map((sw) => sw.buttonFunction).sort()).toEqual(["DND", "MUR"]);
    expect(new Set(privacyRows.map((sw) => sw.switchGroupId || sw.id)).size).toBe(1);

    // CorridorPico stays independent: its quantity is still 0.
    await expect(corridorRow.locator(".pdu-qty-input")).toHaveValue("");

    // Corridor quantity 1 adds a corridor pico without touching the privacy group.
    await corridorRow.locator(".pdu-qty-input").fill("1");
    switches = await waitForSwitches(page, (rows) =>
      rows.some((sw) => sw.kind === "lutronPico" && sw.buttonCount !== "Privacy"),
    );
    expect(switches.filter((sw) => sw.kind === "lutronPico" && sw.buttonCount === "Privacy")).toHaveLength(2);
    expect(switches.filter((sw) => sw.kind === "lutronPico" && sw.buttonCount !== "Privacy").length).toBeGreaterThan(0);

    // Switch -> PDU: quantities survive a reload because they are derived from switches.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await goToPduTab(page);
    await expect(pduRow(page, "PrivacyPico").locator(".pdu-qty-input")).toHaveValue("1");
    await expect(pduRow(page, "CorridorPico").locator(".pdu-qty-input")).toHaveValue("1");

    // Privacy quantity 0 removes only the privacy group.
    await pduRow(page, "PrivacyPico").locator(".pdu-qty-input").fill("0");
    switches = await waitForSwitches(page, (rows) =>
      rows.every((sw) => !(sw.kind === "lutronPico" && sw.buttonCount === "Privacy")),
    );
    expect(switches.filter((sw) => sw.kind === "lutronPico" && sw.buttonCount === "Privacy")).toHaveLength(0);
    expect(switches.filter((sw) => sw.kind === "lutronPico").length).toBeGreaterThan(0);
  });

  test("Palladiom quantity counts keypads per switch number", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoomType(page);

    // Inject two Palladiom groups sharing SW-3 (upper/lower halves) plus SW-1:
    // 3 switch groups, but only 2 physical keypads.
    const projects = await waitForApiProjectWithRoom(page);
    expect(projects).toHaveLength(1);
    // Park the UI on about:blank so autosave does not overwrite the injection.
    await page.waitForTimeout(1800);
    await page.goto("about:blank");
    const roomType = projects[0].roomTypes?.[0] as ApiRoomType;
    const pd = (id: string, group: string, switchNumber: string, label: string): Record<string, unknown> => ({
      id,
      switchGroupId: group,
      kind: "lutronPd",
      switchNumber,
      switchName: `Keypad ${switchNumber}`,
      cciAssignment: "",
      buttonCount: "1",
      buttonLabel: label,
      allocation: "",
      buttonFunction: "",
      buttonType: "single",
      condition: "",
      buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [] },
      backlightTarget: "",
      backlightCondition: "",
      backlightAssignment: "",
    });
    roomType.switches = [
      pd("pd-1", "grp-1", "SW-1", "M1"),
      pd("pd-2", "grp-2", "SW-3", "M1"),
      pd("pd-3", "grp-3", "SW-3", "M1"),
    ] as unknown as ApiSwitchEntry[];
    await apiPutProjects(page, projects);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    // The app may reopen the last project automatically; only click the card
    // when the project list is showing.
    const roomTypeTab = page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first();
    if (!(await roomTypeTab.isVisible().catch(() => false))) {
      await page.locator("button").filter({ hasText: /PDU-SYNC-/ }).first().click();
      await expect(roomTypeTab).toBeVisible({ timeout: 10000 });
    }
    await page.waitForTimeout(400);
    await goToPduTab(page);
    await expect(pduRow(page, "Palladiom Keypad").locator(".pdu-qty-input")).toHaveValue("2");
  });
});
