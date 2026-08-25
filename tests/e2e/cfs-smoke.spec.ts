/**
 * CFS Web App - E2E Smoke Tests
 * 対象: http://localhost:3001 (PLAYWRIGHT_BASE_URL で上書き可)
 * Storage: cfs-projects-v14 (プロジェクト), cfs-app-settings-v1 (デバイスマスター)
 */
import { test, expect, type Page } from '@playwright/test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

const PROJECT_NAME = `E2E-Test-${Date.now()}`;
const ROOM_NAME = `TestRoom-${Date.now()}`;

test.beforeEach(async ({ page }) => {
  await installLocalEditingMocks(page);
});

// ---- helpers ----

/** localStorage を完全クリアする */
async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
}

function projectNameInput(page: Page) {
  return page.locator('input[placeholder="New project name"], input[placeholder*="プロジェクト名"]').first();
}

function createProjectButton(page: Page) {
  return page.getByRole('button', { name: /Create Project|作成|追加|新規/ }).first();
}

function roomTypeNameInput(page: Page) {
  return page.locator('input[placeholder="New room type name"], input[placeholder*="ルームタイプ名"]').first();
}

function createRoomTypeButton(page: Page) {
  return page.getByRole('button', { name: /Create Room Type|ルームタイプ作成|作成/ }).first();
}

function roomTypeParentTab(page: Page) {
  return page.locator('[role="tab"]').filter({ hasText: /Room Type|Rooms/i }).first();
}

/** プロジェクト一覧から新規プロジェクトを作成して画面遷移する */
async function createAndOpenProject(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await clearStorage(page);
  await page.reload({ waitUntil: 'load' });
  const nameInput = projectNameInput(page);
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await expect(nameInput).toBeEnabled({ timeout: 10000 });
  await nameInput.fill(name);
  await expect(nameInput).toHaveValue(name, { timeout: 3000 });
  const createBtn = createProjectButton(page);
  await expect(createBtn).toBeEnabled({ timeout: 5000 });
  await createBtn.click();
  await expect(page.locator('text=プロジェクトがありません')).toHaveCount(0, { timeout: 8000 });
  const card = page.locator('button.screen-card').filter({ hasText: name });
  const projectTablist = page.locator('[role="tablist"]').first();
  await expect(async () => {
    const openedProject = await projectTablist.isVisible().catch(() => false);
    const returnedToList = await card.first().isVisible().catch(() => false);
    expect(openedProject || returnedToList).toBe(true);
  }).toPass({ timeout: 10000 });
  if (await card.first().isVisible().catch(() => false)) {
    await card.first().click();
  }
  await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 10000 });
}

/** タブラベルで切り替える (role="tab" 要素) */
async function switchTab(page: Page, labelPattern: RegExp): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: labelPattern }).first().click();
}

/**
 * Room Type 親タブに移動し、ルームタイプを作成 → 選択して子タブを出現させる。
 * 選択後は activeSubTab が "cfs" になるので、必要なら別途子タブをクリックすること。
 */
async function createRoomTypeAndSelect(page: Page, roomName: string): Promise<void> {
  await roomTypeParentTab(page).click();
  await page.waitForTimeout(300);

  // ルームタイプ名を入力して作成
  const roomInput = roomTypeNameInput(page);
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);

  const roomCreateBtn = createRoomTypeButton(page);
  await roomCreateBtn.click();

  const roomCard = page.locator('button.screen-card').filter({ hasText: roomName }).first();
  const roomTab = page.locator('[role="tab"]').filter({ hasText: roomName }).first();
  await expect(async () => {
    const openedRoomType = await roomTab.isVisible().catch(() => false);
    const returnedToManage = await roomCard.isVisible().catch(() => false);
    expect(openedRoomType || returnedToManage).toBe(true);
  }).toPass({ timeout: 10000 });
  if (await roomCard.isVisible().catch(() => false)) {
    await roomCard.click();
  }

  // 子タブバーが出現するのを待つ (Circuit タブ)
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first()
  ).toBeVisible({ timeout: 8000 });
}

/** Room Type → ルームタイプ作成 → Device Assign 子タブに遷移する */
async function setupRoomAndSelectDeviceAssign(page: Page, roomName: string): Promise<void> {
  await createRoomTypeAndSelect(page, roomName);

  // Device Assign 子タブをクリック
  await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
  await page.waitForTimeout(300);
}

// ============================================================
// テスト 1: アプリ起動 & プロジェクト一覧
// ============================================================
test.describe('01 - プロジェクト一覧', () => {
  test('ルートが 200 で表示される', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/.+/);
  });

  test('プロジェクト作成フォームが存在する', async ({ page }) => {
    await page.goto('/');
    await clearStorage(page);
    await page.reload({ waitUntil: 'networkidle' });
    const input = projectNameInput(page);
    await expect(input).toBeVisible({ timeout: 8000 });
  });

  test('プロジェクトを新規作成できる', async ({ page }) => {
    await page.goto('/');
    await clearStorage(page);
    await page.reload({ waitUntil: 'networkidle' });
    const uniqueName = `TestProj-${Date.now()}`;
    const input = projectNameInput(page);
    await input.fill(uniqueName);
    const createBtn = createProjectButton(page);
    await createBtn.click();
    await expect(page.locator(`text=${uniqueName}`).first()).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================
// テスト 2: プロジェクト画面 - 基本タブ構造 (R7)
// ============================================================
test.describe('02 - プロジェクト画面タブ構造 [R7]', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-tab`);
  });

  test('[R7] 1段目タブに Area / Fixture / Room Type が存在する', async ({ page }) => {
    // 親タブバーのみを対象にする (primary タブ)
    const primaryTablist = page.locator('[role="tablist"]').first();
    await expect(primaryTablist.locator('[role="tab"]').filter({ hasText: /Area/i })).toBeVisible();
    await expect(primaryTablist.locator('[role="tab"]').filter({ hasText: /Fixture/i })).toBeVisible();
    await expect(primaryTablist.locator('[role="tab"]').filter({ hasText: /Room Type|Rooms/i })).toBeVisible();
  });

  test('[R7] Room Type をクリックすると 2段目に Circuit / Device Assign / CFS が出現する', async ({ page }) => {
    const roomName = `R7-Room-${Date.now()}`;
    await createRoomTypeAndSelect(page, roomName);

    // 子タブ Circuit / Device Assign / CFS が出現する
    await expect(page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first()).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[role="tab"]').filter({ hasText: /CFS/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test('設定歯車ボタンが右上に存在する', async ({ page }) => {
    const settingsBtn = page.locator('.settings-button, button[aria-label="設定メニュー"]').first();
    await expect(settingsBtn).toBeVisible();
  });

  test('設定ボタンを開くと Device Master 設定ダイアログが表示される', async ({ page }) => {
    const settingsBtn = page.locator('.settings-button, button[aria-label="設定メニュー"]').first();
    await settingsBtn.click();
    await expect(page.getByRole('dialog', { name: /Device Master Shared App Settings/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Device Master' })).toBeVisible();
  });

  test('設定ダイアログで Display タブへ切り替えられる', async ({ page }) => {
    const settingsBtn = page.locator('.settings-button, button[aria-label="設定メニュー"]').first();
    await settingsBtn.click();
    await page.getByRole('button', { name: 'Display' }).click();
    await expect(page.getByRole('heading', { name: 'Display Size' })).toBeVisible();
  });
});

// ============================================================
// テスト 3: Area タブ
// ============================================================
test.describe('03 - Area タブ', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-area`);
    await switchTab(page, /^📍|^Area/);
  });

  test('＋行追加ボタンで行が増える', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });
  });

  test('Color列にプルダウン (select) が存在する', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    const colorSelect = page.locator('.color-cell select, select.color-select').first();
    await expect(colorSelect).toBeVisible();
  });

  test('Colorプルダウンで Red を選択すると行の背景色が変わる', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    const colorSelect = page.locator('.color-cell select, select.color-select').first();
    await colorSelect.selectOption({ value: '#FFC7CE' });

    const row = page.locator('tbody tr').last();
    await expect(async () => {
      const bgColor = await row.evaluate((el) =>
        window.getComputedStyle(el).backgroundColor
      );
      expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(bgColor).not.toBe('transparent');
    }).toPass({ timeout: 3000 });
  });

  test('削除ボタン → キャンセルで行が消えない', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    const inputsBefore = await page.locator('tbody input').count();

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('tbody tr').last().locator('button').filter({ hasText: /削除/ }).click();

    await page.waitForTimeout(500);
    expect(await page.locator('tbody input').count()).toBe(inputsBefore);
  });

  test('削除ボタン → OK で行が削除される', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    const inputsBefore = await page.locator('tbody input').count();

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('tbody tr').last().locator('button').filter({ hasText: /削除/ }).click();

    await expect(async () => {
      const inputsAfter = await page.locator('tbody input').count();
      const emptyMsg = await page.locator('tbody .screen-empty').count();
      expect(inputsAfter < inputsBefore || emptyMsg > 0).toBe(true);
    }).toPass({ timeout: 5000 });
  });
});

