import { test, expect, type Locator, type Page } from "./support/safe-test";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";

import { createNewProject, migrateProjectsPayload, migrateProjectsWithReport } from "../../app/lib/storage";
import type { ProjectRemark } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type MockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: MockState;

async function openFreshList(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "load" });
  await expect(page.getByPlaceholder("New project name")).toBeVisible({ timeout: 15000 });
}

async function createAndOpenProject(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder("New project name").fill(name);
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("tab", { name: "Room Type", exact: true })).toBeVisible({ timeout: 12000 });
  await expect.poll(() => mockState.projects.length).toBe(1);
}

async function openRemarks(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Remarks", exact: true }).click();
  await expect(page.getByTestId("remarks-view")).toBeVisible();
}

async function saveCurrentProject(page: Page): Promise<void> {
  const saveButton = page.getByRole("button", { name: "Save current project without a new revision" });
  await expect(saveButton).toBeEnabled({ timeout: 8000 });
  await saveButton.click();
}

async function expectColumns(note: Locator, columns: readonly string[]): Promise<void> {
  const inputs = note.locator(".remarks-column-input");
  await expect(inputs).toHaveCount(columns.length);
  for (const [index, column] of columns.entries()) {
    await expect(inputs.nth(index)).toHaveValue(column);
  }
}

test.describe.configure({ mode: "serial" });

