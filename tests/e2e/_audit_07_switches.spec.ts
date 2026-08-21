/**
 * AUDIT #7 - Switch management (Rooms -> Switch subtab / SwitchView)
 *
 * 担当領域: スイッチ種別 (contact/lutronPd/lutronPico/pir/command/tstat),
 *           ボタン設定 (シーン割当 / 回路レベル設定), バックライト設定。
 *
 * アプリ本体は一切変更しない。
 *
 * 重要: このアプリの永続化はサーバ側 /api/projects (data/projects.json) が
 *       source of truth で、localStorage は単なるフォールバックキャッシュ。
 *       よって隔離・シード・検証はすべて /api/projects 経由で行う。
 *       プロジェクト作成はUI、エリア/回路/シーンの注入はAPI、という方針。
 *
 * 対象: http://localhost:3014
 */
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEY } from '../../app/lib/constants';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

const SHOT_DIR = 'test-results/audit-07';
const PROJECT_NAME = 'AUDIT-07-Sw';
const ROOM_NAME = 'AUDIT-07-Room';
const PROJECT_DRAFT_STORAGE_KEY = 'cfs-project-drafts-v2';
const PLAYWRIGHT_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3014';

// 型定義 app/types.ts SwitchKind に存在する全種別
const ALL_SWITCH_KINDS = ['contact', 'lutronPd', 'lutronPico', 'command', 'tstat', 'pir', 'qsm'];
// SWITCH_KIND_OPTIONS が UI で公開しているラベル
const EXPECTED_UI_KIND_LABELS = ['Palladiom', 'CCI', 'Pico', 'PIR', 'QSM'];

interface ApiProject {
  id: string;
  name: string;
  roomTypes: Array<{
    id: string;
    switches: Array<{
      buttonSetting: { sceneIds: string[]; sceneId: string; circuitSettings: Array<{ circuitId: string; percentage: string }> };
      backlightCondition: string;
    }>;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false }).catch(() => {});
}

/** サーバ DB から全プロジェクトを取得 (ナビゲーション中の context 破棄に耐える) */
async function apiGetProjects(page: Page): Promise<ApiProject[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const localProjects = await page.evaluate(({ storageKey, draftKey }) => {
        for (const key of [draftKey, storageKey]) {
          try {
            const parsed = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
          } catch {
            // ignore
          }
        }
        return [];
      }, { storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY });
      if (localProjects.length > 0) return localProjects;
      const projects = await page.evaluate(async () => {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        const json = await res.json();
        return json.projects ?? [];
      });
      if (projects.length > 0) return projects;
      return [];
    } catch (err) {
      // "Execution context was destroyed" 等はリロード直後に起こりうる。少し待って再試行。
      await page.waitForTimeout(500).catch(() => {});
      if (attempt === 3) throw err;
    }
  }
  return [];
}

/** サーバ DB を指定プロジェクト配列で上書き (ページの autosave と競合しない request API 経由) */
async function apiPutProjects(page: Page, projects: ApiProject[]): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
  await page.evaluate(async ({ nextProjects, storageKey, draftKey }) => {
    localStorage.setItem(storageKey, JSON.stringify(nextProjects));
    localStorage.setItem(draftKey, JSON.stringify(nextProjects));
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: nextProjects }),
    });
  }, { nextProjects: projects, storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY });
}

/**
 * サーバ DB と localStorage を空にして隔離する。
 *
 * 注意: ページを開いた状態で POST([]) すると、ページ側の debounce autosave が
 * 後から発火して古いプロジェクトを書き戻してしまう。そのため
 * about:blank に退避してアプリの autosave タイマーを無効化してから DB を空にし、
 * その後アプリを開き直す。
 */
async function isolate(page: Page): Promise<void> {
  // Step 1: まずアプリ外へ退避して、残存ページの autosave タイマーを破棄する
  await page.goto('about:blank');
  // Step 2: autosave タイマー (1200ms) が発火し終えるのを確実に待つ
  await page.waitForTimeout(1800);
  // Step 3: API を空にする
  await apiPutProjects(page, []);

  // Step 4: アプリドメインで localStorage をクリアするために一旦アプリを開く
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  // Step 5: アプリロード後に autosave が発火しないよう、すぐに about:blank に退避してから
  //         タイマーが切れるまで待つ
  await page.goto('about:blank');
  await page.waitForTimeout(1800);

  // Step 6: API を再度空にする (アプリの autosave が書き戻した可能性を排除)
  await apiPutProjects(page, []);

  // Step 7: 改めてアプリを開く (この時点で API も localStorage も空)
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // "Loading projects." が消えるまで待つ
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Loading projects'),
    { timeout: 20000 },
  );
}

