/**
 * T-32 + T-55: Device Assign の Low End / High End 列 回帰テスト
 *
 *  - 列は Zone / Address 列の左隣 (LINE/Group の後) に 2 列
 *  - 自動入力 (マスター初期値表示) は「zone に回路がアサインされている AND
 *    その回路の Dimming Type (Circuit タブの元値) が DALI / PWM / Phase の
 *    いずれか」の場合のみ (T-55)
 *  - 行 (zone) ごとに上書き入力でき、空にすると上書き解除 = マスター初期値に戻る
 *  - 全 On/Off の zone・回路未アサイン (Reserved) の zone は入力不可 (表示 "-")。
 *    未アサイン行に残っている既存上書き値は表示しないがデータは消えない
 *  - マスター (アプリ設定) は変更されない
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

test.setTimeout(120_000);

/**
 * QSN-4P20-D (マスター Low End=5 / High End=90) に PWM 回路 (designer "1") と
 * On/Off 回路 (designer "2") を割り当てた最小プロジェクト。
 */
function makeProject(projectId: string, projectName: string) {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: `${projectId}-area`, name: "Bedroom", number: "1", code: "BR" };
  const makeCircuit = (
    id: string,
    groupId: string,
    designer: string,
    dimmingType: string,
    fixture: string,
    pcs: string,
    detail: string,
  ) => ({
    id,
    circuitGroupId: groupId,
    daliFixtureGroupId: "",
    designerNumber: designer,
    internalNumber: designer,
    dimmingType,
    fixture,
    pcs,
    detail,
    area: bedroom.id,
    ffe: false,
    energySaving: false,
  });
  const makeAssignment = (
    suffix: string,
    zone: string,
    circuitNumber: string,
    extra: Record<string, string> = {},
  ) => ({
    id: `${projectId}-assignment-${suffix}`,
    deviceGroupId: `${projectId}-device-group-1`,
    device: "QSN-4P20-D",
    deviceNum: "1",
    zoneAddress: zone,
    circuitNumber,
    detail: "",
    group: "",
    ...extra,
  });
  const roomType = {
    ...createNewRoomType("RT-A"),
    id: `${projectId}-room-a`,
    name: "RT-A",
    updatedAt: now,
    circuitIds: [`${projectId}-circuit-1a`, `${projectId}-circuit-1b`, `${projectId}-circuit-2`],
    rows: [],
    deviceAssignments: [
      makeAssignment("zn1", "Zn1", "1"),
      makeAssignment("zn2", "Zn2", "2"),
      // T-55: 回路未アサイン (Reserved) の zone。過去に保存された上書き値
      // lowEnd=77 が残っているが、条件を満たさないので表示されないこと。
      makeAssignment("zn3", "Zn3", "Reserved", { lowEnd: "77" }),
    ],
  };
  return {
    id: projectId,
    name: projectName,
    updatedAt: now,
    locations: [bedroom, ...otherLocations],
    fixtures: [
      { id: "fixture-a", fixture: "FX-A", fixtureType: "DL", powerMode: "VA", watt: "10", powerFactor: "0.7" },
      { id: "fixture-b", fixture: "FX-B", fixtureType: "Indirect", powerMode: "W", watt: "7", powerFactor: "0.7" },
    ],
    circuits: [
      makeCircuit(`${projectId}-circuit-1a`, `${projectId}-cg-1`, "1", "PWM", "FX-A", "2", "Load PWM"),
      makeCircuit(`${projectId}-circuit-1b`, `${projectId}-cg-1`, "1", "PWM", "FX-B", "1", "Load PWM"),
      makeCircuit(`${projectId}-circuit-2`, `${projectId}-cg-2`, "2", "On/Off", "FX-A", "1", "Load OnOff"),
    ],
    roomTypes: [roomType],
  };
}

async function openProjectDeviceAssign(page: Page, projectName: string): Promise<void> {
  // リロード直後は sessionStorage 復元でプロジェクト詳細に入ることがあるため、
  // 常に一覧へ戻ってから開く (cfs_view_prefs.spec.ts と同じ決定的ナビゲーション)。
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
  await page.locator('[role="tab"]').filter({ hasText: /Device Assign/i }).first().click();
  await expect(
    page.locator(".scene-area-chip").filter({ hasText: /On\/Off/i }).first(),
  ).toBeVisible({ timeout: 8000 });
}

function zoneRow(page: Page, zone: string) {
  return page.locator("tbody tr").filter({ has: page.locator(".cell-readonly", { hasText: new RegExp(`^${zone}$`) }) }).first();
}