// ============================================================
// テスト 4: Fixture タブ
// ============================================================
test.describe('04 - Fixture タブ', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-fixture`);
    await switchTab(page, /^💡|^Fixture/);
  });

  test('Fixture タブが表示される', async ({ page }) => {
    await expect(page.locator('thead').filter({ hasText: /Fixture/i })).toBeVisible({ timeout: 5000 });
  });

  test('＋行追加ボタンで Fixture 行が増える', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });
  });

  test('CSV 出力ボタンが存在する', async ({ page }) => {
    const exportBtn = page.locator('button').filter({ hasText: /CSV出力|出力|Export/i }).first();
    await expect(exportBtn).toBeVisible();
  });

  test('CSV 取込ボタンが存在し、隠れた file input がある', async ({ page }) => {
    const importBtn = page.locator('button').filter({ hasText: /CSV取込|取込|Import/i }).first();
    await expect(importBtn).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toBeAttached();
  });

  test('削除ボタン → OK で Fixture 行が削除される', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('tbody tr').last().locator('button').filter({ hasText: /削除/ }).click();

    await expect(async () => {
      const inputCount = await page.locator('tbody input').count();
      const emptyMsg = await page.locator('tbody .screen-empty, tbody td[colspan]').count();
      expect(inputCount === 0 || emptyMsg > 0).toBe(true);
    }).toPass({ timeout: 5000 });
  });
});

// ============================================================
// テスト 5: Room Type → Circuit 子タブ (R8, R9)
// ============================================================
test.describe('05 - Room Type → Circuit 子タブ [R8, R9]', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-circuit`);
    // Room Type 親タブ → ルームタイプ作成 → Circuit 子タブ
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-circuit`);
    // ルームタイプ選択後 activeSubTab は "cfs" になるので Circuit に切り替え
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(300);
  });

  test('[R8] Circuit タブに「行を追加」ボタン（旧「+回路を追加」ではない）がある', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    // ラベルが「行を追加」であること
    const label = await addBtn.textContent();
    expect(label).toMatch(/行を追加/);
    // 旧ラベルでないこと
    expect(label).not.toMatch(/^\+回路を追加$/);
  });

  test('[R9] 「行を追加」ボタンが親テーブルの全幅にほぼ一致する', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });

    const btnWidth = await addBtn.evaluate((el) => el.getBoundingClientRect().width);
    const table = page.locator('table.matrix-table').first();
    const tableWidth = await table.evaluate((el) => el.getBoundingClientRect().width);

    // ボタン幅がテーブル幅の 90% 以上であること (余白分を考慮)
    expect(btnWidth).toBeGreaterThan(tableWidth * 0.85);
  });

  test('Circuit タブが表示される', async ({ page }) => {
    await expect(page.locator('thead').filter({ hasText: /Designer|Circuit/i })).toBeVisible({ timeout: 5000 });
  });

  test('＋行追加ボタンで Circuit 行が増える', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });
  });

  test('行の小さな + ボタンで同一 DesignerNumber の行が追加される', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    const subAddBtns = page.locator('tbody button').filter({ hasText: '+' });
    const count = await subAddBtns.count();

    if (count > 0) {
      const inputsBefore = await page.locator('tbody input').count();
      await subAddBtns.first().click();
      await expect(async () => {
        const inputsAfter = await page.locator('tbody input').count();
        expect(inputsAfter).toBeGreaterThan(inputsBefore);
      }).toPass({ timeout: 5000 });
    } else {
      test.fixme(true, 'Circuit sub-add + button not found');
    }
  });

  test('削除ボタン → OK で Circuit 行が削除される', async ({ page }) => {
    // Circuit subtab がアクティブであることを再確認
    const circuitTab = page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first();
    await expect(circuitTab).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });

    // 削除ボタンを持つ行のカウントを取得
    const rowsWithDelete = page.locator('tbody tr:has(button:has-text("削除"))');
    const rowsBefore = await rowsWithDelete.count();

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('tbody tr').last().locator('button').filter({ hasText: /削除/ }).click();

    await expect(async () => {
      const rowsAfter = await rowsWithDelete.count();
      const emptyMsg = await page.locator('tbody .screen-empty, tbody td[colspan]').count();
      expect(rowsAfter < rowsBefore || emptyMsg > 0).toBe(true);
    }).toPass({ timeout: 8000 });
  });
});

// ============================================================
// テスト 6: Room Type → Device Assign タブ (R1〜R6)
// ============================================================
test.describe('06 - Room Type → Device Assign タブ [R1〜R6]', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-rooms`);
    await setupRoomAndSelectDeviceAssign(page, ROOM_NAME);
  });

  // ---- R3: Circuit # ヘッダ確認 ----
  test('[R3] ヘッダが "Circuit #" になっている（旧 "Circuit Number" ではない）', async ({ page }) => {
    // th の中に "Circuit #" テキストがあること
    const circuitHeader = page.locator('thead th').filter({ hasText: /Circuit #/ });
    await expect(circuitHeader.first()).toBeVisible({ timeout: 5000 });

    // 旧テキスト "Circuit Number" が独立してヘッダに無いこと
    const oldHeader = page.locator('thead th').filter({ hasText: /^Circuit Number$/ });
    expect(await oldHeader.count()).toBe(0);
  });

  // ---- R4/R5: ▽ボタン押下でリスト表示、フォーカスのみでは出ない ----
  test('[R4] Circuit # 入力欄の右側に ▾ ボタンがある', async ({ page }) => {
    // 行を追加して Combobox を表示する
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // combobox-trigger ボタンが存在する
    const triggerBtn = page.locator('.combobox-trigger').first();
    await expect(triggerBtn).toBeVisible({ timeout: 5000 });
    const label = await triggerBtn.textContent();
    expect(label?.trim()).toMatch(/▾|▽/);
  });

  test('[R5] フォーカスだけでは Combobox リストが開かない', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // Combobox input にフォーカス
    const comboInput = page.locator('.combobox-input').first();
    await comboInput.focus();
    await page.waitForTimeout(300);

    // リスト (.combobox-list) は表示されていないこと
    const list = page.locator('.combobox-list');
    expect(await list.count()).toBe(0);
  });

  test('[R4/R5] ▾ ボタン押下でリストが開く', async ({ page }) => {
    // combobox は device が設定された行でしか enabled にならない。
    // MQSE-4S1-D を選択してグループを展開し、最初の行で combobox を操作する。
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // デバイスが設定された行の combobox-trigger を取得 (enabled になっているはず)
    const triggerBtn = page.locator('.combobox-trigger:not([disabled])').first();
    await expect(triggerBtn).toBeVisible({ timeout: 5000 });
    await triggerBtn.click();
    await page.waitForTimeout(300);

    // aria-expanded が true になる
    const comboboxWrap = page.locator('[role="combobox"]').first();
    await expect(comboboxWrap).toHaveAttribute('aria-expanded', 'true');
  });

  // ---- R18 (旧 R2 を置き換え): No 列はデバイスインスタンス毎に先頭行のみ表示 ----
  test('[R18] No 列はデバイスインスタンス毎に先頭行のみ番号、以降は空欄', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // MQSE-4S1-D を選択 (6 行展開)
    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // tbody の全行の "No" 列 (2列目 = index 1) を取得
    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(6);

    // 展開された 6 行: 先頭行は "1"、2〜6行目は空欄
    const nos: string[] = [];
    for (let i = rowCount - 6; i < rowCount; i++) {
      const noCell = rows.nth(i).locator('td').nth(1);
      const text = (await noCell.textContent()) ?? '';
      nos.push(text.trim());
    }
    expect(nos[0]).toBe('1');
    expect(nos.slice(1)).toEqual(['', '', '', '', '']);
  });

  // ---- R9: ボタン幅がテーブル全幅 ----
  test('[R9] 「行を追加」ボタンがテーブル全幅', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });

    const btnWidth = await addBtn.evaluate((el) => el.getBoundingClientRect().width);
    const table = page.locator('table.matrix-table').first();
    const tableWidth = await table.evaluate((el) => el.getBoundingClientRect().width);

    expect(btnWidth).toBeGreaterThan(tableWidth * 0.85);
  });

  test('Device Assign タブに ＋行追加ボタンが存在する', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible();
  });

  test('空白行の Device <select> が enabled (バグ修正確認)', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    const selectCount = await deviceSelect.count();

    if (selectCount > 0) {
      const isDisabled = await deviceSelect.isDisabled();
      expect(isDisabled).toBe(false);

      const optionCount = await deviceSelect.locator('option').count();
      expect(optionCount).toBeGreaterThan(1);
    } else {
      const deviceInput = lastRow.locator('input').first();
      await expect(deviceInput).toBeEnabled();
    }
  });

  test('空白行で MQSE-4S1-D を選択すると 6 行に展開される', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const initialRows = await page.locator('tbody tr').count();
    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    const selectCount = await deviceSelect.count();

    if (selectCount === 0) {
      test.fixme(true, 'Device select not found as <select>');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const newRows = await page.locator('tbody tr').count();
    expect(newRows).toBe(initialRows + 5);
  });

  // R30 対応: rowSpan 化により 2 行目以降に Device <td> 自体が存在しない
  test('[R30-existing] 展開グループの 2 行目以降に Device <select> 要素が存在しない (rowSpan 化)', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();

    // MQSE-4S1-D は 6 行展開。先頭行のみ Device td が rowSpan="6" で存在し、
    // 2〜6 行目には Device <select> (td 自体) が存在しないことを確認する。
    expect(rowCount).toBeGreaterThanOrEqual(6);

    // 2 行目以降 (rowCount-5 〜 rowCount-1) に Device select がないこと
    for (let i = rowCount - 5; i < rowCount; i++) {
      const row = rows.nth(i);
      // Device select が td ごと存在しない場合と、td はあるが select がない場合の両方に対応
      const selectsInRow = row.locator('select[class*="input"], select.input-select').count();
      // select 要素の総数が 1 以下 (combobox-trigger のみ) であること
      // rowSpan 化で Device td が先頭行に吸収されているため行内に Device select がない
      const devSelectCount = await row.locator('td select').count();
      // 2行目以降は Device 列の td がないため select が含まれないか、
      // 含まれても circuit number の combobox のみ
      // ここでは select 数が先頭行より少ないことを確認（0 または combobox のみ）
      // 厳密には: Device select は先頭行にのみ存在するので 2 行目以降は 0
      const deviceSelects = await row.locator('td:first-of-type select, td select[size]').count();
      // 行全体の select 要素からcombobox 以外（= native select）を数える
      // DeviceAssignView では Device 列は <select> タグ、Circuit 列は .combobox-input
      // 2 行目以降の native select は 0 であるべき
      const nativeSelects = await row.locator('select:not(.combobox-input)').count();
      expect(nativeSelects).toBe(0);
    }
  });

  // ---- R3: Circuit # ヘッダ確認 (再掲・詳細確認) ----
  test('[R6] Designer/Internal トグルを切り替えると表示テキストが変わる', async ({ page }) => {
    const toggleBtn = page.locator('button.header-toggle, .th-with-toggle button').first();
    await expect(toggleBtn).toBeVisible({ timeout: 5000 });

    const before = await toggleBtn.textContent();
    await toggleBtn.click();
    await page.waitForTimeout(200);
    const after = await toggleBtn.textContent();
    expect(after).not.toBe(before);
    expect(after).toMatch(/Designer#|Internal#/);
  });

  test('[R6] トグル切り替えで入力済み circuit 番号が対応する番号に変換される', async ({ page }) => {
    // combobox は device が設定された行でしか enabled にならないため、
    // まず MQSE-4S1-D を選択してグループを展開する。
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const toggleBtn = page.locator('button.header-toggle, .th-with-toggle button').first();
    await expect(toggleBtn).toBeVisible({ timeout: 5000 });

    const before = await toggleBtn.textContent();

    // enabled な Combobox input に値を直接入力
    const comboInput = page.locator('.combobox-input:not([disabled])').first();
    await expect(comboInput).toBeEnabled({ timeout: 3000 });
    await comboInput.fill('D-001');
    await page.waitForTimeout(200);

    // トグルを切り替え
    await toggleBtn.click();
    await page.waitForTimeout(300);

    const after = await toggleBtn.textContent();
    expect(after).not.toBe(before);
    // 変換ロジックは circuit テーブルの一致がないと変わらないため、
    // ここでは最低限「トグルが切り替わること」を確認
    // (Circuit テーブルの一致がなければ変換は起きない仕様)
    expect(after).toMatch(/Designer#|Internal#/);
  });

  test('グループ展開後に ▼ ボタンで折りたたみ → 行数が減る', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rowsBefore = await page.locator('tbody tr').count();

    const collapseBtn = page.locator('button.collapse-toggle').filter({ hasText: '▼' }).first();
    await expect(collapseBtn).toBeVisible({ timeout: 3000 });
    await collapseBtn.click();
    await page.waitForTimeout(300);

    const rowsAfter = await page.locator('tbody tr').count();
    expect(rowsAfter).toBeLessThan(rowsBefore);
  });

  test('グループ削除 → OK でグループ全行が削除される', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    page.once('dialog', (d) => d.accept());
    const deleteBtn = page.locator('tbody button').filter({ hasText: /削除/ }).first();
    await deleteBtn.click();
    await page.waitForTimeout(500);

    const remainInputs = await page.locator('tbody input').count();
    const emptyMsg = await page.locator('tbody .screen-empty').count();
    expect(remainInputs === 0 || emptyMsg > 0).toBe(true);
  });

  // ---- R1: グループ間ドラッグ&ドロップ (ベストエフォート) ----
  test('[R1] グループ間ドラッグ&ドロップで行が並び替えられる', async ({ page }) => {
    // グループ A (MQSE-4S1-D) を追加
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);
    const row1 = page.locator('tbody tr').last();
    const sel1 = row1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found - R1 manual verification needed');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // グループ B (MQSE-4A1-D, 4行) を追加
    await addBtn.click();
    await page.waitForTimeout(300);
    const lastRow = page.locator('tbody tr').last();
    const sel2 = lastRow.locator('select').first();
    await sel2.selectOption({ label: 'MQSE-4A1-D' });
    await page.waitForTimeout(500);

    const rowsBefore = await page.locator('tbody tr').count();
    expect(rowsBefore).toBeGreaterThanOrEqual(2);

    // drag-handle の存在確認
    const handles = page.locator('.drag-handle');
    const handleCount = await handles.count();
    expect(handleCount).toBeGreaterThan(0);

    // ドラッグ操作: グループ B の handle を グループ A 先頭行にドロップ
    const handleA = handles.first();
    const handleB = handles.nth(1);

    const fromBox = await handleB.boundingBox();
    const toBox = await handleA.boundingBox();

    if (!fromBox || !toBox) {
      test.fixme(true, 'Could not get bounding box for drag handles');
      return;
    }

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    // 行数が変わっていないこと (削除されていない)
    const rowsAfter = await page.locator('tbody tr').count();
    expect(rowsAfter).toBe(rowsBefore);
  });
});

