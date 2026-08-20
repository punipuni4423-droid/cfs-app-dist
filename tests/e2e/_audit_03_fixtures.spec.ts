/**
 * AUDIT-03 — Fixture (器具) 管理 & CSV インポート/エクスポート 監査
 *
 * 対象: FixturesView タブ (http://localhost:3014)
 * 担当領域: 器具の追加/編集/削除, CSV Import (正常/不正), CSV Export ダウンロード
 *
 * アプリ本体は一切変更しない。観察と検証のみ。
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

// OneDrive がプロジェクト配下の test-results を同期で破壊するため、
// スクショは OneDrive 外 (ローカル temp) に保存し、完了後にプロジェクトへコピーする。
const SHOT_DIR = path.join(os.tmpdir(), 'audit-03-shots');
const PROJECT_SHOT_DIR = path.join(process.cwd(), 'test-results', 'audit-03');
const TMP_DIR = path.join(os.tmpdir(), 'audit-03-csv');

test.beforeAll(() => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await installLocalEditingMocks(page);
});

test.afterAll(() => {
  // 完了後にスクショをプロジェクトの test-results へベストエフォートでコピー
  try {
    fs.mkdirSync(PROJECT_SHOT_DIR, { recursive: true });
    for (const f of fs.readdirSync(SHOT_DIR)) {
      fs.copyFileSync(path.join(SHOT_DIR, f), path.join(PROJECT_SHOT_DIR, f));
    }
  } catch {
    // OneDrive 同期で失敗してもテスト結果には影響させない
  }
});

async function shot(page: Page, name: string): Promise<void> {
  await page
    .screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
    .catch(() => {});
}

/**
 * localStorage を完全クリアして隔離した状態でアプリを開く。
 * 並列エージェントによる .next 競合で一時的に 500 が返ることがあるため、
 * プロジェクト作成フォームが出るまで最大数回リロードする。
 */
async function freshApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear()).catch(() => {});

  const form = page.locator('input[placeholder="New project name"]').first();
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    try {
      await form.waitFor({ state: 'visible', timeout: 8000 });
      return;
    } catch {
      // 500 / 未コンパイル → 少し待って再試行
      await page.waitForTimeout(1500);
    }
  }
  // 最後の試行 (ここで失敗すればテスト本体のアサーションが拾う)
  await form.waitFor({ state: 'visible', timeout: 8000 });
}

/** プロジェクトを作成して開き、Fixture タブに移動する */
async function openFixtureTab(page: Page, projectName: string): Promise<void> {
  await freshApp(page);

  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await nameInput.fill(projectName);

  const createBtn = page.locator('button').filter({ hasText: /^Create Project$/ }).first();
  await expect(createBtn).toBeEnabled({ timeout: 5000 });
  await createBtn.click();

  // NOTE: 「Create Project」押下後はリストに留まらず、作成したプロジェクト画面へ
  // 直接遷移する (page.tsx handleCreateProject が setActiveProjectId を即時呼ぶ)。
  // よってカードを探すのではなく、タブバーの出現を待つ。
  await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 10000 });

  // Fixture タブをクリック
  const fixtureTab = page.locator('[role="tab"]').filter({ hasText: /^Fixture$/ }).first();
  await expect(fixtureTab).toBeVisible({ timeout: 8000 });
  await fixtureTab.click();

  // FixturesView の特徴的なツールバーボタンが見えるまで待機
  await expect(
    page.locator('button').filter({ hasText: /CSV Import/i }).first(),
  ).toBeVisible({ timeout: 8000 });
}

