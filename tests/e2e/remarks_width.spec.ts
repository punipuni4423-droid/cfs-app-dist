import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { createNewProject } from "../../app/lib/storage";
import { appendRemarksSheet } from "../../app/lib/remarksExcelExport";
import type { ProjectRemark } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const procedure = "Confirm the entrance circuit state before changing the control mode and record the result. ".repeat(12) + "End of procedure.";
const note: ProjectRemark = {
  id: "width-reference", title: "Operating Procedure", body: "Use the available width for the procedure column.",
  hasTable: true, columns: ["ID", "Procedure", "State"], rows: [["A", procedure, "OK"]],
};

test("Preview uses available width before wrapping and keeps short tables compact", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const state = await installLocalEditingMocks(page);
  const notes = [note,
    { ...note, id: "compact", title: "Short Reference", rows: [["B", "Door", "On"]] },
    { ...note, id: "proportional", title: "Two Long Columns", columns: ["ID", "Procedure", "Detail"], rows: [["C", procedure, procedure.repeat(2)]] },
    { ...note, id: "wide", title: "Many Columns", columns: Array.from({ length: 12 }, (_, i) => `ID ${i}`), rows: [Array(12).fill("OK")] },
  ];
  const project = { ...createNewProject("Sample Hotel"), remarks: notes };
  state.projects = [structuredClone(project)];
  await page.goto("/");
  await page.locator("button.screen-card").filter({ hasText: project.name }).click();
  await page.getByRole("tab", { name: "Remarks", exact: true }).click();
  const view = page.getByTestId("remarks-view");
  await view.getByRole("tab", { name: "Preview", exact: true }).click();
  const measurements = [];
  for (const width of [1800, 1280, 720, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`preview-${width}.png`), fullPage: true });
    const metrics = await view.evaluate((element) => {
      const notes = Array.from(element.querySelectorAll("article"));
      const first = notes[0];
      const style = getComputedStyle(first);
      const available = first.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const widths = (note: Element) => Array.from(note.querySelectorAll("tbody td")).map((cell) => cell.getBoundingClientRect().width);
      const many = notes[3].querySelector<HTMLElement>(".matrix-scroll")!;
      return {
        viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, available,
        tableWidth: first.querySelector("table")!.getBoundingClientRect().width,
        columns: widths(first), compactColumns: widths(notes[1]), proportionalColumns: widths(notes[2]),
        compactWidth: notes[1].querySelector("table")!.getBoundingClientRect().width,
        scrollWidth: many.scrollWidth, clientWidth: many.clientWidth,
      };
    });
    measurements.push(metrics);
    expect.soft(metrics.pageWidth).toBeLessThanOrEqual(width);
    expect.soft(metrics.available - metrics.tableWidth).toBeLessThanOrEqual(3);
    expect.soft(metrics.columns[0]).toBeLessThan(120);
    expect.soft(metrics.columns[2]).toBeLessThan(120);
    expect.soft(metrics.columns[1]).toBeGreaterThanOrEqual(metrics.available - metrics.columns[0] - metrics.columns[2] - 3);
    if (width >= 1280) {
      expect.soft(metrics.columns[1]).toBeGreaterThan(800);
      expect.soft(metrics.compactWidth).toBeLessThan(400);
      expect.soft(metrics.proportionalColumns[2]).toBeGreaterThan(metrics.proportionalColumns[1] * 1.5);
    }
    if (width <= 720) {
      expect.soft(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
      const wrap = view.locator(".remarks-preview-table-wrap").nth(3);
      await wrap.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      expect.soft(await wrap.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }
  }
  await writeFile(testInfo.outputPath("preview-widths.json"), JSON.stringify(measurements, null, 2));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath("manual-preview.png") });
  const downloadPending = page.waitForEvent("download");
  await view.getByRole("button", { name: "Excel Export", exact: true }).click();
  const download = await downloadPending;
  await download.saveAs(testInfo.outputPath("preview-all-notes.xlsx"));
  expect(state.projects[0]).toEqual(project);
});

test("Remarks Excel allocates the width budget to long columns and retains text and borders", async ({}, testInfo) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = appendRemarksSheet(workbook, "Remarks", [note]);
  const path = testInfo.outputPath("long-column.xlsx");
  await workbook.xlsx.writeFile(path);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.readFile(path);
  const actual = loaded.worksheets[0];
  const widths = actual.columns.map((column) => column.width!);
  await writeFile(testInfo.outputPath("excel-widths.json"), JSON.stringify({ widths, rowHeight: actual.getRow(4).height }, null, 2));
  expect.soft(widths[0]).toBeLessThanOrEqual(12);
  expect.soft(widths[2]).toBeLessThanOrEqual(12);
  expect.soft(widths[1]).toBeGreaterThan(140);
  expect.soft(widths.reduce((total, width) => total + width, 0)).toBeLessThanOrEqual(180.1);
  expect.soft(actual.getRow(4).height).toBeLessThan(160);
  expect(actual.getCell("B4").value).toBe(procedure);
  expect(actual.getCell("B4").alignment.wrapText).toBe(true);
  for (const side of ["top", "bottom", "left", "right"] as const) expect(actual.getCell("B4").border[side]?.style).toBe("thin");
  expect(sheet.name).toBe("Remarks");
});

test("Remarks Excel preserves compact columns, proportional long columns, and many-column minimums", async ({}, testInfo) => {
  const cases = [
    { name: "compact", values: ["A", "Door", "OK"] },
    { name: "proportional", values: ["A", "X".repeat(400), "Y".repeat(800)] },
    { name: "single", values: ["LongWord".repeat(120)] },
    { name: "many", values: Array.from({ length: 30 }, () => "日本語".repeat(30)) },
    { name: "multiline", values: ["001", "日本語の動作\n夜間のみ", ""] },
  ];
  const results = [];
  for (const entry of cases) {
    const input = [{ ...note, columns: entry.values.map((_, i) => `C${i}`), rows: [entry.values] }];
    const saved = structuredClone(input);
    const workbook = new ExcelJS.Workbook();
    const sheet = appendRemarksSheet(workbook, "Remarks", input);
    const widths = sheet.columns.slice(0, entry.values.length).map((column) => column.width!);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(8);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(Math.max(180, widths.length * 8) + 0.01);
    expect(Math.max(...widths)).toBeLessThanOrEqual(180);
    if (entry.name === "compact") expect(widths).toEqual([8, 8, 8]);
    if (entry.name === "proportional") expect(widths[2]).toBeGreaterThan(widths[1] * 1.8);
    if (entry.name === "single") expect(widths).toEqual([180]);
    if (entry.name === "many") expect(widths).toEqual(Array(30).fill(8));
    entry.values.forEach((value, index) => expect(sheet.getCell(4, index + 1).value).toBe(value));
    expect(input).toEqual(saved);
    results.push({ name: entry.name, widths });
  }
  await writeFile(testInfo.outputPath("excel-budget-cases.json"), JSON.stringify(results, null, 2));
});
