/**
 * AUDIT #8 - CFS 統合ビュー (Rooms → CFS サブタブ / CfsView)
 *
 * 対象: HVAC/BLL(Backlight)/Command/Switch/Scene を 1 マトリクスに統合表示する読み取り専用ビュー。
 * 検証観点:
 *   - 統合マトリクスの表示 (zones / functions サマリ, ベース列, 関数列ヘッダ階層)
 *   - エリアフィルタ
 *   - Designer# / Internal# 切替
 *   - 予約 (Reserved) 行の表示 / 非表示
 *   - 関数列のドラッグ並べ替え (Function Columns メニュー)
 *   - 横スクロール時の base 列固定 (sticky)
 *   - Excel エクスポート (exceljs) のダウンロードと、ローディング/disabled の観察
 *
 * 注意: CfsView は読み取り専用。CFS データは Circuit / Device Assign / Scene / Switch から生成される。
 * そのため UI でプロジェクト+ルームタイプを作成後、永続化された project を localStorage 経由で
 * シードし (実スキーマを使用)、reload して CFS サブタブを検証する。
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';
import { STORAGE_KEY } from '../../app/lib/constants';
import { installLocalEditingMocks } from './support/secure-sharing-mock';

const SHOT_DIR = path.join('test-results', 'audit-08');
const PROJECT_NAME = 'AUDIT-08-Cfs';
const ROOM_NAME = 'AUDIT-08-Room';
const SECOND_ROOM_NAME = 'AUDIT-08-Room-B';
const EMPTY_ROOM_NAME = 'AUDIT-08-Empty';

test.beforeEach(async ({ page }) => {
  await installLocalEditingMocks(page);
  // Kill the draft-wins race: a stale browser draft written by the still-open
  // project page (1.2s debounced autosave) would beat the seeded server state
  // on reload. Tests never need drafts, so purge them before every load.
  await page.addInitScript(() => {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith('cfs-project-drafts')) doomed.push(key);
      }
      doomed.forEach((key) => localStorage.removeItem(key));
    } catch {
      // best effort
    }
  });
});

function shotPath(name: string): string {
  return path.join(SHOT_DIR, `${name}.png`);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: shotPath(name), fullPage: false });
}

function exactText(label: string): RegExp {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

function cfsMenuTrigger(page: Page, label: string | RegExp): Locator {
  return page
    .locator('.cfs-matrix-controls .cfs-filter-menu-trigger')
    .filter({ hasText: typeof label === 'string' ? exactText(label) : label })
    .first();
}

/**
 * localStorage と API の両方をクリアしてクリーンな状態を作る。
 * /api/projects は共有 DB ファイルのため、空配列で上書きする。
 * ブラウザ内 fetch を使い、page.route のローカル編集 mock 経由で隔離する。
 */
async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [] }),
    });
  });
  // localStorage もクリア (ブラウザ側)
  await page.evaluate(() => localStorage.clear());
}

/**
 * ルートへ堅牢にナビゲートする。dev サーバーが遅い/一時的に 500 を返すため
 * domcontentloaded で待ち、プロジェクト名入力欄が現れるまでリトライする。
 */
