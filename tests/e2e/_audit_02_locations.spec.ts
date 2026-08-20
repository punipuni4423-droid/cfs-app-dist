/**
 * CFS Web App - 動作確認エージェント#2: Area/Location 管理監査
 * 対象: LocationsView (Area タブ) + Circuit/CFS への参照整合性
 * URL: http://localhost:3014
 *
 * 検証観点:
 *  - Location の追加 / 名前編集 / Color 編集 / 並べ替え / 削除
 *  - Location 名変更後、Circuit / CFS の area 表示が壊れないか (参照整合性)
 *  - Location 削除後、Circuit / CFS の area 参照がどうなるか (orphan リスク)
 *
 * アプリ本体は一切変更しない (read-only audit)。
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const SHOT_DIR = join(os.tmpdir(), "cfs-audit02-artifacts", "screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

let mockState: {
  projects: Array<{ name?: string; locations?: Array<{ name?: string }> }>;
};

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
}

/** dev サーバが OneDrive 環境で時々瞬断するため goto をリトライする */
async function gotoWithRetry(page: Page, url: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 15000 });
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1500);
    }
  }
  throw lastErr;
}

/**
 * プロジェクト選択画面が読み込み完了するのを待つ。
 * 注: このアプリは /api/projects (サーバ側 data/projects.json) からプロジェクトを
 * 取得するため、複数監査エージェントが同一 dev サーバを共有すると
 * "Loading projects." のまま固まることがある (環境依存の競合)。
 */
async function waitForProjectList(page: Page): Promise<void> {
  const nameInput = page.locator('input[placeholder*="project name" i]').first();
  await expect(nameInput).toBeVisible({ timeout: 30000 });
}

/** localStorage を完全に消してから reload して隔離する */
async function isolate(page: Page): Promise<void> {
  await gotoWithRetry(page, "/");
  await waitForProjectList(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await waitForProjectList(page);
}

/** プロジェクトを新規作成して開く (UI は英語、競合に備えてリトライ) */
async function createAndOpenProject(page: Page, name: string): Promise<void> {
  await waitForProjectList(page);
  const nameInput = page.locator('input[placeholder*="project name" i]').first();
  const card = page.locator("button.screen-card").filter({ hasText: name });

  for (let attempt = 0; attempt < 3; attempt++) {
    await nameInput.fill(name);
    await expect(nameInput).toHaveValue(name);
    const createBtn = page
      .locator("button")
      .filter({ hasText: /Create Project/i })
      .first();
    await expect(createBtn).toBeEnabled({ timeout: 5000 });
    await createBtn.click();
    try {
      await expect(card.first()).toBeVisible({ timeout: 12000 });
      break;
    } catch {
      // 競合で作成が反映されない場合: ページを再読込して再試行
      if (attempt === 2) throw new Error(`project card "${name}" not visible after retries`);
      await page.reload({ waitUntil: "load" });
      await waitForProjectList(page);
    }
  }

  await card.first().click();
  await expect(page.locator('[role="tablist"]').first()).toBeVisible({
    timeout: 12000,
  });
}

/** 1段目タブをラベルで切り替える */
async function switchPrimaryTab(page: Page, label: RegExp): Promise<void> {
  await page
    .locator('[role="tablist"]')
    .first()
    .locator('[role="tab"]')
    .filter({ hasText: label })
    .first()
    .click();
  await page.waitForTimeout(200);
}

/** Area タブの行を返す (tbody の input を持つ tr) */
function areaRows(page: Page) {
  return page.locator("table.master-table tbody tr").filter({ has: page.locator("input") });
}

/** Room Type タブ → ルームタイプ作成 → Circuit 子タブまで遷移する (UI は英語) */
async function createRoomTypeAndOpenCircuit(page: Page, roomName: string): Promise<void> {
  await switchPrimaryTab(page, /Room Type/i);
  const roomInput = page.locator('input[placeholder*="room type name" i]').first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);
  await page.locator("button").filter({ hasText: /Create Room Type/i }).first().click();
  const roomTab = page.locator('[role="tab"]').filter({ hasText: roomName }).first();
  await expect(roomTab).toBeVisible({ timeout: 8000 });
  await roomTab.click();
  await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
  await page.waitForTimeout(300);
}

