import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// T-73 (2026-09-03): stepping the PDU Qty input (native spinner / arrow keys)
// flips Total PDU across 0. That used to insert/remove the .pdu-warning band
// above the tables and shift the whole layout by ~62px on every press. The
// warning now keeps its layout slot while hidden (shared utility class
// .layout-reserved-hidden), so the tables and the window scroll must not move.

async function isolate(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Loading projects"),
    { timeout: 20000 },
  );
}

async function createProjectAndRoomType(page: Page): Promise<void> {
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(`PDU-SCROLL-${Date.now()}`);
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

// Step the Qty input the way a user does: click the native spinner arrows.
// If the spinner geometry misses in some environment (value unchanged), fall
// back to programmatic stepUp/stepDown, which drives the same onChange path.
async function stepQty(
  page: Page,
  qty: ReturnType<Page["locator"]>,
  direction: "up" | "down",
): Promise<void> {
  const before = await qty.inputValue();
  const box = await qty.boundingBox();
  if (box) {
    await page.mouse.click(
      box.x + box.width - 12,
      box.y + box.height * (direction === "up" ? 0.28 : 0.75),
    );
    await page.waitForTimeout(250);
    if ((await qty.inputValue()) !== before) return;
  }
  await qty.evaluate((el, dir) => {
    const input = el as HTMLInputElement;
    if (dir === "up") input.stepUp();
    else input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, direction);
  await page.waitForTimeout(250);
}

async function warningVisibility(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector(".pdu-warning");
    return el ? getComputedStyle(el).visibility : "missing";
  });
}

async function layoutProbe(page: Page): Promise<{ scrollY: number; tableTop: number }> {
  return page.evaluate(() => {
    const table = document.querySelector(".pdu-table");
    return {
      scrollY: window.scrollY,
      tableTop: table ? Math.round(table.getBoundingClientRect().top * 10) / 10 : Number.NaN,
    };
  });
}

test.describe("PDU Qty stepper layout stability (T-73)", () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });
  test.setTimeout(120000);

  test("warning band keeps its slot and stepping Qty never shifts layout or scroll", async ({ page }) => {
    await isolate(page);
    await createProjectAndRoomType(page);
    await goToPduTab(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // The warning element must occupy its layout slot even while inactive.
    expect(await warningVisibility(page)).toBe("hidden");

    const qty = page.locator(".pdu-qty-input").first();
    await expect(qty).toBeVisible({ timeout: 8000 });
    const before = await layoutProbe(page);
    expect(Number.isNaN(before.tableTop)).toBe(false);

    // Step up: total goes negative -> warning becomes visible, layout unmoved.
    await stepQty(page, qty, "up");
    await expect(qty).toHaveValue("1", { timeout: 5000 });
    await page.waitForTimeout(300);
    expect(await warningVisibility(page)).toBe("visible");
    let probe = await layoutProbe(page);
    expect(probe.scrollY).toBe(before.scrollY);
    expect(Math.abs(probe.tableTop - before.tableTop)).toBeLessThanOrEqual(1);

    // Step down: total returns to 0 -> warning hides again, layout unmoved.
    await stepQty(page, qty, "down");
    await expect(qty).toHaveValue("", { timeout: 5000 });
    await page.waitForTimeout(300);
    expect(await warningVisibility(page)).toBe("hidden");
    probe = await layoutProbe(page);
    expect(probe.scrollY).toBe(before.scrollY);
    expect(Math.abs(probe.tableTop - before.tableTop)).toBeLessThanOrEqual(1);

    // Rapid alternation (spinner-mashing equivalent) stays stable throughout.
    for (let i = 0; i < 4; i += 1) {
      await stepQty(page, qty, i % 2 === 0 ? "up" : "down");
      probe = await layoutProbe(page);
      expect(probe.scrollY).toBe(before.scrollY);
      expect(Math.abs(probe.tableTop - before.tableTop)).toBeLessThanOrEqual(1);
    }
  });
});