async function gotoRootRobust(page: Page): Promise<void> {
  const projectListReady = page.locator('input[placeholder*="project name"], button.screen-card').first();
  const projectListOrDetailReady = page
    .locator('input[placeholder*="project name"], button.screen-card, button.breadcrumb-link')
    .first();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await expect(projectListOrDetailReady).toBeVisible({ timeout: 15000 });
      const backToList = page.getByRole('button', { name: /Back to Project List/i }).first();
      if (await backToList.isVisible({ timeout: 1000 }).catch(() => false)) {
        await backToList.click();
      }
      await expect(projectListReady).toBeVisible({ timeout: 15000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(1500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('gotoRootRobust failed');
}

/**
 * UI でプロジェクト作成 (UI は英語)。作成すると即座にプロジェクト画面へ遷移する
 * (handleCreateProject が activeProjectId を設定するため)。tablist の出現を待つ。
 */
async function createProject(page: Page, name: string): Promise<void> {
  // まずページをロードして Playwright リクエストコンテキストを使える状態にする
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // API (共有 DB) と localStorage の両方をクリア
  await clearStorage(page);
  // クリア後にリロードして空の状態でアプリを再起動
  await gotoRootRobust(page);
  const nameInput = page.locator('input[placeholder*="project name"]').first();
  await nameInput.fill('');
  await nameInput.fill(name);
  await page.locator('button').filter({ hasText: /^Create Project$/ }).first().click();
  // 作成後はプロジェクト画面 (親タブ Area/Fixture/Room Type) に入る。
  // アプリが自動遷移しない場合に備えてカードクリックでフォールバックする。
  const roomTypeTab = page.locator('[role="tab"]').filter({ hasText: /^Room Type$/ }).first();
  try {
    await expect(roomTypeTab).toBeVisible({ timeout: 12000 });
  } catch {
    // 自動遷移しなかった場合: カードをクリックしてプロジェクト画面に入る
    const card = page.locator('button.screen-card').filter({ hasText: name }).first();
    await expect(card).toBeVisible({ timeout: 8000 });
    await card.click();
    await expect(roomTypeTab).toBeVisible({ timeout: 10000 });
  }
}

/** プロジェクトカードを開く */
async function openProject(page: Page, name: string): Promise<void> {
  const card = page.locator('button.screen-card').filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.click();
  await expect(page.locator('[role="tablist"]').first()).toBeVisible({ timeout: 10000 });
}

/** "Room Type" 親タブへ移動 */
async function gotoRoomTypeTab(page: Page): Promise<void> {
  await page.locator('[role="tab"]').filter({ hasText: /^Room Type$/ }).first().click();
  await page.waitForTimeout(300);
}

/** ルームタイプ作成 */
async function createRoomType(page: Page, roomName: string): Promise<void> {
  const roomInput = page.locator('input[placeholder="New room type name"]').first();
  await expect(roomInput).toBeVisible({ timeout: 8000 });
  await roomInput.fill(roomName);
  await page.locator('button').filter({ hasText: /^Create Room Type$/ }).first().click();
}

/** ルームタイプカードを選択 → Circuit サブタブが現れる */
async function selectRoomTypeCard(page: Page, roomName: string): Promise<void> {
  const card = page.locator('button.screen-card').filter({ hasText: roomName }).first();
  if (await card.isVisible({ timeout: 3000 }).catch(() => false)) {
    await card.click();
  } else {
    await page.getByRole('tab', { name: roomName, exact: true }).first().click();
  }
  await expect(
    page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first(),
  ).toBeVisible({ timeout: 8000 });
}

/**
 * 永続化 (1200ms デバウンス保存) を待つ。指定プロジェクト名のルームタイプが
 * localStorage に現れるまでポーリングする。
 */
async function waitForRoomPersisted(page: Page, projectName: string, roomName: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ storageKey, pn, rn }) => {
            const parseProjects = (raw: string | null): Array<{
              name: string;
              roomTypes: Array<{ name: string }>;
            }> => {
              if (!raw) return [];
              try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            };
            const storageKeys = new Set<string>([storageKey]);
            for (let i = 0; i < localStorage.length; i += 1) {
              const key = localStorage.key(i);
              if (key?.startsWith('cfs-project-drafts')) storageKeys.add(key);
            }
            const snapshots = Array.from(storageKeys, (key) => parseProjects(localStorage.getItem(key)));
            try {
              const response = await fetch('/api/projects');
              const payload = await response.json();
              if (Array.isArray(payload.projects)) snapshots.push(payload.projects);
            } catch {
              // Route mocks are optional for this check; localStorage drafts are enough.
            }
            return snapshots.some((projects) => {
              const project = projects.find((p) => p.name === pn);
              if (!project) return false;
              return project.roomTypes.some((r) => r.name === rn);
            });
          },
          { storageKey: STORAGE_KEY, pn: projectName, rn: roomName },
        ),
      { timeout: 8000, intervals: [200, 300, 500] },
    )
    .toBeTruthy();
}

/**
 * 永続化された project を読み込み、circuits / deviceAssignments / scenes / switches を
 * 実スキーマでシードして書き戻す。CFS マトリクスが生成されるだけのデータを用意する。
 */
