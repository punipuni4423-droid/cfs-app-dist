import { test, expect, type Page } from "./support/safe-test";
import { seed, save } from "./support/scene-backlight-test-project";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";
import { readNativeDraftProject } from "./support/native-project-drafts";
import { createEmptySwitchEntry } from "../../app/lib/constants";
import type { ProjectData } from "../../app/types";

const projectId = "button-copy-ui-20261028";
function fixture(): ProjectData {
  const project = seed(); project.id = projectId; project.name = "Button Copy QA";
  const base = { ...createEmptySwitchEntry("lutronPd"), buttonCount: "2" };
  project.roomTypes[0].switches = [
    { ...base, id: "source-1", switchGroupId: "source", switchNumber: "SRC", switchName: "Source panel", buttonLabel: "M1", buttonFunction: "Arrival", condition: "Occupied", isPriorityFunction: true, buttonSetting: { sceneId: "", sceneIds: [], circuitSettings: [{ circuitId: "t140-light", percentage: "Occupied:50%\nVacant:Off", valueMode: "text" }] }, backlightTarget: "target", backlightCondition: "masterOn" },
    { ...base, id: "source-2", switchGroupId: "source", switchNumber: "SRC", switchName: "Source panel", buttonLabel: "M1", buttonFunction: "Departure", condition: "Vacant", backlightTarget: "source", backlightCondition: "relax" },
    { ...base, id: "source-other", switchGroupId: "source", switchNumber: "SRC", switchName: "Source panel", buttonLabel: "M2", buttonFunction: "Keep source other" },
    { ...base, id: "target-1", switchGroupId: "target", switchNumber: "DST", switchName: "Target panel", buttonLabel: "M1", buttonFunction: "Replace me", backlightAssignment: "sleep" },
    { ...base, id: "target-other", switchGroupId: "target", switchNumber: "DST", switchName: "Target panel", buttonLabel: "M2", buttonFunction: "Keep target other", backlightAssignment: "sleep" },
  ];
  return project;
}
async function navigate(page: Page, viewOnly = false) {
  const card = page.locator("button.screen-card").filter({ hasText: "Button Copy QA" });
  const back = page.getByRole("button", { name: /Back to Project List/i }).first();
  await expect(back.or(card).first()).toBeVisible({ timeout: 60_000 });
  if (await back.isVisible()) await back.click();
  await card.click();
  const start = page.getByRole("button", { name: "Start editing", exact: true });
  if (!viewOnly && await start.isVisible()) await start.click();
  const registration = page.getByRole("dialog", { name: "User Registration", exact: true });
  if (await registration.isVisible()) { await registration.getByRole("textbox", { name: "Display name", exact: true }).fill("Button Copy QA"); await registration.getByRole("button", { name: "Register", exact: true }).click(); }
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const room = page.locator("button.screen-card").filter({ hasText: "T140 Room" });
  if (await room.isVisible()) await room.click(); else await page.getByRole("tab", { name: "T140 Room", exact: true }).click();
  await page.getByRole("tab", { name: "Switch", exact: true }).click();
  await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
}
async function setup(page: Page, viewOnly = false) {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.context().route("**/api/**", route => route.fulfill({ json: {} }));
  const state = await installLocalEditingMocks(page); state.projects = [fixture() as unknown as Record<string, unknown>];
  if (viewOnly) await page.context().route("**/api/collaboration/status**", route => route.fulfill({ json: { enabled: true, mode: "view", lock: null, locks: [], lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20000, idleMs: 900000 } }));
  await page.goto("/"); await navigate(page, viewOnly); return state;
}
const openCopy = (page: Page) => buttonRow(page, "SRC / M1").getByRole("button", { name: "Copy Button", exact: true });
const band = (page: Page) => page.locator(".switch-copy-band");
const cancelCopy = (page: Page) => page.getByTitle("Clear copied settings", { exact: true });
const selectedBulkRows = (page: Page) => page.locator(".switch-table tbody tr").getByRole("checkbox", { name: "Select row for bulk setting", exact: true, checked: true });
const buttonIds: Record<string, string> = { "SRC / M1": "source-1", "SRC / M2": "source-other", "DST / M1": "target-1", "DST / M2": "target-other" };
const buttonRow = (page: Page, label: string) => page.locator(`.switch-table tr[data-switch-row-id="${buttonIds[label]}"]`);
const pasteButton = (page: Page, label: string) => buttonRow(page, label).getByRole("button", { name: "Paste Button", exact: true });
const draftRows = async (page: Page) => (await readNativeDraftProject(page, projectId))?.roomTypes[0].switches;

