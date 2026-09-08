import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

test("T99 CSS composition preserves override, revision, and diagnostic priorities", async ({ page }, testInfo) => {
  await installLocalEditingMocks(page);
  await page.goto("/", { waitUntil: "networkidle" });
  // This is a CSS composition probe; real setting/save paths are covered by overlay_entry.
  const styles = await page.evaluate(() => {
    const result: Record<string, { background: string; shadow: string; marker: string }> = {};
    const table = document.createElement("table");
    table.className = "cfs-matrix-table";
    document.body.append(table);
    for (const theme of ["", "cfs-area-color-row", "cfs-ffe-row", "cfs-energy-row", "cfs-ffe-row cfs-energy-row"]) {
      const row = table.insertRow();
      row.className = theme;
      for (const diagnostic of ["", "cfs-repaired-link-cell", "cfs-link-error-cell", "cfs-inspection-marked-cell", "cfs-inspection-selected-cell", "cfs-inspection-draft-cell"]) {
        const cell = row.insertCell();
        cell.className = `cfs-function-cell cfs-individual-override-cell revision-changed-cell ${diagnostic}`;
        cell.textContent = "55%";
        const style = getComputedStyle(cell);
        result[`${theme}|${diagnostic}`] = { background: style.backgroundColor, shadow: style.boxShadow, marker: getComputedStyle(cell, "::before").backgroundColor };
      }
    }
    const plain = table.insertRow().insertCell();
    plain.className = "revision-changed-cell";
    result.plainRevision = { background: getComputedStyle(plain).backgroundColor, shadow: "", marker: "" };
    table.remove();
    return result;
  });
  await writeFile(testInfo.outputPath("css-priority.json"), JSON.stringify(styles, null, 2));
  for (const [key, value] of Object.entries(styles)) {
    const expected = key === "plainRevision" ? "rgb(255, 243, 176)"
      : key.endsWith("|cfs-link-error-cell") ? "rgb(254, 226, 226)"
        : key.endsWith("|cfs-repaired-link-cell") ? "rgb(254, 243, 199)"
          : "rgb(253, 224, 71)";
    expect(value.background, key).toBe(expected);
    if (key.endsWith("|cfs-inspection-marked-cell")) expect(value.marker, key).toBe("rgb(2, 132, 199)");
  }
});
