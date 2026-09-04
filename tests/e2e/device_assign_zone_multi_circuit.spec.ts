/**
 * T-59/T-75: DeviceAssign 同一 Zn への複数回路アサイン (+ボタン、最大5回路) +
 * 編集可能 Detail (zoneDetail) の回帰テスト
 *
 *  - fixed (On/Off・調光) タブの照明 Zn のみ「+」で回路を追加できる (最大5回路、
 *    上限で + 非表示)。Reserved 行には + が出ない
 *  - T-75 レイアウト: 追加回路あり時は Circuit# セル1行目に全回路の「 & 」連結
 *    サマリー (読み取り専用、右に + ボタン)、Detail セル1行目に編集用 zoneDetail、
 *    2行目以降に各回路のアサイン行と各回路 Detail (読み取り専用)
 *  - T-89: 回路追加時に zoneDetail は自動セットしない (旧仕様②の廃止)。空の
 *    まま「 / 」連結のライブ値が表示に使われ、ユーザー入力時のみ固定値になる。
 *    スタック1行目 (回路1 Detail) と CFS は circuit master のライブ参照で、
 *    Circuit タブの Detail 変更に即追従する
 *  - 追加回路を全て外すと additionalCircuitNumbers / zoneDetail がデータから
 *    消えて従来表示へ戻る (仕様③)。Clear でも同時クリア
 *  - Designer#/Internal# トグルで additionalCircuitNumbers も一括変換
 *  - CFS: Detail は zoneDetail 1本、Designer# は「1 & 3」連結 (T-75 で
 *    スペース入り「 & 」に変更)、Total VA は全回路合算、Low/High End は
 *    追加回路の型も判定に算入 (仕様④⑦ + T-55 整合)
 *  - Area Scene: 複数回路 Zn は1行に統合 (表示名=zoneDetail)。値は全回路の
 *    circuitId へ同時書き込み (仕様⑥)
 *  - T-88: zoneDetail 空白時のフォールバックは「全アサイン回路の Detail を
 *    『 / 』(前後半角スペース)で連結」。Detail 空の回路はスキップ、全回路
 *    空なら従来の空欄。zoneDetail 入力時は入力値が優先(不変)
 *
 * データ保護: installLocalEditingMocks で /api/projects を全モック。
 */
import { expect, test, type Page } from "@playwright/test";
import { createDefaultLocations, createNewRoomType } from "../../app/lib/constants";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;

let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

test.setTimeout(180_000);

interface MakeProjectOptions {
  zn1Extra?: Record<string, unknown>;
  scenes?: Array<Record<string, unknown>>;
}

/**
 * QSN-4P20-D に PWM 回路 "1" (20VA) と On/Off 回路 "2" を割当。
 * 追加候補: "3" (PWM 10VA) / "4" / "5" / "6" (On/Off 10VA)。
 * internalNumber は "10x" 形式でトグル変換を検証できるようにする。
 */