test("re-pressing each active Copy clears its paste options and keeps the table in place", async ({ page }) => {
  await setup(page);
  const table = page.locator(".switch-table");
  const source = buttonRow(page, "SRC / M1");
  const destination = buttonRow(page, "DST / M1");
  const checked = destination.getByRole("checkbox", { name: "Select row for bulk setting", exact: true });
  const position = () => table.evaluate(element => {
    const { y, height } = element.getBoundingClientRect();
    const scroller = element.closest(".matrix-scroll");
    return { y, height, scrollY, x: scroller?.scrollLeft, top: scroller?.scrollTop };
  });

  for (const [copyLabel, pasteLabel] of [
    ["Copy Function", "Paste Function"],
    ["Copy Button", "Paste Button"],
    ["Copy Switch Settings", "Paste Switch Settings"],
  ]) {
    const copy = source.getByRole("button", { name: copyLabel, exact: true });
    const paste = destination.getByRole("button", { name: pasteLabel, exact: true });
    await copy.scrollIntoViewIfNeeded();
    await expect(copy).toHaveAttribute("aria-pressed", "false");
    await expect(paste).toBeDisabled();
    await copy.click();
    await expect(copy).toHaveAttribute("aria-pressed", "true");
    await expect(paste).toBeEnabled();
    if (pasteLabel !== "Paste Switch Settings") {
      await checked.check();
      await expect(page.getByRole("button", { name: `${pasteLabel} to 1 row`, exact: true })).toBeEnabled();
      await expect(paste).toHaveCount(0);
    }
    await copy.scrollIntoViewIfNeeded();
    const before = await position();
    await copy.press("Space");
    await expect(copy).toHaveAttribute("aria-pressed", "false");
    await expect(cancelCopy(page)).toBeDisabled();
    await expect(paste).toBeDisabled();
    await expect(page.getByRole("button", { name: `${pasteLabel} to 1 row`, exact: true })).toHaveCount(0);
    expect(await position()).toEqual(before);
    if (pasteLabel !== "Paste Switch Settings") {
      await expect(checked).toBeChecked();
      await checked.uncheck();
    }
  }
});