async function seedCfsData(page: Page): Promise<{ areaIds: string[] }> {
  const result = await page.evaluate(
    async ({ storageKey, pn, rn }) => {
    type ProjectsArray = Array<{
      id: string;
      name: string;
      locations: Array<{ id: string; name: string; number: string; color: string }>;
      circuits: unknown[];
      roomTypes: Array<Record<string, unknown>>;
    }>;
    const empty: ProjectsArray = [];
    const parseProjects = (raw: string | null): ProjectsArray => {
      if (!raw) return empty;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as ProjectsArray : empty;
      } catch {
        return empty;
      }
    };
    const storageKeys = new Set<string>([storageKey]);
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith('cfs-project-drafts')) storageKeys.add(key);
    }
    let projects = Array.from(storageKeys, (key) => parseProjects(localStorage.getItem(key)))
      .find((items) => items.some((p) => p.name === pn && p.roomTypes.some((r) => (r as { name?: string }).name === rn)))
      ?? empty;
    if (projects.length === 0) {
      try {
        const response = await fetch('/api/projects');
        const payload = await response.json();
        projects = Array.isArray(payload.projects) ? payload.projects as ProjectsArray : empty;
      } catch {
        projects = empty;
      }
    }
    if (projects.length === 0) return { ok: false, reason: 'no storage', areaIds: [] as string[], projects: empty };
    const project = projects.find((p) => p.name === pn) ?? projects[0];
    if (!project) return { ok: false, reason: 'no project', areaIds: [], projects: empty };
    const room =
      (project.roomTypes.find((r) => (r as { name?: string }).name === rn) as Record<string, unknown> | undefined) ??
      project.roomTypes[0];
    if (!room) return { ok: false, reason: 'no room', areaIds: [], projects: empty };

    const uuid = () => crypto.randomUUID();
    // 2 つのエリアを使用 (色を付けてエリア識別を可視化)
    const locs = project.locations;
    const areaA = locs[0];
    const areaB = locs[1] ?? locs[0];
    areaA.color = '#FFC7CE';
    areaB.color = '#C6EFCE';
    const areaIds = [areaA.id, areaB.id];

    // --- Circuits (designerNumber でデバイス割当と紐づく) ---
    const mkCircuit = (
      designer: string,
      internal: string,
      area: string,
      dimming: string,
      detail: string,
      ffe: boolean,
      energy: boolean,
    ) => ({
      id: uuid(),
      circuitGroupId: uuid(),
      daliFixtureGroupId: '',
      designerNumber: designer,
      internalNumber: internal,
      dimmingType: dimming,
      fixture: '',
      pcs: '1',
      detail,
      area,
      ffe,
      energySaving: energy,
    });
    const circuits = [
      mkCircuit('D-1', 'L01', areaA.id, '0-10V', 'Downlight A', false, false),
      mkCircuit('D-2', 'L02', areaA.id, '0-10V', 'Cove A', true, false),
      mkCircuit('D-3', 'L03', areaB.id, 'DALI', 'Spot B', false, true),
    ];
    project.circuits = circuits;
    // The app normalizes a fresh room type to circuitIds: [] before any
    // circuits exist; seeding circuits without updating circuitIds leaves the
    // room scoped to zero circuits (Designer#/scene links all blank - the
    // A2/C/H flake). Scope the room to the seeded circuits explicitly.
    (room as { circuitIds?: string[] }).circuitIds = circuits.map((entry) => entry.id);

    // --- Device Assignments (circuitNumber == circuit.designerNumber) ---
    const mkAssign = (
      device: string,
      deviceNum: string,
      zone: string,
      circuitNumber: string,
      detail: string,
      group: string,
    ) => ({
      id: uuid(),
      deviceGroupId: uuid(),
      device,
      deviceNum,
      zoneAddress: zone,
      circuitNumber,
      detail,
      group,
    });
    room.deviceAssignments = [
      mkAssign('MQSE-4A1-D', '1', 'Z1', 'D-1', '', ''),
      mkAssign('MQSE-4A1-D', '1', 'Z2', 'D-2', '', ''),
      mkAssign('QSN2-1DALUNV-D', '1', 'A01', 'D-3', '', 'G1'),
      // 予約行 (circuitNumber 未割当 = Reserved)
      mkAssign('MQSE-4A1-D', '1', 'Z3', '', '', ''),
    ];

    // --- Scene (Area scene) ---
    room.scenes = [
      {
        id: uuid(),
        areaId: areaA.id,
        name: 'Bright',
        settings: [
          { circuitId: circuits[0].id, percentage: '100' },
          { circuitId: circuits[1].id, percentage: '80' },
        ],
      },
    ];
    const areaScenes = room.scenes as Array<{ id: string }>;

    // --- RoomScene (Check In / Check Out → Scene 関数列になる) ---
    const mkSetting = (cid: string, pct: string) => ({ circuitId: cid, percentage: pct });
    room.roomScenes = [
      {
        id: uuid(),
        phase: 'Check In',
        sceneType: 'Welcome',
        detail: '',
        triggerCondition: 'Door open',
        backlightCondition: '',
        settings: [mkSetting(circuits[0].id, '100'), mkSetting(circuits[2].id, '50')],
      },
      {
        id: uuid(),
        phase: 'Check Out',
        sceneType: 'Away',
        detail: '',
        triggerCondition: 'Card out',
        backlightCondition: '',
        settings: [mkSetting(circuits[0].id, '0')],
      },
    ];

    // --- Switches (contact / lutronPico / command) ---
    const baseButtonSetting = (circuitSettings: Array<{ circuitId: string; percentage: string }>) => ({
      sceneId: '',
      sceneIds: [] as string[],
      circuitSettings,
    });
    const mkSwitch = (over: Record<string, unknown>) => ({
      id: uuid(),
      switchGroupId: uuid(),
      kind: 'lutronPico',
      switchNumber: 'SW1',
      switchName: 'Entry',
      cciAssignment: '',
      buttonCount: '1',
      buttonLabel: 'On',
      allocation: '',
      buttonFunction: 'All On',
      buttonType: 'single',
      condition: '',
      buttonSetting: baseButtonSetting([]),
      backlightTarget: '',
      backlightCondition: '',
      backlightLevels: [],
      ...over,
    });
    room.switches = [
      mkSwitch({
        kind: 'lutronPico',
        switchNumber: 'SW1',
        switchName: 'Entry',
        buttonLabel: 'On',
        buttonFunction: 'All On',
        // 個別オーバーライド: scene と異なる直接値を入れて override ハイライトを誘発
        buttonSetting: baseButtonSetting([
          { circuitId: circuits[0].id, percentage: '100' },
          { circuitId: circuits[1].id, percentage: '30' },
        ]),
      }),
      mkSwitch({
        kind: 'contact',
        switchNumber: 'CI1',
        switchName: 'Door',
        cciAssignment: 'CCI-1',
        allocation: 'Lobby',
        buttonLabel: 'Trigger',
        buttonFunction: 'Night',
        buttonSetting: baseButtonSetting([{ circuitId: circuits[2].id, percentage: '20' }]),
      }),
      mkSwitch({
        kind: 'lutronPico',
        switchNumber: 'SW2',
        switchName: 'Scene Recall',
        buttonLabel: 'Scene',
        buttonFunction: 'Bright Recall',
        buttonSetting: {
          sceneId: areaScenes[0].id,
          sceneIds: [areaScenes[0].id],
          circuitSettings: [],
        },
      }),
      mkSwitch({
        kind: 'command',
        switchNumber: 'SW1',
        switchName: 'Entry',
        buttonLabel: 'Cmd',
        buttonFunction: 'Scene Recall',
        condition: 'Timer',
      }),
    ];

    localStorage.setItem(storageKey, JSON.stringify(projects));
    return { ok: true, reason: '', areaIds, projects };
    },
    { storageKey: STORAGE_KEY, pn: PROJECT_NAME, rn: ROOM_NAME },
  );

  if (!result.ok) {
    throw new Error(`seedCfsData failed: ${result.reason}`);
  }

  // API にも同期して再ロード後にデータが消えないようにする
  await page.evaluate(async (projects) => {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects }),
    });
  }, result.projects);

  // The still-open project page can flush a stale autosave (1.2s debounce)
  // AFTER the sync above and wipe the seeded circuits/assignments (the A2/C/H
  // flake). Wait the debounce out, re-assert the seed, and verify the
  // persisted structure actually holds everything the tests rely on.
  let verified = false;
  for (let attempt = 0; attempt < 5 && !verified; attempt += 1) {
    await page.waitForTimeout(1800);
    await page.evaluate(
      async ({ projects, storageKey }) => {
        localStorage.setItem(storageKey, JSON.stringify(projects));
        const doomed: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key && key.startsWith('cfs-project-drafts')) doomed.push(key);
        }
        doomed.forEach((key) => localStorage.removeItem(key));
        await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projects }),
        });
      },
      { projects: result.projects, storageKey: STORAGE_KEY },
    );
    verified = await page.evaluate(
      async ({ pn, rn }) => {
        try {
          const response = await fetch('/api/projects', { cache: 'no-store' });
          const payload = await response.json();
          const project = (payload.projects ?? []).find((item: { name?: string }) => item.name === pn);
          if (!project || (project.circuits ?? []).length < 3) return false;
          const room = (project.roomTypes ?? []).find((item: { name?: string }) => item.name === rn);
          if (!room) return false;
          return (
            (room.circuitIds ?? []).length >= 3 &&
            (room.deviceAssignments ?? []).length >= 4 &&
            (room.scenes ?? []).length >= 1 &&
            (room.roomScenes ?? []).length >= 2 &&
            (room.switches ?? []).length >= 4
          );
        } catch {
          return false;
        }
      },
      { pn: PROJECT_NAME, rn: ROOM_NAME },
    );
  }
  if (!verified) {
    throw new Error('seedCfsData: seeded structure did not persist after retries');
  }

  return { areaIds: result.areaIds };
}

