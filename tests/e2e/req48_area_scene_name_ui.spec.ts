import { expect, test } from "./support/safe-test";
import { seed, save, tab } from "./support/scene-backlight-test-project";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { createEmptyScene } from "../../app/lib/constants";
import type { ProjectData } from "../../app/types";

test("blank Area Scene name shows a placeholder and a typed name persists", async ({ page }) => {
  const project = seed();
  const room = project.roomTypes[0];
  const scene = { ...createEmptyScene(project.locations[0].id), id: "unnamed",
    settings: [{ circuitId: project.circuits[0].id, percentage: "30" }] };
  room.scenes = [scene];
  room.roomScenes[0] = { ...room.roomScenes[0], settings: [], areaSceneSelections: [{ areaId: scene.areaId, sceneId: scene.id }] };
  const state = await installLocalEditingMocks(page);
  state.projects = [project as unknown as Record<string, unknown>];
  await page.goto("/");
  await page.locator("button.screen-card").filter({ hasText: project.name }).click();
  const edit = page.getByRole("button", { name: "Start editing", exact: true });
  if (await edit.isVisible()) await edit.click();
  const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
  if (await registration.isVisible()) {
    await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Area Scene QA");
    await registration.getByRole("button", { name: "Register", exact: true }).click();
  }
  await tab(page, "Room Type");
  await page.locator("button.screen-card").filter({ hasText: room.name }).click();
  await tab(page, "Area Scene");
  const name = page.getByRole("textbox", { name: "Area Scene name", exact: true });
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("placeholder", "Scene 1");
  await expect(page.getByText("Name is empty: CFS shows only the value", { exact: true })).toBeVisible();
  await name.fill("Repro Scene A");
  await expect(page.getByText("Name is empty: CFS shows only the value", { exact: true })).toHaveCount(0);
  await tab(page, "CFS");
  await expect(page.locator("table.cfs-matrix-table tbody")).toContainText("Repro Scene A");
  await tab(page, "Area Scene");
  await expect(name).toHaveValue("Repro Scene A");
  await save(page);
  const saved = state.projects[0] as unknown as ProjectData;
  expect(saved.roomTypes[0].scenes.find(item => item.id === scene.id)?.name).toBe("Repro Scene A");
  await page.reload();
  const projectCard = page.locator("button.screen-card").filter({ hasText: project.name });
  const cfsTab = page.getByRole("tab", { name: "CFS", exact: true });
  await expect(projectCard.or(cfsTab)).toBeVisible();
  if (await projectCard.isVisible()) {
    await projectCard.click();
    await tab(page, "Room Type");
    await page.locator("button.screen-card").filter({ hasText: room.name }).click();
  }
  await tab(page, "Area Scene");
  await expect(name).toHaveValue("Repro Scene A");
  await cfsTab.click();
  await expect(page.locator("table.cfs-matrix-table tbody")).toContainText("Repro Scene A");
});
