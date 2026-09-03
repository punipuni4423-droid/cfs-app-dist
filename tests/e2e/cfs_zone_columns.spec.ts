/**
 * T-33 + T-55/T-56: CFS Base 列「Low End」「High End」「Total VA」回帰テスト
 *
 *  - 3 列は Designer # (designerNumber) の直後に Low End → High End →
 *    Total VA の順で表示される (T-56)
 *  - Total VA は Circuit タブと同一計算 (calcFixtureVa をグループ全行で合計)
 *  - Low/High End は T-32 と同じ解決 (assignment 上書き → DeviceMaster)。
 *    On/Off ゾーンは "-"
 *  - Base メニューで表示/非表示・並び替えでき、プロジェクト単位 (v2 prefs) に保持
 *  - 既存ユーザーの保存済み baseColumnOrder (新キーなし) は Designer # 直後に挿入される
 *  - Excel Export (単一 / All Rooms) は表示列に自動追従し、非表示時は既存列のみ
 *
 * データ保護: installLocalEditingMocks で /api/projects を全モック。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { expect, test, type Page } from "@playwright/test";
import { createDefaultLocations, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const V2_KEY = "cfs-view-preferences-v2";
const OUT_DIR = "test-results/t33-excel";

const NEW_LABELS = ["Total VA", "Low End", "High End"];
const LEGACY_LABELS = [
  "No",
  "Device",
  "Device #",
  "Type",
  "Group",
  "Zone / Address",
  "Designer #",
  "Area",
  "Area Address",
  "Detail",
  "Programming Name",
];
const FULL_LABELS = [
  "No",
  "Device",
  "Device #",
  "Type",
  "Group",
  "Zone / Address",
  "Designer #",
  // T-56: Designer # の直後に Low End -> High End -> Total VA
  "Low End",
  "High End",
  "Total VA",
  "Area",
  "Area Address",
  "Detail",
  "Programming Name",
];

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

test.setTimeout(180_000);

/**
 * QSN-4P20-D (マスター Low 5 / High 90)。
 * Zn1 → 回路 "1" (PWM, グループ2行: FX-A 2pcs=20VA + FX-B 1pcs 7W/0.7=10VA → Total 30)
 * Zn2 → 回路 "2" (On/Off, FX-A 1pcs → Total 10, Low/High は "-")
 */
function makeProject(projectId: string, projectName: string) {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: `${projectId}-area`, name: "Bedroom", number: "1", code: "BR" };
  const makeCircuit = (
    id: string,
    groupId: string,
    designer: string,
    dimmingType: string,
    fixture: string,
    pcs: string,
    detail: string,
  ) => ({
    id,
    circuitGroupId: groupId,
    daliFixtureGroupId: "",
    designerNumber: designer,
    internalNumber: designer,
    dimmingType,
    fixture,
    pcs,
    detail,
    area: bedroom.id,
    ffe: false,
    energySaving: false,
  });
  const makeAssignment = (
    suffix: string,
    zone: string,
    circuitNumber: string,
    extra: Record<string, string> = {},
  ) => ({
    id: `${projectId}-assignment-${suffix}`,
    deviceGroupId: `${projectId}-device-group-1`,
    device: "QSN-4P20-D",
    deviceNum: "1",
    zoneAddress: zone,
    circuitNumber,
    detail: "",
    group: "",
    ...extra,
  });
  const roomType = {
    ...createNewRoomType("RT-A"),
    id: `${projectId}-room-a`,
    name: "RT-A",
    updatedAt: now,
    circuitIds: [`${projectId}-circuit-1a`, `${projectId}-circuit-1b`, `${projectId}-circuit-2`],
    rows: [],
    deviceAssignments: [
      makeAssignment("zn1", "Zn1", "1"),
      makeAssignment("zn2", "Zn2", "2"),
      // T-55: 回路未アサイン (Reserved) の zone。過去の上書き値 lowEnd=77 が
      // 残っていても、条件を満たさないので CFS 側も "-" 表示になること。
      makeAssignment("zn3", "Zn3", "Reserved", { lowEnd: "77" }),
    ],
  };
  return {
    id: projectId,
    name: projectName,
    updatedAt: now,
    locations: [bedroom, ...otherLocations],
    fixtures: [
      { id: "fixture-a", fixture: "FX-A", fixtureType: "DL", powerMode: "VA", watt: "10", powerFactor: "0.7" },
      { id: "fixture-b", fixture: "FX-B", fixtureType: "Indirect", powerMode: "W", watt: "7", powerFactor: "0.7" },
    ],
    circuits: [
      makeCircuit(`${projectId}-circuit-1a`, `${projectId}-cg-1`, "1", "PWM", "FX-A", "2", "Load PWM"),
      makeCircuit(`${projectId}-circuit-1b`, `${projectId}-cg-1`, "1", "PWM", "FX-B", "1", "Load PWM"),
      makeCircuit(`${projectId}-circuit-2`, `${projectId}-cg-2`, "2", "On/Off", "FX-A", "1", "Load OnOff"),
    ],
    roomTypes: [roomType],
  };
}

