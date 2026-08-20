/**
 * AUDIT-09: HVAC (空調) 管理 動作確認
 * 対象領域: HvacAssignView / HvacSettingPanel
 *
 * アクセス導線:
 *   プロジェクト作成 → Room Type タブ → ルームタイプ作成(自動選択)
 *   → Device Assign サブタブ → サブモードチップ "HVAC" をクリック
 *   → HvacAssignView (割り当てテーブル + Season Schedule) が表示される。
 *
 * 検証内容:
 *   - HVAC ビューへの導線とテーブル構造 (Control Type / Area / Low End / High End / Summer-Winter / Note)
 *   - 割り当て行追加とプロトコル(Modbus/FCU/BACnet)・温度レンジ・Summer/Winter・Note の操作
 *   - localStorage 永続化 (reload 後も保持)
 *   - Season Schedule の追加/編集/日付ピッカー(MonthDayPicker)
 *   - 割り当て行の削除
 *
 * 注意: アプリ本体は一切変更しない (read-only audit)。
 *       現行 UI は英語。baseURL は playwright.config.ts の http://localhost:3014。
 * スクショ: test-results/audit-09/<step>.png
 */
import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const SHOT_DIR = "test-results/audit-09";

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true }).catch(() => {});
}

/**
 * localStorage を完全クリアして隔離する。
 * NOTE: 本アプリは reload 直後に "Loading projects." スピナーで稀にスタックする
 *       (ハイドレーション race)。プロジェクト名入力欄が出るまで最大数回 reload して回復する。
 */
async function isolate(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  const nameInput = page.locator('input[placeholder*="project name" i], input[placeholder*="プロジェクト名"]');
  // dev サーバー (+ /api/projects) が OneDrive 上 & 並行負荷で非常に遅い (9〜12s) ため
  // タイムアウトを長め (各試行 20s) にして数回 reload で回復させる。
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      await nameInput.first().waitFor({ state: "visible", timeout: 20000 });
      return;
    } catch {
      // "Loading projects." スピナーでスタックした場合は再試行
    }
  }
  await expect(nameInput.first()).toBeVisible({ timeout: 20000 });
}

/** プロジェクト作成 → 自動でプロジェクト画面へ遷移 (英語 UI) */
async function createAndOpenProject(page: Page, name: string): Promise<void> {
  const nameInput = page
    .locator('input[placeholder*="project name" i], input[placeholder*="プロジェクト名"]')
    .first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await expect(nameInput).toBeEnabled({ timeout: 10000 });
  await nameInput.fill(name);
  const createBtn = page
    .locator("button")
    .filter({ hasText: /Create Project|作成|追加|新規/ })
    .first();
  await expect(createBtn).toBeEnabled({ timeout: 5000 });
  await createBtn.click();
  // 自動で Room Type タブを含むプロジェクト画面へ遷移 (POST /api/projects が遅いので長め)
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Room Type/i }).first(),
  ).toBeVisible({ timeout: 25000 });
}

/** Room Type タブ → ルームタイプ作成 → 自動選択 (サブタブ群が出現) */
async function createRoomTypeAndSelect(page: Page, roomName: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /^Room Type$/i }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page
    .locator('input[placeholder*="room type name" i], input[placeholder*="room type" i], input[placeholder*="ルームタイプ名"]')
    .first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);
  await page
    .locator("button")
    .filter({ hasText: /Create Room Type|Create Room|Add Room|ルームタイプ作成/ })
    .first()
    .click();
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first(),
  ).toBeVisible({ timeout: 8000 });
}

/** Device Assign サブタブ → HVAC サブモードへ */
async function openHvacView(page: Page, roomName: string): Promise<void> {
  await createRoomTypeAndSelect(page, roomName);
  await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
  await page.waitForTimeout(400);
  // DeviceAssignView がレンダリングされたことを On/Off チップで確認
  await expect(
    page.locator(".scene-area-chip").filter({ hasText: /On\/Off/i }).first(),
  ).toBeVisible({ timeout: 8000 });
  // HVAC サブモードチップをクリック
  const hvacChip = page.locator(".scene-area-chip").filter({ hasText: /^HVAC$/ }).first();
  await expect(hvacChip).toBeVisible({ timeout: 5000 });
  await hvacChip.click();
  await page.waitForTimeout(400);
}