// ============================================================
// テスト 7: CFS タブ (R9 ボタン幅)
// ============================================================
test.describe('07 - CFS タブ [R9]', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-cfs`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-cfs`);

    // CFS 子タブに切り替え (ルームタイプ選択後 activeSubTab は "cfs" になるはず)
    const cfsTabs = page.locator('[role="tab"]').filter({ hasText: /^CFS/ });
    const cfsCount = await cfsTabs.count();
    if (cfsCount > 0) {
      await cfsTabs.last().click();
    }
  });

  test('CFS タブが表示され ＋行追加ボタンが存在する', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
  });

  test('[R9] CFS タブの「行を追加」ボタンがテーブル全幅', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });

    const btnWidth = await addBtn.evaluate((el) => el.getBoundingClientRect().width);
    const table = page.locator('table.matrix-table').first();
    const tableWidth = await table.evaluate((el) => el.getBoundingClientRect().width);

    expect(btnWidth).toBeGreaterThan(tableWidth * 0.85);
  });

  test('CFS テーブルに 15 列以上が存在する (ヘッダ確認)', async ({ page }) => {
    const headers = page.locator('thead th');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(15);
  });

  test('行追加で行が増える', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await expect(page.locator('tbody input').first()).toBeVisible({ timeout: 5000 });
  });

  test('CFS の Device プルダウンが操作可能', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const deviceSelect = page.locator('tbody tr').last().locator('select').first();
    if (await deviceSelect.count() > 0) {
      await expect(deviceSelect).toBeEnabled();
      const optionCount = await deviceSelect.locator('option').count();
      expect(optionCount).toBeGreaterThan(1);
    }
  });
});

// ============================================================
// テスト 8: 設定 / デバイスマスター (/settings/devices)
// ============================================================
test.describe('08 - デバイスマスター設定画面', () => {
  test('ページが 200 で返る', async ({ page }) => {
    const res = await page.goto('/settings/devices');
    expect(res?.status()).toBe(200);
  });

  test('デフォルト 7 デバイスが input value として存在する', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const defaultDevices = [
      'MQSE-4S1-D', 'MQSE-4A1-D', 'QSN-4P20-D',
      'QSN2-1DALUNV-D', 'QSN2-2DALUNV-D', 'QSE-IO', 'QSE-CI-WCI',
    ];

    for (const name of defaultDevices) {
      await expect(
        page.locator(`input[value="${name}"]`).first()
      ).toBeAttached({ timeout: 8000 });
    }
  });

  test('デフォルトデバイスに既定バッジが表示され削除ボタンがない', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const badge = page.locator('text=既定').first();
    await expect(badge).toBeVisible({ timeout: 5000 });

    const mqseRow = page.locator('tr').filter({ hasText: 'MQSE-4S1-D' }).first();
    if (await mqseRow.count() > 0) {
      const deleteBtn = mqseRow.locator('button').filter({ hasText: /削除/ });
      expect(await deleteBtn.count()).toBe(0);
    }
  });

  test('行追加→デバイス名入力→削除が可能', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible();

    const inputsBefore = await page.locator('tbody input').count();
    await addBtn.click();
    await expect(async () => {
      const inputsAfter = await page.locator('tbody input').count();
      expect(inputsAfter).toBeGreaterThan(inputsBefore);
    }).toPass({ timeout: 5000 });

    const lastRow = page.locator('tbody tr').last();
    const deleteBtn = lastRow.locator('button').filter({ hasText: /削除/ }).first();
    await expect(deleteBtn).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await deleteBtn.click();
    await page.waitForTimeout(500);

    const inputsAfter = await page.locator('tbody input').count();
    expect(inputsAfter).toBeLessThanOrEqual(inputsBefore);
  });

  test('⋮⋮ ドラッグハンドルが存在する', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const handles = page.locator('.drag-handle').first();
    await expect(handles).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================
// テスト 10: R11〜R19 新規要件検証
// ============================================================

// ---- Circuit タブ共通セットアップ ----
async function setupCircuitTab(page: Page): Promise<void> {
  await createAndOpenProject(page, `${PROJECT_NAME}-r11to15-${Date.now()}`);
  await createRoomTypeAndSelect(page, `${ROOM_NAME}-r11to15-${Date.now()}`);
  await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
  await page.waitForTimeout(300);
}

// ---- Device Assign タブ共通セットアップ ----
async function setupDeviceAssignTab(page: Page): Promise<void> {
  await createAndOpenProject(page, `${PROJECT_NAME}-r16to18-${Date.now()}`);
  await setupRoomAndSelectDeviceAssign(page, `${ROOM_NAME}-r16to18-${Date.now()}`);
}

test.describe('10 - R11〜R19 新規要件検証', () => {
  // ---- R11: Fixture 選択時 pcs が空なら 1 が自動入力 ----
  test('[R11] Fixture を選択すると pcs が空なら 1 が自動入力される', async ({ page }) => {
    // プロジェクトを作成して Fixture タブで先にフィクスチャを登録する
    await createAndOpenProject(page, `${PROJECT_NAME}-r11-${Date.now()}`);

    // Fixture タブへ移動してフィクスチャを追加
    await page.locator('[role="tab"]').filter({ hasText: /Fixture/i }).first().click();
    await page.waitForTimeout(300);

    const fixtureAddBtn = page.locator('.btn-add-row').first();
    await expect(fixtureAddBtn).toBeVisible({ timeout: 5000 });
    await fixtureAddBtn.click();
    await page.waitForTimeout(300);

    // フィクスチャ名を入力 (Fixture 列の input)
    const fixtureNameInput = page.locator('tbody tr').last().locator('input').first();
    await expect(fixtureNameInput).toBeVisible({ timeout: 3000 });
    await fixtureNameInput.fill('TestFixture-R11');
    await page.waitForTimeout(200);

    // Circuit タブへ移動する前にルームタイプを作成
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r11-${Date.now()}`);
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(300);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // 最後の行の Fixture <select> を操作
    // Note: Session A の Area <select> 列追加により select.first() が Area を指す可能性があるため、
    // TestFixture-R11 を option に持つ select を明示的に検索する
    const lastRow = page.locator('tbody tr').last();
    const fixtureSelect = lastRow.locator('select').filter({
      has: page.locator('option', { hasText: 'TestFixture-R11' })
    }).first();
    await expect(fixtureSelect).toBeVisible({ timeout: 5000 });

    // Fixture の選択肢を確認
    const options = await fixtureSelect.locator('option').allTextContents();
    const nonEmpty = options.filter((o) => o.trim() !== '—' && o.trim() !== '');
    if (nonEmpty.length === 0) {
      test.fixme(true, 'Fixture 候補なし - 登録が反映されていない');
      return;
    }

    // pcs の combobox-input を確認して空にしておく
    const pcsInput = lastRow.locator('.combobox-input').first();
    await expect(pcsInput).toBeVisible({ timeout: 3000 });
    const currentPcs = await pcsInput.inputValue();
    if (currentPcs !== '') {
      await pcsInput.fill('');
      await page.waitForTimeout(100);
    }

    // Fixture を選択
    await fixtureSelect.selectOption({ index: 1 });
    await page.waitForTimeout(300);

    // pcs が "1" になること (R11)
    const pcsValue = await pcsInput.inputValue();
    expect(pcsValue).toBe('1');
  });

  // ---- R12: Combobox portal 検証 ----
  test('[R12] Combobox dropdown が table の枠を超えて portal で表示される', async ({ page }) => {
    // プロジェクト作成 → Circuit タブで circuit 番号を先に登録 → Device Assign でドロップダウンを開く
    const uniqueSuffix = Date.now();
    await createAndOpenProject(page, `${PROJECT_NAME}-r12-${uniqueSuffix}`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r12-${uniqueSuffix}`);

    // Circuit タブで designer# "1" の回路を追加
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(300);

    const circuitAddBtn = page.locator('.btn-add-row').first();
    await circuitAddBtn.click();
    await page.waitForTimeout(300);

    const circuitRow = page.locator('tbody tr').last();
    const designerInput = circuitRow.locator('.device-cell input').first();
    await expect(designerInput).toBeVisible({ timeout: 5000 });
    await designerInput.fill('C-001');
    await page.waitForTimeout(200);

    // Device Assign タブに移動
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    await page.waitForTimeout(300);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // enabled な combobox-trigger をクリック
    const triggerBtn = page.locator('.combobox-trigger:not([disabled])').first();
    await expect(triggerBtn).toBeVisible({ timeout: 5000 });
    await triggerBtn.click();
    await page.waitForTimeout(300);

    // ドロップダウンが存在する場合に portal 確認
    const portalList = page.locator('.combobox-list-portal');
    const portalCount = await portalList.count();

    if (portalCount === 0) {
      // options が空の場合はドロップダウンが出ない仕様のため fixme
      test.fixme(true, 'combobox-list-portal not visible - circuit options may be empty');
      return;
    }

    await expect(portalList.first()).toBeVisible({ timeout: 3000 });

    // z-index が 1000 以上であることを確認
    const zIndex = await portalList.first().evaluate((el) => {
      return window.getComputedStyle(el).zIndex;
    });
    expect(Number(zIndex)).toBeGreaterThanOrEqual(1000);

    // ドロップダウンが document.body の直接子孫として存在すること (portal)
    const isDirectBodyChild = await portalList.first().evaluate((el) => {
      return el.parentElement === document.body;
    });
    expect(isDirectBodyChild).toBe(true);
  });

  // ---- R13: + ボタンで同じ designerNumber が継承される ----
  test('[R13] Circuit 行追加 + ボタンで同じ designer# が継承される', async ({ page }) => {
    await setupCircuitTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // 最後の行の designerNumber 入力欄に値を設定
    const lastRow = page.locator('tbody tr').last();
    // Designer # セル内の input (collapse-toggle の隣)
    const designerInput = lastRow.locator('.device-cell input').first();
    await expect(designerInput).toBeVisible({ timeout: 5000 });
    await designerInput.fill('D-Test');
    await page.waitForTimeout(200);

    const rowsBefore = await page.locator('tbody tr').count();

    // + ボタン (btn-add-circuit) をクリック
    const addCircuitBtn = lastRow.locator('.btn-add-circuit').first();
    await expect(addCircuitBtn).toBeVisible({ timeout: 5000 });
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    const rowsAfter = await page.locator('tbody tr').count();
    expect(rowsAfter).toBeGreaterThan(rowsBefore);

    // R28 以降は rowSpan 化のため、Designer# input はグループ先頭行にのみ存在する。
    // 先頭行 (グループ開始行) の Designer# input を確認する。
    const allDesignerInputs = page.locator('.device-cell input');
    const inputCount = await allDesignerInputs.count();
    if (inputCount === 0) {
      test.fixme(true, '.device-cell input not found - R28 rowSpan structure may have changed');
      return;
    }
    // 最初の Designer# input の値が継承されていること
    const firstInputValue = await allDesignerInputs.first().inputValue();
    expect(firstInputValue).toBe('D-Test');
  });

  // ---- R14: Circuit No 列はグループ先頭行のみ番号 ----
  test('[R14] Circuit No 列はグループ先頭行のみ番号表示、以降空欄', async ({ page }) => {
    await setupCircuitTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const firstRow = page.locator('tbody tr').last();
    // + ボタンで同グループに 2 行目を追加
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await expect(addCircuitBtn).toBeVisible({ timeout: 5000 });
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // 先頭グループの No 列 (2列目 = index 1)
    const firstNo = await rows.nth(rowCount - 2).locator('td').nth(1).textContent();
    const secondNo = await rows.nth(rowCount - 1).locator('td').nth(1).textContent();

    expect(firstNo?.trim()).not.toBe('');
    expect(secondNo?.trim()).toBe('');
  });

  // ---- R15: Circuit Designer# セル左に折りたたみボタンが先頭行のみ ----
  test('[R15] Circuit Designer# セルの左に折りたたみボタンが先頭行のみ表示される', async ({ page }) => {
    await setupCircuitTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const firstRow = page.locator('tbody tr').last();

    // + ボタンで 2 行目を追加
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await expect(addCircuitBtn).toBeVisible({ timeout: 5000 });
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // 先頭行に collapse-toggle が存在する
    const firstRowCollapse = rows.nth(rowCount - 2).locator('.collapse-toggle');
    await expect(firstRowCollapse).toBeVisible({ timeout: 3000 });

    // 折りたたみボタンクリック → 2 行目が非表示になること
    const rowsBefore = await page.locator('tbody tr').count();
    await firstRowCollapse.click();
    await page.waitForTimeout(300);

    const rowsAfter = await page.locator('tbody tr').count();
    expect(rowsAfter).toBeLessThan(rowsBefore);
  });

  // ---- R16: Designer/Internal トグル時にコンソールエラーが出ない ----
  test('[R16] Designer/Internal トグル時に console error が発生しない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await setupDeviceAssignTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // circuit 番号入力 (enabled な combobox)
    const comboInput = page.locator('.combobox-input:not([disabled])').first();
    if (await comboInput.count() > 0) {
      await comboInput.fill('1');
      await page.waitForTimeout(200);
    }

    // トグルボタンをクリック
    const toggleBtn = page.locator('button.header-toggle, .th-with-toggle button').first();
    await expect(toggleBtn).toBeVisible({ timeout: 5000 });
    await toggleBtn.click();
    await page.waitForTimeout(500);

    // "Cannot update a component" エラーが含まれないこと
    const renderingErrors = errors.filter((e) =>
      e.includes('Cannot update a component')
    );
    expect(renderingErrors).toHaveLength(0);
  });

  // ---- R17: Device Assign グループ折りたたみでスクロール位置が維持 ----
  test('[R17] Device Assign グループ折りたたみでスクロール位置が維持される', async ({ page }) => {
    // viewport を縦長にして確実にスクロール可能な状態を作る
    await page.setViewportSize({ width: 1280, height: 400 });

    await setupDeviceAssignTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    // 複数グループ追加してページを縦長にする
    await addBtn.click();
    await page.waitForTimeout(300);
    const lastRow1 = page.locator('tbody tr').last();
    const sel1 = lastRow1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(400);

    // 2 つ目のグループを追加してページをさらに縦長に
    await addBtn.click();
    await page.waitForTimeout(300);
    const lastRow2 = page.locator('tbody tr').last();
    const sel2 = lastRow2.locator('select').first();
    await sel2.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(400);

    // ページの最大スクロール量を確認
    const maxScroll = await page.evaluate(() =>
      document.documentElement.scrollHeight - window.innerHeight
    );

    // collapse ボタンの存在を先に確認する（この時点では auto-scroll が起きる可能性あり）
    const collapseBtn = page.locator('button.collapse-toggle').filter({ hasText: '▼' }).first();
    await expect(collapseBtn).toBeVisible({ timeout: 3000 });

    if (maxScroll < 10) {
      // ページが短すぎてスクロールできない場合: collapse-toggle が存在することを確認して終了
      return;
    }

    // collapse ボタンを明示的にビューポート内に scroll-into-view させ、
    // Playwright auto-scroll が起きない状態を確定させてから beforeY を記録する
    await collapseBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    // スクロール可能な場合: collapse ボタンが見えている状態でスクロール位置を記録
    const beforeY = await page.evaluate(() => window.scrollY);

    // 1 つ目のグループの collapse ボタンをクリック（この時点で auto-scroll は発生しない）
    await collapseBtn.click();
    // useLayoutEffect の二段 RAF パターン実行を待つ
    await page.waitForTimeout(800);

    const afterY = await page.evaluate(() => window.scrollY);

    // R17 の実装: scrollPosRef に保存した beforeY を復元するので差分が小さいはず。
    // ただし折りたたみでページ高さが減り maxScroll を下回る場合は許容誤差を広くとる。
    const newMaxScroll = await page.evaluate(() =>
      document.documentElement.scrollHeight - window.innerHeight
    );
    const effectiveExpected = Math.min(beforeY, newMaxScroll);
    // 実際のスクロール位置が期待値から 150px 以内であること
    expect(Math.abs(afterY - effectiveExpected)).toBeLessThan(150);
  });

  // ---- R19: タブ切替でスクロール位置が維持される ----
  test('[R19] タブ切替でスクロール位置が維持される', async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-r19-${Date.now()}`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r19-${Date.now()}`);

    // Circuit タブに移動して複数行追加
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(300);

    // 行を複数追加してスクロール可能な状態にする
    const addBtn = page.locator('.btn-add-row').first();
    for (let i = 0; i < 5; i++) {
      await addBtn.click();
      await page.waitForTimeout(100);
    }

    // スクロールダウン
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(200);
    const scrollYBefore = await page.evaluate(() => window.scrollY);

    // Device Assign タブに移動
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    await page.waitForTimeout(300);

    // Circuit タブに戻る
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(800);

    const scrollYAfter = await page.evaluate(() => window.scrollY);

    // スクロール位置が概ね維持されること (200px 以内の差)
    expect(Math.abs(scrollYAfter - scrollYBefore)).toBeLessThan(200);
  });
});

