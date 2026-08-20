/**
 * CFS Web App - 動作確認エージェント#6 監査スペック
 * 担当領域: シーン管理
 *   - Rooms(Room Type) → "Area Scene" サブタブ = SceneView
 *     (一括操作: percent / On / Off / Clear / Raise / Lower、Add/Copy/Delete)
 *   - Rooms(Room Type) → "Scene" サブタブ = RoomSceneView
 *     (Welcome / Occupied 等のテンプレート行、Area Scene 適用、Individual Override)
 *
 * 対象: http://localhost:3014
 * アプリ本体は変更しない。localStorage.clear() → reload で隔離。
 * スクショ: test-results/audit-06/<step>.png
 */
import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const SHOT_DIR = "test-results/audit-06";

test.beforeEach(async ({ page }) => {
  await installLocalEditingMocks(page);
});

/** 衝突回避用のユニーク接尾辞 (重複名アラートで作成失敗するのを防ぐ) */
function uid(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true }).catch(() => {});
}

/**
 * localStorage を完全クリアして隔離する。
 * ブラウザ storage をクリアした上でリロードし、プロジェクト名入力欄が
 * 操作可能になるまで待つ (前テストの debounced save の取りこぼし対策として
 * ユニーク名併用)。
 */
async function isolate(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/", { waitUntil: "load" });
  await expect(page.locator('input[placeholder="New project name"]').first()).toBeVisible({
    timeout: 15000,
  });
}

/** プロジェクトを作成して開く (作成すると自動でプロジェクト画面に遷移する) */
async function createAndOpenProject(page: Page, name: string): Promise<void> {
  const input = page.locator('input[placeholder="New project name"]').first();
  await expect(input).toBeVisible({ timeout: 15000 });
  await input.fill(name);
  await page.locator("button").filter({ hasText: /^Create Project$/ }).first().click();
  // 作成すると ProjectScreen に直接遷移する → 親タブバー / Back リンク出現を待つ
  await expect(page.getByText("Back to Project List")).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[role="tab"]').filter({ hasText: /^Area$/ }).first()).toBeVisible({
    timeout: 10000,
  });
}

async function gotoParentTab(page: Page, label: RegExp): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: label }).first().click();
  await page.waitForTimeout(200);
}

/** Area タブで指定名のエリアを 1 件追加する */
async function addArea(page: Page, areaName: string): Promise<void> {
  await gotoParentTab(page, /^Area$/);
  const addBtn = page.locator(".btn-add-row").first();
  await expect(addBtn).toBeVisible({ timeout: 5000 });
  await addBtn.click();
  // Area 名は 3 列目 (drag, No, Area) の input
  const row = page.locator("tbody tr").last();
  const nameInput = row.locator("input").first();
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill(areaName);
  await page.waitForTimeout(150);
}

/** Room Type を 1 件作成して開く (作成すると自動で Circuit サブタブが開く) */
async function createRoomType(page: Page, roomName: string): Promise<void> {
  await gotoParentTab(page, /Room Type/);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);
  await page.locator("button").filter({ hasText: /^Create Room Type$/ }).first().click();
  // 作成すると activeRoomTypeId がセットされ Circuit サブタブが自動でアクティブになる
  await expect(page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first()).toBeVisible({
    timeout: 8000,
  });
}

async function gotoSubTab(page: Page, label: RegExp): Promise<void> {
  // サブタブは Room Type 親タブがアクティブで RoomType が選択済みのときのみ表示される。
  // 他の親タブ (Area/Fixture) にいる場合は先に Room Type に戻す。
  const subTab = page.locator('[role="tab"]').filter({ hasText: label }).first();
  if (!(await subTab.isVisible().catch(() => false))) {
    await gotoParentTab(page, /Room Type/);
  }
  await expect(subTab).toBeVisible({ timeout: 8000 });
  await subTab.click();
  await page.waitForTimeout(250);
}

/**
 * Circuit サブタブで指定エリアに紐づく回路を 1 件追加する。
 * designerNumber と dimmingType ("Phase"=調光) を設定する。
 */