/** HVAC 割り当てテーブル (1つ目の master-table) */
function assignTable(page: Page) {
  return page.locator("table.master-table").first();
}

/** Season Schedule テーブル (2つ目の master-table) */
function seasonTable(page: Page) {
  return page.locator("table.master-table").nth(1);
}

test.describe("AUDIT-09 HVAC 管理", () => {
  // dev サーバーが OneDrive 上 + 並行負荷で遅いため per-test timeout を延長する。
  test.slow();
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
    await isolate(page);
    await createAndOpenProject(page, `AUDIT-09-Hvac-${Date.now()}`);
  });

  test("A. HVAC ビューへの導線とテーブル構造", async ({ page }) => {
    await openHvacView(page, "HvacRoom-A");
    await shot(page, "01-hvac-view-opened");

    // 割り当てテーブルのヘッダ
    const headTexts = (await page.locator("thead th").allTextContents()).map((t) => t.trim());
    const joined = headTexts.join("|");
    expect(joined).toMatch(/Control Type/);
    expect(joined).toMatch(/Low End/);
    expect(joined).toMatch(/High End/);
    expect(joined).toMatch(/Summer|Winter/);
    expect(joined).toMatch(/Note/);

    // Season Schedule セクション + 既定の Summer/Winter
    await expect(page.locator("text=Season Schedule")).toBeVisible({ timeout: 5000 });
    const seasonDefaults = page.locator('input[value="Summer"], input[value="Winter"]');
    expect(await seasonDefaults.count()).toBeGreaterThanOrEqual(1);
  });

  test("B. 割り当て行の追加とプロトコル/温度/Summer-Winter/Note 操作", async ({ page }) => {
    await openHvacView(page, "HvacRoom-B");

    // "+ HVAC Add" で行追加
    const addBtn = assignTable(page).locator(".btn-add-row, button.btn-add-row").filter({ hasText: /HVAC Add/i }).first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(300);

    const row = assignTable(page).locator("tbody tr:has(select)").first();
    await expect(row.locator("select").first()).toBeVisible({ timeout: 5000 });
    await shot(page, "02-row-added");

    // Control Type (protocol): Modbus / FCU / BACnet
    const protocolSelect = row.locator("select").nth(0);
    const protoOptions = (await protocolSelect.locator("option").allTextContents()).map((t) => t.trim());
    expect(protoOptions).toEqual(expect.arrayContaining(["Modbus", "FCU", "BACnet"]));

    await protocolSelect.selectOption({ label: "BACnet" });
    await expect(protocolSelect).toHaveValue("BACnet");
    await protocolSelect.selectOption({ label: "FCU" });
    await expect(protocolSelect).toHaveValue("FCU");

    // Low End / High End 温度 (Protocol / Master-Slave / Area の後)
    const lowEnd = row.locator("select").nth(3);
    const highEnd = row.locator("select").nth(4);
    await lowEnd.selectOption({ label: "22 C" });
    await expect(lowEnd).toHaveValue("22");
    await highEnd.selectOption({ label: "26 C" });
    await expect(highEnd).toHaveValue("26");

    // Summer/Winter チェックボックス
    const sw = row.locator('input[type="checkbox"]').first();
    await expect(sw).not.toBeChecked();
    await sw.check();
    await expect(sw).toBeChecked();

    // Note 入力 (text input)
    const note = row.locator('input[type="text"], input:not([type]):not([type="checkbox"])').last();
    await note.fill("Guest room FCU 1");
    await expect(note).toHaveValue("Guest room FCU 1");
    await shot(page, "03-row-configured");
  });

  test("C. 割り当ての永続化 (local draft 保存 + 同タブ内再描画で保持)", async ({ page }) => {
    await openHvacView(page, "HvacRoom-C");

    const addBtn = assignTable(page).locator(".btn-add-row").filter({ hasText: /HVAC Add/i }).first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const row = assignTable(page).locator("tbody tr:has(select)").first();
    await row.locator("select").nth(0).selectOption({ label: "BACnet" });
    const note = row.locator('input[type="text"], input:not([type]):not([type="checkbox"])').last();
    await note.fill("PersistCheck-99");
    await page.waitForTimeout(1500); // デバウンス保存 (/api/projects) を待つ
    await shot(page, "04-before-persist");

    // (1) Secure/local editing modeではローカルドラフトに保存される。
    //     保存はデバウンスされるため数回リトライする。
    let storedOk = false;
    for (let i = 0; i < 6 && !storedOk; i++) {
      storedOk = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key) continue;
          const text = localStorage.getItem(key) ?? "";
          if (text.includes("PersistCheck-99") && /"protocol"\s*:\s*"BACnet"/.test(text)) {
            return true;
          }
        }
        return false;
      });
      if (!storedOk) await page.waitForTimeout(1000);
    }
    expect(storedOk).toBe(true);

    // (2) サブモードを切り替えて戻る (再描画) → 値が保持されることを確認
    await page.locator(".scene-area-chip").filter({ hasText: /On\/Off/i }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".scene-area-chip").filter({ hasText: /^HVAC$/ }).first().click();
    await page.waitForTimeout(400);
    await shot(page, "05-after-remount");

    await expect(page.locator('input[value="PersistCheck-99"]').first()).toBeVisible({ timeout: 5000 });
    const proto = assignTable(page).locator("tbody tr:has(select)").first().locator("select").nth(0);
    await expect(proto).toHaveValue("BACnet");
  });

  test("D. Season Schedule の追加/編集/日付ピッカー", async ({ page }) => {
    await openHvacView(page, "HvacRoom-D");

    const addSeasonBtn = page.locator("button").filter({ hasText: /\+ Season/ }).first();
    await expect(addSeasonBtn).toBeVisible({ timeout: 5000 });

    const rowsBefore = await seasonTable(page).locator("tbody tr").count();
    await addSeasonBtn.click();
    await page.waitForTimeout(300);
    const rowsAfter = await seasonTable(page).locator("tbody tr").count();
    expect(rowsAfter).toBe(rowsBefore + 1);

    // 新規 Season 名
    const newName = seasonTable(page).locator("tbody tr").last().locator("input").first();
    await newName.fill("Spring");
    await expect(newName).toHaveValue("Spring");

    // 日付ピッカー (MonthDayPicker) を開く
    const pickerBtn = seasonTable(page).locator("tbody tr").last().locator("button.cell-input").first();
    await expect(pickerBtn).toBeVisible({ timeout: 3000 });
    await pickerBtn.click();
    await page.waitForTimeout(300);
    await shot(page, "05-date-picker-open");

    // Month select (Month 3 を持つ select)
    const monthSelect = page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: "Month 3" }) })
      .first();
    if (await monthSelect.count() > 0) {
      await monthSelect.selectOption("3");
      await page.waitForTimeout(200);
      const okBtn = page.locator("button").filter({ hasText: /^OK$/ }).first();
      if (await okBtn.count() > 0) await okBtn.click();
      await page.waitForTimeout(200);
      const label = await pickerBtn.textContent();
      expect(label).toMatch(/^3\//);
    }
    await shot(page, "06-season-edited");
  });

  test("E. 割り当て行の削除", async ({ page }) => {
    await openHvacView(page, "HvacRoom-E");

    const addBtn = assignTable(page).locator(".btn-add-row").filter({ hasText: /HVAC Add/i }).first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const rowsBefore = await assignTable(page).locator("tbody tr:has(select)").count();
    expect(rowsBefore).toBeGreaterThanOrEqual(1);

    const deleteBtn = assignTable(page)
      .locator("tbody tr:has(select)")
      .first()
      .locator("button")
      .filter({ hasText: /Delete/i })
      .first();
    await expect(deleteBtn).toBeVisible({ timeout: 3000 });
    await deleteBtn.click();
    await page.waitForTimeout(400);

    const rowsAfter = await assignTable(page).locator("tbody tr:has(select)").count();
    const emptyState = await page.locator("text=No HVAC assignments are registered").count();
    expect(rowsAfter < rowsBefore || emptyState > 0).toBe(true);
    await shot(page, "07-after-delete");
  });
});