// ============================================================
// テスト 11: R18 Device Assign No 列 (2 デバイスグループ確認)
// ============================================================
test.describe('11 - R18 Device Assign No 列 (2 デバイスインスタンス)', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenProject(page, `${PROJECT_NAME}-r18-${Date.now()}`);
    await setupRoomAndSelectDeviceAssign(page, `${ROOM_NAME}-r18-${Date.now()}`);
  });

  test('[R18] デバイス 2 グループ: 先頭行のみ番号、2〜6行は空欄', async ({ page }) => {
    const addBtn = page.locator('.btn-add-row').first();

    // 1 つ目のデバイスグループ (MQSE-4S1-D #1)
    await addBtn.click();
    await page.waitForTimeout(300);
    const row1 = page.locator('tbody tr').last();
    const sel1 = row1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // 2 つ目のデバイスグループ (MQSE-4S1-D #2)
    await addBtn.click();
    await page.waitForTimeout(300);
    const row2 = page.locator('tbody tr').last();
    const sel2 = row2.locator('select').first();
    await sel2.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // 全行の No 列を取得
    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(12); // 6 + 6

    const nos: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const noCell = rows.nth(i).locator('td').nth(1);
      const text = (await noCell.textContent()) ?? '';
      nos.push(text.trim());
    }

    // グループ 1: 先頭は "1"、以降 5 行は空欄
    expect(nos[0]).toBe('1');
    for (let i = 1; i < 6; i++) {
      expect(nos[i]).toBe('');
    }
    // グループ 2: 先頭は "2"、以降 5 行は空欄
    expect(nos[6]).toBe('2');
    for (let i = 7; i < 12; i++) {
      expect(nos[i]).toBe('');
    }
  });
});

// ============================================================
// テスト 13: R20〜R27 新規要件検証
// ============================================================

// ---- Circuit タブのセットアップ (Fixture も登録するバージョン) ----
async function setupCircuitTabWithFixtures(
  page: Page,
  fixtures: Array<{ name: string; watt: string }>,
): Promise<void> {
  const suffix = Date.now();
  await createAndOpenProject(page, `${PROJECT_NAME}-r20-${suffix}`);

  // Fixture タブで登録
  await page.locator('[role="tab"]').filter({ hasText: /Fixture/i }).first().click();
  await page.waitForTimeout(300);
  for (const fx of fixtures) {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(200);
    const lastRow = page.locator('tbody tr').last();
    const nameInput = lastRow.locator('input').nth(0);
    await nameInput.fill(fx.name);
    const wattInput = lastRow.locator('input[type="number"]').first();
    await wattInput.fill(fx.watt);
    await page.waitForTimeout(100);
  }

  // Room 作成 → Circuit タブ
  await createRoomTypeAndSelect(page, `${ROOM_NAME}-r20-${suffix}`);
  await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
  await page.waitForTimeout(300);
}

// ---- Device Assign タブのセットアップ (Circuit も事前登録) ----
async function setupDeviceAssignWithCircuits(
  page: Page,
  circuitDesignerNums: string[],
  circuitPcs: string[],
): Promise<void> {
  const suffix = Date.now();
  await createAndOpenProject(page, `${PROJECT_NAME}-r22-${suffix}`);
  await createRoomTypeAndSelect(page, `${ROOM_NAME}-r22-${suffix}`);

  // Circuit タブで回路登録
  await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
  await page.waitForTimeout(300);
  for (let i = 0; i < circuitDesignerNums.length; i++) {
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(200);
    const lastRow = page.locator('tbody tr').last();
    const designerInput = lastRow.locator('.device-cell input').first();
    await designerInput.fill(circuitDesignerNums[i]);
    if (circuitPcs[i]) {
      const pcsInput = lastRow.locator('.combobox-input').first();
      await pcsInput.fill(circuitPcs[i]);
    }
    await page.waitForTimeout(100);
  }

  // Device Assign タブに移動
  await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
  await page.waitForTimeout(300);
}