async function addCircuit(
  page: Page,
  designer: string,
  areaName: string,
  dimmingType: string,
): Promise<void> {
  await gotoSubTab(page, /^Circuit$/);
  const addBtn = page.locator(".btn-add-row").first();
  await expect(addBtn).toBeVisible({ timeout: 5000 });
  await addBtn.click();
  await page.waitForTimeout(200);

  const row = page.locator("tbody tr").last();
  // Designer # は device-cell 内の textarea
  const designerInput = row.locator(".device-cell textarea, .device-cell input").first();
  await expect(designerInput).toBeVisible({ timeout: 5000 });
  await designerInput.fill(designer);
  await page.waitForTimeout(100);

  // Dimming Type と Area はともに <select>。順序: Dimming(1番目), Area(2番目)
  const selects = row.locator("select");
  const selectCount = await selects.count();
  if (selectCount >= 1 && dimmingType) {
    try {
      await selects.nth(0).selectOption({ label: dimmingType });
    } catch {
      // ラベル不一致は無視 (デフォルトのまま)
    }
    await page.waitForTimeout(100);
  }
  // Area select を名前で選ぶ
  const areaSelect = selects.filter({ has: page.locator("option", { hasText: areaName }) }).first();
  if (await areaSelect.count()) {
    await areaSelect.selectOption({ label: areaName });
  } else if (selectCount >= 2) {
    await selects.nth(1).selectOption({ label: areaName });
  }
  await page.waitForTimeout(150);
}

