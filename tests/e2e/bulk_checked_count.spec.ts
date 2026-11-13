import { expect, test } from "./support/safe-test";
import { open, tab } from "./support/scene-backlight-test-project";

const screens = [
  ["Switch", "Select row for bulk setting"],
  ["Command", "Select row for bulk setting"],
  ["Scene", "Select row for bulk setting"],
  ["Backlight", "Select switch for bulk assignment"],
] as const;

for (const [name, checkboxName] of screens) {
  test(`${name} shows no checked count and keeps the buttons and table in place`, async ({ page }, info) => {
    await open(page);
    for (const width of [1280, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await tab(page, name);
      const anchor = name === "Backlight"
        ? page.getByText("Palladiom Backlight Assignment", { exact: true })
        : page.getByRole("button", { name: "Scene Setting", exact: true });
      const toolbar = page.locator(".toolbar").filter({ has: anchor });
      const count = page.getByText(/^\d+ checked$/);
      const checkbox = page.getByRole("checkbox", { name: checkboxName, exact: true }).first();
      const table = checkbox.locator("xpath=ancestor::table[1]");
      await checkbox.scrollIntoViewIfNeeded();
      // Let the tab entrance finish before measuring geometry.
      await table.evaluate(async element => {
        const card = element.closest(".fade-in");
        await Promise.allSettled(card?.getAnimations().map(animation => animation.finished) ?? []);
      });
      const position = async () => ({
        toolbar: await toolbar.boundingBox(),
        controls: await toolbar.locator("button, select").evaluateAll(controls => controls.map(control => {
          const { x, y, width, height } = control.getBoundingClientRect();
          return { x, y, width, height };
        })),
        table: await table.boundingBox(),
        scroll: await table.evaluate(element => {
          const scroller = element.closest(".matrix-scroll");
          return [scrollY, scroller?.scrollTop, scroller?.scrollLeft];
        }),
      });
      await expect(toolbar).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      await expect(count).toHaveCount(0);
      const before = await position();

      await checkbox.check();
      await expect(checkbox).toBeChecked();
      await expect(count).toHaveCount(0);
      expect(await position()).toEqual(before);
      if (width === 1280) await page.screenshot({ path: info.outputPath(`${name}-one-checked.png`) });

      await checkbox.uncheck();
      await expect(checkbox).not.toBeChecked();
      await expect(count).toHaveCount(0);
      expect(await position()).toEqual(before);
    }
  });
}