async function openProjectCfs(page: Page, projectName: string): Promise<void> {
  const backOrCard = page.locator('button:has-text("Back to Project List"), button.screen-card').first();
  await expect(backOrCard).toBeVisible({ timeout: 20000 });
  const back = page.getByRole("button", { name: /Back to Project List/i }).first();
  if (await back.isVisible().catch(() => false)) {
    await back.click();
  }
  const card = page.locator("button.screen-card").filter({ hasText: projectName }).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  const roomCard = page.locator("button.screen-card").filter({ hasText: "RT-A" }).first();
  if (await roomCard.isVisible({ timeout: 2500 }).catch(() => false)) {
    await roomCard.click();
  } else {
    await page.getByRole("tab", { name: "RT-A", exact: true }).first().click();
  }
  const cfsTab = page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first();
  await expect(cfsTab).toBeVisible({ timeout: 8000 });
  await cfsTab.click();
  await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
}

async function baseHeaderLabels(page: Page): Promise<string[]> {
  return page
    .locator("table.cfs-matrix-table thead th.cfs-base-head .cfs-base-head-content > span")
    .evaluateAll((els) => els.map((el) => (el.textContent || "").trim()));
}

async function openBaseMenu(page: Page) {
  const trigger = page
    .locator(".cfs-matrix-controls .cfs-filter-menu-trigger")
    .filter({ hasText: /^\s*Base\s*$/ })
    .first();
  await expect(trigger).toBeVisible({ timeout: 5000 });
  await trigger.click();
  const panel = page.locator(".cfs-filter-list-portal").last();
  await expect(panel).toBeVisible({ timeout: 3000 });
  return panel;
}

function cfsRow(page: Page, zoneText: string) {
  return page
    .locator("table.cfs-matrix-table tbody tr")
    .filter({ hasText: zoneText })
    .first();
}