// ============================================================
// SceneView (Area Scene サブタブ)
// ============================================================
test.describe("Audit06 - Area Scene (SceneView)", () => {
  test("シーン追加・名前編集・レベル入力・一括操作・削除", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await isolate(page);
    await createAndOpenProject(page, `AUDIT-06-Scn-${uid()}`);

    // エリアを 2 件用意 (調光用 / On-Off 用に同一エリアへ複数回路)
    await addArea(page, "ScnArea");
    await shot(page, "01-area-added");

    // ルームタイプ作成
    await createRoomType(page, "ScnRoom");

    // 回路を数件用意 (同一エリア ScnArea に調光回路 2 件 + On/Off 回路 1 件)
    await addCircuit(page, "C-1", "ScnArea", "Phase");
    await addCircuit(page, "C-2", "ScnArea", "Phase");
    await addCircuit(page, "C-3", "ScnArea", "On/Off");
    await shot(page, "02-circuits-added");

    // Area Scene サブタブへ
    await gotoSubTab(page, /^Area Scene$/);

    // エリアチップに ScnArea が出ていること
    const areaChip = page.locator(".scene-area-chip").filter({ hasText: "ScnArea" });
    await expect(areaChip.first()).toBeVisible({ timeout: 8000 });
    await areaChip.first().click();
    await page.waitForTimeout(200);
    await shot(page, "03-area-scene-tab");

    // --- シーン追加 ---
    const addSceneBtn = page.getByRole("button", { name: "Add Scene", exact: true }).first();
    await expect(addSceneBtn).toBeEnabled({ timeout: 5000 });
    await addSceneBtn.click();
    await page.waitForTimeout(300);

    // シーンタブが 1 件出現
    const sceneTabs = page.locator('.scene-tabs [role="tab"]');
    await expect(sceneTabs.first()).toBeVisible({ timeout: 5000 });
    expect(await sceneTabs.count()).toBeGreaterThanOrEqual(1);

    // --- 名前編集 ---
    const nameInput = page.locator(".scene-name-input").first();
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill("Evening");
    await page.waitForTimeout(200);
    await expect(page.locator('.scene-tabs [role="tab"]').filter({ hasText: "Evening" }).first()).toBeVisible({
      timeout: 5000,
    });
    await shot(page, "04-scene-named");

    // --- レベル(%) 個別入力: 調光回路 C-1 の Level 入力欄に 55 ---
    // 調光回路の行は scene-level-input(type=text) を持つ
    const levelInputs = page.locator(".scene-table tbody .scene-level-input");
    await expect(levelInputs.first()).toBeVisible({ timeout: 5000 });
    await levelInputs.first().fill("55");
    await levelInputs.first().blur();
    await page.waitForTimeout(200);
    await expect(levelInputs.first()).toHaveValue("55", { timeout: 3000 });

    // clamp 検証: 200 を入れたら 100 に丸められる
    await levelInputs.first().fill("200");
    await levelInputs.first().blur();
    await page.waitForTimeout(200);
    await expect(levelInputs.first()).toHaveValue("100", { timeout: 3000 });
    await shot(page, "05-level-clamp");

    // --- 一括操作: percent 一括 (全行チェック → Apply Bulk) ---
    // 「全選択」チェックボックス
    const selectAll = page.locator('.scene-table thead input[type="checkbox"]').first();
    await expect(selectAll).toBeVisible({ timeout: 5000 });
    await selectAll.check();
    await page.waitForTimeout(150);

    // bulkValue に 30 を入れる (bulk percent mode が初期値)
    const bulkInput = page.locator(".scene-bulk-control .scene-level-input").first();
    await expect(bulkInput).toBeVisible({ timeout: 5000 });
    await bulkInput.fill("30");
    await page.waitForTimeout(100);

    const applyBulk = page.locator("button").filter({ hasText: /^Apply Bulk$/ }).first();
    await applyBulk.click();
    await page.waitForTimeout(300);

    // percent 一括は On/Off 回路を除外し調光回路のみ 30 に。先頭 (調光) が 30
    await expect(levelInputs.first()).toHaveValue("30", { timeout: 3000 });
    await shot(page, "06-bulk-percent");

    // --- 一括操作: 全OFF (On/Off 回路を Off に) ---
    // Off モードに切替 → Apply Bulk
    const offModeBtn = page.locator(".scene-bulk-mode-buttons button").filter({ hasText: /^Off$/ }).first();
    await expect(offModeBtn).toBeVisible({ timeout: 5000 });
    await offModeBtn.click();
    await page.waitForTimeout(100);
    await applyBulk.click();
    await page.waitForTimeout(300);

    // On/Off 回路 (scene-onoff-buttons) の Off ボタンが is-active になる
    const offActive = page.locator(".scene-onoff-buttons button.is-active").filter({ hasText: /^Off$/ });
    await expect(offActive.first()).toBeVisible({ timeout: 4000 });
    await shot(page, "07-bulk-off");

    // --- 一括操作: 全ON ---
    const onModeBtn = page.locator(".scene-bulk-mode-buttons button").filter({ hasText: /^On$/ }).first();
    await onModeBtn.click();
    await page.waitForTimeout(100);
    await applyBulk.click();
    await page.waitForTimeout(300);
    const onActive = page.locator(".scene-onoff-buttons button.is-active").filter({ hasText: /^On$/ });
    await expect(onActive.first()).toBeVisible({ timeout: 4000 });
    await shot(page, "08-bulk-on");

    // --- 一括操作: Clear (調光回路の値を消す) ---
    const clearModeBtn = page.locator(".scene-bulk-mode-buttons button").filter({ hasText: /^Uneffected$/ }).first();
    await clearModeBtn.click();
    await page.waitForTimeout(100);
    await applyBulk.click();
    await page.waitForTimeout(300);
    // 調光回路の Level が空に戻る
    await expect(levelInputs.first()).toHaveValue("", { timeout: 3000 });
    await shot(page, "09-bulk-clear");

    // --- Copy でシーン複製 ---
    const copyBtn = page.locator(".scene-toolbar-actions").getByRole("button", { name: "Copy Scene" }).first();
    await copyBtn.click();
    await page.waitForTimeout(300);
    expect(await sceneTabs.count()).toBeGreaterThanOrEqual(2);
    await shot(page, "10-scene-copied");

    // --- Delete でシーン削除 ---
    const beforeDelete = await sceneTabs.count();
    const deleteBtn = page.locator(".scene-toolbar-actions").getByRole("button", { name: "Delete Scene" }).first();
    await deleteBtn.click();
    await page.waitForTimeout(300);
    await expect(async () => {
      expect(await sceneTabs.count()).toBeLessThan(beforeDelete);
    }).toPass({ timeout: 5000 });
    await shot(page, "11-scene-deleted");

    // console / pageerror が発生していないこと
    expect(errors, `Console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("回路未割当エリアでは Add Scene が無効", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, `AUDIT-06-Empty-${uid()}`);
    await addArea(page, "EmptyArea");
    await createRoomType(page, "EmptyRoom");
    await gotoSubTab(page, /^Area Scene$/);

    // EmptyArea には回路が無い → チップは表示されない or Add Scene 無効
    const addSceneBtn = page.getByRole("button", { name: "Add Scene", exact: true }).first();
    if (await addSceneBtn.count()) {
      await expect(addSceneBtn).toBeDisabled({ timeout: 5000 });
    } else {
      // チップ自体が出ない実装 = 空状態メッセージ
      await expect(page.locator(".screen-empty").first()).toBeVisible({ timeout: 5000 });
    }
    await shot(page, "12-empty-area-disabled");
  });
});

// ============================================================
// RoomSceneView (Scene サブタブ) — テンプレート検証
// ============================================================
test.describe("Audit06 - Room Scene (RoomSceneView)", () => {
  test("デフォルトテンプレート行 (Welcome / Occupied 等) が生成される", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await isolate(page);
    await createAndOpenProject(page, `AUDIT-06-RoomScn-${uid()}`);
    await addArea(page, "RSArea");
    await createRoomType(page, "RSRoom");

    // Scene サブタブへ
    await gotoSubTab(page, /^Scene$/);
    await page.waitForTimeout(400);
    await shot(page, "20-room-scene-tab");

    // デフォルトテンプレートが自動投入される (Welcome Scene / Occupied Scene / From PMS)
    const body = page.locator("body");
    await expect(body).toContainText("Welcome Scene", { timeout: 8000 });
    await expect(body).toContainText("Occupied Scene", { timeout: 5000 });
    await expect(body).toContainText("From PMS", { timeout: 5000 });

    // Door Magnet Scene テーブルの行数 (標準テンプレ 7 件以上)
    const standardRows = page.locator(".room-scene-table:not(.room-scene-pms-table) tbody tr");
    expect(await standardRows.count()).toBeGreaterThanOrEqual(5);

    // PMS テーブル行 (2 件)
    const pmsRows = page.locator(".room-scene-pms-table tbody tr");
    expect(await pmsRows.count()).toBeGreaterThanOrEqual(2);
    await shot(page, "21-templates-present");

    expect(errors, `Console/page errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("行追加・Setting パネル展開・Copy・Delete", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, `AUDIT-06-RoomScn2-${uid()}`);
    await addArea(page, "RS2Area");
    await createRoomType(page, "RS2Room");
    await gotoSubTab(page, /^Scene$/);
    await page.waitForTimeout(400);

    // --- 行追加 (Door Magnet) ---
    const addRowBtn = page.locator("button.btn-add-row").filter({ hasText: /\+ Add Row/ }).first();
    await expect(addRowBtn).toBeVisible({ timeout: 8000 });
    const standardRows = page.locator(".room-scene-table:not(.room-scene-pms-table) tbody tr");
    const before = await standardRows.count();
    await addRowBtn.click();
    await page.waitForTimeout(300);
    await expect(async () => {
      expect(await standardRows.count()).toBeGreaterThan(before);
    }).toPass({ timeout: 5000 });
    await shot(page, "22-room-scene-row-added");

    // + Add Row should only add the row. Setting opens from the row button.
    await expect(page.locator(".setting-overlay")).toHaveCount(0, { timeout: 5000 });

    // --- Setting パネル展開 (最初の Setting ボタン) ---
    const standardTable = page.locator(".room-scene-table:not(.room-scene-pms-table)").first();
    const settingBtn = standardTable.getByRole("button", { name: /^Setting$/ }).first();
    await expect(settingBtn).toBeVisible({ timeout: 5000 });
    await settingBtn.click();
    await page.waitForTimeout(300);
    // Area Scene / Individual Override パネルが出る
    await expect(page.locator(".room-scene-setting-card").first()).toBeVisible({ timeout: 5000 });
    await shot(page, "23-setting-panel-open");
    // 閉じる
    let closeBtn = page.locator(".setting-overlay").getByRole("button", { name: /^Close$/ }).first();
    await closeBtn.click();
    await expect(page.locator(".setting-overlay")).toHaveCount(0, { timeout: 5000 });

    // --- Copy ---
    const beforeCopy = await standardRows.count();
    const copyBtn = page
      .locator(".room-scene-table:not(.room-scene-pms-table)")
      .getByRole("button", { name: "Copy Scene" })
      .first();
    await copyBtn.click();
    await page.waitForTimeout(300);
    await expect(async () => {
      expect(await standardRows.count()).toBeGreaterThan(beforeCopy);
    }).toPass({ timeout: 5000 });
    await expect(page.locator(".room-scene-setting-card").first()).toBeVisible({ timeout: 5000 });
    closeBtn = page.locator(".setting-overlay").getByRole("button", { name: /^Close$/ }).first();
    await closeBtn.click();
    await expect(page.locator(".setting-overlay")).toHaveCount(0, { timeout: 5000 });

    // --- Delete ---
    const beforeDelete = await standardRows.count();
    const deleteBtn = page
      .locator(".room-scene-table:not(.room-scene-pms-table)")
      .getByRole("button", { name: "Delete Scene" })
      .first();
    await deleteBtn.click();
    await page.waitForTimeout(300);
    await expect(async () => {
      expect(await standardRows.count()).toBeLessThan(beforeDelete);
    }).toPass({ timeout: 5000 });
    await shot(page, "24-room-scene-deleted");
  });

  test("Area Scene 適用: SceneView で作ったシーンを選択保持し、Individual Overrideへ自動コピーしない", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, `AUDIT-06-Apply-${uid()}`);
    await addArea(page, "ApArea");
    await createRoomType(page, "ApRoom");

    // 調光回路 1 件を用意
    await addCircuit(page, "AC-1", "ApArea", "Phase");

    // Area Scene でシーンを作りレベルを設定
    await gotoSubTab(page, /^Area Scene$/);
    const chip = page.locator(".scene-area-chip").filter({ hasText: "ApArea" }).first();
    await expect(chip).toBeVisible({ timeout: 8000 });
    await chip.click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "Add Scene", exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.locator(".scene-name-input").first().fill("ApScene");
    await page.waitForTimeout(150);
    const lvl = page.locator(".scene-table tbody .scene-level-input").first();
    await expect(lvl).toBeVisible({ timeout: 5000 });
    await lvl.fill("77");
    await lvl.blur();
    await page.waitForTimeout(200);
    await shot(page, "30-area-scene-prepared");

    // Scene サブタブで Setting → Area Scene セレクトに ApScene が出る
    await gotoSubTab(page, /^Scene$/);
    await page.waitForTimeout(400);
    const settingBtn = page.locator(".room-scene-table button").filter({ hasText: /^Setting$/ }).first();
    await expect(settingBtn).toBeVisible({ timeout: 8000 });
    await settingBtn.click();
    await page.waitForTimeout(300);

    // Area Scene テーブル内の select に ApScene option が存在
    const areaSceneSelect = page
      .locator(".switch-setting-scene-section select")
      .filter({ has: page.locator("option", { hasText: "ApScene" }) })
      .first();
    await expect(areaSceneSelect).toBeVisible({ timeout: 5000 });
    await areaSceneSelect.selectOption({ label: "ApScene" });
    await page.waitForTimeout(300);
    await shot(page, "31-area-scene-applied");

    const selectedLabel = await areaSceneSelect.evaluate((element) =>
      (element as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
    );
    expect(selectedLabel).toBe("ApScene");

    // 適用後、Area Scene選択は保持するが Individual Override へは自動コピーしない。
    const areaToggle = page.locator(".switch-area-toggle").filter({ hasText: "ApArea" }).first();
    if (await areaToggle.count()) {
      await areaToggle.click();
      await page.waitForTimeout(300);
      const overrideInputs = page.locator(".switch-individual-table .scene-level-input");
      const values = await overrideInputs.evaluateAll((els) =>
        els.map((el) => (el as HTMLTextAreaElement).value),
      );
      expect(values, "Area Scene選択だけでIndividual Overrideへ77を自動コピーしないこと").not.toContain("77");
    }
    await shot(page, "32-override-reflected");
  });
});
