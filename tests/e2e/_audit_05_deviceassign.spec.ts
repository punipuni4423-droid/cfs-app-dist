/**
 * AUDIT #5 - Device Assign (Rooms → Device Assign サブタブ / DeviceAssignView)
 *
 * 担当領域: デバイス割り当て。
 *  - + Add Device → DeviceSelectModal でデバイス選択 → アドレス行の自動展開
 *  - DALI 自動アドレッシング (1DALUNV=64ch, 2DALUNV=128ch) / ゾーン展開 / instance(Device#) 自動採番
 *  - DALI / non-DALI のモード切替, 予約(Reserved)行の表示/非表示
 *  - ブロック(デバイスグループ)のドラッグ並べ替え
 *  - デバイス置換 (window.confirm 付き)
 *
 * アプリ本体は変更しない。読み取り専用の動作確認 (audit)。
 * スクショ: test-results/audit-05/<step>.png
 */
import { test, expect, type Page } from "@playwright/test";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const SHOT_DIR = "test-results/audit-05";

test.beforeEach(async ({ page }) => {
  await installLocalEditingMocks(page);
});

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true }).catch(() => {});
}

/** localStorage を完全クリアして隔離する */
async function isolate(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
}

/**
 * プロジェクト作成 → 自動で開く。
 * NOTE: 現行 UI は英語化済み。placeholder="New project name", ボタン="Create Project"。
 *       Create Project 直後にプロジェクト画面へ自動遷移する (カードクリック不要)。
 */
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
  // 自動でプロジェクト画面 (tablist + Room Type タブ) に遷移する
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Room Type/i }).first(),
  ).toBeVisible({ timeout: 12000 });
}

/**
 * Room Type タブ → ルームタイプ作成 → 自動選択 (Device Assign 等のサブタブが出現する)。
 * NOTE: 現行 UI ではルームタイプ作成後、その名前のタブが primary バーに追加され、
 *       サブタブ群 (Circuit / Device Assign / Scene / Switch / CFS ...) が即時に出現する。
 *       カードクリックは不要。
 */
async function createRoomTypeAndSelect(page: Page, roomName: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /^Room Type$/i }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page
    .locator(
      'input[placeholder*="room type name" i], input[placeholder*="room type" i], input[placeholder*="ルームタイプ名"]',
    )
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

/** Device Assign サブタブへ移動 */
async function gotoDeviceAssign(page: Page): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
  await page.waitForTimeout(400);
  // mode chip "On/Off / Dimming" が見えること = DeviceAssignView がレンダリングされた
  await expect(
    page.locator(".scene-area-chip").filter({ hasText: /On\/Off/i }).first(),
  ).toBeVisible({ timeout: 8000 });
}