test.describe("T-33 CFS Base 3 列", () => {
  test("A. Designer # 直後に 3 列表示・値解決 (Total VA=Circuit タブ合計 / Low/High End / On/Off ゾーン)", async ({ page }) => {
    mockState.projects = [makeProject("zone-proj", "ZONE-PROJ")];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, "ZONE-PROJ");

    // --- 列順: Designer # の直後に Low End / High End / Total VA (T-56) ---
    const labels = await baseHeaderLabels(page);
    expect(labels).toEqual(FULL_LABELS);

    // --- 値: Zn1 (PWM グループ) ---
    const zn1 = cfsRow(page, "Zn1");
    await expect(zn1.locator("td.cfs-base-totalVa")).toHaveText("30");
    await expect(zn1.locator("td.cfs-base-zoneLowEnd")).toHaveText("5");
    await expect(zn1.locator("td.cfs-base-zoneHighEnd")).toHaveText("90");

    // --- 値: Zn2 (On/Off) → Total VA は出るが Low/High は "-" ---
    const zn2 = cfsRow(page, "Zn2");
    await expect(zn2.locator("td.cfs-base-totalVa")).toHaveText("10");
    await expect(zn2.locator("td.cfs-base-zoneLowEnd")).toHaveText("-");
    await expect(zn2.locator("td.cfs-base-zoneHighEnd")).toHaveText("-");

    // --- T-55: Zn3 (回路未アサイン Reserved) → Low/High は "-"。
    //     残っている上書き値 77 も表示されない ---
    const zn3 = cfsRow(page, "Zn3");
    await expect(zn3.locator("td.cfs-base-totalVa")).toHaveText("-");
    await expect(zn3.locator("td.cfs-base-zoneLowEnd")).toHaveText("-");
    await expect(zn3.locator("td.cfs-base-zoneHighEnd")).toHaveText("-");

    // --- Circuit タブの Total VA と一致する (同一計算の確認) ---
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await expect(page.locator("table").first()).toBeVisible({ timeout: 8000 });
    const circuitCells = await page
      .locator("tbody td")
      .evaluateAll((els) => els.map((el) => (el.textContent || "").trim()));
    expect(circuitCells).toContain("30"); // グループ1 (FX-A 20VA + FX-B 10VA)
    expect(circuitCells).toContain("10"); // グループ2
  });

  test("B. Base メニューで表示/非表示+並び替えでき、プロジェクト単位に保持される", async ({ page }) => {
    mockState.projects = [makeProject("zone-proj-b", "ZONE-PROJ-B")];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, "ZONE-PROJ-B");

    // 非表示: Total VA
    let panel = await openBaseMenu(page);
    await panel.getByLabel("Show Total VA column").uncheck();
    await page.keyboard.press("Escape");
    let labels = await baseHeaderLabels(page);
    expect(labels).not.toContain("Total VA");
    expect(labels).toContain("Low End");

    // 並び替え: Low End を 1 つ上 (Designer # の直後 → Designer # の前) へ
    panel = await openBaseMenu(page);
    await panel.getByRole("button", { name: "Move Low End column up" }).click();
    await page.keyboard.press("Escape");

    // リロードしてもプロジェクト単位で保持される
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjectCfs(page, "ZONE-PROJ-B");
    labels = await baseHeaderLabels(page);
    expect(labels).not.toContain("Total VA");
    const designerIndex = labels.indexOf("Designer #");
    expect(labels[designerIndex - 1]).toBe("Low End");
    expect(labels[designerIndex + 1]).toBe("High End");

    // v2 prefs に反映されている
    const v2 = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { byProject?: Record<string, { hiddenBaseColumns?: string[] }> }) : null;
    }, V2_KEY);
    expect(v2?.byProject?.["zone-proj-b"]?.hiddenBaseColumns).toContain("totalVa");

    // 再表示できる
    panel = await openBaseMenu(page);
    await panel.getByLabel("Show Total VA column").check();
    await page.keyboard.press("Escape");
    labels = await baseHeaderLabels(page);
    expect(labels).toContain("Total VA");
  });

  test("C. 既存ユーザーの保存済み baseColumnOrder (新キーなし) は Designer # の直後に挿入される", async ({ page }) => {
    mockState.projects = [makeProject("zone-proj-c", "ZONE-PROJ-C")];
    // 旧リリース時代の保存済み並び (新キーを含まない・独自順) を再現
    const legacyOrder = [
      "number",
      "deviceNum",
      "device",
      "dimmingType",
      "group",
      "zone",
      "designerNumber",
      "area",
      "areaAddress",
      "detail",
      "programmingName",
    ];
    await page.addInitScript(
      ({ key, order }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            global: { baseColumnOrder: order },
            byProject: { "zone-proj-c": { baseColumnOrder: order } },
          }),
        );
      },
      { key: V2_KEY, order: legacyOrder },
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, "ZONE-PROJ-C");

    const labels = await baseHeaderLabels(page);
    // 保存済みの独自順 (Device # が Device の前) は維持しつつ、
    // 新 3 列は末尾ではなく Designer # の直後に入る (T-56)
    expect(labels).toEqual([
      "No",
      "Device #",
      "Device",
      "Type",
      "Group",
      "Zone / Address",
      "Designer #",
      "Low End",
      "High End",
      "Total VA",
      "Area",
      "Area Address",
      "Detail",
      "Programming Name",
    ]);
  });

  test("D. Excel Export (単一/All Rooms) が新列に自動追従し、非表示時は既存列のみになる", async ({ page }) => {
    mockState.projects = [makeProject("zone-proj-d", "ZONE-PROJ-D")];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, "ZONE-PROJ-D");
    fs.mkdirSync(OUT_DIR, { recursive: true });

    async function exportXlsx(scope: "This Room Type" | "All Rooms", saveName: string): Promise<ExcelJS.Workbook> {
      const exportBtn = page.getByRole("button", { name: /^Excel Export$/ }).first();
      await expect(exportBtn).toBeEnabled();
      await exportBtn.click();
      const exportMenu = page.getByRole("menu", { name: "Excel export scope" });
      await expect(exportMenu).toBeVisible();
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
      await exportMenu.getByRole("menuitem", { name: scope }).click();
      const download = await downloadPromise;
      const savePath = path.join(OUT_DIR, saveName);
      await download.saveAs(savePath);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(savePath);
      return workbook;
    }

    function headerLabels(sheet: ExcelJS.Worksheet, count: number): string[] {
      const labels: string[] = [];
      for (let col = 1; col <= count; col += 1) {
        labels.push(String(sheet.getCell(1, col).value ?? "").trim());
      }
      return labels;
    }

    function bodyValueByLabel(sheet: ExcelJS.Worksheet, labels: string[], label: string, row: number): string {
      const col = labels.indexOf(label) + 1;
      expect(col).toBeGreaterThan(0);
      return String(sheet.getCell(row, col).value ?? "").trim();
    }

    // --- (1) 新列あり: 単一 RoomType ---
    const visibleSingle = await exportXlsx("This Room Type", "single-visible.xlsx");
    const visibleSheet = visibleSingle.worksheets[0];
    const visibleLabels = headerLabels(visibleSheet, FULL_LABELS.length);
    expect(visibleLabels).toEqual(FULL_LABELS);
    // Zn1 行 (row5) / Zn2 行 (row6)
    expect(bodyValueByLabel(visibleSheet, visibleLabels, "Total VA", 5)).toBe("30");
    expect(bodyValueByLabel(visibleSheet, visibleLabels, "Low End", 5)).toBe("5");
    expect(bodyValueByLabel(visibleSheet, visibleLabels, "High End", 5)).toBe("90");
    expect(bodyValueByLabel(visibleSheet, visibleLabels, "Total VA", 6)).toBe("10");
    expect(bodyValueByLabel(visibleSheet, visibleLabels, "Low End", 6)).toBe("-");
    expect(bodyValueByLabel(visibleSheet, visibleLabels, "High End", 6)).toBe("-");
    // frozen 列数 = 表示ベース列数
    expect((visibleSheet.views[0] as { xSplit?: number })?.xSplit).toBe(FULL_LABELS.length);

    // --- (2) 新列あり: All Rooms (baseValuesForEntry 経路) ---
    const visibleAll = await exportXlsx("All Rooms", "all-visible.xlsx");
    const visibleAllSheet = visibleAll.worksheets[0];
    expect(visibleAll.worksheets.map((sheet) => sheet.name)).toEqual(["RT-A"]);
    const visibleAllLabels = headerLabels(visibleAllSheet, FULL_LABELS.length);
    expect(visibleAllLabels).toEqual(FULL_LABELS);
    expect(bodyValueByLabel(visibleAllSheet, visibleAllLabels, "Total VA", 5)).toBe("30");
    expect(bodyValueByLabel(visibleAllSheet, visibleAllLabels, "Low End", 5)).toBe("5");
    expect(bodyValueByLabel(visibleAllSheet, visibleAllLabels, "High End", 5)).toBe("90");
    expect(bodyValueByLabel(visibleAllSheet, visibleAllLabels, "Total VA", 6)).toBe("10");
    expect(bodyValueByLabel(visibleAllSheet, visibleAllLabels, "Low End", 6)).toBe("-");

    // --- (3) 新列を非表示にして再エクスポート → 既存列のみ・値は不変 ---
    const panel = await openBaseMenu(page);
    await panel.getByLabel("Show Total VA column").uncheck();
    await panel.getByLabel("Show Low End column").uncheck();
    await panel.getByLabel("Show High End column").uncheck();
    await page.keyboard.press("Escape");

    const hiddenSingle = await exportXlsx("This Room Type", "single-hidden.xlsx");
    const hiddenSheet = hiddenSingle.worksheets[0];
    const hiddenLabels = headerLabels(hiddenSheet, LEGACY_LABELS.length);
    expect(hiddenLabels).toEqual(LEGACY_LABELS);
    expect(String(hiddenSheet.getCell(1, LEGACY_LABELS.length + 1).value ?? "")).not.toContain("Total VA");
    expect((hiddenSheet.views[0] as { xSplit?: number })?.xSplit).toBe(LEGACY_LABELS.length);

    const hiddenAll = await exportXlsx("All Rooms", "all-hidden.xlsx");
    const hiddenAllSheet = hiddenAll.worksheets[0];
    const hiddenAllLabels = headerLabels(hiddenAllSheet, LEGACY_LABELS.length);
    expect(hiddenAllLabels).toEqual(LEGACY_LABELS);

    // 既存列の非回帰: 非表示エクスポートの既存列の値が、新列ありエクスポート
    // の同じ列と行ごとに完全一致する (単一 / All Rooms とも)
    const compare = (
      hidden: ExcelJS.Worksheet,
      hiddenHeaderLabels: string[],
      visible: ExcelJS.Worksheet,
      visibleHeaderLabels: string[],
    ): void => {
      for (const label of LEGACY_LABELS) {
        if (NEW_LABELS.includes(label)) continue;
        for (let row = 5; row <= 6; row += 1) {
          expect(
            `${label}@${row}:${bodyValueByLabel(hidden, hiddenHeaderLabels, label, row)}`,
          ).toBe(
            `${label}@${row}:${bodyValueByLabel(visible, visibleHeaderLabels, label, row)}`,
          );
        }
      }
    };
    compare(hiddenSheet, hiddenLabels, visibleSheet, visibleLabels);
    compare(hiddenAllSheet, hiddenAllLabels, visibleAllSheet, visibleAllLabels);
  });

  test("E. Backlight Logic 行の結合帯が新 3 列を含んで崩れない", async ({ page }) => {
    const project = makeProject("zone-proj-e", "ZONE-PROJ-E");
    // Palladiom ターゲット (By Scene) + それを指す Backlight ソーススイッチ
    const target = {
      ...createEmptySwitchEntry("lutronPd"),
      id: "sw-target",
      switchGroupId: "sw-target-group",
      switchNumber: "1",
      switchName: "PD-1",
      backlightAssignment: "",
    };
    const source = {
      ...createEmptySwitchEntry("lutronPd"),
      id: "sw-source",
      switchGroupId: "sw-source-group",
      switchNumber: "2",
      switchName: "PD-2",
      backlightTarget: "sw-target-group",
      backlightCondition: "masterOn",
    };
    (project.roomTypes[0] as { switches: unknown[] }).switches = [target, source];
    mockState.projects = [project];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectCfs(page, "ZONE-PROJ-E");

    // Backlight Logic 行: device..areaAddress の結合帯は新 3 列を含む 11 列分
    const backlightCell = page
      .locator("table.cfs-matrix-table tbody td.cfs-merged-cell")
      .filter({ hasText: "Backlight Logic" })
      .first();
    await expect(backlightCell).toBeVisible({ timeout: 8000 });
    await expect(backlightCell).toHaveAttribute("colspan", "11");

    // Total VA を非表示にすると結合帯は 10 列分に追従する (レイアウト非破壊)
    const panel = await openBaseMenu(page);
    await panel.getByLabel("Show Total VA column").uncheck();
    await page.keyboard.press("Escape");
    await expect(backlightCell).toHaveAttribute("colspan", "10");
  });
});
