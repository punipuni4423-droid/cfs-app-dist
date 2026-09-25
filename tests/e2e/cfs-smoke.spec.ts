/**
 * CFS Web App - E2E Smoke Tests
 * 対象: http://localhost:3001 (PLAYWRIGHT_BASE_URL で上書き可)
 * Draft observation: native IndexedDB; server writes are mocked per browser context.
 */
import { test, expect, type Page } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { readNativeDraftProject } from './support/native-project-drafts';

const PROJECT_NAME = `E2E-Test-${Date.now()}`;
const ROOM_NAME = `TestRoom-${Date.now()}`;
let mockState: Awaited<ReturnType<typeof installLocalEditingMocks>>;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

// ---- helpers ----

function observeProjectPosts(page: Page): () => number {
  let posts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') posts += 1;
  });
  return () => posts;
}

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

async function addDeviceGroup(page: Page, model = 'MQSE-4S1-D'): Promise<void> {
  await page.getByRole('tab', { name: model.includes('DAL') ? 'DALI' : 'On/Off / Dimming', exact: true }).click();
  const count = await page.locator('tbody .device-cell select').count();
  await page.locator('.btn-add-row').first().click();
  const dialog = page.getByRole('dialog', { name: 'Select Device', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button').filter({ has: page.locator('div').filter({ hasText: new RegExp('^' + model + '$') }) }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('tbody .device-cell select')).toHaveCount(count + 1);
}
async function registerCircuit(page: Page, designer: string, internal: string, dimming = 'On/Off', pcs = '1') {
  await switchTab(page, /^Circuit$/);
  await page.locator('.btn-add-row').first().click();
  // The empty-state placeholder occupies a tbody row before the first add.
  const index = (await page.locator('tbody tr').count()) - 1;
  const row = page.locator('tbody tr').nth(index);
  await row.locator('.device-cell textarea').fill(designer);
  await row.locator('textarea').nth(1).fill(internal);
  await row.locator('select').first().selectOption(dimming);
  await row.locator('.combobox-input').first().fill(pcs);
  await page.keyboard.press('Tab');
  return row;
}
async function setupAssignments(page: Page, designers: string[]): Promise<void> {
  await createAndOpenProject(page, PROJECT_NAME + '-assign-' + Date.now());
  await createRoomTypeAndSelect(page, ROOM_NAME);
  for (const name of designers) await registerCircuit(page, name, 'I-' + name);
  await switchTab(page, /^Device Assign$/);
  await addDeviceGroup(page);
}
async function assignAt(page: Page, rowIndex: number, circuit: string): Promise<void> {
  const input = page.locator('tbody tr').nth(rowIndex).locator('.combobox-input').first();
  await input.fill(circuit);
  await input.press('Tab');
  await expect(input).toHaveValue(circuit);
}
async function logicalColumn(page: Page, header: string) {
  return page.locator('table').first().evaluate((element, name) => {
    const table = element as HTMLTableElement;
    const index = [...table.tHead!.rows[0].cells].findIndex(cell => cell.textContent?.trim() === name);
    if (index < 0) throw new Error('Missing column ' + name);
    type Cell = { text: string; originRow: number; rowSpan: number; editable: boolean };
    const grid: Cell[][] = [];
    [...table.tBodies[0].rows].forEach((row, rowIndex) => {
      grid[rowIndex] ??= [];
      let column = 0;
      for (const cell of [...row.cells]) {
        while (grid[rowIndex][column]) column++;
        const value = { text: cell.textContent?.trim() ?? '', originRow: rowIndex, rowSpan: cell.rowSpan,
          editable: !!cell.querySelector('input,textarea,select') };
        for (let y = rowIndex; y < rowIndex + cell.rowSpan; y++) {
          grid[y] ??= [];
          for (let x = column; x < column + cell.colSpan; x++) grid[y][x] = value;
        }
        column += cell.colSpan;
      }
    });
    return grid.map(row => row[index]);
  }, header);
}

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

  test('現行 Area パレットで選択すると行の背景色が変わる', async ({ page }) => {
    await page.locator('.btn-add-row').first().click();
    const row = page.locator('tbody tr').last();
    await row.locator('.color-select').selectOption('#FF8A65');
    await expect(row.locator('.color-select')).toHaveValue('#FF8A65');
    await expect(row).toHaveCSS('background-color', 'rgb(255, 138, 101)');
  });



  test('削除ボタン → OK で行が削除される', async ({ page }) => {
    const posts = observeProjectPosts(page);
    const serverBefore = JSON.stringify(mockState.projects);
    await page.locator('.btn-add-row').first().click();
    await page.locator('tbody tr').last().locator('input').first().fill('AREA-KEEP-UNSAVED');
    await page.locator('.btn-add-row').first().click();
    await page.locator('tbody tr').last().locator('input').first().fill('AREA-DELETE-UNSAVED');
    await expect.poll(async () => (await readNativeDraftProject(page))?.locations.at(-1)?.name).toBe('AREA-DELETE-UNSAVED');
    const before = (await readNativeDraftProject(page))!.locations;
    const target = before.find(row => row.name === 'AREA-DELETE-UNSAVED')!;
    expect(target?.id).toBeTruthy();
    expect(before.some(row => row.name === 'AREA-KEEP-UNSAVED')).toBe(true);
    // Edits within 900 ms form one Undo step; deletion must be its own action.
    await page.waitForTimeout(1050);
    const buttons = page.getByRole('button', { name: 'Delete Area', exact: true });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    await buttons.last().click();
    await expect(buttons).toHaveCount(count - 1);
    await expect.poll(async () => (await readNativeDraftProject(page))?.locations).toEqual(before.filter(row => row.id !== target.id));
    expect(posts()).toBe(0);
    expect(JSON.stringify(mockState.projects)).toBe(serverBefore);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(buttons).toHaveCount(count);
    await expect.poll(async () => (await readNativeDraftProject(page))?.locations).toEqual(before);
    expect(posts()).toBe(0);
    expect(JSON.stringify(mockState.projects)).toBe(serverBefore);
    await expect(page.locator('.revision-save-status-label')).toHaveText('Draft');
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
    const posts = observeProjectPosts(page);
    const serverBefore = JSON.stringify(mockState.projects);
    await page.locator('.btn-add-row').first().click();
    await page.locator('tbody tr').last().locator('input').first().fill('FIXTURE-KEEP-UNSAVED');
    await page.locator('.btn-add-row').first().click();
    await page.locator('tbody tr').last().locator('input').first().fill('FIXTURE-DELETE-UNSAVED');
    await expect.poll(async () => (await readNativeDraftProject(page))?.fixtures.at(-1)?.fixture).toBe('FIXTURE-DELETE-UNSAVED');
    const before = (await readNativeDraftProject(page))!.fixtures;
    const target = before.find(row => row.fixture === 'FIXTURE-DELETE-UNSAVED')!;
    expect(target?.id).toBeTruthy();
    expect(before.some(row => row.fixture === 'FIXTURE-KEEP-UNSAVED')).toBe(true);
    const buttons = page.getByRole('button', { name: 'Delete Fixture', exact: true });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    await buttons.last().click();
    await expect(buttons).toHaveCount(count - 1);
    await expect.poll(async () => (await readNativeDraftProject(page))?.fixtures).toEqual(before.filter(row => row.id !== target.id));
    expect(posts()).toBe(0);
    expect(JSON.stringify(mockState.projects)).toBe(serverBefore);
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
    await expect(page.locator('.btn-add-row').first()).toHaveText('+ Add Row');
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
      throw new Error('Circuit sub-add + button not found');
    }
  });

  test('削除ボタン → OK で Circuit 行が削除される', async ({ page }) => {
    const posts = observeProjectPosts(page);
    const serverBefore = JSON.stringify(mockState.projects);
    await registerCircuit(page, 'CIRCUIT-KEEP-UNSAVED', 'KEEP-INTERNAL');
    await registerCircuit(page, 'CIRCUIT-DELETE-UNSAVED', 'DELETE-INTERNAL');
    await expect.poll(async () => (await readNativeDraftProject(page))?.circuits.at(-1)?.internalNumber).toBe('DELETE-INTERNAL');
    const before = (await readNativeDraftProject(page))!.circuits;
    const target = before.find(row => row.designerNumber === 'CIRCUIT-DELETE-UNSAVED')!;
    expect(target?.id).toBeTruthy();
    expect(before.some(row => row.designerNumber === 'CIRCUIT-KEEP-UNSAVED')).toBe(true);
    const buttons = page.getByRole('button', { name: 'Delete Circuit', exact: true });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    await buttons.last().click();
    await expect(buttons).toHaveCount(count - 1);
    await expect.poll(async () => (await readNativeDraftProject(page))?.circuits).toEqual(before.filter(row => row.id !== target.id));
    expect(posts()).toBe(0);
    expect(JSON.stringify(mockState.projects)).toBe(serverBefore);
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
    await addDeviceGroup(page);
    await expect(page.locator('.combobox-trigger').first()).toBeVisible();
  });

  test('[R5] フォーカスだけでは Combobox リストが開かない', async ({ page }) => {
    await addDeviceGroup(page);
    await page.locator('.combobox-input').first().focus();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });

  test('[R4/R5] ▾ ボタン押下でリストが開く', async ({ page }) => {
    await registerCircuit(page, 'D-001', 'I-001');
    await switchTab(page, /^Device Assign$/);
    await addDeviceGroup(page);
    await page.locator('.combobox-trigger').first().click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('listbox')).toContainText('D-001');
  });

  // ---- R18 (旧 R2 を置き換え): No 列はデバイスインスタンス毎に先頭行のみ表示 ----
  test('[R18] No 列はデバイスインスタンス毎に先頭行のみ番号、以降は空欄', async ({ page }) => {
    await addDeviceGroup(page);
    const column = await logicalColumn(page, 'No');
    expect(column).toHaveLength(6);
    expect(column.map(cell => cell.text)).toEqual(Array(6).fill('1'));
    expect(column.map(cell => cell.originRow)).toEqual(Array(6).fill(0));
    expect(column[0].rowSpan).toBe(6);
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



  test('Add Device の Cancel と MQSE-4S1-D 追加時の6行展開', async ({ page }) => {
    await page.locator('.btn-add-row').first().click();
    const dialog = page.getByRole('dialog', { name: 'Select Device' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(page.locator('tbody .device-cell select')).toHaveCount(0);
    await addDeviceGroup(page);
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await expect(page.locator('tbody .device-cell select')).toHaveCount(1);
  });

  // R30 対応: rowSpan 化により 2 行目以降に Device <td> 自体が存在しない
  test('[R30-existing] 展開グループの 2 行目以降に Device <select> 要素が存在しない (rowSpan 化)', async ({ page }) => {
    await addDeviceGroup(page);
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(6);
    await expect(rows.first().locator('.device-cell select')).toHaveCount(1);
    for (let i = 1; i < 6; i++) await expect(rows.nth(i).locator('.device-cell select')).toHaveCount(0);
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
    await registerCircuit(page, 'D-001', 'I-001');
    await switchTab(page, /^Device Assign$/);
    await addDeviceGroup(page);
    await assignAt(page, 0, 'D-001');
    await page.getByRole('button', { name: 'Designer#', exact: true }).click();
    await expect(page.locator('tbody tr').first().locator('.combobox-input').first()).toHaveValue('I-001');
    await page.getByRole('button', { name: 'Internal#', exact: true }).click();
    await expect(page.locator('tbody tr').first().locator('.combobox-input').first()).toHaveValue('D-001');
  });

  test('グループ展開後に ▼ ボタンで折りたたみ → 行数が減る', async ({ page }) => {
    await addDeviceGroup(page);
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await page.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(6);
  });

  test('グループ削除 → OK でグループ全行が削除される', async ({ page }) => {
    await addDeviceGroup(page);
    await page.getByRole('button', { name: 'Delete Device', exact: true }).click();
    await expect(page.locator('tbody .device-cell select')).toHaveCount(0);
    await expect(page.getByText('No devices are registered yet. Add a device below.')).toBeVisible();
    await expect.poll(async () => (await readNativeDraftProject(page))?.roomTypes[0].deviceAssignments.length).toBe(0);
  });

  // ---- R1: グループ間ドラッグ&ドロップ (ベストエフォート) ----
  test('[R1] グループ間ドラッグ&ドロップで行が並び替えられる', async ({ page }) => {
    await addDeviceGroup(page, 'MQSE-4S1-D');
    await addDeviceGroup(page, 'MQSE-4A1-D');
    const handles = page.getByLabel('Group reorder handle');
    await expect(handles).toHaveCount(2);
    // Keep both group handles in the viewport and drop in the upper quarter
    // of the actual target row (a rowspan handle's midpoint is not that row).
    await page.getByRole('button', { name: 'Collapse', exact: true }).last().click();
    await page.getByRole('button', { name: 'Collapse', exact: true }).first().click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    const source = await handles.last().boundingBox();
    const target = await page.locator('tbody tr').first().boundingBox();
    if (!source || !target) throw new Error('Missing group drag bounds');
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 4, { steps: 15 });
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 4);
    await page.mouse.up();
    await expect.poll(() => page.locator('tbody .device-cell select').evaluateAll(nodes => nodes.map(node => (node as HTMLSelectElement).value))).toEqual(['MQSE-4A1-D', 'MQSE-4S1-D']);
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

  test('CFS タブは表示ビューとして開き、行追加ボタンを持たない', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'CFS', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('table.cfs-matrix-table')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.btn-add-row')).toHaveCount(0);
  });

  test('CFS テーブルに 15 列以上が存在する (ヘッダ確認)', async ({ page }) => {
    const headers = page.locator('thead th');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(15);
  });

  test('CFS タブには表示用テーブルだけがあり、Device 入力プルダウンを直接持たない', async ({ page }) => {
    await expect(page.locator('table.cfs-matrix-table')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('table.cfs-matrix-table tbody select')).toHaveCount(0);
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

  test('デフォルト 7 デバイスが読み取り専用表示として存在する', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const defaultDevices = [
      'MQSE-4S1-D', 'MQSE-4A1-D', 'QSN-4P20-D',
      'QSN2-1DALUNV-D', 'QSN2-2DALUNV-D', 'QSE-IO', 'QSE-CI-WCI',
    ];

    for (const name of defaultDevices) {
      await expect(
        page.locator('tbody tr').filter({ hasText: name }).locator('span.cell-readonly').filter({ hasText: name }).first()
      ).toBeVisible({ timeout: 8000 });
    }
  });

  test('デフォルトデバイスに既定バッジが表示され削除ボタンがない', async ({ page }) => {
    await page.goto('/settings/devices');
    await page.waitForLoadState('networkidle');

    const badge = page.locator('.muted-pill').filter({ hasText: 'Default' }).first();
    await expect(badge).toBeVisible({ timeout: 5000 });

    const mqseRow = page.locator('tr').filter({ hasText: 'MQSE-4S1-D' }).first();
    if (await mqseRow.count() > 0) {
      await expect(mqseRow.getByRole('button', { name: 'Delete Device' })).toHaveCount(0);
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
    const deleteBtn = lastRow.getByRole('button', { name: 'Delete Device' }).first();
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
      throw new Error('Fixture 候補なし - 登録が反映されていない');
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
    await setupAssignments(page, ['D-PORTAL']);
    await page.locator('.combobox-trigger').first().click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    expect(await list.evaluate(el => el.parentElement === document.body)).toBe(true);
    await expect(list).toHaveCSS('position', 'fixed');
  });

  // ---- R13: + ボタンで同じ designerNumber が継承される ----
  test('[R13] Circuit 行追加 + ボタンで同じ designer# が継承される', async ({ page }) => {
    await setupCircuitTab(page);
    const row = await registerCircuit(page, 'INHERITED', 'I-1');
    await row.locator('.btn-add-circuit').click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tbody .device-cell textarea')).toHaveCount(1);
    await expect(page.locator('tbody .device-cell textarea')).toHaveValue('INHERITED');
    await expect.poll(async () => (await readNativeDraftProject(page))?.circuits.map(c => c.designerNumber)).toEqual(['INHERITED', 'INHERITED']);
  });

  // ---- R14: Circuit No 列はグループ先頭行のみ番号 ----
  test('[R14] Circuit No 列はグループ先頭行のみ番号表示、以降空欄', async ({ page }) => {
    await setupCircuitTab(page);
    const row = await registerCircuit(page, 'GROUP', 'I-1');
    await row.locator('.btn-add-circuit').click();
    const column = await logicalColumn(page, 'No');
    expect(column.map(cell => cell.text)).toEqual(['1', '1']);
    expect(column.map(cell => cell.originRow)).toEqual([0, 0]);
    expect(column[0].rowSpan).toBe(2);
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
    page.on('pageerror', error => errors.push(error.message));
    await setupAssignments(page, ['D-001']);
    await assignAt(page, 0, 'D-001');
    await page.getByRole('button', { name: 'Designer#', exact: true }).click();
    await expect(page.locator('tbody tr').first().locator('.combobox-input').first()).toHaveValue('I-D-001');
    await page.getByRole('button', { name: 'Internal#', exact: true }).click();
    await expect(page.locator('tbody tr').first().locator('.combobox-input').first()).toHaveValue('D-001');
    expect(errors).toEqual([]);
  });

  // ---- R17: Device Assign グループ折りたたみでスクロール位置が維持 ----
  test('[R17] Device Assign グループ折りたたみでスクロール位置が維持される', async ({ page }) => {
    await createAndOpenProject(page, PROJECT_NAME + '-scroll');
    await setupRoomAndSelectDeviceAssign(page, ROOM_NAME);
    for (let i = 0; i < 8; i++) await addDeviceGroup(page);
    const scroll = page.locator('.matrix-scroll').first();
    await scroll.evaluate(el => { el.scrollTop = 160; });
    const before = await scroll.evaluate(el => el.scrollTop);
    expect(before).toBeGreaterThan(0);
    // Use a visible group at the existing scroll offset; do not auto-scroll to the first group.
    const visibleCollapse = page.getByRole('button', { name: 'Collapse', exact: true }).nth(1);
    await visibleCollapse.click();
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(before);
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
    await addDeviceGroup(page);
    await addDeviceGroup(page);
    const column = await logicalColumn(page, 'No');
    expect(column).toHaveLength(12);
    expect(column.slice(0, 6).map(c => c.originRow)).toEqual(Array(6).fill(0));
    expect(column.slice(6).map(c => c.originRow)).toEqual(Array(6).fill(6));
    expect(column[0].text).toBe('1');
    expect(column[6].text).toBe('2');
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
    const row = await registerCircuit(page, 'VA-1', 'I-1', 'On/Off', '2');
    await row.locator('select:has(option[value="FixA"])').selectOption('FixA');
    await expect.poll(async () => (await logicalColumn(page, 'Total VA'))[0]?.text).toBe('200');
    expect((await logicalColumn(page, 'VA'))[0].text).toBe('200');
  });

  test('[R20] 複数行グループで Total VA が合計値を rowSpan で表示', async ({ page }) => {
    await setupCircuitTabWithFixtures(page, [{ name: 'FixB', watt: '50' }]);
    const row = await registerCircuit(page, 'VA-GROUP', 'I-1', 'On/Off', '2');
    await row.locator('select:has(option[value="FixB"])').selectOption('FixB');
    await row.locator('.btn-add-circuit').click();
    const second = page.locator('tbody tr').last();
    await second.locator('select:has(option[value="FixB"])').selectOption('FixB');
    await second.locator('.combobox-input').first().fill('3');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await logicalColumn(page, 'Total VA'))[0]?.text).toBe('250');
    const totals = await logicalColumn(page, 'Total VA');
    expect(totals.map(c => c.originRow)).toEqual([0, 0]);
    expect(totals[0].rowSpan).toBe(2);
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
      throw new Error('combobox-trigger not found in last row');
    }
    await expect(lastTrigger).toBeEnabled({ timeout: 3000 });

    // trigger の bounding box を記録
    const triggerBox = await lastTrigger.boundingBox();
    if (!triggerBox) {
      throw new Error('Could not get trigger bounding box');
    }

    await lastTrigger.click();
    await page.waitForTimeout(300);

    const portalList = page.locator('.combobox-list-portal');
    const listCount = await portalList.count();
    if (listCount === 0) {
      throw new Error('combobox-list-portal not visible - may have no options');
    }

    const listBox = await portalList.first().boundingBox();
    if (!listBox) {
      throw new Error('Could not get list bounding box');
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
    await setupAssignments(page, ['D-001']);
    const addresses = await logicalColumn(page, 'Zone / Address');
    expect(addresses).toHaveLength(6);
    expect(addresses.every(cell => !cell.editable)).toBe(true);
    expect(addresses.map(cell => cell.text)).toEqual(['Zn1', 'Zn2', 'Zn3', 'Zn4', 'CCO', 'CCI']);
  });

  test('[R22] intra-group 行ハンドル ⋮ (drag-handle-intra) が削除されている', async ({ page }) => {
    await setupAssignments(page, ['D-001']);
    await expect(page.locator('.drag-handle-intra')).toHaveCount(0);
    await expect(page.getByLabel('Group reorder handle')).toHaveCount(1);
  });

  // ============================================================
  // R23: pair-swap ハンドルで Circuit#/Detail を入れ替え
  // ============================================================
  test('[R23] pair-swap ハンドルが Swap 列に存在する', async ({ page }) => {
    await setupAssignments(page, ['D-001']);
    await expect(page.getByLabel('Pair swap handle')).toHaveCount(6);
    await expect(page.getByLabel('Pair swap handle').first()).toHaveAttribute('draggable', 'true');
  });

  test('[R23] Circuit#/Detail を pair-swap ハンドルでドラッグして他行と swap', async ({ page }) => {
    await setupAssignments(page, ['D-A', 'D-B']);
    await assignAt(page, 0, 'D-A');
    await assignAt(page, 1, 'D-B');
    const rows = page.locator('tbody tr');
    await rows.nth(0).locator('textarea').fill('Detail A');
    await rows.nth(1).locator('textarea').fill('Detail B');
    const handles = page.getByLabel('Pair swap handle');
    await handles.nth(0).dragTo(handles.nth(1));
    await expect(rows.nth(0).locator('.combobox-input').first()).toHaveValue('D-B');
    await expect(rows.nth(1).locator('.combobox-input').first()).toHaveValue('D-A');
    await expect(rows.nth(0).locator('textarea')).toHaveValue('Detail B');
    await expect(rows.nth(1).locator('textarea')).toHaveValue('Detail A');
  });

  test('[R23] 異 deviceGroupId への swap は無視される', async ({ page }) => {
    await setupAssignments(page, ['D-A', 'D-B']);
    await addDeviceGroup(page);
    await assignAt(page, 0, 'D-A');
    await assignAt(page, 6, 'D-B');
    await page.getByLabel('Pair swap handle').nth(0).dragTo(page.getByLabel('Pair swap handle').nth(6));
    await expect(page.locator('tbody tr').nth(0).locator('.combobox-input').first()).toHaveValue('D-A');
    await expect(page.locator('tbody tr').nth(6).locator('.combobox-input').first()).toHaveValue('D-B');
  });

  // ============================================================
  // R24: Device Assign Circuit # 重複検出
  // ============================================================
  test('[R24] Device Assign Circuit # 重複時に cell-duplicate と banner 表示', async ({ page }) => {
    await setupAssignments(page, ['DUP', 'DIFF']);
    await assignAt(page, 0, 'DUP');
    await assignAt(page, 1, 'DUP');
    await expect(page.locator('.duplication-banner')).toBeVisible();
    await expect(page.locator('td.cell-duplicate').first()).toBeVisible();
  });

  test('[R24] 重複解消で banner が非表示になる', async ({ page }) => {
    await setupAssignments(page, ['DUP', 'DIFF']);
    await assignAt(page, 0, 'DUP');
    await assignAt(page, 1, 'DUP');
    await expect(page.locator('.duplication-banner')).toBeVisible();
    await expect(page.locator('td.cell-duplicate').first()).toBeVisible();
    await assignAt(page, 1, 'DIFF');
    await expect(page.locator('.duplication-banner')).toHaveCount(0);
    await expect(page.locator('td.cell-duplicate')).toHaveCount(0);
  });

  // ============================================================
  // R25: Circuit Designer# / Internal# の重複検出
  // ============================================================
  test('[R25] Circuit Designer# が異グループ間で重複時 cell-duplicate と banner', async ({ page }) => {
    await setupCircuitTab(page);
    await registerCircuit(page, 'DUP', 'I-A');
    await registerCircuit(page, 'DUP', 'I-B');

    await expect(page.locator('.duplication-banner')).toBeVisible();
    await expect(page.locator('td.cell-duplicate').first()).toBeVisible();
  });

  test('[R25] 同グループ内の同 designer# は重複扱いしない', async ({ page }) => {
    await setupCircuitTab(page);
    const row = await registerCircuit(page, 'SAME-GROUP', 'I-A');
    await row.locator('.btn-add-circuit').click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('td.cell-duplicate')).toHaveCount(0);
    await expect(page.locator('.duplication-banner')).toHaveCount(0);
  });

  test('[R25] 入力ブロックなし - 重複があっても引き続き入力できる', async ({ page }) => {
    await setupCircuitTab(page);
    await registerCircuit(page, 'DUP', 'I-A');
    const second = await registerCircuit(page, 'DUP', 'I-B');

    await expect(page.locator('.duplication-banner')).toBeVisible();
    await expect(page.locator('td.cell-duplicate').first()).toBeVisible();
    await expect(second.locator('.device-cell textarea')).toBeEnabled();
    await second.locator('.device-cell textarea').fill('UNIQUE');
    await expect(page.locator('.duplication-banner')).toHaveCount(0);
  });

  // ============================================================
  // R26: DevicesView に Address Mode 列
  // ============================================================
  test('[R26] DevicesView に Address Mode 列があり select で切替可能', async ({ page }) => {
    await page.goto('/settings/devices');
    await expect(page.getByRole('columnheader', { name: 'Address Mode', exact: true })).toBeVisible();
    await expect(page.locator('tbody select:has(option[value="fixed"])')).toHaveCount(0);
    await page.locator('.btn-add-row').click();
    const select = page.locator('tbody select:has(option[value="fixed"])');
    await expect(select).toHaveCount(1);
    await select.selectOption('dali');
    await expect(select).toHaveValue('dali');
    await select.selectOption('fixed');
    await expect(select).toHaveValue('fixed');
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

  test('[R26] DALI デバイス追加時に64アドレスを展開', async ({ page }) => {
    await createAndOpenProject(page, PROJECT_NAME + '-dali');
    await setupRoomAndSelectDeviceAssign(page, ROOM_NAME);
    await addDeviceGroup(page, 'QSN2-1DALUNV-D');
    await expect(page.locator('tbody tr')).toHaveCount(64);
    const addresses = await logicalColumn(page, 'Address');
    expect(addresses.map(c => c.text)).toEqual(Array.from({ length: 64 }, (_, i) => String(i + 1)));
    await expect.poll(async () => (await readNativeDraftProject(page))?.roomTypes[0].deviceAssignments.length).toBe(64);
  });

  test('[R26] DALI の既存アドレスに pcs 数分を連続割当', async ({ page }) => {
    await setupCircuitTabWithFixtures(page, [{ name: 'FixDali', watt: '50' }]);
    const circuit = await registerCircuit(page, 'DALI-A', 'I-A', 'DALI', '3');
    await circuit.locator('select:has(option[value="FixDali"])').selectOption('FixDali');
    await switchTab(page, /^Device Assign$/);
    await addDeviceGroup(page, 'QSN2-1DALUNV-D');
    await assignAt(page, 0, 'DALI-A');
    await expect.poll(async () => (await readNativeDraftProject(page))?.roomTypes[0].deviceAssignments.filter(a => a.circuitNumber === 'DALI-A').length).toBe(3);
    const assignments = (await readNativeDraftProject(page))!.roomTypes[0].deviceAssignments;
    expect(assignments).toHaveLength(64);
    expect(assignments.slice(0, 3).map(a => a.zoneAddress)).toEqual(['1', '2', '3']);
    expect(new Set(assignments.slice(0, 3).map(a => a.group)).size).toBe(1);
    expect(assignments[0].group).not.toBe('');
    expect(assignments.slice(3).every(a => a.circuitNumber === 'Reserved')).toBe(true);
  });

  // ============================================================
  // R27: deviceNum は同一機種内で連番、別機種は1から
  // ============================================================
  test('[R27] deviceNum は同一機種内で連番、別機種は1から', async ({ page }) => {
    await createAndOpenProject(page, PROJECT_NAME + '-number-2174');
    await setupRoomAndSelectDeviceAssign(page, ROOM_NAME);
    await addDeviceGroup(page, 'MQSE-4S1-D');
    await addDeviceGroup(page, 'MQSE-4S1-D');
    await addDeviceGroup(page, 'QSN2-1DALUNV-D');
    await expect.poll(async () => {
      const rows = (await readNativeDraftProject(page))?.roomTypes[0].deviceAssignments ?? [];
      return [...new Map(rows.map(a => [a.deviceGroupId, [a.device, a.deviceNum]])).values()];
    }).toEqual([['MQSE-4S1-D', '1'], ['MQSE-4S1-D', '2'], ['QSN2-1DALUNV-D', '1']]);
  });

  test('[R27] 異なる機種の deviceNum はそれぞれ1から', async ({ page }) => {
    await createAndOpenProject(page, PROJECT_NAME + '-number-2229');
    await setupRoomAndSelectDeviceAssign(page, ROOM_NAME);
    await addDeviceGroup(page, 'MQSE-4A1-D');

    await addDeviceGroup(page, 'QSN2-1DALUNV-D');
    await expect.poll(async () => {
      const rows = (await readNativeDraftProject(page))?.roomTypes[0].deviceAssignments ?? [];
      return [...new Map(rows.map(a => [a.deviceGroupId, [a.device, a.deviceNum]])).values()];
    }).toEqual([['MQSE-4A1-D', '1'], ['QSN2-1DALUNV-D', '1']]);
  });
});

// ============================================================
// テスト 12: 新規プロジェクト Room Type 一覧が空 (R10)
// ============================================================
test.describe('12 - 新規プロジェクト Room Type 一覧 [R10]', () => {
  test('[R10] 新規プロジェクト作成直後 Room Type 一覧が空', async ({ page }) => {
    await createAndOpenProject(page, PROJECT_NAME + '-empty-2270');
    await roomTypeParentTab(page).click();
    await expect(page.getByText('No room types yet. Create one from the form above.')).toBeVisible();
    await expect(page.locator('button.screen-card')).toHaveCount(0);
  });

  test('[R10] Room Type 一覧に Default という名前のルームタイプが存在しない', async ({ page }) => {
    await createAndOpenProject(page, PROJECT_NAME + '-empty-2299');
    await roomTypeParentTab(page).click();
    await expect(page.getByText('No room types yet. Create one from the form above.')).toBeVisible();
    await expect(page.locator('button.screen-card')).toHaveCount(0);
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
    await setupCircuitTab(page);
    await registerCircuit(page, 'DUP', 'I-A');
    const second = await registerCircuit(page, 'DUP', 'I-B');
    await second.locator('.btn-add-circuit').click();
    await expect(page.locator('.duplication-banner')).toBeVisible();
    await expect(page.locator('td.cell-duplicate').first()).toBeVisible();
    expect(await page.locator('td.cell-duplicate').evaluateAll(cells => cells.every(cell => Number(cell.getAttribute('rowspan')) >= 1))).toBe(true);
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
    const inputA = rowA.locator('.device-cell textarea').first();
    await inputA.fill('ROW-A');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    const rowB = page.locator('tbody tr').last();
    const inputB = rowB.locator('.device-cell textarea').first();
    await inputB.fill('ROW-B');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    const rowC = page.locator('tbody tr').last();
    const inputC = rowC.locator('.device-cell textarea').first();
    await inputC.fill('ROW-C');
    await page.waitForTimeout(100);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(3);

    const handles = page.locator('.drag-handle');
    const handleCount = await handles.count();
    if (handleCount < 3) {
      throw new Error('drag-handle count < 3');
    }

    // 行 A (先頭) のハンドルを行 C (末尾) の下半分にドロップ
    const handleA = handles.nth(0);
    const targetRowC = rows.nth(rowCount - 1);

    const fromBox = await handleA.boundingBox();
    const targetBox = await targetRowC.boundingBox();

    if (!fromBox || !targetBox) {
      throw new Error('Could not get bounding boxes');
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
    const inputs = page.locator('tbody tr .device-cell textarea');
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
    await page.locator('tbody tr').last().locator('.device-cell textarea').first().fill('ROW-A');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    await page.locator('tbody tr').last().locator('.device-cell textarea').first().fill('ROW-B');
    await page.waitForTimeout(100);

    await addBtn.click();
    await page.waitForTimeout(200);
    await page.locator('tbody tr').last().locator('.device-cell textarea').first().fill('ROW-C');
    await page.waitForTimeout(100);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(3);

    const handles = page.locator('.drag-handle');
    if (await handles.count() < 3) {
      throw new Error('drag-handle count < 3');
    }

    // 行 C (末尾) のハンドルを行 A (先頭) の上半分にドロップ
    const handleC = handles.nth((await handles.count()) - 1);
    const targetRowA = rows.nth(rowCount - 3);

    const fromBox = await handleC.boundingBox();
    const targetBox = await targetRowA.boundingBox();

    if (!fromBox || !targetBox) {
      throw new Error('Could not get bounding boxes');
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
    const inputs = page.locator('tbody tr .device-cell textarea');
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

  test('[R29] DnD 視覚フィードバックの挿入位置行が表示される', async ({ page }) => {
    await setupCircuitTabR28(page);

    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await page.waitForTimeout(200);
    await addBtn.click();
    await page.waitForTimeout(200);

    const rows = page.locator('tbody tr');
    const rowCount = await rows.count();
    if (rowCount < 2) {
      throw new Error('Not enough rows for DnD feedback test');
    }

    const handles = page.locator('.drag-handle');
    if (await handles.count() < 2) {
      throw new Error('drag-handle count < 2');
    }

    const handleA = handles.nth(0);
    const targetRowB = rows.nth(rowCount - 1);

    const fromBox = await handleA.boundingBox();
    const targetBox = await targetRowB.boundingBox();

    if (!fromBox || !targetBox) {
      throw new Error('Could not get bounding boxes');
    }

    // ドラッグ開始
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // ターゲット行の下半分へ移動（after フィードバック）
    const hoverY = targetBox.y + targetBox.height * 0.75;
    await page.mouse.move(targetBox.x + targetBox.width / 2, hoverY, { steps: 10 });
    await page.waitForTimeout(200);

    // 現行の挿入位置インジケーター行が表示されていること
    const dropFeedback = page.locator('tr.drop-indicator-row');
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
    await addDeviceGroup(page);

    const column = await logicalColumn(page, 'Device');
    expect(column).toHaveLength(6);
    expect(column[0].rowSpan).toBe(6);
    expect(new Set(column.map(cell => cell.originRow)).size).toBe(1);
  });

  test('[R30] Device Assign Device# 列が rowSpan で 1 セル化', async ({ page }) => {
    await setupDeviceAssignTabR30(page);
    await addDeviceGroup(page);

    const column = await logicalColumn(page, 'Device #');
    expect(column).toHaveLength(6);
    expect(column[0].rowSpan).toBe(6);
    expect(new Set(column.map(cell => cell.originRow)).size).toBe(1);
  });

  test('[R30] グループ 2 行目以降に Device <select> 要素が存在しない', async ({ page }) => {
    await setupDeviceAssignTabR30(page);
    await addDeviceGroup(page);
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(6);
    await expect(rows.first().locator('.device-cell select')).toHaveCount(1);
    for (let i = 1; i < 6; i++) await expect(rows.nth(i).locator('.device-cell select')).toHaveCount(0);
  });

  test('[R30] Device Assign 折りたたみ時は rowSpan が 1 に縮退する', async ({ page }) => {
    await setupDeviceAssignTabR30(page);
    await addDeviceGroup(page);
    await page.getByRole('button', { name: 'Collapse', exact: true }).click();
    const column = await logicalColumn(page, 'Device');
    expect(column).toHaveLength(1);
    expect(column[0].rowSpan).toBe(1);
    expect(new Set(column.map(cell => cell.originRow)).size).toBe(1);
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    expect((await logicalColumn(page, 'Device'))[0].rowSpan).toBe(6);
  });

  // ============================================================
  // R31: 入力欄の文字入力時の背景色を削除
  // ============================================================
  test('[R31] 入力欄フォーカス時に現行の teal 背景と枠線', async ({ page }) => {
    await page.goto('/settings/devices');
    const input = page.locator('.cell-input').first();
    await input.focus();
    await expect(input).toHaveCSS('background-color', 'rgba(0, 123, 126, 0.08)');
    await expect(input).toHaveCSS('border-color', 'rgb(0, 123, 126)');
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

  test('[R31] .cell-input の通常背景が現行の薄灰色', async ({ page }) => {
    await page.goto('/settings/devices');
    const input = page.locator('.cell-input').first();
    await expect(input).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(input).toHaveCSS('background-color', 'rgb(240, 241, 243)');
  });
});