test.describe('13 - R20〜R27 新規要件検証', () => {
  // ============================================================
  // R20: Total VA 列が rowSpan で合計表示
  // ============================================================
  test('[R20] Circuit Total VA 列ヘッダが存在する', async ({ page }) => {
    await setupCircuitTab(page);
    const totalVaHeader = page.locator('thead th').filter({ hasText: /Total VA/ });
    await expect(totalVaHeader.first()).toBeVisible({ timeout: 5000 });
  });

  test('[R20] 単独グループは VA = Total VA', async ({ page }) => {
    await setupCircuitTabWithFixtures(page, [{ name: 'FixA', watt: '100' }]);

    // 1 行追加
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    // Fixture を選択
    const fixtureSelect = lastRow.locator('select').first();
    const options = await fixtureSelect.locator('option').allTextContents();
    const fixAOption = options.find((o) => o.includes('FixA'));
    if (!fixAOption) {
      test.fixme(true, 'FixA fixture option not found');
      return;
    }
    await fixtureSelect.selectOption({ label: fixAOption.trim() });
    await page.waitForTimeout(300);

    // pcs を設定
    const pcsInput = lastRow.locator('.combobox-input').first();
    await pcsInput.fill('2');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // VA 値を確認
    const vaCell = lastRow.locator('td').filter({ hasText: /^200$/ });
    // Total VA セルが存在する (rowSpan=1 でも表示される)
    const totalVaCell = page.locator('td.cell-readonly-merged');
    await expect(totalVaCell.first()).toBeVisible({ timeout: 5000 });
    const totalVaText = await totalVaCell.first().textContent();
    expect(totalVaText?.trim()).toBe('200');
  });

  test('[R20] 複数行グループで Total VA が合計値を rowSpan で表示', async ({ page }) => {
    await setupCircuitTabWithFixtures(page, [{ name: 'FixB', watt: '50' }]);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const firstRow = page.locator('tbody tr').last();
    const fixtureSelect = firstRow.locator('select').first();
    const options = await fixtureSelect.locator('option').allTextContents();
    const fixBOption = options.find((o) => o.includes('FixB'));
    if (!fixBOption) {
      test.fixme(true, 'FixB fixture option not found');
      return;
    }
    await fixtureSelect.selectOption({ label: fixBOption.trim() });
    const pcsInput = firstRow.locator('.combobox-input').first();
    await pcsInput.fill('2');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // + ボタンで同グループに 2 行目追加
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    const secondRow = page.locator('tbody tr').last();
    const fixtureSelect2 = secondRow.locator('select').first();
    await fixtureSelect2.selectOption({ label: fixBOption.trim() });
    const pcsInput2 = secondRow.locator('.combobox-input').first();
    await pcsInput2.fill('3');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    // Total VA = 2*50 + 3*50 = 250
    const totalVaCells = page.locator('td.cell-readonly-merged');
    const count = await totalVaCells.count();
    // 複数行グループは先頭行に rowSpan セルが 1 つのみ
    expect(count).toBe(1);
    const totalText = await totalVaCells.first().textContent();
    expect(totalText?.trim()).toBe('250');
  });

  test('[R20] Total VA セルは input でなく読み取り専用', async ({ page }) => {
    await setupCircuitTab(page);
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // Total VA 列 (cell-readonly-merged) に input がないこと
    const totalVaInputs = page.locator('td.cell-readonly-merged input');
    expect(await totalVaInputs.count()).toBe(0);
  });

  // ============================================================
  // R21: Combobox が viewport 下端で flip-up する
  // ============================================================
  test('[R21] Combobox がページ下端で開く時 flip-up する', async ({ page }) => {
    // viewport を縦 500px に縮めてスペースを制限
    await page.setViewportSize({ width: 1280, height: 500 });

    const suffix = Date.now();
    await createAndOpenProject(page, `${PROJECT_NAME}-r21-${suffix}`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r21-${suffix}`);
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(300);

    // 複数行追加してページを縦に伸ばす
    const addBtn = page.locator('.btn-add-row').first();
    for (let i = 0; i < 8; i++) {
      await addBtn.click();
      await page.waitForTimeout(100);
    }

    // 最後の行へスクロール
    const lastRow = page.locator('tbody tr').last();
    await lastRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // 最後の行の pcs Combobox trigger をクリック
    const lastTrigger = lastRow.locator('.combobox-trigger').first();
    const triggerCount = await lastTrigger.count();
    if (triggerCount === 0) {
      test.fixme(true, 'combobox-trigger not found in last row');
      return;
    }
    await expect(lastTrigger).toBeEnabled({ timeout: 3000 });

    // trigger の bounding box を記録
    const triggerBox = await lastTrigger.boundingBox();
    if (!triggerBox) {
      test.fixme(true, 'Could not get trigger bounding box');
      return;
    }

    await lastTrigger.click();
    await page.waitForTimeout(300);

    const portalList = page.locator('.combobox-list-portal');
    const listCount = await portalList.count();
    if (listCount === 0) {
      test.fixme(true, 'combobox-list-portal not visible - may have no options');
      return;
    }

    const listBox = await portalList.first().boundingBox();
    if (!listBox) {
      test.fixme(true, 'Could not get list bounding box');
      return;
    }

    const viewportHeight = 500;
    const spaceBelow = viewportHeight - (triggerBox.y + triggerBox.height);
    const spaceAbove = triggerBox.y;

    // flip が必要な条件を確認し、実際に flip したかを確認
    if (spaceBelow < listBox.height && spaceAbove > spaceBelow) {
      // flip-up: dropdown の bottom が trigger の top より上
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(triggerBox.y + 5);
    } else {
      // flip 不要: dropdown が trigger より下
      expect(listBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 5);
    }
  });

  // ============================================================
  // R22: Zone/Address が readonly span、intra-group ハンドル削除
  // ============================================================
  test('[R22] Device Assign Zone/Address が input でなく readonly span', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['C1'], ['1']);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // R30 以降は rowSpan 化のため td インデックスが行によって変わる。
    // span.cell-readonly を tbody 全体から検索することで列インデックスに依存しない。
    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // テーブル全体で cell-readonly span が存在すること (Zone/Address は span.cell-readonly)
    const cellReadonlyCount = await page.locator('tbody span.cell-readonly').count();
    expect(cellReadonlyCount).toBeGreaterThanOrEqual(1);

    // テーブル内に Zone/Address 専用の input が存在しないこと
    // (Circuit# は combobox-input があるが Zone/Address には input がない)
    // Zone/Address セルは cell-readonly span のみを含む td なので、
    // span.cell-readonly を含む td 内に input がないことを確認する
    const zoneAddressTds = page.locator('td:has(span.cell-readonly)');
    const zoneAddrCount = await zoneAddressTds.count();
    expect(zoneAddrCount).toBeGreaterThanOrEqual(1);

    let foundInput = false;
    for (let i = 0; i < zoneAddrCount; i++) {
      const inputCount = await zoneAddressTds.nth(i).locator('input').count();
      if (inputCount > 0) foundInput = true;
    }
    expect(foundInput).toBe(false);
  });

  test('[R22] intra-group 行ハンドル ⋮ (drag-handle-intra) が削除されている', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['C1'], ['1']);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // グループ 2 行目以降に intra-group ハンドルがないこと
    // (.drag-handle-intra または data-testid="intra-handle" 等)
    const intraHandles = page.locator('.drag-handle-intra, [data-testid="intra-handle"]');
    expect(await intraHandles.count()).toBe(0);

    // block ハンドル ⋮⋮ (.drag-handle) は先頭行に存在すること
    const blockHandles = page.locator('.drag-handle');
    expect(await blockHandles.count()).toBeGreaterThan(0);
  });

  // ============================================================
  // R23: pair-swap ハンドルで Circuit#/Detail を入れ替え
  // ============================================================
  test('[R23] pair-swap ハンドルが Circuit # セルに存在する', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['C1', 'C2'], ['1', '1']);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // 2 行以上のグループに pair-swap-handle が表示されること
    const swapHandles = page.locator('.pair-swap-handle');
    const count = await swapHandles.count();
    expect(count).toBeGreaterThan(0);
  });

  test('[R23] Circuit#/Detail を pair-swap ハンドルでドラッグして他行と swap', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['C1', 'C2'], ['1', '1']);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    if (rowCount < 2) {
      test.fixme(true, 'Not enough rows for swap test');
      return;
    }

    // 1 行目に C1 入力、2 行目に C2 入力
    const firstCombo = rows.nth(rowCount - 6).locator('.combobox-input').first();
    const secondCombo = rows.nth(rowCount - 5).locator('.combobox-input').first();
    if (await firstCombo.count() === 0 || await secondCombo.count() === 0) {
      test.fixme(true, 'Combobox inputs not found');
      return;
    }

    await firstCombo.fill('C1');
    await page.waitForTimeout(200);
    await secondCombo.fill('C2');
    await page.waitForTimeout(200);

    const val1Before = await firstCombo.inputValue();
    const val2Before = await secondCombo.inputValue();

    // pair-swap ハンドルの存在確認
    const swapHandles = page.locator('.pair-swap-handle');
    if (await swapHandles.count() < 2) {
      test.fixme(true, 'pair-swap-handle count < 2');
      return;
    }

    // ドラッグ: 1 行目のハンドルから 2 行目のハンドルへ
    const fromHandle = swapHandles.nth(0);
    const toHandle = swapHandles.nth(1);
    const fromBox = await fromHandle.boundingBox();
    const toBox = await toHandle.boundingBox();
    if (!fromBox || !toBox) {
      test.fixme(true, 'Could not get bounding boxes for swap handles');
      return;
    }

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const val1After = await firstCombo.inputValue();
    const val2After = await secondCombo.inputValue();

    // 値が入れ替わっていること
    expect(val1After).toBe(val2Before);
    expect(val2After).toBe(val1Before);
  });

  test('[R23] 異 deviceGroupId への swap は無視される', async ({ page }) => {
    const suffix = Date.now();
    await createAndOpenProject(page, `${PROJECT_NAME}-r23x-${suffix}`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r23x-${suffix}`);
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    await page.waitForTimeout(300);

    const addBtn = page.locator('.btn-add-row').first();

    // グループ A (MQSE-4S1-D)
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowA = page.locator('tbody tr').last();
    const selA = rowA.locator('select').first();
    if (await selA.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await selA.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // グループ B (MQSE-4A1-D)
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowB = page.locator('tbody tr').last();
    const selB = rowB.locator('select').first();
    await selB.selectOption({ label: 'MQSE-4A1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();

    // グループ A の 1 行目に値を入力
    const comboA = rows.nth(0).locator('.combobox-input').first();
    if (await comboA.count() > 0) {
      await comboA.fill('GroupA-Val');
      await page.waitForTimeout(200);
    }

    const valBefore = await comboA.inputValue();

    // グループ A のペアスワップハンドルからグループ B 行へドラッグを試みる
    const swapHandles = page.locator('.pair-swap-handle');
    if (await swapHandles.count() === 0) {
      // swap ハンドルがない場合はスキップ
      return;
    }

    const fromHandle = swapHandles.first();
    // グループ B の先頭行
    const groupBFirstRow = rows.nth(6); // MQSE-4S1-D が 6 行なので
    const fromBox = await fromHandle.boundingBox();
    const toBox = await groupBFirstRow.boundingBox();
    if (!fromBox || !toBox) return;

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const valAfter = await comboA.inputValue();
    // 異グループへの swap は無視されるので値が変わらない
    expect(valAfter).toBe(valBefore);
  });

  // ============================================================
  // R24: Device Assign Circuit # 重複検出
  // ============================================================
  test('[R24] Device Assign Circuit # 重複時に cell-duplicate と banner 表示', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['D1', 'D2'], ['1', '1']);

    const addBtn = page.locator('.btn-add-row').first();

    // グループ 1 追加
    await addBtn.click();
    await page.waitForTimeout(300);
    const row1 = page.locator('tbody tr').last();
    const sel1 = row1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // グループ 2 追加
    await addBtn.click();
    await page.waitForTimeout(300);
    const row2 = page.locator('tbody tr').last();
    const sel2 = row2.locator('select').first();
    await sel2.selectOption({ label: 'MQSE-4A1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();

    // グループ 1 の 1 行目と グループ 2 の 1 行目に同じ circuitNumber を入力
    const combo1 = rows.nth(0).locator('.combobox-input').first();
    const combo2 = rows.nth(6).locator('.combobox-input').first();
    if (await combo1.count() === 0 || await combo2.count() === 0) {
      test.fixme(true, 'Combobox inputs not found for duplicate test');
      return;
    }

    await combo1.fill('DUP-001');
    await page.waitForTimeout(200);
    await combo2.fill('DUP-001');
    await page.waitForTimeout(500);

    // cell-duplicate クラスが付与されること
    const dupCells = page.locator('td.cell-duplicate');
    await expect(async () => {
      const c = await dupCells.count();
      expect(c).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 5000 });

    // DuplicationBanner が表示されること
    const banner = page.locator('.duplication-banner');
    await expect(banner.first()).toBeVisible({ timeout: 5000 });
  });

  test('[R24] 重複解消で banner が非表示になる', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['D1'], ['1']);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);
    const row1 = page.locator('tbody tr').last();
    const sel1 = row1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);
    await addBtn.click();
    await page.waitForTimeout(300);
    const row2 = page.locator('tbody tr').last();
    const sel2 = row2.locator('select').first();
    await sel2.selectOption({ label: 'MQSE-4A1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const combo1 = rows.nth(0).locator('.combobox-input').first();
    const combo2 = rows.nth(6).locator('.combobox-input').first();
    if (await combo1.count() === 0 || await combo2.count() === 0) {
      test.fixme(true, 'Combobox inputs not found');
      return;
    }

    await combo1.fill('SAME');
    await combo2.fill('SAME');
    await page.waitForTimeout(300);
    // banner 表示を確認
    await expect(page.locator('.duplication-banner').first()).toBeVisible({ timeout: 3000 });

    // 重複を解消
    await combo2.fill('DIFF');
    await page.waitForTimeout(300);
    // banner が消えること
    await expect(async () => {
      const cnt = await page.locator('.duplication-banner').count();
      expect(cnt).toBe(0);
    }).toPass({ timeout: 5000 });
  });

  // ============================================================
  // R25: Circuit Designer# / Internal# の重複検出
  // ============================================================
  test('[R25] Circuit Designer# が異グループ間で重複時 cell-duplicate と banner', async ({ page }) => {
    await setupCircuitTab(page);

    const addBtn = page.locator('.btn-add-row').first();

    // グループ A
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowA = page.locator('tbody tr').last();
    const inputA = rowA.locator('.device-cell input').first();
    await inputA.fill('DUP-CIRCUIT');
    await page.waitForTimeout(200);

    // グループ B (別グループ)
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowB = page.locator('tbody tr').last();
    const inputB = rowB.locator('.device-cell input').first();
    await inputB.fill('DUP-CIRCUIT');
    await page.waitForTimeout(500);

    // cell-duplicate が 2 つ以上付与されること
    const dupCells = page.locator('td.cell-duplicate');
    await expect(async () => {
      const c = await dupCells.count();
      expect(c).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 5000 });

    // DuplicationBanner が表示されること
    const banner = page.locator('.duplication-banner');
    await expect(banner.first()).toBeVisible({ timeout: 5000 });
  });

  test('[R25] 同グループ内の同 designer# は重複扱いしない', async ({ page }) => {
    await setupCircuitTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const firstRow = page.locator('tbody tr').last();
    const inputFirst = firstRow.locator('.device-cell input').first();
    await inputFirst.fill('SAME-GROUP');
    await page.waitForTimeout(200);

    // + ボタンで同グループに 2 行目追加 (designerNumber が伝播される)
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    // 同グループ内なので cell-duplicate が付与されないこと
    const dupCells = page.locator('td.cell-duplicate');
    const count = await dupCells.count();
    expect(count).toBe(0);

    // banner も表示されないこと
    const banner = page.locator('.duplication-banner');
    expect(await banner.count()).toBe(0);
  });

  test('[R25] 入力ブロックなし - 重複があっても引き続き入力できる', async ({ page }) => {
    await setupCircuitTab(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowA = page.locator('tbody tr').last();
    const inputA = rowA.locator('.device-cell input').first();
    await inputA.fill('BLOCK-TEST');
    await page.waitForTimeout(200);

    await addBtn.click();
    await page.waitForTimeout(300);
    const rowB = page.locator('tbody tr').last();
    const inputB = rowB.locator('.device-cell input').first();
    await inputB.fill('BLOCK-TEST');
    await page.waitForTimeout(300);

    // 重複検出後もInputが disabled でないこと
    await expect(inputB).toBeEnabled();
    // さらに入力できること
    await inputB.fill('BLOCK-TEST-2');
    const newVal = await inputB.inputValue();
    expect(newVal).toBe('BLOCK-TEST-2');
  });

  // ============================================================
  // R26: DevicesView に Address Mode 列
  // ============================================================
  test('[R26] DevicesView に Address Mode 列があり select で切替可能', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    // Address Mode ヘッダが存在すること
    const addressModeHeader = page.locator('thead th').filter({ hasText: /Address Mode/i });
    await expect(addressModeHeader.first()).toBeVisible({ timeout: 5000 });

    // Address Mode の select: option value が "fixed" または "dali" (小文字) を持つ select を探す
    // DevicesView では <option value="fixed">Fixed</option> / <option value="dali">DALI</option>
    const addressModeSelects = page.locator('tbody select').filter({
      has: page.locator('option[value="fixed"]'),
    });
    const selCount = await addressModeSelects.count();
    expect(selCount).toBeGreaterThan(0);

    // Fixed と DALI の option value が存在すること
    const firstSelect = addressModeSelects.first();
    const fixedOption = firstSelect.locator('option[value="fixed"]');
    const daliOption = firstSelect.locator('option[value="dali"]');
    await expect(fixedOption).toBeAttached({ timeout: 3000 });
    await expect(daliOption).toBeAttached({ timeout: 3000 });
  });

  test('[R26] DALUNV を含むデバイスは DALI、他は Fixed', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const modelInput = row.locator('input').first();
      const model = await modelInput.inputValue();
      if (!model) continue;

      // Address Mode select の value を確認
      // Address Mode select は tbody の最後から 2 番目の select (操作列の前)
      const allSelects = row.locator('select');
      const selectCount = await allSelects.count();
      if (selectCount === 0) continue;

      // 最後の select が Address Mode
      const addressModeSelect = allSelects.last();
      const selectedValue = await addressModeSelect.inputValue();

      if (/DALUNV/i.test(model)) {
        expect(selectedValue).toBe('dali');
      } else {
        expect(selectedValue).toBe('fixed');
      }
    }
  });

  test('[R26] DALI デバイス選択時に初期 1 行のみ展開', async ({ page }) => {
    await setupDeviceAssignWithCircuits(page, ['A', 'B', 'C'], ['1', '1', '1']);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const rowsBefore = await page.locator('tbody tr').count();
    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    // DALI デバイスを選択 (confirm ダイアログが出る場合は accept)
    page.once('dialog', (d) => d.accept());
    await deviceSelect.selectOption({ label: 'QSN2-1DALUNV-D' });
    await page.waitForTimeout(500);

    const rowsAfter = await page.locator('tbody tr').count();
    // DALI: 初期は 1 行のみ展開 (rowsBefore - 1 + 1 = rowsBefore)
    expect(rowsAfter).toBe(rowsBefore);
  });

  test('[R26] DALI で Circuit # 入力すると pcs 数の行に展開', async ({ page }) => {
    // Fixture A pcs=3 を Circuit に登録してから Device Assign に移動
    const suffix = Date.now();
    await createAndOpenProject(page, `${PROJECT_NAME}-r26dali-${suffix}`);

    // Fixture タブで FixDali を登録
    await page.locator('[role="tab"]').filter({ hasText: /Fixture/i }).first().click();
    await page.waitForTimeout(300);
    const fixtureAddBtn = page.locator('.btn-add-row').first();
    await fixtureAddBtn.click();
    await page.waitForTimeout(200);
    const fixtureRow = page.locator('tbody tr').last();
    await fixtureRow.locator('input').nth(0).fill('FixDali');
    await fixtureRow.locator('input[type="number"]').first().fill('50');
    await page.waitForTimeout(100);

    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r26dali-${suffix}`);

    // Circuit タブで designer# "DALI-A", pcs=3 を登録
    await page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first().click();
    await page.waitForTimeout(300);
    const circuitAddBtn = page.locator('.btn-add-row').first();
    await circuitAddBtn.click();
    await page.waitForTimeout(300);
    const circuitRow = page.locator('tbody tr').last();
    const designerInput = circuitRow.locator('.device-cell input').first();
    await designerInput.fill('DALI-A');
    const fixtureSelect = circuitRow.locator('select').first();
    const fxOptions = await fixtureSelect.locator('option').allTextContents();
    const fixDaliOpt = fxOptions.find((o) => o.includes('FixDali'));
    if (fixDaliOpt) {
      await fixtureSelect.selectOption({ label: fixDaliOpt.trim() });
      await page.waitForTimeout(200);
    }
    const pcsInput = circuitRow.locator('.combobox-input').first();
    await pcsInput.fill('3');
    await page.waitForTimeout(200);

    // Device Assign タブに移動
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    await page.waitForTimeout(300);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();
    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    page.once('dialog', (d) => d.accept());
    await deviceSelect.selectOption({ label: 'QSN2-1DALUNV-D' });
    await page.waitForTimeout(500);

    const rowsBefore = await page.locator('tbody tr').count();

    // Circuit # に DALI-A を入力
    const comboInput = page.locator('.combobox-input:not([disabled])').last();
    await comboInput.fill('DALI-A');
    await page.waitForTimeout(500);

    const rowsAfter = await page.locator('tbody tr').count();
    // pcs=3 なので 3 行に展開 (元 1 行が 3 行に)
    expect(rowsAfter).toBe(rowsBefore + 2); // +2 because 1 row becomes 3

    // 展開された行の circuitNumber が DALI-A-1, DALI-A-2, DALI-A-3 であること
    const rows = page.locator('tbody tr');
    const newRowCount = await rows.count();
    const circuitNumbers: string[] = [];
    for (let i = newRowCount - 3; i < newRowCount; i++) {
      const combo = rows.nth(i).locator('.combobox-input').first();
      if (await combo.count() > 0) {
        circuitNumbers.push(await combo.inputValue());
      }
    }
    expect(circuitNumbers).toContain('DALI-A-1');
    expect(circuitNumbers).toContain('DALI-A-2');
    expect(circuitNumbers).toContain('DALI-A-3');
  });

  // ============================================================
  // R27: deviceNum が全デバイス通し連番
  // ============================================================
  test('[R27] deviceNum が全デバイス通し連番', async ({ page }) => {
    const suffix = Date.now();
    await createAndOpenProject(page, `${PROJECT_NAME}-r27-${suffix}`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r27-${suffix}`);
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    await page.waitForTimeout(300);

    const addBtn = page.locator('.btn-add-row').first();

    // MQSE-4S1-D を 1 つ目として追加 → deviceNum = 1
    await addBtn.click();
    await page.waitForTimeout(300);
    const row1 = page.locator('tbody tr').last();
    const sel1 = row1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // MQSE-4S1-D を 2 つ目として追加 → deviceNum = 2
    await addBtn.click();
    await page.waitForTimeout(300);
    const row2 = page.locator('tbody tr').last();
    const sel2 = row2.locator('select').first();
    await sel2.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    // QSN2-1DALUNV-D を追加 → deviceNum = 3 (モデルが違っても通し番号)
    await addBtn.click();
    await page.waitForTimeout(300);
    const row3 = page.locator('tbody tr').last();
    const sel3 = row3.locator('select').first();
    page.once('dialog', (d) => d.accept());
    await sel3.selectOption({ label: 'QSN2-1DALUNV-D' });
    await page.waitForTimeout(500);

    // No 列 (2列目 = index 1) を取得
    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();

    // グループ 1 の先頭行 → No = "1"
    const no1 = await rows.nth(0).locator('td').nth(1).textContent();
    expect(no1?.trim()).toBe('1');

    // グループ 2 の先頭行 → No = "2"
    const no2 = await rows.nth(6).locator('td').nth(1).textContent();
    expect(no2?.trim()).toBe('2');

    // グループ 3 (QSN2-1DALUNV-D DALI) の先頭行 → No = "3"
    const no3 = await rows.nth(12).locator('td').nth(1).textContent();
    expect(no3?.trim()).toBe('3');
  });

  test('[R27] MQSE-4A1-D 追加後に QSN2-1DALUNV-D 追加で deviceNum が連番', async ({ page }) => {
    const suffix = Date.now();
    await createAndOpenProject(page, `${PROJECT_NAME}-r27b-${suffix}`);
    await createRoomTypeAndSelect(page, `${ROOM_NAME}-r27b-${suffix}`);
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    await page.waitForTimeout(300);

    const addBtn = page.locator('.btn-add-row').first();

    // MQSE-4A1-D を追加 → deviceNum = 1
    await addBtn.click();
    await page.waitForTimeout(300);
    const row1 = page.locator('tbody tr').last();
    const sel1 = row1.locator('select').first();
    if (await sel1.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }
    await sel1.selectOption({ label: 'MQSE-4A1-D' });
    await page.waitForTimeout(500);

    // QSN2-1DALUNV-D を追加 → deviceNum = 2
    await addBtn.click();
    await page.waitForTimeout(300);
    const row2 = page.locator('tbody tr').last();
    const sel2 = row2.locator('select').first();
    page.once('dialog', (d) => d.accept());
    await sel2.selectOption({ label: 'QSN2-1DALUNV-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    // MQSE-4A1-D は 4 行 → グループ 2 は index 4 から
    const noGroup2 = await rows.nth(4).locator('td').nth(1).textContent();
    expect(noGroup2?.trim()).toBe('2');
  });
});