function makeProject(projectId: string, projectName: string, options: MakeProjectOptions = {}) {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: `${projectId}-area`, name: "Bedroom", number: "1", code: "BR" };
  const makeCircuit = (
    designer: string,
    dimmingType: string,
    pcs: string,
    detail: string,
  ) => ({
    id: `${projectId}-circuit-${designer}`,
    circuitGroupId: `${projectId}-cg-${designer}`,
    daliFixtureGroupId: "",
    designerNumber: designer,
    internalNumber: `10${designer}`,
    dimmingType,
    fixture: "FX-A",
    pcs,
    detail,
    area: bedroom.id,
    ffe: false,
    energySaving: false,
  });
  const circuits = [
    makeCircuit("1", "PWM", "2", "Load One"),
    makeCircuit("2", "On/Off", "1", "Load Two"),
    makeCircuit("3", "PWM", "1", "Load Three"),
    makeCircuit("4", "On/Off", "1", "Load Four"),
    makeCircuit("5", "On/Off", "1", "Load Five"),
    makeCircuit("6", "On/Off", "1", "Load Six"),
  ];
  const makeAssignment = (
    suffix: string,
    zone: string,
    circuitNumber: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `${projectId}-assignment-${suffix}`,
    deviceGroupId: `${projectId}-device-group-1`,
    device: "QSN-4P20-D",
    deviceNum: "1",
    zoneAddress: zone,
    circuitNumber,
    detail: circuitNumber === "1" ? "Load One" : circuitNumber === "2" ? "Load Two" : "",
    group: "",
    ...extra,
  });
  const roomType = {
    ...createNewRoomType("RT-A"),
    id: `${projectId}-room-a`,
    name: "RT-A",
    updatedAt: now,
    circuitIds: circuits.map((circuit) => circuit.id),
    rows: [],
    scenes: options.scenes ?? [],
    deviceAssignments: [
      makeAssignment("zn1", "Zn1", "1", options.zn1Extra ?? {}),
      makeAssignment("zn2", "Zn2", "2"),
      makeAssignment("zn3", "Zn3", "Reserved"),
    ],
  };
  return {
    id: projectId,
    name: projectName,
    updatedAt: now,
    locations: [bedroom, ...otherLocations],
    fixtures: [
      { id: "fixture-a", fixture: "FX-A", fixtureType: "DL", powerMode: "VA", watt: "10", powerFactor: "0.7" },
    ],
    circuits,
    roomTypes: [roomType],
  };
}

async function openRoomTypeTab(page: Page, projectName: string, tabPattern: RegExp): Promise<void> {
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
  await page.locator('[role="tab"]').filter({ hasText: tabPattern }).first().click();
}

async function openDeviceAssign(page: Page, projectName: string): Promise<void> {
  await openRoomTypeTab(page, projectName, /Device Assign/i);
  await expect(
    page.locator(".scene-area-chip").filter({ hasText: /On\/Off/i }).first(),
  ).toBeVisible({ timeout: 8000 });
}

function zoneRow(page: Page, zone: string) {
  return page
    .locator("tbody tr")
    .filter({ has: page.locator(".cell-readonly", { hasText: new RegExp(`^${zone}$`) }) })
    .first();
}

function readDraftAssignments(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("cfs-project-drafts-v2");
    if (!raw) return [];
    const projects = JSON.parse(raw) as Array<{
      roomTypes?: Array<{ deviceAssignments?: Array<Record<string, unknown>> }>;
    }>;
    return projects[0]?.roomTypes?.[0]?.deviceAssignments ?? [];
  });
}

async function draftZn1(page: Page): Promise<Record<string, unknown> | undefined> {
  return (await readDraftAssignments(page)).find((a) => a.zoneAddress === "Zn1");
}

async function addZoneCircuit(page: Page, zone: string, value: string): Promise<void> {
  const row = zoneRow(page, zone);
  await row.locator(".btn-add-zone-circuit").click();
  const pendingInput = row.locator(".zone-extra-circuit .combobox-input").last();
  await pendingInput.fill(value);
  await pendingInput.press("Enter");
}