/** Circuit タブに戻る (Room Type → Circuit) */
async function backToCircuit(page: Page): Promise<void> {
  await switchPrimaryTab(page, /Room Type/i);
  await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
  await page.waitForTimeout(300);
}

test.describe("AUDIT-02 Area/Location 管理", () => {
  // 複数監査エージェントが同一 dev サーバ + data/projects.json を共有するため
  // /api/projects が高負荷で遅延する。各テストのタイムアウトを延長する。
  test.describe.configure({ timeout: 150000 });

  // 並行して走る他監査エージェントと localStorage を共有するため、
  // プロジェクト名はテストごとに一意にして取り違えを防ぐ。
  let projectName = "AUDIT-02-Loc";

  test.beforeEach(async ({ page }, testInfo) => {
    mockState = await installLocalEditingMocks(page);
    projectName = `AUDIT-02-Loc-${Date.now()}-${testInfo.workerIndex}`;
    await isolate(page);
    await createAndOpenProject(page, projectName);
    await switchPrimaryTab(page, /^Area$/);
    // LocationsView が出ていること
    await expect(
      page.locator("table.master-table thead").filter({ hasText: /Area/ }),
    ).toBeVisible({ timeout: 8000 });
  });

  test("A1: Location を複数追加できる (デフォルト11件 + 追加)", async ({ page }) => {
    const addBtn = page.locator(".btn-add-row").first();
    await expect(addBtn).toBeVisible();
    // 新規プロジェクトはデフォルトで Area が seed される (Entrance 等)
    const initial = await areaRows(page).count();
    expect(initial).toBeGreaterThan(0);
    await shot(page, "A1-01-default-seed");

    await addBtn.click();
    await addBtn.click();
    await addBtn.click();

    await expect(areaRows(page)).toHaveCount(initial + 3, { timeout: 5000 });
    await shot(page, "A1-02-after-add3");

    // No 列が最終的に連番 (1..initial+3) で表示されること
    const rows = areaRows(page);
    const count = await rows.count();
    const lastNo = ((await rows.nth(count - 1).locator("td").nth(1).textContent()) ?? "").trim();
    expect(lastNo).toBe(String(initial + 3));
    // アノテーション: デフォルト seed 件数を記録
    test.info().annotations.push({
      type: "default-area-seed-count",
      description: String(initial),
    });
  });

  test("A2: 名前と番号を編集して保持される", async ({ page }) => {
    const addBtn = page.locator(".btn-add-row").first();
    await addBtn.click();

    // 追加した最終行を編集 (デフォルト seed 行は触らない)
    const row = areaRows(page).last();
    const nameInput = row.locator("input").nth(0);
    const numberInput = row.locator("input").nth(1);

    await nameInput.fill("Living Room");
    await numberInput.fill("101");
    await page.waitForTimeout(200);

    await expect(nameInput).toHaveValue("Living Room");
    await expect(numberInput).toHaveValue("101");
    await shot(page, "A2-01-edited");

    // Secure-sharing regression mode verifies persistence by reloading the app.
    await page.waitForTimeout(1500);

    // リロードして永続化を確認。
    // 注意: リロード後はプロジェクト選択画面に戻る (アクティブプロジェクトは復元されない)。
    // → プロジェクトを再度開く必要がある。
    await page.reload({ waitUntil: "load" });
    const reopenCard = page
      .locator("button.screen-card")
      .filter({ hasText: projectName })
      .first();
    await expect(reopenCard).toBeVisible({ timeout: 10000 });
    await reopenCard.click();
    await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 10000 });
    await switchPrimaryTab(page, /^Area$/);

    // 永続化された "Living Room" 行が存在することを確認 (位置ではなく値で特定)
    const persisted = page.locator('table.master-table tbody input[value="Living Room"]');
    await expect(persisted).toHaveCount(1, { timeout: 8000 });
    await shot(page, "A2-02-after-reload");
  });

  test("A3: Color プルダウンで色を変更すると行の背景が変わる", async ({ page }) => {
    const addBtn = page.locator(".btn-add-row").first();
    await addBtn.click();

    const row = areaRows(page).last();
    const colorSelect = row.locator("select.color-select, select").first();
    await expect(colorSelect).toBeVisible();

    // AREA_COLORS の最初の色 (空白以外) を選ぶ
    const optionValues = await colorSelect.locator("option").evaluateAll(
      (opts) => opts.map((o) => (o as HTMLOptionElement).value),
    );
    const firstColor = optionValues.find((v) => v && v.startsWith("#"));
    expect(firstColor, "色オプションが存在する").toBeTruthy();
    await colorSelect.selectOption(firstColor!);
    await page.waitForTimeout(200);

    const bg = await row.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    await shot(page, "A3-01-colored");
  });

  test("A4: ドラッグハンドルが存在し並べ替え操作で行数が保持される", async ({ page }) => {
    const addBtn = page.locator(".btn-add-row").first();
    const before = await areaRows(page).count();
    await addBtn.click();
    await addBtn.click();

    const totalRows = before + 2;
    await expect(areaRows(page)).toHaveCount(totalRows);

    // ドラッグハンドルは全行分存在する
    const handles = page.locator(".drag-handle");
    expect(await handles.count()).toBe(totalRows);
    await shot(page, "A4-01-before-reorder");

    // 末尾2行のハンドルでドラッグ操作を試す (HTML5 ネイティブ DnD)
    const lastIdx = totalRows - 1;
    const fromBox = await handles.nth(lastIdx).boundingBox();
    const toBox = await handles.nth(lastIdx - 1).boundingBox();
    expect(fromBox && toBox).toBeTruthy();

    await handles.nth(lastIdx).hover();
    await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(toBox!.x + toBox!.width / 2, toBox!.y + 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await shot(page, "A4-02-after-reorder");

    // 行数は保持される (削除されない)
    await expect(areaRows(page)).toHaveCount(totalRows);
  });

  test("A5: Delete ボタンで行が即削除される (確認ダイアログの有無を記録)", async ({ page }) => {
    const addBtn = page.locator(".btn-add-row").first();
    const before = await areaRows(page).count();
    await addBtn.click();
    await expect(areaRows(page)).toHaveCount(before + 1);
    await shot(page, "A5-00-before-delete");

    // 確認ダイアログが出るか監視 (LocationsView は確認なしで即削除する想定)
    let dialogShown = false;
    page.once("dialog", (d) => {
      dialogShown = true;
      d.accept();
    });

    await areaRows(page)
      .last()
      .locator("button")
      .filter({ hasText: /Delete|削除/ })
      .click();
    await page.waitForTimeout(400);

    await expect(areaRows(page)).toHaveCount(before, { timeout: 5000 });
    await shot(page, "A5-01-after-delete");
    // dialogShown の値は後段の報告で参照 (ここではアサートしない)
    test.info().annotations.push({
      type: "delete-confirm-dialog",
      description: String(dialogShown),
    });
  });

  // ---- 参照整合性: 名前変更 ----
  test("A6: Location 名変更が Circuit の Area プルダウン表示に反映される (参照整合性)", async ({
    page,
  }) => {
    // Area を1件作成 (デフォルト seed に "Bedroom" が含まれるため一意名を使う)
    const addBtn = page.locator(".btn-add-row").first();
    await addBtn.click();
    const areaName = areaRows(page).last().locator("input").nth(0);
    await areaName.fill("AreaA6-Orig");
    await page.waitForTimeout(200);

    // Room Type タブへ → ルームタイプ作成 → Circuit
    await createRoomTypeAndOpenCircuit(page, "Room-A6");

    // Circuit 行を追加して Area を "AreaA6-Orig" に設定
    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);

    // Circuit の Area select (option に "AreaA6-Orig" を持つ select) を探す
    const areaSelect = page
      .locator("tbody select")
      .filter({ has: page.locator("option", { hasText: "AreaA6-Orig" }) })
      .first();
    await expect(areaSelect).toBeVisible({ timeout: 5000 });
    await areaSelect.selectOption({ label: "AreaA6-Orig" });
    await page.waitForTimeout(200);
    await shot(page, "A6-01-circuit-area-set");

    // 設定値 (= LocationMaster.id) を控える
    const selectedIdBefore = await areaSelect.inputValue();
    expect(selectedIdBefore).not.toBe("");

    // Area タブに戻って自分の行の名前を "AreaA6-Renamed" に変更
    await switchPrimaryTab(page, /^Area$/);
    const myRow = areaRows(page).filter({
      has: page.locator('input[value="AreaA6-Orig"]'),
    });
    await myRow.locator("input").nth(0).fill("AreaA6-Renamed");
    await page.waitForTimeout(300);
    await shot(page, "A6-02-renamed");

    // Circuit タブに戻る
    await backToCircuit(page);

    const areaSelectAfter = page
      .locator("tbody select")
      .filter({ has: page.locator("option", { hasText: "AreaA6-Renamed" }) })
      .first();
    await expect(areaSelectAfter).toBeVisible({ timeout: 5000 });

    // (1) 選択 id は変わっていない (参照は id ベース)
    const selectedIdAfter = await areaSelectAfter.inputValue();
    expect(selectedIdAfter).toBe(selectedIdBefore);

    // (2) 表示ラベルが新名称になっている = "unregistered" 化していない
    const selectedLabel = await areaSelectAfter.evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "",
    );
    expect(selectedLabel.trim()).toBe("AreaA6-Renamed");

    // (3) 旧名称 "AreaA6-Orig" の option が残っていない (orphan/unregistered なし)
    const hasOldLabel = await areaSelectAfter
      .locator("option")
      .filter({ hasText: /^AreaA6-Orig$/ })
      .count();
    expect(hasOldLabel).toBe(0);

    await shot(page, "A6-03-circuit-after-rename");
  });

  // ---- 参照整合性: 削除 ----
  test("A7: Location 削除後 Circuit の area 参照が orphan 化する挙動を観察", async ({
    page,
  }) => {
    // Area を1件作成 (一意名)
    await page.locator(".btn-add-row").first().click();
    await areaRows(page).last().locator("input").nth(0).fill("AreaA7-Del");
    await page.waitForTimeout(200);

    // Room Type → ルームタイプ → Circuit
    await createRoomTypeAndOpenCircuit(page, "Room-A7");

    await page.locator(".btn-add-row").first().click();
    await page.waitForTimeout(300);

    const areaSelect = page
      .locator("tbody select")
      .filter({ has: page.locator("option", { hasText: "AreaA7-Del" }) })
      .first();
    await expect(areaSelect).toBeVisible({ timeout: 5000 });
    await areaSelect.selectOption({ label: "AreaA7-Del" });
    await page.waitForTimeout(200);
    const orphanId = await areaSelect.inputValue();
    expect(orphanId).not.toBe("");
    await shot(page, "A7-01-circuit-uses-area");

    // Area タブへ戻って "AreaA7-Del" の行を削除
    await switchPrimaryTab(page, /^Area$/);
    page.once("dialog", (d) => d.accept());
    await areaRows(page)
      .filter({ has: page.locator('input[value="AreaA7-Del"]') })
      .locator("button")
      .filter({ hasText: /Delete|削除/ })
      .click();
    await page.waitForTimeout(400);
    await shot(page, "A7-02-area-deleted");

    // Circuit に戻り、Area select の状態を観察
    await backToCircuit(page);

    // どの Area select も "AreaA7-Del" option を持たないこと (削除済み)
    const deletedOptionCount = await page
      .locator("tbody select option")
      .filter({ hasText: /^AreaA7-Del$/ })
      .count();

    // Circuit 行の Area select (— option を持つ select) の現在値とラベルを観察
    const areaSelectNow = page
      .locator("tbody select")
      .filter({ has: page.locator("option", { hasText: "—" }) })
      .first();
    let currentVal = "(no area select)";
    let selectedLabel = "(no area select)";
    if (await areaSelectNow.count()) {
      currentVal = await areaSelectNow.inputValue();
      selectedLabel = await areaSelectNow.evaluate(
        (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "(none)",
      );
    }
    await shot(page, "A7-03-circuit-after-delete");

    // アノテーションに観察結果を記録 (挙動の良し悪しは報告で判断)
    test.info().annotations.push({
      type: "orphan-observation",
      description: `deletedOptionCount=${deletedOptionCount}, circuitAreaValue="${currentVal}", selectedLabel="${selectedLabel}", orphanIdWas="${orphanId}"`,
    });

    // 削除された Area の option は消えているはず
    expect(deletedOptionCount).toBe(0);
  });
});