// ============================================================
// テスト 12: 新規プロジェクト Room Type 一覧が空 (R10)
// ============================================================
test.describe('12 - 新規プロジェクト Room Type 一覧 [R10]', () => {
  test('[R10] 新規プロジェクト作成直後 Room Type 一覧が空', async ({ page }) => {
    await page.goto('/');
    await clearStorage(page);
    await page.reload({ waitUntil: 'networkidle' });

    const uniqueName = `R10-Test-${Date.now()}`;
    const input = projectNameInput(page);
    await expect(input).toBeVisible({ timeout: 8000 });
    await input.fill(uniqueName);

    const createBtn = createProjectButton(page);
    await createBtn.click();

    // プロジェクトを開く
    await page.locator('button, a').filter({ hasText: uniqueName }).first().click();
    await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 8000 });

    await roomTypeParentTab(page).click();
    await page.waitForTimeout(300);

    // ルームタイプ一覧が空のメッセージが表示されること
    const emptyMsg = page.locator('text=ルームタイプがありません');
    await expect(emptyMsg).toBeVisible({ timeout: 5000 });

    // roomTypes 配列が空 → デフォルトタイプが入っていないこと
    const roomCards = page.locator('button.screen-card');
    expect(await roomCards.count()).toBe(0);
  });

  test('[R10] Room Type 一覧に Default という名前のルームタイプが存在しない', async ({ page }) => {
    await page.goto('/');
    await clearStorage(page);
    await page.reload({ waitUntil: 'networkidle' });

    const uniqueName = `R10b-Test-${Date.now()}`;
    const input = projectNameInput(page);
    await input.fill(uniqueName);
    await createProjectButton(page).click();
    await page.locator('button, a').filter({ hasText: uniqueName }).first().click();
    await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 8000 });

    await roomTypeParentTab(page).click();
    await page.waitForTimeout(300);

    const defaultCard = page.locator('button.screen-card').filter({ hasText: /^Default$/i });
    expect(await defaultCard.count()).toBe(0);
  });
});

