import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

// Visual capture for the unified top bar + single-scroll layout. Run on
// demand; artifacts land in test-results/topbar-visual.

const OUT = "test-results/topbar-visual";

async function apiPutProjects(page: Page, projects: unknown[]): Promise<void> {
  if (page.url() === "about:blank") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await page.evaluate(async ({ nextProjects }) => {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects: nextProjects }),
    });
  }, { nextProjects: projects });
}

test("capture unified top bar layout", async ({ page }) => {
  test.setTimeout(120000);
  await installLocalEditingMocks(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("about:blank");
  await apiPutProjects(page, []);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.textContent?.includes("Loading projects"), { timeout: 20000 });

  await page.locator('input[placeholder="New project name"]').first().fill(`TopBar-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/01-project-top.png` });

  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="New room type name"]').first().fill(`Room-${Date.now()}`);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/02-roomtype.png` });

  await page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.scene-area-chip:has-text("Palladiom")').first().click();
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i += 1) {
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${OUT}/03-switch-tab.png` });

  const switchMetrics = await page.evaluate(() => {
    const el = document.querySelector(".resizable-matrix-scroll");
    const rect = el?.getBoundingClientRect();
    return {
      pageScrollable: document.documentElement.scrollHeight - window.innerHeight,
      scroller: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), inner: window.innerHeight } : null,
    };
  });
  console.log("SWITCH_METRICS", JSON.stringify(switchMetrics));

  await page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/04-cfs-tab.png` });
  await page.waitForTimeout(1500);
  const cfsMetrics = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".cfs-matrix-scroll");
    const rect = el?.getBoundingClientRect();
    return {
      pageScrollable: document.documentElement.scrollHeight - window.innerHeight,
      inlineBlockSize: el?.style.blockSize ?? null,
      computedHeight: el ? Math.round(Number.parseFloat(getComputedStyle(el).height)) : null,
      scroller: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), inner: window.innerHeight } : null,
      mainBottom: Math.round(el?.closest("main")?.getBoundingClientRect().bottom ?? -1),
      mainPad: el ? getComputedStyle(el.closest("main")!).paddingBottom : null,
      cardBottom: Math.round(el?.closest("section")?.getBoundingClientRect().bottom ?? -1),
      below: (() => {
        if (!el) return [];
        const all = Array.from(document.querySelectorAll("main *"));
        const bottomEdge = el.getBoundingClientRect().bottom;
        return all
          .filter((node) => {
            const r = (node as HTMLElement).getBoundingClientRect();
            return r.top >= bottomEdge - 1 && r.height > 8 && !el.contains(node);
          })
          .slice(0, 6)
          .map((node) => `${(node as HTMLElement).className}`.slice(0, 60));
      })(),
    };
  });
  console.log("CFS_METRICS", JSON.stringify(cfsMetrics));
  expect(cfsMetrics.scroller).not.toBeNull();
});