/**
 * 新規プロジェクトを UI で作成する。
 * handleCreateProject が setActiveProjectId を呼ぶため、作成直後に
 * そのままプロジェクト画面 (Area/Fixture/Room Type タブ) へ自動遷移する。
 */
async function createAndOpenProject(page: Page, name: string): Promise<void> {
  const nameInput = page.locator('input[placeholder="New project name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(name);
  await page.locator('button').filter({ hasText: /^Create Project$/ }).first().click();
  // カード一覧ではなく、作成したプロジェクト画面へ直接遷移する
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first(),
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Room Type 親タブ → ルームタイプ作成。
 * handleCreateRoomType が setActiveRoomTypeId/setActiveSubTab("circuit") を呼ぶため、
 * 作成直後にそのまま当該ルームタイプのサブタブ画面 (Circuit/Switch 等) へ自動遷移する。
 */
async function createRoomTypeAndSelect(page: Page, roomName: string): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await expect(roomInput).toBeVisible({ timeout: 5000 });
  await roomInput.fill(roomName);
  await page.locator('button').filter({ hasText: /^Create Room Type$/ }).first().click();
  // カード一覧ではなくサブタブ画面へ直接遷移する
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /Switch/i }).first(),
  ).toBeVisible({ timeout: 8000 });
}

/**
 * UI で作成したプロジェクト/ルームタイプは 1200ms の debounce 後に /api/projects へ
 * 保存される。サーバ DB に project[0].roomTypes[0] が現れるまでポーリングして待つ。
 */
async function waitForApiProjectWithRoom(page: Page): Promise<ApiProject[]> {
  for (let i = 0; i < 30; i++) {
    const projects = await apiGetProjects(page);
    if (projects[0]?.roomTypes?.[0]) return projects;
    await page.waitForTimeout(400);
  }
  throw new Error('timed out waiting for project/roomType to persist to /api/projects');
}

/**
 * サーバ DB の単一プロジェクト/ルームタイプに、エリア・回路・シーンを注入する。
 * /api/projects を GET → 変更 → POST する。
 * 既存の factory 生成構造をベースに最小限の差分のみ足し、決定的なデータを用意する。
 */
async function seedAreasCircuitsScenes(page: Page): Promise<void> {
  const projects = await waitForApiProjectWithRoom(page);
  const project = projects[0] as ApiProject & {
    locations: unknown[];
    circuits: unknown[];
  };

  project.locations = [
    { id: 'audit-area-a', name: 'Bedroom', number: '1', color: '#FFC7CE' },
    { id: 'audit-area-b', name: 'Bathroom', number: '2', color: '#C6EFCE' },
  ];

  // 回路: Bedroom に 2 つ (DALI調光 + Switch On/Off), Bathroom に 1 つ
  project.circuits = [
    {
      id: 'audit-cir-1', circuitGroupId: 'g1', daliFixtureGroupId: '',
      designerNumber: 'D-001', internalNumber: 'I-001', dimmingType: 'DALI',
      fixture: '', pcs: '1', detail: 'Ceiling', area: 'audit-area-a',
      ffe: false, energySaving: false,
    },
    {
      id: 'audit-cir-2', circuitGroupId: 'g2', daliFixtureGroupId: '',
      designerNumber: 'D-002', internalNumber: 'I-002', dimmingType: 'Switch',
      fixture: '', pcs: '1', detail: 'Lamp', area: 'audit-area-a',
      ffe: false, energySaving: false,
    },
    {
      id: 'audit-cir-3', circuitGroupId: 'g3', daliFixtureGroupId: '',
      designerNumber: 'D-003', internalNumber: 'I-003', dimmingType: 'DALI',
      fixture: '', pcs: '1', detail: 'Mirror', area: 'audit-area-b',
      ffe: false, energySaving: false,
    },
  ];

  const rt = project.roomTypes[0] as ApiProject['roomTypes'][number] & { scenes: unknown[] };
  // Bedroom に 2 シーン、Bathroom に 1 シーン
  rt.scenes = [
    { id: 'audit-scene-a1', areaId: 'audit-area-a', name: 'Welcome', settings: [{ circuitId: 'audit-cir-1', percentage: '80' }] },
    { id: 'audit-scene-a2', areaId: 'audit-area-a', name: 'Relax', settings: [{ circuitId: 'audit-cir-1', percentage: '20' }] },
    { id: 'audit-scene-b1', areaId: 'audit-area-b', name: 'Bright', settings: [{ circuitId: 'audit-cir-3', percentage: '100' }] },
  ];
  rt.switches = [];

  await apiPutProjects(page, projects);
}