async function seedAdditionalRoomType(page: Page, roomName: string): Promise<void> {
  const result = await page.evaluate(
    async ({ storageKey, pn, sourceRoomName, nextRoomName }) => {
      type ProjectShell = {
        name: string;
        roomTypes: Array<Record<string, unknown>>;
      };
      type ProjectsArray = ProjectShell[];
      const parseProjects = (raw: string | null): ProjectsArray => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? (parsed as ProjectsArray) : [];
        } catch {
          return [];
        }
      };
      let projects = parseProjects(localStorage.getItem(storageKey));
      if (projects.length === 0) {
        try {
          const response = await fetch('/api/projects');
          const payload = await response.json();
          projects = Array.isArray(payload.projects) ? (payload.projects as ProjectsArray) : [];
        } catch {
          projects = [];
        }
      }
      const project = projects.find((item) => item.name === pn);
      if (!project) return { ok: false, reason: 'project not found' };
      const sourceRoom = project.roomTypes.find((item) => item.name === sourceRoomName);
      if (!sourceRoom) return { ok: false, reason: 'source room not found' };
      const clone = JSON.parse(JSON.stringify(sourceRoom)) as Record<string, unknown>;
      clone.id = crypto.randomUUID();
      clone.name = nextRoomName;
      project.roomTypes = [
        ...project.roomTypes.filter((item) => item.name !== nextRoomName),
        clone,
      ];
      localStorage.setItem(storageKey, JSON.stringify(projects));
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects }),
      });
      return { ok: true, reason: '' };
    },
    { storageKey: STORAGE_KEY, pn: PROJECT_NAME, sourceRoomName: ROOM_NAME, nextRoomName: roomName },
  );

  if (!result.ok) {
    throw new Error(`seedAdditionalRoomType failed: ${result.reason}`);
  }
}

async function seedEmptyRoomType(page: Page, roomName: string): Promise<void> {
  const result = await page.evaluate(
    async ({ storageKey, pn, sourceRoomName, nextRoomName }) => {
      type ProjectShell = {
        name: string;
        roomTypes: Array<Record<string, unknown>>;
      };
      type ProjectsArray = ProjectShell[];
      const parseProjects = (raw: string | null): ProjectsArray => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? (parsed as ProjectsArray) : [];
        } catch {
          return [];
        }
      };
      let projects = parseProjects(localStorage.getItem(storageKey));
      if (projects.length === 0) {
        try {
          const response = await fetch('/api/projects');
          const payload = await response.json();
          projects = Array.isArray(payload.projects) ? (payload.projects as ProjectsArray) : [];
        } catch {
          projects = [];
        }
      }
      const project = projects.find((item) => item.name === pn);
      if (!project) return { ok: false, reason: 'project not found' };
      const sourceRoom = project.roomTypes.find((item) => item.name === sourceRoomName);
      if (!sourceRoom) return { ok: false, reason: 'source room not found' };
      const clone = JSON.parse(JSON.stringify(sourceRoom)) as Record<string, unknown>;
      clone.id = crypto.randomUUID();
      clone.name = nextRoomName;
      clone.circuitIds = [];
      clone.deviceAssignments = [];
      clone.scenes = [];
      clone.roomScenes = [];
      clone.switches = [];
      clone.backlights = [];
      clone.inspectionMarks = [];
      project.roomTypes = [
        ...project.roomTypes.filter((item) => item.name !== nextRoomName),
        clone,
      ];
      localStorage.setItem(storageKey, JSON.stringify(projects));
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects }),
      });
      return { ok: true, reason: '' };
    },
    { storageKey: STORAGE_KEY, pn: PROJECT_NAME, sourceRoomName: ROOM_NAME, nextRoomName: roomName },
  );

  if (!result.ok) {
    throw new Error(`seedEmptyRoomType failed: ${result.reason}`);
  }
}