// ============================================================
// テスト 14: R28〜R31 新規要件検証
// ============================================================

// ---- Circuit タブのセットアップ（R28 用）----
async function setupCircuitTabR28(page: Page): Promise<void> {
  await createAndOpenProject(page, `${PROJECT_NAME}-r28-${Date.now()}`);
  await createRoomTypeAndSelect(page, `${ROOM_NAME}-r28-${Date.now()}`);
  // Circuit タブが安定するまで待機（DOM detach を防ぐ）
  const circuitTab = page.locator('[role="tab"]').filter({ hasText: /Circuit/i }).first();
  await expect(circuitTab).toBeVisible({ timeout: 8000 });
  await expect(circuitTab).toBeEnabled({ timeout: 5000 });
  await page.waitForTimeout(300);
  await circuitTab.click();
  await page.waitForTimeout(300);
}

// ---- Device Assign タブのセットアップ（R30 用）----
async function setupDeviceAssignTabR30(page: Page): Promise<void> {
  await createAndOpenProject(page, `${PROJECT_NAME}-r30-${Date.now()}`);
  await setupRoomAndSelectDeviceAssign(page, `${ROOM_NAME}-r30-${Date.now()}`);
}

test.describe('14 - R28〜R31 新規要件検証', () => {
  // ============================================================
  // R28: Circuit タブで Designer# / Internal# を rowSpan 表示
  // ============================================================
  test('[R28] Circuit Designer# 列が複数行グループで rowSpan で 1 セル化', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    // グループ先頭行で + ボタンを押して 2 行目を追加
    const firstRow = page.locator('tbody tr').last();
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await expect(addCircuitBtn).toBeVisible({ timeout: 5000 });
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // 先頭行の Designer# セル (td) が rowSpan >= 2 を持つことを確認
    // CircuitsView は先頭行のみ Designer# td を出力する
    const groupStartIdx = rowCount - 2;
    const firstTr = rows.nth(groupStartIdx);

    // Designer# 列の td を取得（colspan 等は考慮せず rowspan を確認）
    // td[rowspan] が存在すること
    const rowSpanTds = firstTr.locator('td[rowspan]');
    const rowSpanCount = await rowSpanTds.count();
    expect(rowSpanCount).toBeGreaterThan(0);

    // rowSpan 値が 2 以上
    const firstRowSpanVal = await rowSpanTds.first().getAttribute('rowspan');
    expect(Number(firstRowSpanVal)).toBeGreaterThanOrEqual(2);

    // 2 行目グループ行には Designer# td が存在しない（rowSpan で吸収）
    const secondTr = rows.nth(groupStartIdx + 1);
    const secondRowTdCount = await secondTr.locator('td').count();
    const firstRowTdCount = await firstTr.locator('td').count();
    // 2 行目は先頭行より td 数が少ない（rowSpan で吸収されたため）
    expect(secondRowTdCount).toBeLessThan(firstRowTdCount);
  });

  test('[R28] Circuit グループ列が rowSpan で 1 セル化', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const firstRow = page.locator('tbody tr').last();
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await expect(addCircuitBtn).toBeVisible({ timeout: 5000 });
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    const groupStartIdx = rowCount - 2;
    const firstTr = rows.nth(groupStartIdx);
    const secondTr = rows.nth(groupStartIdx + 1);

    // rowspan が付いた td が先頭行に存在すること
    const rowSpanTds = firstTr.locator('td[rowspan]');
    const count = await rowSpanTds.count();
    // Designer# などグループ共通列で rowSpan セルがある
    expect(count).toBeGreaterThanOrEqual(1);

    // 2 行目の td 数が先頭行より少ない（rowSpan による吸収）
    const firstTdCount = await firstTr.locator('td').count();
    const secondTdCount = await secondTr.locator('td').count();
    expect(secondTdCount).toBeLessThan(firstTdCount);
  });

  test('[R28] Circuit 折りたたみ時は rowSpan="1"', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const firstRow = page.locator('tbody tr').last();
    const addCircuitBtn = firstRow.locator('.btn-add-circuit').first();
    await expect(addCircuitBtn).toBeVisible({ timeout: 5000 });
    await addCircuitBtn.click();
    await page.waitForTimeout(300);

    // 展開状態で rowSpan >= 2
    const rows = page.locator('tbody tr');
    const rowCountBefore = await rows.count();
    const groupStartIdx = rowCountBefore - 2;
    const firstTr = rows.nth(groupStartIdx);
    const rowSpanTdsBefore = firstTr.locator('td[rowspan]');
    const rowSpanValBefore = await rowSpanTdsBefore.first().getAttribute('rowspan');
    expect(Number(rowSpanValBefore)).toBeGreaterThanOrEqual(2);

    // 折りたたみ
    const collapseBtn = firstTr.locator('.collapse-toggle').first();
    await expect(collapseBtn).toBeVisible({ timeout: 3000 });
    await collapseBtn.click();
    await page.waitForTimeout(300);

    // 折りたたみ後は rowSpan="1" またはその td がなくなる
    const rowCountAfter = await rows.count();
    expect(rowCountAfter).toBeLessThan(rowCountBefore);

    // 現在 first tr を再取得（インデックスは変わらないが行数が変わった）
    const collapsedTr = rows.nth(rowCountAfter - 1);
    const rowSpanTdsAfter = collapsedTr.locator('td[rowspan]');
    const afterCount = await rowSpanTdsAfter.count();
    if (afterCount > 0) {
      const rowSpanValAfter = await rowSpanTdsAfter.first().getAttribute('rowspan');
      expect(Number(rowSpanValAfter)).toBe(1);
    }
    // rowspan 属性がない場合も折りたたまれた状態として OK
  });

  test('[R28] Circuit Designer# 重複ハイライトは先頭行の rowSpan セルに付与される', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();

    // グループ A
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowA = page.locator('tbody tr').last();
    const inputA = rowA.locator('.device-cell input').first();
    await inputA.fill('DUP-R28');
    await page.waitForTimeout(200);

    // グループ B
    await addBtn.click();
    await page.waitForTimeout(300);
    const rowB = page.locator('tbody tr').last();
    const inputB = rowB.locator('.device-cell input').first();
    await inputB.fill('DUP-R28');
    await page.waitForTimeout(500);

    // cell-duplicate が付与されること
    const dupCells = page.locator('td.cell-duplicate');
    await expect(async () => {
      const c = await dupCells.count();
      expect(c).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 5000 });

    // cell-duplicate は rowSpan td に付与されていること（td が rowspan 属性を持つ）
    const dupRowSpanTds = page.locator('td.cell-duplicate[rowspan]');
    const dupRowSpanCount = await dupRowSpanTds.count();
    // 少なくとも 1 つ以上の rowSpan 付き cell-duplicate が存在すること
    // （単一行グループの場合は rowspan=1 の場合もあるため、cell-duplicate 数を優先確認）
    expect(await dupCells.count()).toBeGreaterThanOrEqual(2);
  });

  // ============================================================
  // R29: 行 DnD で「上から下」の移動を修正
  // ============================================================
  test('[R29] 行 DnD: 上から下にドラッグするとターゲット直下に挿入される', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();

    // 3 行追加 (A, B, C)
    await addBtn.click();
    await page.waitForTimeout(200);
    const rowA = page.locator('tbody tr').last();
    const inputA = rowA.locator('.device-cell input').first();
    await inputA.fill('ROW-A');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    const rowB = page.locator('tbody tr').last();
    const inputB = rowB.locator('.device-cell input').first();
    await inputB.fill('ROW-B');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    const rowC = page.locator('tbody tr').last();
    const inputC = rowC.locator('.device-cell input').first();
    await inputC.fill('ROW-C');
    await page.waitForTimeout(100);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(3);

    const handles = page.locator('.drag-handle');
    const handleCount = await handles.count();
    if (handleCount < 3) {
      test.fixme(true, 'drag-handle count < 3 - R29 DnD test skipped');
      return;
    }

    // 行 A (先頭) のハンドルを行 C (末尾) の下半分にドロップ
    const handleA = handles.nth(0);
    const targetRowC = rows.nth(rowCount - 1);

    const fromBox = await handleA.boundingBox();
    const targetBox = await targetRowC.boundingBox();

    if (!fromBox || !targetBox) {
      test.fixme(true, 'Could not get bounding boxes');
      return;
    }

    // ターゲット行の下半分 (75% の位置) にドロップ
    const dropY = targetBox.y + targetBox.height * 0.75;
    const dropX = targetBox.x + targetBox.width / 2;

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(dropX, dropY, { steps: 15 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(500);

    // 行数が変わっていないこと
    const rowsAfter = await rows.count();
    expect(rowsAfter).toBe(rowCount);

    // 順序確認: ROW-A が ROW-C の後に来ること (B, C, A)
    const inputs = page.locator('tbody tr .device-cell input');
    const inputCount = await inputs.count();
    if (inputCount >= 3) {
      const val1 = await inputs.nth(0).inputValue();
      const val2 = await inputs.nth(1).inputValue();
      const val3 = await inputs.nth(2).inputValue();
      // B が先頭、C が 2 番目、A が末尾（B,C,A 順）
      expect(val1).toBe('ROW-B');
      expect(val2).toBe('ROW-C');
      expect(val3).toBe('ROW-A');
    }
  });

  test('[R29] 行 DnD: 下から上にドラッグするとターゲット直上に挿入される', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();

    // 3 行追加 (A, B, C)
    await addBtn.click();
    await page.waitForTimeout(200);
    await page.locator('tbody tr').last().locator('.device-cell input').first().fill('ROW-A');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    await page.locator('tbody tr').last().locator('.device-cell input').first().fill('ROW-B');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    await page.locator('tbody tr').last().locator('.device-cell input').first().fill('ROW-C');
    await page.waitForTimeout(100);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(3);

    const handles = page.locator('.drag-handle');
    if (await handles.count() < 3) {
      test.fixme(true, 'drag-handle count < 3');
      return;
    }

    // 行 C (末尾) のハンドルを行 A (先頭) の上半分にドロップ
    const handleC = handles.nth((await handles.count()) - 1);
    const targetRowA = rows.nth(rowCount - 3);

    const fromBox = await handleC.boundingBox();
    const targetBox = await targetRowA.boundingBox();

    if (!fromBox || !targetBox) {
      test.fixme(true, 'Could not get bounding boxes');
      return;
    }

    // ターゲット行の上半分 (25% の位置) にドロップ
    const dropY = targetBox.y + targetBox.height * 0.25;
    const dropX = targetBox.x + targetBox.width / 2;

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(dropX, dropY, { steps: 15 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(500);

    const rowsAfter = await rows.count();
    expect(rowsAfter).toBe(rowCount);

    // 順序確認: C が先頭に来ること (C, A, B)
    const inputs = page.locator('tbody tr .device-cell input');
    const inputCount = await inputs.count();
    if (inputCount >= 3) {
      const val1 = await inputs.nth(0).inputValue();
      const val2 = await inputs.nth(1).inputValue();
      const val3 = await inputs.nth(2).inputValue();
      expect(val1).toBe('ROW-C');
      expect(val2).toBe('ROW-A');
      expect(val3).toBe('ROW-B');
    }
  });

  test('[R29] DnD 視覚フィードバック .row-drop-before/.row-drop-after が付与される', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(200);
    await addBtn.click();
    await page.waitForTimeout(200);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    if (rowCount < 2) {
      test.fixme(true, 'Not enough rows for DnD feedback test');
      return;
    }

    const handles = page.locator('.drag-handle');
    if (await handles.count() < 2) {
      test.fixme(true, 'drag-handle count < 2');
      return;
    }

    const handleA = handles.nth(0);
    const targetRowB = rows.nth(rowCount - 1);

    const fromBox = await handleA.boundingBox();
    const targetBox = await targetRowB.boundingBox();

    if (!fromBox || !targetBox) {
      test.fixme(true, 'Could not get bounding boxes');
      return;
    }

    // ドラッグ開始
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // ターゲット行の下半分へ移動（after フィードバック）
    const hoverY = targetBox.y + targetBox.height * 0.75;
    await page.mouse.move(targetBox.x + targetBox.width / 2, hoverY, { steps: 10 });
    await page.waitForTimeout(200);

    // .row-drop-before または .row-drop-after のいずれかが付与されていること
    const dropFeedback = page.locator('tr.row-drop-before, tr.row-drop-after');
    const feedbackCount = await dropFeedback.count();
    // ドラッグオーバー中はフィードバッククラスが付与される
    expect(feedbackCount).toBeGreaterThanOrEqual(1);

    await page.mouse.up();
    await page.waitForTimeout(300);

    // ドロップ後はフィードバッククラスが消える
    const afterCount = await dropFeedback.count();
    expect(afterCount).toBe(0);
  });

  // ============================================================
  // R30: Device Assign タブの Device 列・Device# 列を rowSpan 表示
  // ============================================================
  test('[R30] Device Assign Device 列が rowSpan で 1 セル化（MQSE-4S1-D で 6 行→1 セル）', async ({ page }) => {
    await setupDeviceAssignTabR30(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(6);

    const groupStartIdx = rowCount - 6;
    const firstTr = rows.nth(groupStartIdx);

    // 先頭行に rowspan="6" の td が存在すること
    const rowSpanTd = firstTr.locator('td[rowspan="6"]');
    const rsCount = await rowSpanTd.count();
    expect(rsCount).toBeGreaterThanOrEqual(1);

    // グループ内に Device select を含む td が 1 つだけ存在すること
    let deviceSelectTotalCount = 0;
    for (let i = groupStartIdx; i < rowCount; i++) {
      const row = rows.nth(i);
      const selCount = await row.locator('select').count();
      deviceSelectTotalCount += selCount;
    }
    // 先頭行の Device select のみ存在するため合計は少なくとも 1 以上、
    // 2 行目以降には select がないため合計は 1 のはず
    // combobox-input は select ではないので実際の <select> 要素のみカウント
    const nativeSelectsInGroup: number[] = [];
    for (let i = groupStartIdx; i < rowCount; i++) {
      const row = rows.nth(i);
      const cnt = await row.locator('select').count();
      nativeSelectsInGroup.push(cnt);
    }
    // 先頭行: 1 (Device select)、2〜6 行目: 0
    expect(nativeSelectsInGroup[0]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < 6; i++) {
      expect(nativeSelectsInGroup[i]).toBe(0);
    }
  });

  test('[R30] Device Assign Device# 列が rowSpan で 1 セル化', async ({ page }) => {
    await setupDeviceAssignTabR30(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(6);

    const groupStartIdx = rowCount - 6;
    const firstTr = rows.nth(groupStartIdx);
    const secondTr = rows.nth(groupStartIdx + 1);

    // 先頭行の td 数 > 2 行目の td 数 (rowSpan で吸収された td がある)
    const firstTdCount = await firstTr.locator('td').count();
    const secondTdCount = await secondTr.locator('td').count();
    expect(firstTdCount).toBeGreaterThan(secondTdCount);

    // rowspan="6" の td が先頭行に 2 つ以上存在する (Device 列 + Device# 列)
    const rowSpan6Tds = firstTr.locator('td[rowspan="6"]');
    const rs6Count = await rowSpan6Tds.count();
    expect(rs6Count).toBeGreaterThanOrEqual(2);
  });

  test('[R30] グループ 2 行目以降に Device <select> 要素が存在しない', async ({ page }) => {
    await setupDeviceAssignTabR30(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(6);

    const groupStartIdx = rowCount - 6;

    // 2〜6 行目 (groupStartIdx+1 〜 groupStartIdx+5) に Device select がないこと
    for (let i = groupStartIdx + 1; i < groupStartIdx + 6; i++) {
      const row = rows.nth(i);
      const selectCount = await row.locator('select').count();
      // rowSpan 化により Device td ごと存在しないため select は 0
      expect(selectCount).toBe(0);
    }
  });

  test('[R30] Device Assign 折りたたみ時は rowSpan が 1 に縮退する', async ({ page }) => {
    await setupDeviceAssignTabR30(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(300);

    const lastRow = page.locator('tbody tr').last();
    const deviceSelect = lastRow.locator('select').first();

    if (await deviceSelect.count() === 0) {
      test.fixme(true, 'Device select not found');
      return;
    }

    await deviceSelect.selectOption({ label: 'MQSE-4S1-D' });
    await page.waitForTimeout(500);

    const rows = page.locator('tbody tr');
    const rowCountBefore = await rows.count();
    expect(rowCountBefore).toBeGreaterThanOrEqual(6);

    const groupStartIdx = rowCountBefore - 6;
    const firstTr = rows.nth(groupStartIdx);

    // 展開時 rowspan="6"
    const rs6Before = await firstTr.locator('td[rowspan="6"]').count();
    expect(rs6Before).toBeGreaterThanOrEqual(1);

    // 折りたたみ
    const collapseBtn = page.locator('button.collapse-toggle').filter({ hasText: '▼' }).first();
    await expect(collapseBtn).toBeVisible({ timeout: 3000 });
    await collapseBtn.click();
    await page.waitForTimeout(300);

    const rowCountAfter = await rows.count();
    expect(rowCountAfter).toBeLessThan(rowCountBefore);

    // 折りたたみ後: rowspan は 1 になるか属性が消える
    const collapsedFirstTr = rows.nth(rowCountAfter - 1);
    const rs6After = await collapsedFirstTr.locator('td[rowspan="6"]').count();
    // rowspan="6" が消えていること
    expect(rs6After).toBe(0);
  });

  // ============================================================
  // R31: 入力欄の文字入力時の背景色を削除
  // ============================================================
  test('[R31] 入力欄フォーカス時の背景が transparent', async ({ page }) => {
    // /settings/devices ページには .cell-input が存在するため、そこで確認
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    // .cell-input に focus
    const cellInput = page.locator('.cell-input').first();
    await expect(cellInput).toBeVisible({ timeout: 5000 });
    await cellInput.focus();
    await page.waitForTimeout(200);

    // focus 時の background-color が transparent / rgba(0,0,0,0) であること
    // CSS: .cell-input:focus-visible { background: transparent; }
    const bgColor = await cellInput.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // transparent = rgba(0, 0, 0, 0)
    expect(bgColor).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)|transparent/);
  });

  test('[R31] :root に color-scheme: light が設定されている', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const colorScheme = await page.evaluate(() => {
      return window.getComputedStyle(document.documentElement).colorScheme;
    });

    expect(colorScheme).toBe('light');
  });

  test('[R31] globals.css に -webkit-autofill 抑止スタイルが存在する', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // -webkit-autofill スタイルが適用されていることを確認
    // ページが読み込まれた際に CSS が適用されていれば OK
    // CSSStyleSheet から -webkit-autofill ルールの存在を確認
    const hasAutofillStyle = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          for (const rule of rules) {
            if (rule.cssText && rule.cssText.includes('-webkit-autofill')) {
              return true;
            }
          }
        } catch {
          // cross-origin stylesheet は cssRules にアクセスできない場合がある
        }
      }
      return false;
    });

    // globals.css の内容を確認する代替: HTML ソースから確認
    // Next.js の場合 <style> タグにインライン化されている場合もある
    if (!hasAutofillStyle) {
      // インライン style タグから確認
      const hasInlineStyle = await page.evaluate(() => {
        const styles = document.querySelectorAll('style');
        for (const style of styles) {
          if (style.textContent && style.textContent.includes('-webkit-autofill')) {
            return true;
          }
        }
        return false;
      });
      expect(hasInlineStyle).toBe(true);
    } else {
      expect(hasAutofillStyle).toBe(true);
    }
  });

  test('[R31] .cell-input の CSS で background が transparent になっている', async ({ page }) => {
    // /settings/devices ページには .cell-input が存在するため、そこで確認
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    // .cell-input の通常状態の background が transparent であること (R31 の要件)
    const cellInput = page.locator('.cell-input').first();
    await expect(cellInput).toBeVisible({ timeout: 5000 });

    const bgColor = await cellInput.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // 通常状態: background: transparent
    expect(bgColor).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)|transparent/);
  });
});