test("explicit button destinations cancel safely, replace all functions, Undo/Redo and save/reload", async ({ page }, info) => {
  test.setTimeout(150_000);
  const state = await setup(page); const original = fixture().roomTypes[0].switches;
  await openCopy(page).click();
  await expect(openCopy(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog", { name: "Copy Button Settings", exact: true })).toHaveCount(0);
  await expect(page.locator(".switch-table tbody tr").getByRole("button", { name: "Paste Button", exact: true }).and(page.locator(":enabled"))).toHaveCount(3);
  await expect(pasteButton(page, "SRC / M1")).toBeDisabled();
  await expect(pasteButton(page, "DST / M1")).toBeEnabled();
  await expect(page.locator(".switch-table tbody tr").nth(1).getByRole("button", { name: "Paste Button", exact: true })).toHaveCount(0);
  await buttonRow(page, "DST / M1").getByRole("checkbox", { name: "Select row for bulk setting" }).check();
  await expect(page.getByRole("button", { name: "Paste Button to 1 row", exact: true })).toBeEnabled();
  await expect(pasteButton(page, "DST / M1")).toHaveCount(0);
  await expect(pasteButton(page, "DST / M2")).toBeEnabled();
  await cancelCopy(page).click();
  await expect(openCopy(page)).toHaveAttribute("aria-pressed", "false");
  await expect(cancelCopy(page)).toBeDisabled();
  expect((state.projects[0] as unknown as ProjectData).roomTypes[0].switches).toEqual(original);
  await buttonRow(page, "DST / M2").getByRole("button", { name: "Copy Button", exact: true }).click();
  await expect(buttonRow(page, "DST / M2").getByRole("button", { name: "Copy Button", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(band(page)).toHaveCount(0);
  await expect(pasteButton(page, "DST / M2")).toBeDisabled();
  await cancelCopy(page).click();
  await buttonRow(page, "DST / M1").getByRole("checkbox", { name: "Select row for bulk setting" }).uncheck();
  await openCopy(page).click();
  await expect(selectedBulkRows(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Paste Button to .* rows/ })).toHaveCount(0);
  await expect(pasteButton(page, "DST / M1")).toBeEnabled();
  await page.screenshot({ path: info.outputPath("explicit-destination.png"), fullPage: true });
  await pasteButton(page, "DST / M1").click();
  await expect(openCopy(page)).toHaveAttribute("aria-pressed", "false");
  await expect(cancelCopy(page)).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "Copy Button Settings", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await draftRows(page))?.filter(row => row.switchGroupId === "target" && row.buttonLabel === "M1").length).toBe(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await draftRows(page))?.find(row => row.id === "target-1")?.buttonFunction).toBe("Replace me");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await draftRows(page))?.find(row => row.id === "target-1")?.buttonFunction).toBe("Arrival");
  await save(page);
  const saved = (state.projects[0] as unknown as ProjectData).roomTypes[0].switches;
  const target = saved.filter(row => row.switchGroupId === "target" && row.buttonLabel === "M1");
  expect(target.map(row => row.buttonFunction)).toEqual(["Arrival", "Departure"]);
  expect(target[0].buttonSetting.circuitSettings[0]).toEqual(original[0].buttonSetting.circuitSettings[0]);
  expect(target[0]).toMatchObject({ id: "target-1", switchNumber: "DST", switchName: "Target panel", buttonLabel: "M1", backlightAssignment: "sleep", condition: "Occupied", backlightTarget: "", backlightCondition: "masterOn" });
  for (const id of ["source-1", "source-2", "source-other", "target-other"]) expect(saved.find(row => row.id === id)).toEqual(original.find(row => row.id === id));
  await page.reload(); await navigate(page);
  await expect(page.locator(".switch-table")).toContainText("Arrival");
  await openCopy(page).click();
  await expect(selectedBulkRows(page)).toHaveCount(0);
  await page.keyboard.press("Escape"); await expect(cancelCopy(page)).toBeEnabled();
  await cancelCopy(page).click(); await expect(band(page)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("copied-buttons-after-reload.png"), fullPage: true });
});

test("readonly mode disables button copy without changing data", async ({ page }) => {
  test.setTimeout(90000);
  const state = await setup(page, true); const before = JSON.stringify(state.projects);
  await expect(openCopy(page)).toBeDisabled();
  expect(JSON.stringify(state.projects)).toBe(before);
});

test("pending project save disables button copy until the save completes", async ({ page }) => {
  test.setTimeout(90000);
  const state = await setup(page);
  await page.getByRole("textbox", { name: "Trigger Condition", exact: true }).first().fill("Occupied pending save");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const received = new Promise<void>(resolve => { entered = resolve; });
  await page.context().route("**/api/projects", async route => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    entered(); await pending; await route.fallback();
  });
  try {
    await openCopy(page).click();
    await buttonRow(page, "DST / M1").getByRole("checkbox", { name: "Select row for bulk setting" }).check();
    // Simulate an overlapping save already queued elsewhere in the app while
    // the dialog is open; no private React state or application handler access.
    await page.getByRole("button", { name: "Save current project without a new revision", exact: true }).dispatchEvent("click");
    await received;
    await expect(openCopy(page)).toBeDisabled();
    await expect(pasteButton(page, "DST / M1")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Paste Button to 1 row", exact: true })).toBeDisabled();
    expect((state.projects[0] as unknown as ProjectData).roomTypes[0].switches).toEqual(fixture().roomTypes[0].switches);
  } finally { release(); }
  await expect(openCopy(page)).toBeEnabled();
  await cancelCopy(page).click();
});