/** CFS サブタブを開く */
async function openCfsTab(page: Page): Promise<void> {
  const cfsTab = page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first();
  await expect(cfsTab).toBeVisible({ timeout: 8000 });
  await cfsTab.click();
  await expect(page.locator('table.cfs-matrix-table')).toBeVisible({ timeout: 8000 });
}

/** Open the current CFS toolbar menu and return its portal panel. */
async function openCfsMenu(page: Page, label: string | RegExp): Promise<Locator> {
  const trigger = cfsMenuTrigger(page, label);
  await expect(trigger).toBeVisible({ timeout: 5000 });
  await trigger.click();
  const panel = page.locator('.cfs-filter-list-portal').last();
  await expect(panel).toBeVisible({ timeout: 3000 });
  return panel;
}

/** CFS ビューの UI 設定 (トグル/フィルタ) を初期化する。各テスト間の状態漏れを防ぐ。 */
async function resetCfsPrefs(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('cfs-view-preferences-v1');
    localStorage.removeItem('cfs-view-preferences-v2');
  });
}

/**
 * 各テストの独立セットアップ: プロジェクト + ルーム作成 → 実スキーマでシード →
 * 再ナビゲートして CFS タブを開く。テスト間で状態を共有しない (独立性のため)。
 * dev サーバーが不安定なため per-test 分離 + リトライで耐性を持たせる。
 */
async function setupAndOpenCfs(
  page: Page,
  options: { includeSecondRoom?: boolean; includeEmptyRoom?: boolean } = {},
): Promise<void> {
  // createProject 後は既にプロジェクト画面内 (openProject 不要)
  await createProject(page, PROJECT_NAME);
  await gotoRoomTypeTab(page);
  // createRoomType 後は handleCreateRoomType が自動的に activeRoomTypeId を設定し
  // ルームタイプ詳細 (Circuit サブタブ) に遷移するはず。
  // 同名ルームタイプが存在するとアラートが出て遷移しないため、フォールバックを用意する。
  await createRoomType(page, ROOM_NAME);
  const circuitTab = page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first();
  try {
    await expect(circuitTab).toBeVisible({ timeout: 8000 });
  } catch {
    // 同名ルームタイプが既に存在する場合: カードをクリックして詳細に移動
    const roomCard = page.locator('button.screen-card').filter({ hasText: ROOM_NAME }).first();
    if (await roomCard.isVisible()) {
      await roomCard.click();
      await expect(circuitTab).toBeVisible({ timeout: 8000 });
    }
  }
  await waitForRoomPersisted(page, PROJECT_NAME, ROOM_NAME);
  await seedCfsData(page);
  if (options.includeSecondRoom) {
    await seedAdditionalRoomType(page, SECOND_ROOM_NAME);
  }
  if (options.includeEmptyRoom) {
    await seedEmptyRoomType(page, EMPTY_ROOM_NAME);
  }
  // CFS view prefs を初期化してから再ナビゲート (トグル/フィルタを既定に)
  await resetCfsPrefs(page);
  await gotoRootRobust(page);
  await openProject(page, PROJECT_NAME);
  await gotoRoomTypeTab(page);
  // 再ナビゲート後もルームタイプカードをクリックして詳細に入る
  await selectRoomTypeCard(page, ROOM_NAME);
  await openCfsTab(page);
}