function writeCsv(filename: string, content: string): string {
  const p = path.join(TMP_DIR, filename);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** 隠れた file input にファイルをセットしてインポートを実行する */
async function setImportFile(page: Page, filePath: string): Promise<void> {
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(filePath);
}

// ============================================================
// セクション 1: 器具 CRUD
// ============================================================
test.describe('AUDIT-03 / Fixture CRUD', () => {
  test('Fixture タブが表示され、ツールバーに CSV Import / Export がある', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-crud-${Date.now()}`);

    await expect(page.locator('button').filter({ hasText: /CSV Import/i }).first()).toBeVisible();
    await expect(page.locator('button').filter({ hasText: /CSV Export/i }).first()).toBeVisible();

    // 初期状態は空表示 (empty state)
    const empty = page.locator('.screen-empty');
    await expect(empty.first()).toBeVisible({ timeout: 5000 });

    await shot(page, '01-fixture-tab-empty');
  });

  test('+ Add Row で行が追加され、items カウンタが増える', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-add-${Date.now()}`);

    const addBtn = page.locator('.btn-add-row').first();
    await expect(addBtn).toBeVisible();

    await addBtn.click();
    await expect(page.locator('tbody tr input.cell-input').first()).toBeVisible({ timeout: 5000 });

    // items カウンタ (muted-pill "N items")
    const counter = page.locator('.muted-pill').filter({ hasText: /items/i }).first();
    await expect(counter).toHaveText(/1\s*items/i, { timeout: 3000 });

    // もう一行追加して 2 items
    await addBtn.click();
    await expect(counter).toHaveText(/2\s*items/i, { timeout: 3000 });

    await shot(page, '02-fixture-two-rows');
  });

  test('器具名 / Mode / VA・W@ / Type を編集できる', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-edit-${Date.now()}`);

    await page.locator('.btn-add-row').first().click();
    const row = page.locator('tbody tr').first();

    // 器具名 (最初の text input)
    const nameInput = row.locator('input.cell-input').first();
    await nameInput.fill('UL4M-W');
    await expect(nameInput).toHaveValue('UL4M-W');

    // Type select (DL / Indirect)
    const typeSelect = row.locator('select.cell-input').nth(0);
    await typeSelect.selectOption('Indirect');
    await expect(typeSelect).toHaveValue('Indirect');

    // Mode select (VA / W)
    const modeSelect = row.locator('select.cell-input').nth(1);
    await modeSelect.selectOption('W');
    await expect(modeSelect).toHaveValue('W');

    // VA/W@ number input
    const wattInput = row.locator('input[type="number"]').first();
    await wattInput.fill('24');
    await expect(wattInput).toHaveValue('24');

    // W モードでは Correction(powerFactor) が有効になる
    const correctionInput = row.locator('input[type="number"]').nth(1);
    await expect(correctionInput).toBeEnabled({ timeout: 3000 });

    await shot(page, '03-fixture-edited');
  });

  test('Mode=VA のとき Correction 入力が disabled、W に切替で enabled になる', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-pf-${Date.now()}`);
    await page.locator('.btn-add-row').first().click();
    const row = page.locator('tbody tr').first();

    const modeSelect = row.locator('select.cell-input').nth(1);
    const correctionInput = row.locator('input[type="number"]').nth(1);

    // デフォルト Mode は VA → Correction disabled
    await expect(modeSelect).toHaveValue('VA');
    await expect(correctionInput).toBeDisabled();

    // W に切替 → enabled
    await modeSelect.selectOption('W');
    await expect(correctionInput).toBeEnabled({ timeout: 3000 });
  });

  test('削除ボタン → OK で器具行が削除される', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-del-${Date.now()}`);
    const addBtn = page.locator('.btn-add-row').first();
    await addBtn.click();
    await addBtn.click();
    await expect(page.locator('.muted-pill').filter({ hasText: /2\s*items/i })).toBeVisible({ timeout: 3000 });

    // FixturesView の Delete には confirm が無い (即削除) — dialog が出ても OK で受ける
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page
      .locator('tbody tr')
      .last()
      .getByRole('button', { name: 'Delete Fixture' })
      .click();

    await expect(page.locator('.muted-pill').filter({ hasText: /1\s*items/i })).toBeVisible({ timeout: 5000 });
    await shot(page, '04-fixture-after-delete');
  });
});

// ============================================================
// セクション 2: CSV Export
// ============================================================
test.describe('AUDIT-03 / CSV Export', () => {
  test('CSV Export でダウンロードイベントが発火し fixtures.csv が落ちる', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-export-${Date.now()}`);

    // 1 行作って中身を入れる
    await page.locator('.btn-add-row').first().click();
    const row = page.locator('tbody tr').first();
    await row.locator('input.cell-input').first().fill('EXP-FIX-1');
    await row.locator('input[type="number"]').first().fill('30');

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('button').filter({ hasText: /CSV Export/i }).first().click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('fixtures.csv');

    // 中身を保存して検証
    const savePath = path.join(TMP_DIR, 'exported.csv');
    await download.saveAs(savePath);
    const text = fs.readFileSync(savePath, 'utf-8');

    expect(text).toContain('Fixture');
    expect(text).toContain('Power Mode');
    expect(text).toContain('EXP-FIX-1');

    await shot(page, '05-after-export');
  });
});