test("Function clipboard survives Switch tabs and supports direct or checked Paste", async ({ page }) => {
  await setup(page);
  const table = page.locator(".switch-table");
  const destinationOne = buttonRow(page, "DST / M1");
  const destinationTwo = buttonRow(page, "DST / M2");
  const destinationThree = buttonRow(page, "SRC / M2");
  const source = table.locator('tr[data-switch-row-id="source-2"]');
  const copy = source.getByRole("button", { name: "Copy Function", exact: true });
  await copy.scrollIntoViewIfNeeded();
  const tablePosition = () => table.evaluate(element => {
    const { y, height } = element.getBoundingClientRect();
    return { y, height, scrollY: window.scrollY, tableScroll: element.closest(".matrix-scroll")?.scrollTop };
  });
  const before = await tablePosition();
  const border = await copy.evaluate(element => getComputedStyle(element).borderColor);
  await copy.click();
  await expect(copy).toHaveAttribute("aria-pressed", "true");
  await expect(cancelCopy(page)).toBeEnabled();
  await expect(band(page)).toHaveCount(0);
  await expect(table.locator(".switch-operation-stack .action-icon-label")).toHaveCount(0);
  await expect(copy).toHaveAttribute("title", "Copy Function");
  await expect.poll(() => copy.evaluate(element => getComputedStyle(element).borderColor)).not.toBe(border);
  expect(await tablePosition()).toEqual(before);
  for (const kind of ["CCI", "Pico", "PIR", "QSM", "Thermostat"]) {
    await page.getByRole("tab", { name: kind, exact: true }).click();
    await expect(band(page)).toHaveCount(0);
    await expect(cancelCopy(page)).toBeEnabled();
    await expect(table.getByRole("button", { name: "Paste Function", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "Palladiom", exact: true }).click();
  await expect(source.getByRole("button", { name: "Paste Function", exact: true })).toBeDisabled();
  const check = (row: ReturnType<typeof buttonRow>) => row.getByRole("checkbox", { name: "Select row for bulk setting", exact: true });
  await check(destinationTwo).check();
  await check(destinationThree).check();
  const directPaste = destinationOne.getByRole("button", { name: "Paste Function", exact: true });
  await expect(directPaste).toHaveAttribute("title", "Paste Function");
  const beforeSelection = await tablePosition();
  await check(destinationOne).check();
  await expect(directPaste).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paste Function to 3 rows", exact: true })).toBeEnabled();
  expect(await tablePosition()).toEqual(beforeSelection);
  await check(destinationOne).uncheck();
  await expect(directPaste).toBeEnabled();
  await directPaste.click();
  await expect(page.getByRole("dialog", { name: /Paste Function/ })).toHaveCount(0);
  await expect.poll(async () => (await draftRows(page))?.find(row => row.id === "target-1")).toMatchObject({
    buttonFunction: "Replace me", backlightTarget: "source", backlightCondition: "relax",
  });
  expect((await draftRows(page))?.find(row => row.id === "target-other")?.backlightCondition).toBe("");
  await expect(copy).toHaveAttribute("aria-pressed", "false");
  await expect(check(destinationOne)).not.toBeChecked();
  await expect(check(destinationTwo)).toBeChecked();
  await expect(check(destinationThree)).toBeChecked();
  await copy.click();
  await check(destinationOne).check();
  await page.getByRole("button", { name: "Paste Function to 3 rows", exact: true }).click();
  await expect(table.getByRole("checkbox", { name: "Select row for bulk setting", checked: true })).toHaveCount(0);
  await expect.poll(async () => (await draftRows(page))?.find(row => row.id === "target-other")).toMatchObject({
    buttonFunction: "Keep target other", backlightCondition: "relax",
  });
  expect((await draftRows(page))?.find(row => row.id === "source-other")).toMatchObject({
    buttonFunction: "Keep source other", backlightCondition: "relax",
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await draftRows(page))?.find(row => row.id === "target-other")?.backlightCondition).toBe("");
  await expect(cancelCopy(page)).toBeDisabled();
  await expect(band(page)).toHaveCount(0);
  await expect(table.getByRole("button", { name: "Paste Function", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
});
