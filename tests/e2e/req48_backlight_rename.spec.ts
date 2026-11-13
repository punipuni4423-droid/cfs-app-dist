import { expect, test } from "./support/safe-test";
import { open, save, tab } from "./support/scene-backlight-test-project";
import type { ProjectData } from "../../app/types";

test("Backlight Scene can be cleared and edited before normalization on blur", async ({ page }) => {
  const state = await open(page);
  await tab(page, "Backlight");
  const name = page.locator("table.switch-table").first().locator("tbody tr").first().getByRole("textbox");
  await expect(name).toHaveValue("Base");
  await name.fill("");
  await expect(name).toHaveValue("");
  await name.pressSequentially("Night  Mode  ");
  await expect(name).toHaveValue("Night  Mode  ");
  await name.blur();
  await expect(name).toHaveValue("Night  Mode");
  await save(page);
  const room = (state.projects[0] as unknown as ProjectData).roomTypes[0];
  expect(room.backlightLevels?.find(level => level.key === "base")?.name).toBe("Night  Mode");
  expect(room.switches.filter(row => row.kind === "lutronPd").every(row =>
    row.backlightLevels.find(level => level.key === "base")?.name === "Night  Mode")).toBe(true);
});

test("Backlight confirms with Enter and flushes focused input before Save and navigation", async ({ page }) => {
  const state = await open(page);
  await tab(page, "Backlight");
  const backlightTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "Backlight Scene", exact: true }),
  });
  const name = backlightTable.locator("tbody tr").first().getByRole("textbox");
  await name.fill("Enter  Scene  ");
  await name.press("Enter");
  await expect(name).toHaveValue("Enter  Scene");
  await expect(name).toBeFocused();

  await name.fill("Save  Scene  ");
  await expect(name).toBeFocused();
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === "/api/projects" && r.request().method() === "POST");
  const saveButton = page.getByRole("button", { name: "Save current project without a new revision", exact: true });
  await saveButton.evaluate((button: HTMLButtonElement) => button.click());
  expect((await saved).status()).toBe(200);
  await expect(page.locator(".revision-save-status")).toContainText("Saved");
  expect((state.projects[0] as unknown as ProjectData).roomTypes[0].backlightLevels?.[0].name).toBe("Save  Scene");

  await name.fill("Tab  Scene  ");
  await expect(name).toBeFocused();
  const sceneTab = page.getByRole("tab", { name: "Scene", exact: true });
  await sceneTab.evaluate((button: HTMLElement) => button.click());
  await expect(sceneTab).toHaveAttribute("aria-selected", "true");
  await expect(name).toHaveCount(0);
  await tab(page, "Backlight");
  await expect(name).toHaveValue("Tab  Scene");
});