// ============================================================
// セクション 3: CSV Import (正常系)
// ============================================================
test.describe('AUDIT-03 / CSV Import (正常)', () => {
  test('正常CSV をインポート (replace) すると器具が取り込まれる', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-imp-ok-${Date.now()}`);

    const csv = [
      'Fixture,Type,Power Mode,VA/W@,Power Factor',
      'DL-A,DL,VA,12,',
      'IND-B,Indirect,W,24,0.9',
      'DL-C,DL,VA,8,',
    ].join('\r\n');
    const file = writeCsv('valid.csv', csv);

    // 既存リストは空なので、confirm が出たら Cancel(replace) で取り込む
    page.once('dialog', (d) => {
      // OK=append / Cancel=replace。空なのでどちらでも結果は同じ → dismiss(replace)
      d.dismiss().catch(() => {});
    });

    await setImportFile(page, file);

    // 3 行取り込まれる
    await expect(page.locator('.muted-pill').filter({ hasText: /3\s*items/i })).toBeVisible({ timeout: 8000 });

    // 名前が反映されている
    await expect(page.locator('input.cell-input[value="DL-A"]').first()).toBeAttached({ timeout: 3000 });
    await expect(page.locator('input.cell-input[value="IND-B"]').first()).toBeAttached();

    await shot(page, '06-import-valid-replace');
  });

  test('既存リストがある状態で append (OK) すると行が増える', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-imp-append-${Date.now()}`);

    // 既存 1 行
    await page.locator('.btn-add-row').first().click();
    await page.locator('tbody tr').first().locator('input.cell-input').first().fill('EXISTING-1');
    await expect(page.locator('.muted-pill').filter({ hasText: /1\s*items/i })).toBeVisible({ timeout: 3000 });

    const csv = [
      'Fixture,Type,Power Mode,VA/W@,Power Factor',
      'NEW-A,DL,VA,10,',
      'NEW-B,DL,VA,20,',
    ].join('\r\n');
    const file = writeCsv('append.csv', csv);

    // append = OK (accept)
    page.once('dialog', (d) => d.accept().catch(() => {}));
    await setImportFile(page, file);

    // 1 + 2 = 3 items
    await expect(page.locator('.muted-pill').filter({ hasText: /3\s*items/i })).toBeVisible({ timeout: 8000 });
    await expect(page.locator('input.cell-input[value="EXISTING-1"]').first()).toBeAttached();
    await expect(page.locator('input.cell-input[value="NEW-A"]').first()).toBeAttached();

    await shot(page, '07-import-append');
  });

  test('未知の Type 値は DL に正規化され、空 Fixture 行は破棄される', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-imp-norm-${Date.now()}`);

    const csv = [
      'Fixture,Type,Power Mode,VA/W@,Power Factor',
      'KEEP-1,SomethingWeird,VA,5,', // 未知 Type → DL に丸められる想定
      ',DL,VA,99,', // Fixture 空 → 破棄される想定
      'KEEP-2,Indirect,W,7,0.8',
    ].join('\r\n');
    const file = writeCsv('normalize.csv', csv);

    page.once('dialog', (d) => d.dismiss().catch(() => {}));
    await setImportFile(page, file);

    // 空行が破棄され、2 行のみ取り込まれる
    await expect(page.locator('.muted-pill').filter({ hasText: /2\s*items/i })).toBeVisible({ timeout: 8000 });

    // KEEP-1 の Type select が DL に正規化されている
    const keep1Row = page.locator('tbody tr').filter({ has: page.locator('input.cell-input[value="KEEP-1"]') }).first();
    const typeSelect = keep1Row.locator('select.cell-input').nth(0);
    await expect(typeSelect).toHaveValue('DL', { timeout: 3000 });

    await shot(page, '08-import-normalized');
  });
});

// ============================================================
// セクション 4: CSV Import (不正系 / エラーハンドリング)
// ============================================================
test.describe('AUDIT-03 / CSV Import (不正)', () => {
  test('有効行が0件のCSVでは「No valid rows」アラートが出る', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-imp-empty-${Date.now()}`);

    // ヘッダのみ + 空 Fixture 行 → 取り込み 0 件
    const csv = ['Fixture,Type,Power Mode,VA/W@,Power Factor', ',DL,VA,1,', ',Indirect,W,2,0.7'].join('\r\n');
    const file = writeCsv('novalid.csv', csv);

    let alertText = '';
    page.once('dialog', (d) => {
      alertText = d.message();
      d.accept().catch(() => {});
    });

    await setImportFile(page, file);

    await expect.poll(() => alertText, { timeout: 8000 }).toMatch(/No valid rows/i);
    // リストは空のまま
    await expect(page.locator('.muted-pill').filter({ hasText: /0\s*items/i })).toBeVisible({ timeout: 3000 });

    await shot(page, '09-import-no-valid-rows');
  });

  test('壊れた列構造のCSV (列ずれ/余分な列) でクラッシュしない', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-imp-broken-${Date.now()}`);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // 引用符が壊れている / 列数バラバラ / 余分列
    const csv = [
      'Fixture,Type,Power Mode,VA/W@,Power Factor,Extra1,Extra2',
      'BROKEN-1,DL,VA,5,,foo,bar,baz,qux', // 列数オーバー
      'BROKEN-2,DL', // 列数不足
      '"Unterminated quote,DL,VA,3,', // 引用符閉じ忘れ
    ].join('\r\n');
    const file = writeCsv('broken.csv', csv);

    let dialogSeen = false;
    page.on('dialog', (d) => {
      dialogSeen = true;
      d.accept().catch(() => {}); // どんな dialog (confirm/alert) でも受ける
    });

    await setImportFile(page, file);
    await page.waitForTimeout(2500);

    // クラッシュしない (致命的 pageerror が出ない)。アプリが応答し続けることを確認。
    await expect(page.locator('button').filter({ hasText: /CSV Import/i }).first()).toBeVisible();

    // 観察ログ用にエラーとダイアログ有無を記録
    test.info().annotations.push({
      type: 'broken-csv-observation',
      description: `pageerrors=${errors.length} dialogSeen=${dialogSeen}`,
    });

    await shot(page, '10-import-broken-columns');
    // pageerror (未捕捉例外) が発生していないこと
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('巨大行数CSV (5000行) を取り込んでも処理が完了する', async ({ page }) => {
    test.setTimeout(60000);
    await openFixtureTab(page, `AUDIT-03-Fix-imp-huge-${Date.now()}`);

    const lines = ['Fixture,Type,Power Mode,VA/W@,Power Factor'];
    for (let i = 0; i < 5000; i++) {
      lines.push(`BULK-${i},DL,VA,${(i % 50) + 1},`);
    }
    const file = writeCsv('huge.csv', lines.join('\r\n'));

    page.once('dialog', (d) => d.dismiss().catch(() => {})); // replace

    const start = Date.now();
    await setImportFile(page, file);

    // 5000 items カウンタが出るまで待つ
    await expect(page.locator('.muted-pill').filter({ hasText: /5000\s*items/i })).toBeVisible({ timeout: 45000 });
    const elapsed = Date.now() - start;
    test.info().annotations.push({
      type: 'huge-import-timing',
      description: `5000 rows imported in ${elapsed}ms`,
    });

    await shot(page, '11-import-5000-rows');
  });

  test('5MB超のCSVではサイズ制限アラートが出て取り込まれない', async ({ page }) => {
    await openFixtureTab(page, `AUDIT-03-Fix-imp-toobig-${Date.now()}`);

    // 5MB を超えるダミーCSVを生成
    const header = 'Fixture,Type,Power Mode,VA/W@,Power Factor\r\n';
    const padding = 'X'.repeat(200);
    const lines: string[] = [header.trim()];
    // 1行 ~250 bytes として ~25000 行で ~6MB
    for (let i = 0; i < 26000; i++) {
      lines.push(`BIG-${i}-${padding},DL,VA,1,`);
    }
    const file = writeCsv('toobig.csv', lines.join('\r\n'));
    const sizeMB = (fs.statSync(file).size / (1024 * 1024)).toFixed(2);
    test.info().annotations.push({ type: 'file-size', description: `${sizeMB} MB` });

    let alertText = '';
    page.once('dialog', (d) => {
      alertText = d.message();
      d.accept().catch(() => {});
    });

    await setImportFile(page, file);

    await expect.poll(() => alertText, { timeout: 8000 }).toMatch(/5 ?MB|less/i);
    // 取り込まれていない (空のまま)
    await expect(page.locator('.muted-pill').filter({ hasText: /0\s*items/i })).toBeVisible({ timeout: 3000 });

    await shot(page, '12-import-too-big');
  });
});