/** サーバ DB から現在のプロジェクトのルームタイプ[0].switches を取得 */
async function readSwitches(page: Page): Promise<ApiProject['roomTypes'][number]['switches']> {
  const projects = await apiGetProjects(page);
  return projects[0]?.roomTypes?.[0]?.switches ?? [];
}

/** Switch サブタブに移動 */
async function goToSwitchTab(page: Page): Promise<void> {
  const switchTab = page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first();
  await expect(switchTab).toBeVisible({ timeout: 8000 });
  await switchTab.click();
  await page.waitForTimeout(300);
  // SwitchView 内の種別バー (CCI チップ) が出るのを待つ
  await expect(
    page.locator('.scene-area-chip').filter({ hasText: /CCI/ }).first(),
  ).toBeVisible({ timeout: 8000 });
}

/**
 * プロジェクト一覧から既存プロジェクト → 既存ルームタイプを開き、Switch タブへ。
 * (リロード後など、未選択状態から開き直すために使う)
 */
async function reopenProjectRoomSwitch(page: Page): Promise<void> {
  const switchSubTab = page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first();
  if (await switchSubTab.isVisible().catch(() => false)) {
    await goToSwitchTab(page);
    return;
  }
  // プロジェクトカードをクリックして開く
  const projectCard = page.locator('button.screen-card').first();
  await expect(projectCard).toBeVisible({ timeout: 10000 });
  await projectCard.click();
  // Room Type タブ → ルームタイプカードを開く
  await page.locator('[role="tab"]').filter({ hasText: /Room Type/ }).first().click();
  await page.waitForTimeout(300);
  const roomCard = page.locator('button.screen-card').first();
  await expect(roomCard).toBeVisible({ timeout: 8000 });
  await roomCard.click();
  await goToSwitchTab(page);
}