test.describe("T-32 Device Assign Low/High End 列", () => {
  test("列位置・マスター初期値・行上書き・空で初期値復帰・On/Off 行の入力不可", async ({ page }) => {
    mockState.projects = [makeProject("lh-proj", "LH-PROJ")];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProjectDeviceAssign(page, "LH-PROJ");

    // --- 列位置: Low End / High End は Zone / Address の直前 ---
    const headers = await page
      .locator("table.device-assign-table thead th")
      .evaluateAll((els) => els.map((el) => (el.textContent || "").trim()));
    const lowIndex = headers.indexOf("Low End");
    const highIndex = headers.indexOf("High End");
    const zoneIndex = headers.findIndex((text) => /Zone \/ Address/.test(text));
    expect(lowIndex).toBeGreaterThan(-1);
    expect(highIndex).toBe(lowIndex + 1);
    expect(zoneIndex).toBe(highIndex + 1);

    // --- Zn1 (PWM 回路): マスター初期値 5 / 90 が表示され編集可能 ---
    const zn1 = zoneRow(page, "Zn1");
    const zn1Low = zn1.locator('input[aria-label="Low End"]');
    const zn1High = zn1.locator('input[aria-label="High End"]');
    await expect(zn1Low).toHaveValue("5");
    await expect(zn1High).toHaveValue("90");
    await expect(zn1Low).toBeEnabled();

    // --- Zn2 (On/Off 回路): 入力なし・"-" 表示 ---
    const zn2 = zoneRow(page, "Zn2");
    await expect(zn2.locator('input[aria-label="Low End"]')).toHaveCount(0);
    await expect(zn2.locator('input[aria-label="High End"]')).toHaveCount(0);
    await expect(zn2.locator(".device-assign-end-na")).toHaveCount(2);

    // --- T-55: Zn3 (回路未アサイン Reserved): 入力なし・"-" 表示。
    //     既存の上書き値 77 も表示されない ---
    const zn3 = zoneRow(page, "Zn3");
    await expect(zn3.locator('input[aria-label="Low End"]')).toHaveCount(0);
    await expect(zn3.locator('input[aria-label="High End"]')).toHaveCount(0);
    await expect(zn3.locator(".device-assign-end-na")).toHaveCount(2);

    // --- 行上書き: Zn1 の Low End を 25 に ---
    await zn1Low.fill("25");
    await expect(zn1Low).toHaveValue("25");
    // ローカルモードの自動保存はドラフト (cfs-project-drafts-v2) へ 1200ms
    // デバウンスで書かれる。保存後のドラフト内容を直接検証する。
    const readDraftAssignments = async (): Promise<Array<Record<string, unknown>>> =>
      page.evaluate(() => {
        const raw = localStorage.getItem("cfs-project-drafts-v2");
        if (!raw) return [];
        const projects = JSON.parse(raw) as Array<{
          roomTypes?: Array<{ deviceAssignments?: Array<Record<string, unknown>> }>;
        }>;
        return projects[0]?.roomTypes?.[0]?.deviceAssignments ?? [];
      });
    await expect
      .poll(async () => (await readDraftAssignments()).find((a) => a.zoneAddress === "Zn1")?.lowEnd, {
        timeout: 8000,
      })
      .toBe("25");
    const savedAssignments = await readDraftAssignments();
    const savedZn1 = savedAssignments.find((a) => a.zoneAddress === "Zn1");
    const savedZn2 = savedAssignments.find((a) => a.zoneAddress === "Zn2");
    expect(savedZn1?.highEnd ?? undefined).toBeUndefined();
    expect(savedZn2?.lowEnd ?? undefined).toBeUndefined();
    // T-55: 表示されない Zn3 の既存上書き値は保存後も消えない (データ保持)
    const savedZn3 = savedAssignments.find((a) => a.zoneAddress === "Zn3");
    expect(savedZn3?.lowEnd).toBe("77");

    // 上書きはリロード後も残る (更新の新しいドラフトが復元される)
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjectDeviceAssign(page, "LH-PROJ");
    const zn1AfterReload = zoneRow(page, "Zn1");
    await expect(zn1AfterReload.locator('input[aria-label="Low End"]')).toHaveValue("25");
    // High End は上書きしていないのでマスター初期値のまま
    await expect(zn1AfterReload.locator('input[aria-label="High End"]')).toHaveValue("90");

    // --- 空にすると上書き解除 = マスター初期値 5 に戻る (空文字は保存しない) ---
    await zn1AfterReload.locator('input[aria-label="Low End"]').fill("");
    await expect(zn1AfterReload.locator('input[aria-label="Low End"]')).toHaveValue("5");
    await expect
      .poll(async () => {
        const cleared = (await readDraftAssignments()).find((a) => a.zoneAddress === "Zn1");
        return cleared ? "lowEnd" in cleared : "missing";
      }, { timeout: 8000 })
      .toBe(false);

    // --- マスター (アプリ設定) は変更されていない ---
    const settingsRaw = await page.evaluate(() => localStorage.getItem("cfs-app-settings-v3"));
    if (settingsRaw) {
      const settings = JSON.parse(settingsRaw) as { devices?: Array<{ model: string; lowEnd: string; highEnd: string }> };
      const master = settings.devices?.find((d) => d.model === "QSN-4P20-D");
      if (master) {
        expect(master.lowEnd).toBe("5");
        expect(master.highEnd).toBe("90");
      }
    }
  });
});