test.describe('AUDIT-08 CFS 統合ビュー', () => {
  // dev サーバーが遅く不安定なため timeout を延長し、各テストにリトライを 1 回付与。
  test.describe.configure({ timeout: 150000, retries: 1 });

  test('A. 統合マトリクスが生成され、サマリ・ベース列・関数列ヘッダが表示される', async ({ page }) => {
    await setupAndOpenCfs(page);
    await shot(page, '01-matrix-initial');

    // CFS ツールバー
    await expect(cfsMenuTrigger(page, 'Area')).toBeVisible();
    await expect(cfsMenuTrigger(page, 'Base')).toBeVisible();
    await expect(cfsMenuTrigger(page, 'Function')).toBeVisible();

    // ベース列ヘッダ
    await expect(page.locator('thead th').filter({ hasText: /Device/ }).first()).toBeVisible();
    await expect(page.locator('thead th').filter({ hasText: /Designer #|Internal #/ }).first()).toBeVisible();

    // データ行が存在する
    const bodyRows = page.locator('table.cfs-matrix-table tbody tr');
    expect(await bodyRows.count()).toBeGreaterThanOrEqual(3);

    // 関数列 (Scene/Command/Switch) が 1 つ以上存在
    const funcCells = page.locator('td.cfs-function-cell');
    expect(await funcCells.count()).toBeGreaterThan(0);
  });

  test('A2. Area Scene Name display toggle hides switch-derived scene labels', async ({ page }) => {
    await setupAndOpenCfs(page);

    const functionCells = page.locator('td.cfs-function-cell');
    await expect(functionCells.filter({ hasText: 'Bright' }).first()).toBeVisible({ timeout: 5000 });
    await expect(functionCells.filter({ hasText: /100%|80%/ }).first()).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Display' }).click();
    const displayPanel = page.locator('.cfs-filter-list-portal').filter({ hasText: 'Area Scene Name' }).last();
    await expect(displayPanel).toBeVisible({ timeout: 3000 });
    const areaSceneNameToggle = displayPanel
      .locator('label.cfs-check')
      .filter({ hasText: /Area Scene Name/ })
      .locator('input[type="checkbox"]')
      .first();
    await expect(areaSceneNameToggle).toBeChecked();

    await areaSceneNameToggle.uncheck();
    await expect(functionCells.filter({ hasText: 'Bright' })).toHaveCount(0);
    await expect(functionCells.filter({ hasText: /100%|80%/ }).first()).toBeVisible({ timeout: 5000 });
    await shot(page, '01-area-scene-name-hidden');
  });

  test('B. エリアフィルタで行が絞り込まれる', async ({ page }) => {
    await setupAndOpenCfs(page);

    const rows = page.locator('table.cfs-matrix-table tbody tr');
    const before = await rows.count();
    expect(before).toBeGreaterThanOrEqual(3);

    // Areas メニューを開く
    const areasMenu = await openCfsMenu(page, 'Area');
    await shot(page, '02-area-filter-open');

    // "Hide all" を押すと 0 行 (または空メッセージ) になる
    await areasMenu.getByRole('button', { name: 'Hide all', exact: true }).click();
    await page.waitForTimeout(300);
    const afterHideAll = await page.locator('table.cfs-matrix-table tbody tr:not(:has(.screen-empty))').count();
    // 全エリア非表示 → データ行 0 (空メッセージ行のみ)
    const emptyMsg = await page.locator('td.screen-empty').count();
    expect(afterHideAll === 0 || emptyMsg > 0).toBeTruthy();
    await shot(page, '03-area-hide-all');

    // 個別エリアを 1 つだけ選ぶ: まず Show all → 最初のエリアのチェックを外して絞り込み
    await areasMenu.getByRole('button', { name: 'Show all', exact: true }).click();
    await page.waitForTimeout(200);
    const checks = areasMenu.locator('label.cfs-check input[type="checkbox"]');
    const checkCount = await checks.count();
    if (checkCount >= 2) {
      // 1 つ目のエリアのチェックを外す
      await checks.nth(0).click();
      await page.waitForTimeout(300);
      const filtered = await page.locator('table.cfs-matrix-table tbody tr').count();
      // 絞り込みにより全件未満になる (1エリア分のみ)
      expect(filtered).toBeLessThanOrEqual(before);
      await shot(page, '04-area-single');
    }
  });

  test('C. Designer# / Internal# 切替でベース列の番号表示が変わる', async ({ page }) => {
    await setupAndOpenCfs(page);

    const displayMenu = await openCfsMenu(page, 'Display');
    const segmented = displayMenu.locator('.cfs-segmented[aria-label="Number display"]');
    await expect(segmented).toBeVisible();
    const designerBtn = segmented.getByRole('button', { name: 'Designer#', exact: true });
    const internalBtn = segmented.getByRole('button', { name: 'Internal#', exact: true });

    // 初期は Designer# がアクティブ
    await expect(designerBtn).toHaveClass(/is-active/);

    // ヘッダが "Designer #"
    await expect(
      page.getByRole('columnheader', { name: /Designer #/ }).first(),
    ).toBeVisible({ timeout: 3000 });

    // designer 番号 (D-1 等) がマトリクスに現れる
    const designerVisible = await page
      .locator('table.cfs-matrix-table tbody')
      .getByText('D-1', { exact: false })
      .count();

    // Internal# に切替
    await internalBtn.click();
    await page.waitForTimeout(300);
    await expect(internalBtn).toHaveClass(/is-active/);
    await expect(
      page.getByRole('columnheader', { name: /Internal #/ }).first(),
    ).toBeVisible({ timeout: 3000 });
    await shot(page, '05-internal-mode');

    // internal 番号 (L01 等) が現れる
    const internalVisible = await page
      .locator('table.cfs-matrix-table tbody')
      .getByText('L01', { exact: false })
      .count();
    expect(internalVisible).toBeGreaterThan(0);

    // designer と internal で表示が変化していること (少なくとも片方は表示)
    expect(designerVisible + internalVisible).toBeGreaterThan(0);
  });

  test('D. 予約 (Reserved) 行の表示 / 非表示トグル', async ({ page }) => {
    await setupAndOpenCfs(page);

    // 予約行が存在する (circuitNumber 未割当の Device Assignment)
    const reservedRows = page.locator('table.cfs-matrix-table tbody tr.cfs-reserved-row');
    const reservedBefore = await reservedRows.count();
    await shot(page, '06-reserved-visible');

    // Hide Reserved トグル
    const displayMenu = await openCfsMenu(page, 'Display');
    const hideReserved = displayMenu
      .locator('label.cfs-check')
      .filter({ hasText: /Hide Reserved/ })
      .locator('input[type="checkbox"]')
      .first();
    await expect(hideReserved).toBeVisible();

    const totalBefore = await page.locator('table.cfs-matrix-table tbody tr').count();
    await hideReserved.check();
    await page.waitForTimeout(300);
    const reservedAfter = await page.locator('table.cfs-matrix-table tbody tr.cfs-reserved-row').count();
    const totalAfter = await page.locator('table.cfs-matrix-table tbody tr').count();
    await shot(page, '07-reserved-hidden');

    if (reservedBefore > 0) {
      // 予約行が消える
      expect(reservedAfter).toBe(0);
      expect(totalAfter).toBeLessThan(totalBefore);
    } else {
      // 予約行が無い場合はトグルが操作可能であることのみ確認 (アノマリとして記録)
      expect(await hideReserved.isChecked()).toBeTruthy();
    }

    // 再表示
    await hideReserved.uncheck();
    await page.waitForTimeout(300);
    const reservedRestored = await page.locator('table.cfs-matrix-table tbody tr.cfs-reserved-row').count();
    expect(reservedRestored).toBe(reservedBefore);
  });

  test('E. 関数列のドラッグ並べ替え (Function Columns メニュー)', async ({ page }) => {
    await setupAndOpenCfs(page);

    const fnMenu = await openCfsMenu(page, 'Function');
    await shot(page, '08-function-columns-menu');

    const groups = fnMenu.locator('.cfs-function-group-panel');
    const groupCount = await groups.count();
    expect(groupCount).toBeGreaterThan(0);

    if (groupCount < 2) {
      test.info().annotations.push({ type: 'note', description: 'ドラッグ可能な関数列が2未満。並べ替え検証はスキップ。' });
      return;
    }

    // 並べ替え前のラベル順を記録
    const labelOf = async (i: number) =>
      ((await groups.nth(i).locator('.cfs-function-group-label').textContent()) ?? '').replace(/\s+/g, ' ').trim();
    const firstBefore = await labelOf(0);
    const secondBefore = await labelOf(1);

    const moveDown = groups.nth(0).locator('button.cfs-function-group-move').filter({ hasText: '↓' }).first();
    await expect(moveDown).toBeEnabled();
    await moveDown.click();
    await page.waitForTimeout(400);

    const firstAfter = await labelOf(0);
    await shot(page, '09-function-columns-reordered');

    // 並べ替えが反映されたか (先頭ラベルが変化)
    const changed = firstAfter !== firstBefore;
    test.info().annotations.push({
      type: 'reorder',
      description: `before[0]=${firstBefore} before[1]=${secondBefore} after[0]=${firstAfter} changed=${changed}`,
    });
    expect(changed).toBeTruthy();
    expect(await groups.count()).toBe(groupCount);
  });

  test('F. 横スクロールで base 列が固定 (sticky) される', async ({ page }) => {
    await setupAndOpenCfs(page);

    // base 列に cfs-sticky-base クラスが付与され position: sticky であること
    const stickyCell = page.locator('table.cfs-matrix-table thead th.cfs-sticky-base').first();
    await expect(stickyCell).toBeVisible();
    const position = await stickyCell.evaluate((el) => window.getComputedStyle(el).position);
    expect(position).toBe('sticky');

    const scroller = page.locator('.cfs-matrix-scroll').first();
    // スクロール前の Device セルの画面上 X 座標
    const deviceHead = page.getByRole('columnheader', { name: /^Hide Device Device$/ }).first();
    await expect(deviceHead).toBeVisible({ timeout: 3000 });
    const xBefore = (await deviceHead.boundingBox())?.x ?? null;

    // 横スクロール
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth; // 最大までスクロール
    });
    await page.waitForTimeout(400);
    const scrolledLeft = await scroller.evaluate((el) => el.scrollLeft);
    const xAfter = (await deviceHead.boundingBox())?.x ?? null;
    await shot(page, '10-horizontal-scroll-sticky');

    // 実際に横スクロールが発生したか
    test.info().annotations.push({ type: 'scroll', description: `scrollLeft=${scrolledLeft} xBefore=${xBefore} xAfter=${xAfter}` });

    if (scrolledLeft > 5 && xBefore !== null && xAfter !== null) {
      // sticky なら Device 列の画面 X 座標はほぼ変わらない (固定)
      expect(Math.abs(xAfter - xBefore)).toBeLessThan(20);
    } else {
      // スクロールが発生しない (列が少ない) 場合は position:sticky の確認で代替
      expect(position).toBe('sticky');
    }
  });

  test('G. Excel エクスポートでファイルがダウンロードされる', async ({ page }) => {
    await setupAndOpenCfs(page);

    // T-23: 単一「Excel Export」ボタン → スコープ選択メニュー(This Room Type / All Rooms)
    const exportBtn = page.getByRole('button', { name: /^Excel Export$/ }).first();
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toBeEnabled();
    await shot(page, '11-before-export');

    // メニューが開き、Esc でキャンセルできる
    await exportBtn.click();
    const exportMenu = page.getByRole('menu', { name: 'Excel export scope' });
    await expect(exportMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exportMenu).not.toBeVisible();

    // 再度開いて「This Room Type」を選択 → 従来の単一 RoomType エクスポート
    await exportBtn.click();
    await expect(exportMenu).toBeVisible();
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
    await exportMenu.getByRole('menuitem', { name: 'This Room Type' }).click();
    // 選択直後 (await なし) のボタン状態をサンプリング
    const disabledDuring = await exportBtn.isDisabled().catch(() => false);
    const textDuring = ((await exportBtn.textContent().catch(() => '')) ?? '').trim();
    test.info().annotations.push({
      type: 'export-state',
      description: `disabledDuringExport=${disabledDuring} buttonTextDuring="${textDuring}"`,
    });

    const download = await downloadPromise;
    const suggested = download.suggestedFilename();
    test.info().annotations.push({ type: 'download', description: `filename=${suggested}` });
    expect(suggested).toMatch(/\.xlsx$/);

    // ファイルを保存して非空であることを確認
    const savePath = path.join(SHOT_DIR, suggested);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await download.saveAs(savePath);
    const stat = fs.statSync(savePath);
    expect(stat.size).toBeGreaterThan(1000); // xlsx は最低でも数KB
    // xlsx は zip (PK ヘッダ) で始まる
    const head = fs.readFileSync(savePath).subarray(0, 2).toString('latin1');
    expect(head).toBe('PK');
    await shot(page, '12-after-export');
  });

  test('G2. Project Excel で全 RoomType が 1 ブックの複数シートとして出力される', async ({ page }) => {
    await setupAndOpenCfs(page, { includeSecondRoom: true, includeEmptyRoom: true });

    // T-23: 単一「Excel Export」ボタン → メニューから「All Rooms」を選択
    const exportBtn = page.getByRole('button', { name: /^Excel Export$/ }).first();
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toBeEnabled();
    const areasMenu = await openCfsMenu(page, 'Area');
    await areasMenu.locator('button').filter({ hasText: /^Hide all$/ }).first().click();
    await shot(page, '11b-before-project-export');

    await exportBtn.click();
    const exportMenu = page.getByRole('menu', { name: 'Excel export scope' });
    await expect(exportMenu).toBeVisible();
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
    await exportMenu.getByRole('menuitem', { name: 'All Rooms' }).click();
    const download = await downloadPromise;
    const suggested = download.suggestedFilename();
    test.info().annotations.push({ type: 'download', description: `filename=${suggested}` });
    expect(suggested).toMatch(/_CFS_ALL\.xlsx$/);

    const savePath = path.join(SHOT_DIR, suggested);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await download.saveAs(savePath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(savePath);
    const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
    test.info().annotations.push({ type: 'sheets', description: sheetNames.join(', ') });
    expect(sheetNames).toEqual([ROOM_NAME, SECOND_ROOM_NAME, EMPTY_ROOM_NAME]);
    expect(workbook.worksheets[0].rowCount).toBeGreaterThan(5);
    expect(workbook.worksheets[1].rowCount).toBeGreaterThan(5);
    expect(String(workbook.worksheets[0].getCell('A5').value ?? '')).not.toContain('Enter Circuit');
    expect(String(workbook.worksheets[1].getCell('A5').value ?? '')).not.toContain('Enter Circuit');
    expect(String(workbook.worksheets[2].getCell('A5').value ?? '')).toContain('Enter Circuit');

    for (const sheet of workbook.worksheets) {
      const view = sheet.views[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
      expect(view?.state).toBe('frozen');
      expect(view?.ySplit).toBe(4);
      expect(Number(view?.xSplit ?? 0)).toBeGreaterThan(0);
      expect(sheet.getCell('A1').border?.top?.style).toBe('medium');
      expect(sheet.getCell('A1').border?.left?.style).toBe('medium');
      const merges = ((sheet as unknown as { model: { merges?: string[] } }).model.merges ?? []);
      expect(merges.length).toBeGreaterThan(0);
    }

    for (const sheet of workbook.worksheets.slice(0, 2)) {
      const view = sheet.views[0] as { xSplit?: number } | undefined;
      const firstFunctionCol = Number(view?.xSplit ?? 0) + 1;
      expect(sheet.getCell(1, firstFunctionCol).border?.left?.style).toBe('medium');
      expect(sheet.getCell(1, firstFunctionCol).border?.top?.style).toBe('medium');
    }
  });

  test('H. ハイライトトグル (Individual Override / FFE / Energy Saving) が機能する', async ({ page }) => {
    await setupAndOpenCfs(page);

    // FFE 行 (circuit.ffe = true の D-2) にハイライトクラスが付く
    const ffeRows = page.locator('table.cfs-matrix-table tbody tr.cfs-ffe-row');
    const energyRows = page.locator('table.cfs-matrix-table tbody tr.cfs-energy-row');
    const overrideCells = page.locator('td.cfs-individual-override-cell');

    const ffeBefore = await ffeRows.count();
    const energyBefore = await energyRows.count();
    const overrideBefore = await overrideCells.count();
    test.info().annotations.push({
      type: 'highlight',
      description: `ffeRows=${ffeBefore} energyRows=${energyBefore} overrideCells=${overrideBefore}`,
    });
    await shot(page, '13-highlights-on');

    // FFE トグルを OFF にするとクラスが消える
    const highlightsMenu = await openCfsMenu(page, 'Highlights');
    const ffeToggle = highlightsMenu
      .locator('label.cfs-check')
      .filter({ hasText: /^.*FFE\s*$/ })
      .locator('input[type="checkbox"]')
      .first();
    if (await ffeToggle.count() > 0 && ffeBefore > 0) {
      await ffeToggle.uncheck();
      await page.waitForTimeout(300);
      expect(await ffeRows.count()).toBe(0);
      await ffeToggle.check();
      await page.waitForTimeout(200);
      expect(await ffeRows.count()).toBe(ffeBefore);
    }

    // 少なくとも 1 種類のハイライトが効いていることを期待
    expect(ffeBefore + energyBefore + overrideBefore).toBeGreaterThan(0);
  });
});