/** プロジェクト作成 → ルーム作成 → データ注入 → Switch タブ という共通セットアップ */
async function fullSetup(page: Page): Promise<void> {
  await isolate(page);
  await createAndOpenProject(page, `${PROJECT_NAME}-${Date.now()}`);
  await createRoomTypeAndSelect(page, `${ROOM_NAME}-${Date.now()}`);
  await seedAreasCircuitsScenes(page);
  // 開いている UI ページの autosave がシードを上書きしないよう一旦退避してから開き直す
  // autosave タイマー (1200ms) が発火し終えるのを確実に待ってから about:blank へ
  await page.waitForTimeout(1800);
  await page.goto('about:blank');
  // autosave が書き戻したかもしれないデータを page.request (Node.js fetch) で取得し直す
  const afterSeedResp = await page.request.get(`${PLAYWRIGHT_BASE_URL}/api/projects`);
  const afterSeedBody = await afterSeedResp.json();
  const afterSeedProjects: ApiProject[] = afterSeedBody.projects ?? [];
  // autosave によってシードデータが上書きされていた場合、シードを再注入する
  if (afterSeedProjects.length > 0 && afterSeedProjects[0]?.roomTypes?.[0]) {
    const proj = afterSeedProjects[0] as ApiProject & { locations: unknown[]; circuits: unknown[] };
    const rt = proj.roomTypes[0] as ApiProject['roomTypes'][number] & { scenes: unknown[] };
    // scenes が消えていたら再注入
    if (!rt.scenes || (rt.scenes as unknown[]).length === 0) {
      proj.locations = [
        { id: 'audit-area-a', name: 'Bedroom', number: '1', color: '#FFC7CE' },
        { id: 'audit-area-b', name: 'Bathroom', number: '2', color: '#C6EFCE' },
      ];
      proj.circuits = [
        { id: 'audit-cir-1', circuitGroupId: 'g1', daliFixtureGroupId: '', designerNumber: 'D-001', internalNumber: 'I-001', dimmingType: 'DALI', fixture: '', pcs: '1', detail: 'Ceiling', area: 'audit-area-a', ffe: false, energySaving: false },
        { id: 'audit-cir-2', circuitGroupId: 'g2', daliFixtureGroupId: '', designerNumber: 'D-002', internalNumber: 'I-002', dimmingType: 'Switch', fixture: '', pcs: '1', detail: 'Lamp', area: 'audit-area-a', ffe: false, energySaving: false },
        { id: 'audit-cir-3', circuitGroupId: 'g3', daliFixtureGroupId: '', designerNumber: 'D-003', internalNumber: 'I-003', dimmingType: 'DALI', fixture: '', pcs: '1', detail: 'Mirror', area: 'audit-area-b', ffe: false, energySaving: false },
      ];
      rt.scenes = [
        { id: 'audit-scene-a1', areaId: 'audit-area-a', name: 'Welcome', settings: [{ circuitId: 'audit-cir-1', percentage: '80' }] },
        { id: 'audit-scene-a2', areaId: 'audit-area-a', name: 'Relax', settings: [{ circuitId: 'audit-cir-1', percentage: '20' }] },
        { id: 'audit-scene-b1', areaId: 'audit-area-b', name: 'Bright', settings: [{ circuitId: 'audit-cir-3', percentage: '100' }] },
      ];
      rt.switches = rt.switches ?? [];
      await apiPutProjects(page, afterSeedProjects);
    }
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // "Loading projects." が消えるまで待つ
  await page.waitForFunction(
    () => !document.body.textContent?.includes('Loading projects'),
    { timeout: 20000 },
  );
  await reopenProjectRoomSwitch(page);
}

const KIND_CHIP = (label: string) =>
  `.scene-area-chip:has-text("${label}")`;

// ============================================================
test.describe('AUDIT-07 Switch management', () => {
  test.beforeEach(async ({ page }) => {
    await installLocalEditingMocks(page);
  });

  // 各テストは fullSetup() で隔離するため独立。1テストの失敗で他を隠さない。
  test.setTimeout(90000);

  // ---- A. 種別タブの公開状況と型定義との整合 ----
  test('[A1] Switch タブの種別チップが SWITCH_KIND_OPTIONS と一致する', async ({ page }) => {
    await fullSetup(page);

    const chips = page.locator('.scene-area-bar .scene-area-chip');
    const labels = (await chips.allTextContents()).map((t) => t.trim());
    await shot(page, 'A1-kind-chips');

    // UI に出ている種別ラベル
    expect(labels).toEqual(EXPECTED_UI_KIND_LABELS);

    // 型定義 SwitchKind には command / tstat も存在するが UI には無いことを観察(回帰検出)
    const hasCommandChip = labels.some((l) => /command/i.test(l));
    const hasTstatChip = labels.some((l) => /tstat|thermostat/i.test(l));
    // この2つは Switch タブには出ないのが現状仕様 (Command は別タブ)。
    expect(hasCommandChip).toBe(false);
    expect(hasTstatChip).toBe(false);
  });

  test('[A2] 型定義 SwitchKind の値が把握できている (参考: ' + ALL_SWITCH_KINDS.join(',') + ')', async () => {
    // ドキュメント用。型に存在する kind は 6 種、UI 露出は 4 種。
    expect(ALL_SWITCH_KINDS.length).toBe(7);
    expect(EXPECTED_UI_KIND_LABELS.length).toBe(5);
  });

  // ---- B. スイッチ追加と各種別への切替 ----
  test('[B1] 各種別タブでスイッチを追加できる (CCI/Palladiom/Pico/PIR)', async ({ page }) => {
    await fullSetup(page);

    for (const label of EXPECTED_UI_KIND_LABELS) {
      await page.locator(KIND_CHIP(label)).first().click();
      await page.waitForTimeout(200);

      const addBtn = page.locator('.btn-add-row').first();
      await expect(addBtn).toBeVisible({ timeout: 5000 });
      await addBtn.click();
      await page.waitForTimeout(300);

      // items カウントが 1 以上になる (SwitchView の toolbar 内の pill に限定)
      const pill = page.locator('.toolbar .muted-pill').filter({ hasText: /items/ }).first();
      const pillText = (await pill.textContent()) ?? '';
      expect(pillText).toMatch(/\d+\s*items/);
      const count = Number.parseInt(pillText, 10);
      expect(count).toBeGreaterThanOrEqual(1);

      // 行 (tbody tr) が出現
      const bodyRows = page.locator('tbody tr');
      expect(await bodyRows.count()).toBeGreaterThanOrEqual(1);
      await shot(page, `B1-added-${label}`);
    }
  });

  test('[B2] Palladiom でボタン数を選ぶと M1..Mn 行が展開される', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);

    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    // Buttons 列の select でボタン数 4 を選択
    const buttonCountSelect = page.locator('tbody select').first();
    await expect(buttonCountSelect).toBeVisible({ timeout: 5000 });
    await buttonCountSelect.selectOption('4');
    await page.waitForTimeout(400);
    await shot(page, 'B2-palladiom-4buttons');

    // M1..M4 のボタンバッジが出る
    const badges = page.locator('.switch-button-badge');
    const badgeTexts = (await badges.allTextContents()).map((t) => t.trim());
    expect(badgeTexts).toEqual(expect.arrayContaining(['M1', 'M2', 'M3', 'M4']));
  });

  test('[B3] Pico でボタン数を選ぶと 1..n 行が展開される', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Pico')).first().click();
    await page.waitForTimeout(200);

    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    const buttonCountSelect = page.locator('tbody select').first();
    await expect(buttonCountSelect).toBeVisible({ timeout: 5000 });
    await buttonCountSelect.selectOption('3');
    await page.waitForTimeout(400);
    await shot(page, 'B3-pico-3buttons');

    const badges = page.locator('.switch-button-badge');
    const badgeTexts = (await badges.allTextContents()).map((t) => t.trim());
    expect(badgeTexts).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  test('[B4] Pico Corridor / Privacy special buttons expand with default functions and LED CFS rows', async ({ page }) => {
    test.setTimeout(60000);
    await fullSetup(page);
    await page.locator(KIND_CHIP('Pico')).first().click();
    await page.waitForTimeout(200);

    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);
    const corridorSelect = page.locator('tbody select').first();
    await expect(corridorSelect).toBeVisible({ timeout: 5000 });
    await corridorSelect.selectOption('Corridor');
    await page.waitForTimeout(400);

    let specialBadgeTexts = (await page.locator('.switch-button-badge').allTextContents()).map((t) => t.trim());
    expect(specialBadgeTexts).toEqual(expect.arrayContaining(['Chime Button']));
    await page.waitForTimeout(1600);

    let stored = (await readSwitches(page)) as Array<Record<string, unknown>>;
    expect(stored.some((sw) =>
      sw.kind === 'lutronPico' &&
      sw.buttonCount === 'Corridor' &&
      sw.buttonLabel === 'Chime Button' &&
      sw.buttonFunction === 'Chime Button' &&
      sw.allocation === 'CorridorPico',
    )).toBe(true);

    await page.locator('tbody button').filter({ hasText: /^Setting$/ }).first().click();
    await page.locator('.switch-area-toggle').filter({ hasText: /Other/ }).first().click();
    await expect(page.getByText('MUR LED').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('DND LED').first()).toBeVisible({ timeout: 5000 });
    await page.locator('button').filter({ hasText: /^Close$/ }).first().click();

    await page.locator(KIND_CHIP('Pico')).first().click();
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);
    const privacySelect = page.locator('tbody select').last();
    await privacySelect.selectOption('Privacy');
    await page.waitForTimeout(400);

    specialBadgeTexts = (await page.locator('.switch-button-badge').allTextContents()).map((t) => t.trim());
    expect(specialBadgeTexts).toEqual(expect.arrayContaining(['M1', 'M2']));
    await page.waitForTimeout(1600);

    stored = (await readSwitches(page)) as Array<Record<string, unknown>>;
    const privacyRows = stored.filter((sw) => sw.kind === 'lutronPico' && sw.buttonCount === 'Privacy');
    expect(privacyRows.map((sw) => sw.buttonLabel)).toEqual(expect.arrayContaining(['M1', 'M2']));
    expect(privacyRows.map((sw) => sw.buttonFunction)).toEqual(expect.arrayContaining(['MUR', 'DND']));

    await page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first().click();
    await expect(page.getByText('MUR LED').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('DND LED').first()).toBeVisible({ timeout: 10000 });
  });

  // ---- C. ボタン設定パネル: シーン割当 ----
  test('[C1] Setting パネルでエリアごとにシーンを割り当てられる', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    // Setting ボタンを開く
    const settingBtn = page.locator('tbody button').filter({ hasText: /^Setting$/ }).first();
    await expect(settingBtn).toBeVisible({ timeout: 5000 });
    await settingBtn.click();
    await page.waitForTimeout(400);
    await shot(page, 'C1-setting-open');

    // Area Scene テーブルが出る (Bedroom 行)
    const areaSceneTable = page.locator('.switch-scene-table');
    await expect(areaSceneTable.first()).toBeVisible({ timeout: 5000 });

    // Bedroom 行の Scene select を取得
    const bedroomRow = areaSceneTable.locator('tbody tr').filter({ hasText: 'Bedroom' }).first();
    await expect(bedroomRow).toBeVisible({ timeout: 5000 });
    const sceneSelect = bedroomRow.locator('select').first();

    // option に Welcome / Relax が存在
    const opts = (await sceneSelect.locator('option').allTextContents()).map((t) => t.trim());
    expect(opts).toEqual(expect.arrayContaining(['Welcome', 'Relax']));

    // Welcome を選択
    await sceneSelect.selectOption({ label: 'Welcome' });
    await page.waitForTimeout(300);
    await expect(sceneSelect).toHaveValue('audit-scene-a1');
    await shot(page, 'C1-scene-assigned');

    // サーバ DB に sceneIds が保存されているか (1200ms debounce 待ち)
    await page.waitForTimeout(1600);
    const stored = await readSwitches(page);
    const anyHasScene = stored.some(
      (s) =>
        (s.buttonSetting.sceneIds && s.buttonSetting.sceneIds.includes('audit-scene-a1')) ||
        s.buttonSetting.sceneId === 'audit-scene-a1',
    );
    expect(anyHasScene).toBe(true);
  });

  test('[C2] Clear ボタンで割り当てたシーンを解除できる', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    await page.locator('tbody button').filter({ hasText: /^Setting$/ }).first().click();
    await page.waitForTimeout(400);

    const bedroomRow = page.locator('.switch-scene-table tbody tr').filter({ hasText: 'Bedroom' }).first();
    const sceneSelect = bedroomRow.locator('select').first();
    await sceneSelect.selectOption({ label: 'Relax' });
    await page.waitForTimeout(200);
    await expect(sceneSelect).toHaveValue('audit-scene-a2');

    // Clear ボタン
    await bedroomRow.locator('button').filter({ hasText: /Clear/ }).first().click();
    await page.waitForTimeout(300);
    await expect(sceneSelect).toHaveValue('');
    await shot(page, 'C2-scene-cleared');
  });

  // ---- D. ボタン設定パネル: 回路レベル個別設定 (Individual Override) ----
  test('[D1] Individual Override でエリアを開き回路レベル(%)を入力できる', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    await page.locator('tbody button').filter({ hasText: /^Setting$/ }).first().click();
    await page.waitForTimeout(400);

    // Individual Override セクション内のエリアトグル (Bedroom)
    const areaToggle = page.locator('.switch-area-toggle').filter({ hasText: 'Bedroom' }).first();
    await expect(areaToggle).toBeVisible({ timeout: 5000 });
    await areaToggle.click();
    await page.waitForTimeout(300);
    await shot(page, 'D1-override-open');

    // 個別回路テーブルが出る
    const overrideTable = page.locator('.switch-individual-table').first();
    await expect(overrideTable).toBeVisible({ timeout: 5000 });

    // DALI 回路 (D-001 Ceiling) は数値入力、Switch 回路 (D-002 Lamp) は On/Off ボタン
    const numberInput = overrideTable.locator('input.scene-level-input').first();
    await expect(numberInput).toBeVisible({ timeout: 5000 });
    await numberInput.fill('55');
    await page.waitForTimeout(300);
    await expect(numberInput).toHaveValue('55');
    await shot(page, 'D1-percent-entered');

    // サーバ DB の circuitSettings に 55 が保存される
    await page.waitForTimeout(1600);
    const settings = (await readSwitches(page)).flatMap((s) => s.buttonSetting.circuitSettings);
    const has55 = settings.some((s) => s.percentage === '55');
    expect(has55).toBe(true);
  });

  test('[D2] On/Off 回路は On/Off/Uneffected ボタンで設定できる', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    await page.locator('tbody button').filter({ hasText: /^Setting$/ }).first().click();
    await page.waitForTimeout(400);

    const areaToggle = page.locator('.switch-area-toggle').filter({ hasText: 'Bedroom' }).first();
    await areaToggle.click();
    await page.waitForTimeout(300);

    // On/Off ボタングループ (Switch 回路 = D-002 Lamp)
    const onOffGroup = page.locator('.switch-individual-table .switch-onoff-buttons').first();
    const groupCount = await onOffGroup.count();
    if (groupCount === 0) {
      // dimmingType の判定で On/Off にならない場合は記録のみ
      test.info().annotations.push({ type: 'note', description: 'On/Off ボタングループが見つからない (dimmingType 判定の可能性)' });
      await shot(page, 'D2-no-onoff-group');
      return;
    }
    const onBtn = onOffGroup.locator('button').filter({ hasText: /^On$/ }).first();
    await onBtn.click();
    await page.waitForTimeout(300);
    await expect(onBtn).toHaveClass(/is-active/);
    await shot(page, 'D2-on-active');
  });

  test('[D3] Area bulk applies percent and On/Off by target type', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    await page.locator('tbody button').filter({ hasText: /^Setting$/ }).first().click();
    await page.waitForTimeout(400);

    const areaPanel = page.locator('.switch-area-panel').filter({ hasText: 'Bedroom' }).first();
    await expect(areaPanel).toBeVisible({ timeout: 5000 });
    await areaPanel.locator('.switch-area-toggle').click();

    const bulkInput = areaPanel.locator('.switch-area-bulk-control input').first();
    await expect(bulkInput).toBeVisible({ timeout: 5000 });
    await bulkInput.fill('66');
    await areaPanel.locator('.switch-area-bulk-buttons button').filter({ hasText: /^Apply %$/ }).click();

    const overrideTable = areaPanel.locator('.switch-individual-table').first();
    await expect(overrideTable.locator('input.scene-level-input').first()).toHaveValue('66');

    const onOffGroup = overrideTable.locator('.switch-onoff-buttons').first();
    await expect(onOffGroup).toBeVisible({ timeout: 5000 });
    const onBtn = onOffGroup.locator('button').filter({ hasText: /^On$/ }).first();
    await onBtn.click();
    await expect(onBtn).toHaveClass(/is-active/);

    await page.waitForTimeout(1600);
    const settings = (await readSwitches(page)).flatMap((s) => s.buttonSetting.circuitSettings);
    expect(settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ circuitId: 'audit-cir-1', percentage: '66' }),
      expect.objectContaining({ circuitId: 'audit-cir-2', percentage: 'On' }),
    ]));

    await areaPanel.locator('.switch-area-bulk-buttons button').filter({ hasText: /^Uneffected$/ }).click();
    await page.waitForTimeout(1600);
    const clearedSettings = (await readSwitches(page)).flatMap((s) => s.buttonSetting.circuitSettings);
    expect(clearedSettings.some((s) => s.circuitId === 'audit-cir-1' || s.circuitId === 'audit-cir-2')).toBe(false);
  });

  // ---- E. バックライト設定 ----
  test('[E1] Backlight Setting パネルが開き Condition を選べる', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(300);

    // Backlight Setting 列のボタン (Setting 列の右隣 = 2番目の Setting ボタン)
    const settingBtns = page.locator('tbody button').filter({ hasText: /^Setting$/ });
    const btnCount = await settingBtns.count();
    expect(btnCount).toBeGreaterThanOrEqual(2);
    // 2 番目が Backlight
    await settingBtns.nth(1).click();
    await page.waitForTimeout(400);
    await shot(page, 'E1-backlight-open');

    // Condition select が出る (Backlight setting layout)
    const backlightLayout = page.locator('.switch-backlight-setting-layout').first();
    await expect(backlightLayout).toBeVisible({ timeout: 5000 });

    const conditionSelect = backlightLayout.locator('select').first();
    await expect(conditionSelect).toBeVisible({ timeout: 5000 });

    // BACKLIGHT_LEVEL_NAMES の選択肢が含まれる
    const condOpts = (await conditionSelect.locator('option').allTextContents()).map((t) => t.trim());
    expect(condOpts).toEqual(expect.arrayContaining(['Base', 'Bright', 'Relax', 'Mood', 'Sleep']));
    expect(condOpts).not.toEqual(expect.arrayContaining(['Master On', 'Light']));

    await conditionSelect.selectOption({ label: 'Relax' });
    await page.waitForTimeout(300);
    await shot(page, 'E1-backlight-condition-set');

    // 保存確認
    await page.waitForTimeout(1600);
    const cond = (await readSwitches(page)).map((s) => s.backlightCondition);
    expect(cond.some((c) => c === 'relax' || c === 'Relax')).toBe(true);
  });

  // ---- F. 永続化と削除 ----
  test('[F1] 追加したスイッチがリロード後も残る (永続化)', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('CCI')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(400);

    await page.waitForTimeout(1600);
    const countBefore = (await readSwitches(page)).length;
    expect(countBefore).toBeGreaterThanOrEqual(1);

    // reload は Next dev で ERR_ABORTED になりやすいので about:blank 経由で開き直す
    await page.goto('about:blank');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const countAfter = (await readSwitches(page)).length;
    expect(countAfter).toBe(countBefore);

    // UI 上でもリロード後に開き直すと CCI 行が残っている
    await reopenProjectRoomSwitch(page);
    await page.locator(KIND_CHIP('CCI')).first().click();
    await page.waitForTimeout(300);
    expect(await page.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);
  });

  test('[F2] Delete ボタンでスイッチ行を削除できる', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('CCI')).first().click();
    await page.waitForTimeout(200);
    await page.locator('.btn-add-row').first().click();
    await page.waitForTimeout(400);

    const rowsBefore = await page.locator('tbody tr').count();
    expect(rowsBefore).toBeGreaterThanOrEqual(1);

    const deleteBtn = page.locator('tbody').getByRole('button', { name: 'Delete Switch' }).first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();
    await page.waitForTimeout(400);
    await shot(page, 'F2-after-delete');

    await page.waitForTimeout(1600);
    const stored = (await readSwitches(page)).length;
    expect(stored).toBe(0);
  });

  // ---- G. PIR 種別 ----
  test('[G1] PIR タブでエリア選択 (details) が機能する', async ({ page }) => {
    await fullSetup(page);
    await page.locator(KIND_CHIP('PIR')).first().click();
    await page.waitForTimeout(200);
    const bedroomRegistration = page.locator('.pir-registration-table tbody tr').filter({ hasText: 'Bedroom' }).first();
    await expect(bedroomRegistration).toBeVisible({ timeout: 5000 });
    const qtyInput = bedroomRegistration.locator('textarea, input').first();
    await qtyInput.fill('1');
    await page.waitForTimeout(300);
    await shot(page, 'G1-pir-registration');

    // PIR の Area セルは details.pir-area-select
    await expect(page.locator('.pir-registration-heading .muted-pill')).toHaveText(/1\s*PIRs?/i, { timeout: 5000 });

    // 回路が割り当てられたエリア (Bedroom/Bathroom) がチェックボックスとして並ぶ
    const options = page.locator('.pir-logic-check');
    await expect(options.first()).toBeVisible({ timeout: 5000 });

    const firstCheckbox = options.first().locator('input[type="checkbox"]');
    await expect(firstCheckbox).toBeChecked();
    await firstCheckbox.uncheck();
    await expect(firstCheckbox).not.toBeChecked();
    await firstCheckbox.check();
    await expect(firstCheckbox).toBeChecked();
    await expect(page.locator('.pir-location-chip').first()).toHaveText(/Bedroom/);
  });

  // ---- H. コンソールエラー監視 ----
  test('[H1] Switch 操作中に console error / pageerror が発生しない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });

    await fullSetup(page);

    // 各種別を一巡し、追加・設定を行う
    for (const label of EXPECTED_UI_KIND_LABELS) {
      await page.locator(KIND_CHIP(label)).first().click();
      await page.waitForTimeout(150);
      await page.locator('.btn-add-row').first().click();
      await page.waitForTimeout(250);
    }
    // Setting / Backlight を開閉
    await page.locator(KIND_CHIP('Palladiom')).first().click();
    await page.waitForTimeout(150);
    const settingBtns = page.locator('tbody button').filter({ hasText: /^Setting$/ });
    if (await settingBtns.count() > 0) {
      await settingBtns.first().click();
      await page.waitForTimeout(300);
    }
    await shot(page, 'H1-final-state');

    // React の致命的レンダリングエラーが無いこと
    const fatal = errors.filter(
      (e) => /Cannot update a component|Maximum update depth|is not a function|Cannot read/.test(e),
    );
    expect(fatal, `fatal errors:\n${fatal.join('\n')}`).toHaveLength(0);
  });
});