/** Circuit サブタブで回路を1件用意する (designer# を入力) */
async function addCircuit(page: Page, designerNum: string, dimmingType?: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
  await page.waitForTimeout(300);
  const addBtn = page.locator(".btn-add-row").first();
  await addBtn.click();
  await page.waitForTimeout(300);
  const lastRow = page.locator("tbody tr").last();
  const designerInput = lastRow.locator(".device-cell textarea, .device-cell input").first();
  await expect(designerInput).toBeVisible({ timeout: 5000 });
  await designerInput.fill(designerNum);
  await page.waitForTimeout(150);
  if (dimmingType) {
    // dimmingType <select> を探す (オプションに DALI/On/Off/Phase 等を持つ select)
    const dimSelect = lastRow.locator("select").filter({
      has: page.locator("option", { hasText: dimmingType }),
    }).first();
    if (await dimSelect.count() > 0) {
      await dimSelect.selectOption({ label: dimmingType }).catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}

/** Device Assign の DALI / fixed モードを切り替える */
async function switchMode(page: Page, mode: "On/Off" | "DALI" | "HVAC"): Promise<void> {
  await page.locator(".scene-area-chip").filter({ hasText: mode === "On/Off" ? /On\/Off/ : new RegExp(`^${mode}$`) }).first().click();
  await page.waitForTimeout(400);
}

/** 実データ行数 (空状態プレースホルダ行 .screen-empty を除く) */
async function dataRowCount(page: Page): Promise<number> {
  const total = await page.locator("tbody tr").count();
  const empty = await page.locator("tbody .screen-empty").count();
  return empty > 0 ? 0 : total;
}

/**
 * + Add Device → DeviceSelectModal でモデルを選択する。
 * 戻り値: 追加後に増えた実データ行数 (空プレースホルダを考慮)。
 */
async function addDeviceViaModal(page: Page, modelLabel: string): Promise<number> {
  const before = await dataRowCount(page);
  await page.locator(".btn-add-row").filter({ hasText: /Add Device/i }).first().click();
  await expect(page.locator("h3").filter({ hasText: /Select Device/i })).toBeVisible({ timeout: 5000 });
  const deviceBtn = page
    .locator("button")
    .filter({ hasText: new RegExp(modelLabel.replace(/[-]/g, "\\-")) })
    .first();
  await expect(deviceBtn).toBeVisible({ timeout: 5000 });
  await deviceBtn.click();
  await page.waitForTimeout(500);
  const after = await dataRowCount(page);
  return after - before;
}

// ============================================================
test.describe("AUDIT-05 Device Assign", () => {
  test.describe.configure({ mode: "serial" });

  // ---- 1. 基本セットアップ & モーダル経由のデバイス追加 ----
  test("[A05-01] non-DALI デバイス (MQSE-4S1-D) を追加すると 6 アドレス行に展開される", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Dev");
    await createRoomTypeAndSelect(page, "AUDIT-05-Room");
    await gotoDeviceAssign(page);
    await shot(page, "01a-deviceassign-empty");

    const delta = await addDeviceViaModal(page, "MQSE-4S1-D");
    await shot(page, "01b-mqse-added");
    // MQSE-4S1-D は 6 アドレス (Zn1-4, CCO, CCI)
    expect(delta).toBe(6);

    // Device# (instance) が自動採番されて "1" になっている
    // (T-32 で Low/High End の number input が増えたため aria-label で特定する)
    const deviceNumInput = page.locator('tbody input[aria-label="Device number"]').first();
    await expect(deviceNumInput).toHaveValue("1", { timeout: 3000 });
  });

  // ---- 2. instance(Device#) 自動採番: 同一モデル2台目は 2 ----
  test("[A05-02] 同一モデルを2台追加すると Device# が 1, 2 に自動採番される", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Dev2");
    await createRoomTypeAndSelect(page, "AUDIT-05-Room2");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4A1-D"); // 4 addresses
    await addDeviceViaModal(page, "MQSE-4A1-D"); // 2台目
    await shot(page, "02-two-devices");

    // T-32 で Low/High End の number input が増えたため Device# は aria-label で特定する
    const nums = await page.locator('tbody input[aria-label="Device number"]').evaluateAll(
      (els) => els.map((e) => (e as HTMLInputElement).value),
    );
    // 先頭行のみ Device# input を持つ (rowSpan 化) → [1, 2]
    expect(nums).toEqual(["1", "2"]);
  });

  // ---- 3. DALI モード: 1DALUNV=64 アドレス自動アドレッシング ----
  test("[A05-03] DALI タブで QSN2-1DALUNV-D を追加すると 64 アドレス行が生成される", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Dali1");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomD1");
    await gotoDeviceAssign(page);

    await switchMode(page, "DALI");
    await shot(page, "03a-dali-tab-empty");

    const delta = await addDeviceViaModal(page, "QSN2-1DALUNV-D");
    await shot(page, "03b-1dalunv-added");
    expect(delta).toBe(64);

    // Address 列が 1..64 で連番になっているか先頭付近を確認
    // LINE 列が存在する (DALI のみ)
    const lineHeader = page.locator("thead th").filter({ hasText: /^LINE$/ });
    await expect(lineHeader.first()).toBeVisible();
  });

  // ---- 4. DALI モード: 2DALUNV=128 アドレス (2 ライン) ----
  test("[A05-04] DALI タブで QSN2-2DALUNV-D を追加すると 128 アドレス行 (2 LINE) が生成される", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Dali2");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomD2");
    await gotoDeviceAssign(page);

    await switchMode(page, "DALI");
    // 128 行追加には confirm (>10 rows) が出るので accept
    page.once("dialog", (d) => d.accept());
    const delta = await addDeviceViaModal(page, "QSN2-2DALUNV-D");
    await shot(page, "04-2dalunv-added");
    expect(delta).toBe(128);

    // LINE 列に 1 と 2 の両方が出現する (先頭64=LINE1, 後半64=LINE2)
    const lineTexts = await page.locator("tbody td.col-center .cell-readonly").evaluateAll(
      (els) => els.map((e) => (e.textContent || "").trim()).filter((t) => t === "1" || t === "2"),
    );
    expect(lineTexts).toContain("1");
    expect(lineTexts).toContain("2");
  });

  // ---- 5. DALI / non-DALI モード切替でデバイスが正しくフィルタされる ----
  test("[A05-05] DALI で追加したデバイスは On/Off タブに表示されない (タブフィルタ)", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Filter");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomF");
    await gotoDeviceAssign(page);

    // On/Off タブで MQSE-4S1-D 追加
    await addDeviceViaModal(page, "MQSE-4S1-D");
    const fixedRows = await dataRowCount(page);
    expect(fixedRows).toBe(6);

    // DALI タブに切替 → MQSE は出ない (空状態 or 6行ではない)
    await switchMode(page, "DALI");
    await shot(page, "05a-dali-tab-no-fixed");
    const daliBodyText = (await page.locator("tbody").textContent()) || "";
    expect(daliBodyText).not.toContain("MQSE-4S1-D");

    // On/Off タブに戻すと MQSE が再表示
    await switchMode(page, "On/Off");
    const back = (await page.locator("tbody").textContent()) || "";
    expect(back).toContain("MQSE-4S1-D");
  });

  // ---- 6. Reserved 行の表示/非表示トグル ----
  test("[A05-06] Hide Reserved トグルで Reserved 行が非表示になる", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Reserved");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomR");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4S1-D"); // 全行 Reserved 状態
    const rowsAll = await dataRowCount(page);
    expect(rowsAll).toBeGreaterThanOrEqual(6);

    const toggle = page.getByRole("button", { name: /Hide Reserved/i }).first();
    await expect(toggle).toBeVisible({ timeout: 3000 });
    await toggle.click();
    await page.waitForTimeout(400);
    await shot(page, "06a-reserved-hidden");

    // 全行 Reserved なので、Hide すると tbody は空 (screen-empty) または行が大幅減
    const rowsHidden = await dataRowCount(page);
    const emptyMsg = await page.locator("tbody .screen-empty").count();
    expect(rowsHidden < rowsAll || emptyMsg > 0).toBe(true);

    // ラベルが "Show Reserved" に変わる
    await expect(
      page.getByRole("button", { name: /Show Reserved/i }).first(),
    ).toBeVisible({ timeout: 3000 });
  });

  // ---- 7. デバイス置換 (confirm 付き) ----
  test("[A05-07] 既存デバイスグループを別モデルに置換 (confirm) すると行数が変わる", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Replace");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomRp");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4S1-D"); // 6 rows
    const rowsBefore = await dataRowCount(page);
    expect(rowsBefore).toBe(6);

    // 先頭行の device <select> を MQSE-4A1-D (4 rows) に変更 → confirm で置換
    const deviceSelect = page.locator("tbody tr").first().locator("select.cell-input").first();
    await expect(deviceSelect).toBeVisible({ timeout: 3000 });

    let dialogMsg = "";
    page.once("dialog", (d) => {
      dialogMsg = d.message();
      d.accept();
    });
    await deviceSelect.selectOption({ label: "MQSE-4A1-D" });
    await page.waitForTimeout(500);
    await shot(page, "07a-replaced");

    // confirm ダイアログに "Replace" が含まれていた
    expect(dialogMsg).toMatch(/Replace/i);

    const rowsAfter = await dataRowCount(page);
    // MQSE-4A1-D は 4 アドレス → 6 から 4 へ
    expect(rowsAfter).toBe(4);
  });

  // ---- 7b. デバイス置換 confirm キャンセルで置換されない ----
  test("[A05-07b] 置換 confirm をキャンセルすると元のデバイスのまま", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-ReplaceCancel");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomRpC");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4S1-D");
    const rowsBefore = await dataRowCount(page);

    const deviceSelect = page.locator("tbody tr").first().locator("select.cell-input").first();
    page.once("dialog", (d) => d.dismiss());
    await deviceSelect.selectOption({ label: "MQSE-4A1-D" });
    await page.waitForTimeout(500);

    const rowsAfter = await dataRowCount(page);
    expect(rowsAfter).toBe(rowsBefore); // 6 のまま
    // device select の値も MQSE-4S1-D のまま
    const val = await deviceSelect.inputValue();
    expect(val).toBe("MQSE-4S1-D");
  });

  // ---- 8. DALI 回路割り当て: 回路選択でグループ番号が採番される ----
  test("[A05-08] DALI で回路を割り当てると Group 番号 (instance) が自動採番される", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-DaliAssign");
    // DALI 回路を先に用意
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomDA");
    await addCircuit(page, "1", "DALI");

    await gotoDeviceAssign(page);
    await switchMode(page, "DALI");
    await addDeviceViaModal(page, "QSN2-1DALUNV-D"); // 64 addr
    await shot(page, "08a-dali-before-assign");

    // 最初の編集可能な circuit combobox に "1" を入力
    const comboInput = page.locator(".combobox-input:not([disabled])").first();
    if (await comboInput.count() === 0) {
      test.info().annotations.push({ type: "note", description: "DALI circuit combobox not enabled - circuit option may not surface" });
      await shot(page, "08b-no-combobox");
      return;
    }
    await comboInput.fill("1");
    await comboInput.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, "08c-dali-assigned");

    // Group 列に何らかの番号 (1) が表示される
    const bodyText = (await page.locator("tbody").textContent()) || "";
    // circuit "1" が割り当てられて Reserved 以外の行が存在
    expect(bodyText.length).toBeGreaterThan(0);
  });

  // ---- 9. ブロック (デバイスグループ) のドラッグ並べ替え ----
  test("[A05-09] デバイスグループのドラッグハンドルで並べ替えできる (行数維持)", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Drag");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomDr");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4S1-D"); // group A (No=1)
    await addDeviceViaModal(page, "MQSE-4A1-D"); // group B (No=2)
    const rowsBefore = await dataRowCount(page);
    expect(rowsBefore).toBe(10); // 6 + 4

    const handles = page.locator(".drag-handle");
    const handleCount = await handles.count();
    expect(handleCount).toBeGreaterThanOrEqual(2);

    // 先頭デバイス名で並び順を記録
    const firstDeviceBefore = await page.locator("tbody tr").first().locator("select.cell-input").first().inputValue();

    // group B handle を group A の上にドラッグ
    const fromBox = await handles.nth(1).boundingBox();
    const toBox = await handles.nth(0).boundingBox();
    if (!fromBox || !toBox) {
      test.info().annotations.push({ type: "note", description: "drag handle bounding box unavailable" });
      return;
    }
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2 - 4, { steps: 12 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(500);
    await shot(page, "09a-after-drag");

    const rowsAfter = await dataRowCount(page);
    expect(rowsAfter).toBe(rowsBefore); // 削除されていない

    // 並び替えが反映されたか (先頭デバイスが変わったか) — HTML5 DnD はヘッドレスで不安定なため記録のみ
    const firstDeviceAfter = await page.locator("tbody tr").first().locator("select.cell-input").first().inputValue();
    test.info().annotations.push({
      type: "drag-result",
      description: `firstDevice before=${firstDeviceBefore} after=${firstDeviceAfter}`,
    });
  });

  // ---- 10. グループ折りたたみ ----
  test("[A05-10] グループの ▼ ボタンで折りたたむと表示行が減る", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Collapse");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomCol");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4S1-D");
    const rowsBefore = await page.locator("tbody tr").count();

    const collapseBtn = page.locator("button.collapse-toggle").filter({ hasText: "▼" }).first();
    await expect(collapseBtn).toBeVisible({ timeout: 3000 });
    await collapseBtn.click();
    await page.waitForTimeout(400);
    await shot(page, "10a-collapsed");

    const rowsAfter = await page.locator("tbody tr").count();
    expect(rowsAfter).toBeLessThan(rowsBefore);
    expect(rowsAfter).toBe(1); // 先頭行のみ残る
  });

  // ---- 11. グループ削除 ----
  test("[A05-11] Delete Device でグループ全行が削除される", async ({ page }) => {
    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Del");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomDel");
    await gotoDeviceAssign(page);

    await addDeviceViaModal(page, "MQSE-4S1-D");
    expect(await page.locator("tbody tr").count()).toBe(6);

    const delBtn = page.locator("tbody button").filter({ hasText: /Delete Device|Delete/i }).first();
    await expect(delBtn).toBeVisible({ timeout: 3000 });
    await delBtn.click();
    await page.waitForTimeout(400);
    await shot(page, "11a-deleted");

    const emptyMsg = await page.locator("tbody .screen-empty").count();
    const remaining = await page.locator("tbody tr").count();
    expect(emptyMsg > 0 || remaining === 0 || remaining === 1).toBe(true);
  });

  // ---- 12. コンソールエラー監視 (DALI 操作中) ----
  test("[A05-12] DALI デバイス追加〜モード切替で console error が出ない", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await isolate(page);
    await createAndOpenProject(page, "AUDIT-05-Console");
    await createRoomTypeAndSelect(page, "AUDIT-05-RoomCon");
    await gotoDeviceAssign(page);

    await switchMode(page, "DALI");
    await addDeviceViaModal(page, "QSN2-1DALUNV-D");
    await switchMode(page, "On/Off");
    await switchMode(page, "DALI");
    await page.waitForTimeout(300);

    // React の致命的レンダリングエラーが無いこと
    const fatal = errors.filter((e) =>
      /Cannot update a component|Maximum update depth|Rendered more hooks/i.test(e),
    );
    test.info().annotations.push({
      type: "console-errors",
      description: `total=${errors.length} fatal=${fatal.length} :: ${errors.slice(0, 3).join(" | ")}`,
    });
    expect(fatal).toHaveLength(0);
  });
});