test.describe("T-59 同一 Zn への複数回路アサイン", () => {
  test("A. +ボタン追加・上限5回路・zoneDetail 初期化/編集・解除/Clear・トグル変換", async ({ page }) => {
    mockState.projects = [makeProject("zn-multi", "ZN-MULTI")];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openDeviceAssign(page, "ZN-MULTI");

    const zn1 = zoneRow(page, "Zn1");
    const zn3 = zoneRow(page, "Zn3");

    // --- + は回路アサイン済みの Zn1 に出る。Reserved の Zn3 には出ない ---
    await expect(zn1.locator(".btn-add-zone-circuit")).toBeVisible();
    await expect(zn3.locator(".btn-add-zone-circuit")).toHaveCount(0);

    // --- 追加1本目: "3" → 保存。T-89: zoneDetail は自動セットしない (旧仕様②廃止) ---
    await addZoneCircuit(page, "Zn1", "3");
    await expect(zn1.locator(".zone-extra-circuit .combobox-input").first()).toHaveValue("3");
    await expect
      .poll(async () => (await draftZn1(page))?.additionalCircuitNumbers, { timeout: 8000 })
      .toEqual(["3"]);
    expect("zoneDetail" in ((await draftZn1(page)) ?? {})).toBe(false);

    // --- T-75: 1行目=「 & 」連結サマリー (読み取り専用) + 右に + ボタン ---
    const summary = zn1.locator(".zone-circuit-summary");
    await expect(summary.locator(".zone-circuit-summary-text")).toHaveText("1 & 3");
    await expect(zn1.locator(".circuit-cell-stack > div").first()).toHaveClass(/zone-circuit-summary/);
    await expect(summary.locator(".btn-add-zone-circuit")).toBeVisible();

    // --- T-75: Detail セルは1行目が編集用 zoneDetail、2行目以降が各回路 Detail ---
    // T-89: 編集用 zoneDetail は空のまま (自動コピーなし)
    const zoneDetailInput = zn1.locator(".zone-detail-edit textarea");
    await expect(zn1.locator(".zone-detail-stack > div").first()).toHaveClass(/zone-detail-edit/);
    await expect(zoneDetailInput).toHaveValue("");
    await expect(zn1.locator(".zone-detail-line .cell-readonly").nth(0)).toHaveText("Load One");
    await expect(zn1.locator(".zone-detail-line .cell-readonly").nth(1)).toHaveText("Load Three");

    // --- T-75: Clear と − のボタンサイズ一致 + アサイン行の Combobox 左端揃え ---
    const clearBox = await zn1
      .locator(".zone-assign-line .btn-clear-circuit", { hasText: "Clear" })
      .first()
      .boundingBox();
    const minusBox = await zn1
      .locator('.zone-extra-circuit button[aria-label="Remove additional circuit"]')
      .first()
      .boundingBox();
    expect(clearBox && minusBox && Math.abs(clearBox.width - minusBox.width) <= 1).toBe(true);
    expect(clearBox && minusBox && Math.abs(clearBox.height - minusBox.height) <= 1).toBe(true);
    const primaryInputBox = await zn1
      .locator(".zone-assign-line .combobox-input")
      .first()
      .boundingBox();
    const extraInputBox = await zn1
      .locator(".zone-extra-circuit .combobox-input")
      .first()
      .boundingBox();
    expect(
      primaryInputBox && extraInputBox && Math.abs(primaryInputBox.x - extraInputBox.x) <= 1,
    ).toBe(true);

    await zoneDetailInput.fill("Zone Combined");
    await expect
      .poll(async () => (await draftZn1(page))?.zoneDetail, { timeout: 8000 })
      .toBe("Zone Combined");

    // --- 上限: 4本追加 (合計5回路) で + 非表示 (仕様①) ---
    await addZoneCircuit(page, "Zn1", "4");
    await addZoneCircuit(page, "Zn1", "5");
    await addZoneCircuit(page, "Zn1", "6");
    await expect(zn1.locator(".zone-extra-circuit")).toHaveCount(4);
    await expect(zn1.locator(".btn-add-zone-circuit")).toHaveCount(0);
    // T-75: サマリーはアサイン順の「 & 」連結 (& の前後に半角スペース)
    await expect(zn1.locator(".zone-circuit-summary-text")).toHaveText("1 & 3 & 4 & 5 & 6");
    await expect
      .poll(async () => (await draftZn1(page))?.additionalCircuitNumbers, { timeout: 8000 })
      .toEqual(["3", "4", "5", "6"]);

    // --- Designer#/Internal# トグルで追加回路も一括変換 (必須注意) ---
    await page.locator("button.header-toggle").filter({ hasText: /Designer#/ }).click();
    await expect
      .poll(async () => (await draftZn1(page))?.additionalCircuitNumbers, { timeout: 8000 })
      .toEqual(["103", "104", "105", "106"]);
    expect((await draftZn1(page))?.circuitNumber).toBe("101");
    await page.locator("button.header-toggle").filter({ hasText: /Internal#/ }).click();
    await expect
      .poll(async () => (await draftZn1(page))?.additionalCircuitNumbers, { timeout: 8000 })
      .toEqual(["3", "4", "5", "6"]);

    // --- − で全て外すと zoneDetail ごと消えて従来表示へ (仕様③) ---
    for (let i = 0; i < 4; i += 1) {
      await zoneRow(page, "Zn1")
        .locator('.zone-extra-circuit button[aria-label="Remove additional circuit"]')
        .first()
        .click();
    }
    await expect(zoneRow(page, "Zn1").locator(".zone-extra-circuit")).toHaveCount(0);
    await expect
      .poll(async () => {
        const draft = await draftZn1(page);
        if (!draft) return "missing";
        return `${"additionalCircuitNumbers" in draft}/${"zoneDetail" in draft}`;
      }, { timeout: 8000 })
      .toBe("false/false");
    await expect(zoneRow(page, "Zn1").locator(".zone-detail-stack")).toHaveCount(0);

    // --- Clear で追加回路 + zoneDetail が同時に消える (必須注意) ---
    await addZoneCircuit(page, "Zn1", "3");
    await expect
      .poll(async () => (await draftZn1(page))?.additionalCircuitNumbers, { timeout: 8000 })
      .toEqual(["3"]);
    await zoneRow(page, "Zn1")
      .locator(".circuit-cell .btn-clear-circuit", { hasText: "Clear" })
      .first()
      .click();
    await expect
      .poll(async () => {
        const draft = await draftZn1(page);
        if (!draft) return "missing";
        return `${draft.circuitNumber}/${"additionalCircuitNumbers" in draft}/${"zoneDetail" in draft}`;
      }, { timeout: 8000 })
      .toBe("Reserved/false/false");
  });

  test("B. CFS: Designer# の & 連結・Detail=zoneDetail 1本・Total VA 合算・Low/High End 整合", async ({ page }) => {
    mockState.projects = [
      makeProject("zn-cfs", "ZN-CFS", {
        zn1Extra: { additionalCircuitNumbers: ["3"], zoneDetail: "Zone Combined" },
      }),
    ];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openRoomTypeTab(page, "ZN-CFS", /^CFS$/);
    await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });

    const zn1 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn1" }).first();
    // Designer# は「1 & 3」連結 (仕様⑦ + T-75 スペース入り)
    await expect(zn1.locator("td.cfs-base-designerNumber")).toHaveText("1 & 3");
    // Detail は zoneDetail 1本 (仕様⑦)
    await expect(zn1.locator("td.cfs-base-detail")).toHaveText("Zone Combined");
    // Total VA は 回路1 (2pcs x 10VA=20) + 回路3 (1pcs x 10VA=10) の合算 (仕様④)
    await expect(zn1.locator("td.cfs-base-totalVa")).toHaveText("30");
    // Low/High End: PWM を含むので値が出る (T-55 整合)
    await expect(zn1.locator("td.cfs-base-zoneLowEnd")).toHaveText("5");
    await expect(zn1.locator("td.cfs-base-zoneHighEnd")).toHaveText("90");

    // 単一回路 Zn2 は従来どおり (保護挙動)
    const zn2 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn2" }).first();
    await expect(zn2.locator("td.cfs-base-designerNumber")).toHaveText("2");
    await expect(zn2.locator("td.cfs-base-detail")).toHaveText("Load Two");
    await expect(zn2.locator("td.cfs-base-totalVa")).toHaveText("10");
  });

  test("C. Area Scene: 複数回路 Zn は zoneDetail の1行に統合され、値は全回路へ同時書き込み", async ({ page }) => {
    mockState.projects = [
      makeProject("zn-scene", "ZN-SCENE", {
        zn1Extra: { additionalCircuitNumbers: ["3"], zoneDetail: "Zone Combined" },
        scenes: [
          { id: "zn-scene-s1", areaId: "zn-scene-area", name: "S1", settings: [] },
        ],
      }),
    ];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openRoomTypeTab(page, "ZN-SCENE", /Area Scene/i);

    // 統合行 (primary 回路 id) が zoneDetail 表示で1行だけ。回路 "3" の
    // 単独行 (Load Three) は消える (仕様⑥)
    const mergedRow = page.locator('tr[data-scene-circuit-id="zn-scene-circuit-1"]');
    await expect(mergedRow).toHaveCount(1);
    await expect(mergedRow.locator(".cell-readonly").filter({ hasText: "Zone Combined" })).toHaveCount(1);
    await expect(page.locator('tr[data-scene-circuit-id="zn-scene-circuit-3"]')).toHaveCount(0);
    await expect(page.locator("tbody").filter({ hasText: "Load Three" })).toHaveCount(0);

    // 統合行への入力が両回路の SceneCircuitSetting に書き込まれる (仕様⑥)
    await mergedRow.locator(".scene-level-input").fill("50");
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const raw = localStorage.getItem("cfs-project-drafts-v2");
          if (!raw) return "no-draft";
          const projects = JSON.parse(raw) as Array<{
            roomTypes?: Array<{ scenes?: Array<{ id: string; settings: Array<{ circuitId: string; percentage: string }> }> }>;
          }>;
          const scene = projects[0]?.roomTypes?.[0]?.scenes?.find((s) => s.id === "zn-scene-s1");
          if (!scene) return "no-scene";
          const value = (circuitId: string) =>
            scene.settings.find((setting) => setting.circuitId === circuitId)?.percentage ?? "";
          return `${value("zn-scene-circuit-1")}/${value("zn-scene-circuit-3")}`;
        });
      }, { timeout: 8000 })
      .toBe("50/50");
  });

  test("D. T-88: zoneDetail 空白時は全回路 Detail の「 / 」連結(空 Detail 回路はスキップ、全空は空欄)", async ({ page }) => {
    // 回路1 "Load One" + 追加回路3 "Load Three" + 追加回路4 (Detail 空 → スキップ)
    const joinProject = makeProject("zn-join", "ZN-JOIN", {
      zn1Extra: { additionalCircuitNumbers: ["3", "4"] },
      scenes: [
        { id: "zn-join-s1", areaId: "zn-join-area", name: "S1", settings: [] },
      ],
    });
    const circuit4 = joinProject.circuits.find((circuit) => circuit.designerNumber === "4");
    if (circuit4) circuit4.detail = "";
    // 全回路 Detail 空のケース: 従来どおり空欄 (「 / 」を出さない)
    const emptyProject = makeProject("zn-empty", "ZN-EMPTY", {
      zn1Extra: { additionalCircuitNumbers: ["3"], detail: "" },
    });
    for (const circuit of emptyProject.circuits) circuit.detail = "";
    mockState.projects = [joinProject, emptyProject];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openRoomTypeTab(page, "ZN-JOIN", /^CFS$/);
    await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });

    const zn1 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn1" }).first();
    await expect(zn1.locator("td.cfs-base-designerNumber")).toHaveText("1 & 3 & 4");
    // zoneDetail 空白: 全アサイン回路の Detail を「 / 」連結。Detail 空の回路4はスキップ
    await expect(zn1.locator("td.cfs-base-detail")).toHaveText("Load One / Load Three");
    // 単一回路 Zn2 は従来どおり (保護挙動)
    const zn2 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn2" }).first();
    await expect(zn2.locator("td.cfs-base-detail")).toHaveText("Load Two");

    // Area Scene 統合行の項目名も同じ連結 (二重連結「... / Load Three / Load Three」を出さない)
    await openRoomTypeTab(page, "ZN-JOIN", /Area Scene/i);
    const mergedRow = page.locator('tr[data-scene-circuit-id="zn-join-circuit-1"]');
    await expect(mergedRow).toHaveCount(1);
    await expect(
      mergedRow.locator(".cell-readonly").filter({ hasText: /^Load One \/ Load Three$/ }),
    ).toHaveCount(1);

    // 全回路 Detail 空: 連結は空文字となり、従来どおり下流の既存フォールバック
    // (cfsBaseColumnValues: detail 空 → designerNumber 表示) が働く。T-88 前と
    // 同一表示で「 / 」は出さない
    await openRoomTypeTab(page, "ZN-EMPTY", /^CFS$/);
    await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
    const emptyZn1 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn1" }).first();
    await expect(emptyZn1.locator("td.cfs-base-designerNumber")).toHaveText("1 & 3");
    await expect(emptyZn1.locator("td.cfs-base-detail")).toHaveText("1 & 3");
    await expect(emptyZn1.locator("td.cfs-base-detail")).not.toContainText("/");
  });

  test("E. T-89: Circuit タブの Detail 変更が複数回路 Zn のスタック1行目と CFS 連結へ即追従(単一 Zn は不変)", async ({ page }) => {
    mockState.projects = [
      makeProject("zn-live", "ZN-LIVE", {
        zn1Extra: { additionalCircuitNumbers: ["3"] },
      }),
    ];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openDeviceAssign(page, "ZN-LIVE");

    // T-89: zoneDetail 自動コピーなし → 編集欄は空、スタックは circuit master のライブ値
    const zn1 = zoneRow(page, "Zn1");
    await expect(zn1.locator(".zone-detail-edit textarea")).toHaveValue("");
    await expect(zn1.locator(".zone-detail-line .cell-readonly").nth(0)).toHaveText("Load One");
    await expect(zn1.locator(".zone-detail-line .cell-readonly").nth(1)).toHaveText("Load Three");

    // Circuit タブで回路1の Detail を "Load One" → "B" に変更
    await page.locator('[role="tab"]').filter({ hasText: /^Circuit$/ }).first().click();
    const circuit1Detail = page.getByRole("textbox", { name: "Detail", exact: true }).first();
    await expect(circuit1Detail).toHaveValue("Load One");
    await circuit1Detail.fill("B");
    await page.keyboard.press("Tab");

    // Device Assign: スタック1行目が即追従、zoneDetail は空のまま、
    // sync で assignment.detail(保存値)も circuit master に追従(sync 漏れ修正)
    await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
    const zn1After = zoneRow(page, "Zn1");
    await expect(zn1After.locator(".zone-detail-line .cell-readonly").nth(0)).toHaveText("B");
    await expect(zn1After.locator(".zone-detail-line .cell-readonly").nth(1)).toHaveText("Load Three");
    await expect(zn1After.locator(".zone-detail-edit textarea")).toHaveValue("");
    await expect
      .poll(async () => (await draftZn1(page))?.detail, { timeout: 8000 })
      .toBe("B");
    expect("zoneDetail" in ((await draftZn1(page)) ?? {})).toBe(false);

    // 単一回路 Zn2 の Device Assign Detail は既存仕様のまま(assignment 側の値が優先)
    const zn2 = zoneRow(page, "Zn2");
    await expect(zn2.locator(".cell-with-clear textarea").first()).toHaveValue("Load Two");

    // CFS: 連結値も即追従(旧値 "Load One" が残らない)。単一 Zn2 は不変
    await page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first().click();
    await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
    const cfsZn1 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn1" }).first();
    await expect(cfsZn1.locator("td.cfs-base-detail")).toHaveText("B / Load Three");
    const cfsZn2 = page.locator("table.cfs-matrix-table tbody tr").filter({ hasText: "Zn2" }).first();
    await expect(cfsZn2.locator("td.cfs-base-detail")).toHaveText("Load Two");
  });
});