test.describe("Remarks tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().route('**/api/**', (route) => route.fulfill({ json: {} }));
    mockState = await installLocalEditingMocks(page);
    await openFreshList(page);
  });

  test("storage migration preserves optional valid remarks and reports malformed remarks without discarding the project", () => {
    const baseProject = createNewProject("Remarks Storage");

    const withoutRemarks = migrateProjectsPayload([baseProject]);
    expect(withoutRemarks).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(withoutRemarks[0], "remarks")).toBe(false);

    const validRemark = {
      id: "remark-1",
      title: "Reference",
      body: "Line 1\nLine 2",
      hasTable: true,
      columns: ["トリガー", "条件"],
      rows: [["Door", "Night"]],
    };
    const withRemarks = migrateProjectsPayload([{ ...baseProject, remarks: [validRemark] }]);
    expect(withRemarks).toHaveLength(1);
    expect(withRemarks[0].remarks).toEqual([validRemark]);

    const malformedCollection = migrateProjectsWithReport([{ ...baseProject, remarks: "bad-shape" }]);
    expect(malformedCollection.projects).toHaveLength(1);
    expect(malformedCollection.projects[0].remarks).toEqual([]);
    expect(malformedCollection.report.repaired).toBe(1);
    const malformedElement = migrateProjectsWithReport([
        {
          ...baseProject,
          remarks: [validRemark, { ...validRemark, id: 'invalid', rows: [["Door", 1]] }],
        },
      ]);
    expect(malformedElement.projects).toHaveLength(1);
    expect(malformedElement.projects[0].remarks).toEqual([validRemark]);
    expect(malformedElement.report.excluded).toBe(1);
  });

  test("parent tabs include Remarks after Room Type and navigation restores safely", async ({ page }) => {
    await createAndOpenProject(page, "T37 Tabs");
    const projectId = String(mockState.projects[0].id);

    const primaryTabs = page.locator('[role="tablist"]').first().getByRole("tab");
    await expect(primaryTabs).toHaveText(["Area", "Fixture", "Room Type", "Remarks"]);
    expect(Object.prototype.hasOwnProperty.call(mockState.projects[0], "remarks")).toBe(false);

    await page.evaluate((id) => {
      sessionStorage.setItem(`cfs-project-navigation-v1:${id}`, JSON.stringify({ activeTab: "not-a-tab" }));
    }, projectId);
    await page.reload({ waitUntil: "load" });
    await expect(page.getByRole("tab", { name: "Room Type", exact: true })).toHaveAttribute("aria-selected", "true");

    await openRemarks(page);
    await expect(page.getByText("No remarks yet.")).toBeVisible();
    await expect(page.getByTestId("remarks-view").getByRole("button", { name: "Add Remark" })).toHaveCount(1);

    await page.reload({ waitUntil: "load" });
    await expect(page.getByRole("tab", { name: "Remarks", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("remarks-view")).toBeVisible();
  });

  test("edits notes, optional table, preview, explicit save, and reload persistence", async ({ page }, testInfo) => {
    const projectName = "T37 CRUD";
    await createAndOpenProject(page, projectName);
    await openRemarks(page);

    await page.getByTestId("remarks-view").getByRole("button", { name: "Add Remark" }).click();
    const note = page.locator(".remarks-note").first();
    await expect(note.getByLabel("Title for remark 1")).toHaveValue("Remark 1");
    await note.getByLabel("Title for remark 1").fill("Operations Note");
    await note.getByLabel("Body for remark 1").fill("Line one\nLine two\n日本語メモ");

    await note.getByRole("checkbox", { name: "Table" }).check();
    await expect(note.locator(".remarks-column-input").nth(0)).toHaveValue("Trigger");
    await note.getByLabel("Remark 1 row 1 column 1").fill("Door opens");
    await note.getByLabel("Remark 1 row 1 column 2").fill("After sunset");
    await note.getByRole("button", { name: "Add Column" }).click();
    await expect(note.locator(".remarks-column-input").last()).toHaveValue("Column 5");
    await note.getByRole("button", { name: "Remove column 5" }).click();
    await expect(note.locator(".remarks-column-input")).toHaveCount(4);
    await note.getByRole("button", { name: "Add Row" }).click();
    await expect(note.locator("tbody tr")).toHaveCount(2);
    await note.getByRole("button", { name: "Remove row 2" }).click();
    await expect(note.locator("tbody tr")).toHaveCount(1);

    await note.getByRole("checkbox", { name: "Table" }).uncheck();
    await expect(note.locator("table")).toHaveCount(0);
    await note.getByRole("checkbox", { name: "Table" }).check();
    await expect(note.getByLabel("Remark 1 row 1 column 1")).toHaveValue("Door opens");

    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await expect(page.locator(".remarks-preview-note").first()).toContainText("Operations Note");
    await expect(page.locator(".remarks-preview-note").first()).toContainText("日本語メモ");
    await page.screenshot({ path: testInfo.outputPath("remarks-preview.png"), fullPage: true });

    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    await saveCurrentProject(page);
    await expect
      .poll(() => JSON.stringify(mockState.projects[0]?.remarks ?? []), { timeout: 8000 })
      .toContain("Operations Note");

    await page.reload({ waitUntil: "load" });
    await expect(page.getByRole("tab", { name: "Remarks", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Title for remark 1")).toHaveValue("Operations Note");
    await expect(page.getByLabel("Body for remark 1")).toHaveValue("Line one\nLine two\n日本語メモ");
    await expect(page.getByLabel("Remark 1 row 1 column 1")).toHaveValue("Door opens");
  });

  test("all table presets insert English headings repeatedly and preserve them after save and reload", async ({ page }, testInfo) => {
    await createAndOpenProject(page, "T94 English Presets");
    await openRemarks(page);
    const presets = [
      { label: "Flow", columns: ["Trigger", "Condition", "Action", "Result"] },
      { label: "Variable", columns: ["Variable", "State", "Action"] },
      { label: "Rationale", columns: ["Target", "Value", "Rationale"] },
      { label: "Legend", columns: ["Symbol", "Meaning"] },
    ];

    for (const [index, preset] of presets.entries()) {
      await page.getByTestId("remarks-view").getByRole("button", { name: "Add Remark" }).click();
      const note = page.locator(".remarks-note").nth(index);
      await note.getByLabel(`Title for remark ${index + 1}`).fill(preset.label);
      await note.getByRole("checkbox", { name: "Table", exact: true }).check();
      await expectColumns(note, presets[0].columns);
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await note.getByRole("button", { name: preset.label, exact: true }).click();
        await expectColumns(note, preset.columns);
        await expect(note.locator("tbody tr")).toHaveCount(1);
        await expect(note.getByLabel(`Remark ${index + 1} row 1 column 1`)).toHaveValue("");
        await note.getByLabel(`Remark ${index + 1} row 1 column 1`).fill(`${preset.label} example`);
      }
    }

    await saveCurrentProject(page);
    await expect.poll(() => (mockState.projects[0]?.remarks as ProjectRemark[] | undefined)?.map((remark) => remark.columns))
      .toEqual(presets.map((preset) => preset.columns));
    await page.reload({ waitUntil: "load" });
    await openRemarks(page);
    for (const [index, preset] of presets.entries()) {
      await expectColumns(page.locator(".remarks-note").nth(index), preset.columns);
      await expect(page.getByLabel(`Remark ${index + 1} row 1 column 1`)).toHaveValue(`${preset.label} example`);
    }
    for (const width of [1800, 1100]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: testInfo.outputPath(`english-presets-${width}.png`), fullPage: true });
    }
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    for (const [index, preset] of presets.entries()) {
      await expect(page.locator(".remarks-preview-note").nth(index).locator("thead th")).toHaveText(preset.columns);
    }
    await page.screenshot({ path: testInfo.outputPath("english-presets-preview.png"), fullPage: true });
  });

  test("saved Japanese headings and cell values survive toggles, duplication, unrelated edits, and reload", async ({ page }) => {
    const original: ProjectRemark = {
      id: "legacy-remark",
      title: "Saved Japanese Table",
      body: "Existing body",
      hasTable: true,
      columns: ["トリガー", "条件", "動作", "結果"],
      rows: [["ドア", "夜間", "点灯", "完了"]],
    };
    const legacy = { ...createNewProject("T94 Existing Japanese"), remarks: [original] };
    const protectedFields = Object.fromEntries(Object.entries(legacy).filter(([key]) => !["remarks", "updatedAt"].includes(key)));
    mockState.projects = [structuredClone(legacy)];
    await page.reload({ waitUntil: "load" });
    await page.locator("button.screen-card").filter({ hasText: legacy.name }).click();
    await openRemarks(page);
    const first = page.locator(".remarks-note").first();
    await expectColumns(first, original.columns);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await first.getByRole("checkbox", { name: "Table", exact: true }).uncheck();
      await expect(first.locator("table")).toHaveCount(0);
      await first.getByRole("checkbox", { name: "Table", exact: true }).check();
      await expectColumns(first, original.columns);
    }
    await first.getByLabel("Body for remark 1").fill("Updated body only");
    await first.getByRole("button", { name: "Duplicate remark", exact: true }).click();
    await expectColumns(page.locator(".remarks-note").nth(1), original.columns);
    await page.getByTestId("remarks-view").getByRole("button", { name: "Add Remark" }).click();
    const added = page.locator(".remarks-note").nth(2);
    await added.getByRole("checkbox", { name: "Table", exact: true }).check();
    await added.getByRole("button", { name: "Legend", exact: true }).click();
    await expectColumns(added, ["Symbol", "Meaning"]);
    await expectColumns(first, original.columns);
    await saveCurrentProject(page);
    await expect.poll(() => mockState.projects[0]?.remarks).toHaveLength(3);
    const saved = mockState.projects[0].remarks as ProjectRemark[];
    expect(saved[0]).toEqual({ ...original, body: "Updated body only" });
    expect(saved[1].columns).toEqual(original.columns);
    expect(saved[1].rows).toEqual(original.rows);
    expect(saved[1].id).not.toBe(original.id);
    expect(mockState.projects[0]).toMatchObject(protectedFields);

    await page.reload({ waitUntil: "load" });
    await openRemarks(page);
    await expectColumns(first, original.columns);
    for (const [index, value] of original.rows[0].entries()) {
      await expect(first.getByLabel(`Remark 1 row 1 column ${index + 1}`)).toHaveValue(value);
    }
    await expectColumns(page.locator(".remarks-note").nth(1), original.columns);
    await expectColumns(page.locator(".remarks-note").nth(2), ["Symbol", "Meaning"]);
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    await expect(page.locator(".remarks-preview-note").first().locator("thead th")).toHaveText(original.columns);
  });

  test("duplicates, deletes, and reorders independent notes", async ({ page }) => {
    await createAndOpenProject(page, "T37 Reorder");
    await openRemarks(page);

    const view = page.getByTestId("remarks-view");
    await view.getByRole("button", { name: "Add Remark" }).click();
    await page.locator(".remarks-note").nth(0).getByLabel("Title for remark 1").fill("First");
    await page.locator(".remarks-note").nth(0).getByLabel("Body for remark 1").fill("Original body");
    await view.getByRole("button", { name: "Add Remark" }).click();
    await page.locator(".remarks-note").nth(1).getByLabel("Title for remark 2").fill("Second");

    await page.locator(".remarks-note").nth(0).getByRole("button", { name: "Duplicate remark" }).click();
    await expect(page.locator(".remarks-note")).toHaveCount(3);
    await expect(page.locator(".remarks-note").nth(1).getByLabel("Title for remark 2")).toHaveValue("First Copy");
    await page.locator(".remarks-note").nth(1).getByLabel("Title for remark 2").fill("Edited Copy");
    await expect(page.locator(".remarks-note").nth(0).getByLabel("Title for remark 1")).toHaveValue("First");

    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.locator(".remarks-note").nth(1).getByRole("button", { name: "Delete remark" }).click();
    await expect(page.locator(".remarks-note")).toHaveCount(2);

    const firstNoteBox = await page.locator(".remarks-note").nth(0).boundingBox();
    const secondHandleBox = await page.locator(".remarks-note").nth(1).locator(".drag-handle").boundingBox();
    expect(firstNoteBox).not.toBeNull();
    expect(secondHandleBox).not.toBeNull();
    await page.mouse.move(secondHandleBox!.x + secondHandleBox!.width / 2, secondHandleBox!.y + secondHandleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstNoteBox!.x + firstNoteBox!.width / 2, firstNoteBox!.y + 4, { steps: 6 });
    await page.mouse.up();

    await expect(page.locator(".remarks-note").nth(0).getByLabel("Title for remark 1")).toHaveValue("Second");

    await saveCurrentProject(page);
    await expect
      .poll(() => (mockState.projects[0]?.remarks as Array<{ title?: string }> | undefined)?.map((remark) => remark.title).join("|") ?? "")
      .toBe("Second|First");

    await page.reload({ waitUntil: "load" });
    await expect(page.getByLabel("Title for remark 1")).toHaveValue("Second");
    await expect(page.getByLabel("Title for remark 2")).toHaveValue("First");
  });

  test("wide Edit and content-fit Preview tables stay white, wrap long text, and scroll inside notes", async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const sample: ProjectRemark = {
      id: "layout-sample",
      title: "Operations Reference",
      body: "A short code beside longer instructions.\n" + "LongUnbrokenBody".repeat(30),
      hasTable: true,
      columns: ["ID", "Meaning", "日本語の見出し", "Reference heading ".repeat(8)],
      rows: [
        ["A", "Turn on the entrance lights after sunset and keep them on until the door closes. ".repeat(3), "夜間の照明制御について確認する。".repeat(10), "REFERENCE_WITHOUT_SPACES_".repeat(16)],
        ["B", "Line one\nLine two", "", "OK"],
      ],
    };
    const wide: ProjectRemark = {
      ...sample,
      id: "many-columns",
      title: "Many Columns",
      body: "",
      columns: Array.from({ length: 12 }, (_, index) => `Field ${index + 1}`),
      rows: [Array.from({ length: 12 }, (_, index) => `Channel ${index + 1} operating condition`)],
    };
    const project = { ...createNewProject("T96 Layout"), remarks: [sample, wide] };
    mockState.projects = [structuredClone(project)];
    await page.reload({ waitUntil: "load" });
    await page.locator("button.screen-card").filter({ hasText: project.name }).click();
    await openRemarks(page);

    for (const width of [1800, 1100, 720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const mode of ["Edit", "Preview"]) {
        await page.getByRole("tab", { name: mode, exact: true }).click();
        await page.screenshot({ path: testInfo.outputPath(`layout-${mode}-${width}.png`), fullPage: true });
        const metrics = await page.getByTestId("remarks-view").evaluate((view) => {
          const notes = Array.from(view.querySelectorAll("article"));
          const table = notes[0].querySelector("table")!;
          const cells = Array.from(table.querySelectorAll("tbody tr:first-child td")).slice(0, 4);
          const wrap = notes[1].querySelector<HTMLElement>(".matrix-scroll")!;
          const tableStyle = getComputedStyle(table);
          const rects = cells.map((cell) => ({ width: cell.getBoundingClientRect().width, height: cell.getBoundingClientRect().height }));
          const first = getComputedStyle(cells[0]);
          return {
            viewport: window.innerWidth,
            pageWidth: document.documentElement.scrollWidth,
            tableLayout: tableStyle.tableLayout,
            widths: rects.map((rect) => rect.width),
            height: rects[1].height,
            backgrounds: [getComputedStyle(notes[0]).backgroundColor, tableStyle.backgroundColor, first.backgroundColor],
            headerBackground: getComputedStyle(table.querySelector("th")!).backgroundColor,
            clippedEditors: Array.from(view.querySelectorAll<HTMLTextAreaElement>(".remarks-cell-control"))
              .filter((input) => input.scrollHeight > input.clientHeight + 2 || input.scrollWidth > input.clientWidth + 2).length,
            border: { color: first.borderRightColor, width: first.borderRightWidth, style: first.borderRightStyle },
            scrollWidth: wrap.scrollWidth,
            clientWidth: wrap.clientWidth,
            noteRight: notes[0].getBoundingClientRect().right,
          };
        });
        const metricsPath = testInfo.outputPath(`layout-${mode}-${width}.json`);
        await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
        await testInfo.attach(`layout-${mode}-${width}.json`, { path: metricsPath, contentType: "application/json" });
        expect.soft(metrics.pageWidth, `${mode} ${width}: page overflow`).toBeLessThanOrEqual(width + 1);
        expect.soft(metrics.noteRight).toBeLessThanOrEqual(width);
        expect.soft(metrics.tableLayout).toBe("auto");
        expect.soft(metrics.backgrounds).toEqual(Array(3).fill("rgb(255, 255, 255)"));
        expect.soft(metrics.headerBackground).toBe("rgb(255, 255, 255)");
        expect.soft(metrics.clippedEditors).toBe(0);
        expect.soft(metrics.border).toEqual({ color: "rgb(209, 213, 219)", width: "1px", style: "solid" });
        if (mode === "Preview") {
          expect.soft(metrics.widths[0]).toBeLessThan(150);
          if (width >= 720) expect.soft(metrics.widths[1]).toBeGreaterThan(metrics.widths[0] * 1.5);
          else expect.soft(Math.min(...metrics.widths)).toBeGreaterThanOrEqual(64);
        } else {
          expect.soft(Math.min(...metrics.widths)).toBeGreaterThanOrEqual(280);
          expect.soft(Math.max(...metrics.widths) - Math.min(...metrics.widths)).toBeLessThan(2);
          expect.soft(Math.max(...metrics.widths)).toBeLessThanOrEqual(450);
        }
        expect.soft(Math.max(...metrics.widths)).toBeLessThanOrEqual(width);
        expect.soft(metrics.height).toBeGreaterThan(60);
        if (mode === "Edit" || width <= 720) expect.soft(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
        const wrap = page.locator(mode === "Edit" ? ".remarks-table-wrap" : ".remarks-preview-table-wrap").nth(1);
        await wrap.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        if (metrics.scrollWidth > metrics.clientWidth) expect.soft(await wrap.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
    }
    expect(mockState.projects[0]).toEqual(project);
  });

  test("Edit width stays wide through repeated edits and preserves multiline values after save", async ({ page }, testInfo) => {
    await createAndOpenProject(page, "T96 Content Edits");
    await openRemarks(page);
    await page.getByTestId("remarks-view").getByRole("button", { name: "Add Remark" }).click();
    const note = page.locator(".remarks-note").first();
    await note.getByRole("checkbox", { name: "Table" }).check();
    await note.getByRole("button", { name: "Legend", exact: true }).click();
    const cell = note.getByLabel("Remark 1 row 1 column 2");
    const header = note.getByLabel("Column 2 name for remark 1");
    const widthOfCell = () => cell.evaluate((element) => element.closest("td")!.getBoundingClientRect().width);
    const long = "Turn on the entry lights when the door opens. ".repeat(8) + "\nSecond line\n";
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await cell.fill("On");
      const shortWidth = await widthOfCell();
      expect(shortWidth).toBeGreaterThanOrEqual(280);
      await cell.fill(long);
      expect(await widthOfCell()).toBeCloseTo(shortWidth, 0);
      const dimensions = await cell.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
      expect(dimensions.height).toBeGreaterThan(60);
      expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 2);
      await cell.fill("Off");
      expect(await widthOfCell()).toBeLessThanOrEqual(shortWidth + 1);
    }
    const longHeader = "Meaning and detailed operating condition ".repeat(5);
    await header.fill(longHeader);
    expect(await header.evaluate((element) => element.clientHeight)).toBeGreaterThan(32);
    await header.fill("Meaning");
    await cell.fill(long);
    await saveCurrentProject(page);
    await expect.poll(() => (mockState.projects[0]?.remarks as ProjectRemark[] | undefined)?.[0].rows[0][1]).toBe(long);
    await page.reload({ waitUntil: "load" });
    await openRemarks(page);
    await expect(cell).toHaveValue(long);
    await expect(header).toHaveValue("Meaning");
    await page.screenshot({ path: testInfo.outputPath("multiline-edit.png"), fullPage: true });
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    expect(await page.locator(".remarks-preview-note tbody td").nth(1).textContent()).toBe(long);
    await page.screenshot({ path: testInfo.outputPath("multiline-preview.png"), fullPage: true });
  });

  test("Remarks Excel Export is disabled when empty and exports current edits in both modes", async ({ page }, testInfo) => {
    await createAndOpenProject(page, "Sample Hotel");
    await openRemarks(page);
    const view = page.getByTestId("remarks-view");
    const exportButton = view.getByRole("button", { name: "Excel Export", exact: true });
    await expect(exportButton).toBeDisabled();
    await view.getByRole("button", { name: "Add Remark", exact: true }).click();
    await view.getByLabel("Title for remark 1").fill("Entrance Lighting");
    const body = view.getByLabel("Body for remark 1");
    await body.fill("Door contact sequence.\nApply to the entrance circuit.");
    await view.getByRole("checkbox", { name: "Table", exact: true }).check();
    for (const [index, value] of ["Door opens", "After sunset", "Turn on entry lights", "Entry is lit"].entries()) {
      await view.getByLabel(`Remark 1 row 1 column ${index + 1}`).fill(value);
    }
    await expect(exportButton).toBeEnabled();
    for (const mode of ["Edit", "Preview"]) {
      await view.getByRole("tab", { name: mode, exact: true }).click();
      const pending = page.waitForEvent("download");
      await exportButton.click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe("Sample_Hotel_Remarks.xlsx");
      const filePath = testInfo.outputPath(`remarks-${mode}.xlsx`);
      await download.saveAs(filePath);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Remarks"]);
      expect(workbook.worksheets[0].getCell("A1").value).toBe("Entrance Lighting");
      expect(workbook.worksheets[0].getCell("A2").value).toBe("Door contact sequence.\nApply to the entrance circuit.");
      expect(workbook.worksheets[0].getCell("A4").value).toBe("Door opens");
      await expect(exportButton).toBeEnabled();
    }
    await view.getByRole("tab", { name: "Edit", exact: true }).click();
    for (const width of [1800, 1100, 720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const exportBox = (await exportButton.boundingBox())!;
      const addBox = (await view.getByRole("button", { name: "Add Remark", exact: true }).boundingBox())!;
      expect(exportBox.height).toBeCloseTo(addBox.height, 0);
      expect(exportBox.x + exportBox.width).toBeLessThan(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`export-toolbar-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1800, height: 1000 });
    const targets = [page.getByRole("tab", { name: "Remarks", exact: true }), view.getByRole("tablist"),
      view.getByRole("button", { name: "Add Remark", exact: true }), view.locator(".drag-handle"),
      view.locator(".remarks-table-toggle"), view.getByRole("button", { name: "Add Row", exact: true }), exportButton];
    const pins = [];
    for (const target of targets) {
      const box = (await target.boundingBox())!;
      pins.push({ x: (box.x + box.width / 2) / 18, y: (box.y + box.height / 2) / 10 });
    }
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("manual-remarks-edit.png") });
    await writeFile(testInfo.outputPath("manual-pins.json"), JSON.stringify(pins, null, 2));
    await view.getByRole("tab", { name: "Preview", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("manual-remarks-preview.png") });
    await view.getByRole("tab", { name: "Edit", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await view.getByRole("button", { name: "Delete remark", exact: true }).click();
    await expect(exportButton).toBeDisabled();
  });

  test("Remarks Excel Export recovers after a download failure and uses subsequent edits", async ({ page }, testInfo) => {
    await createAndOpenProject(page, "T102 Recovery");
    await openRemarks(page);
    const view = page.getByTestId("remarks-view");
    await view.getByRole("button", { name: "Add Remark", exact: true }).click();
    const exportButton = view.getByRole("button", { name: "Excel Export", exact: true });
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = (...args) => {
        URL.createObjectURL = original;
        throw new Error(`Simulated download failure (${args.length})`);
      };
    });
    const dialogPromise = page.waitForEvent("dialog");
    await exportButton.click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toBe("Excel export failed. Please try again.");
    await dialog.accept();
    await expect(exportButton).toBeEnabled();
    await expect(exportButton).toHaveAttribute("aria-busy", "false");
    await view.getByLabel("Title for remark 1").fill("Latest unsaved title");
    const pending = page.waitForEvent("download");
    await exportButton.click();
    const download = await pending;
    const filePath = testInfo.outputPath("recovered.xlsx");
    await download.saveAs(filePath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    expect(workbook.worksheets[0].getCell("A1").value).toBe("Latest unsaved title");
    await expect(exportButton).toBeEnabled();
  });
});
