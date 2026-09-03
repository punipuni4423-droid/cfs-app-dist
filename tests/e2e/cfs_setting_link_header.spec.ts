/**
 * T-60: CFS "Link" toolbar button + link-extraction panel + per-group
 * vertical column highlight lines. (Replaces the T-58 Display-menu toggle +
 * header band spec.)
 * T-61: (a) the lines start at the BUTTON-NAME header row — the SW-group
 * band and the Scene/Command category band (header row 1) stay clear of
 * them; (b) the panel gains a "Show icons" checkbox that toggles the 🔗
 * badges (default ON), independent of the per-group line checkboxes.
 * T-62: every panel text is English and the Switch tab identifies linked
 * rows by the Setting button text ("Link <symbol>") instead of the removed
 * checkbox-cell badge.
 * T-65 (design option 3, T-63): the CFS header badge and the panel's
 * swatch+symbol row are replaced by a "Link <symbol>" text pill — the exact
 * Switch tab wording — filled with the shared group color (white text). The
 * header pill sits centered UNDER the button name; while labels are shown
 * the button-name row gains uniform bottom padding, and hiding them via the
 * renamed "Show labels" checkbox restores the compact height.
 *
 *  - Toolbar gets a "Link" button right of "Highlights". Its panel lists the
 *    current room type's setting-link groups in symbol order (A, B, ...)
 *    with a "Link <symbol>" pill + members ("switch name − button name") +
 *    per-group checkbox, plus Select All / Clear. Empty state: "No links".
 *  - Checked groups paint vertical highlight lines on BOTH edges of their
 *    member columns from the top of the button-name header row (row 2) down
 *    to the last body row; header row 1 renders no line spans, and the line
 *    top edge must sit within ±2px of the button-name row top.
 *    Colors MUST equal the Switch tab group colors (shared palette
 *    app/lib/settingLinkGroups.ts, first-appearance order).
 *  - The CFS header "Link <symbol>" label is shown by default; the
 *    "Show labels" checkbox hides every label without touching the lines,
 *    persists per project in v2 prefs as hideSettingLinkBadges (field name
 *    kept from T-61 for compatibility; missing field = shown), and is
 *    independent of the group checkboxes / Select All / Clear.
 *  - Selection persists per project in cfs-view-preferences-v2 as the
 *    HIDDEN group set (hiddenSettingLinkGroups) so new groups default to
 *    visible. The old Display menu no longer has a "Link" item.
 *  - Display only: sticky base columns and the Excel export are untouched;
 *    every button-head cell keeps one identical height (taller only while
 *    labels are shown).
 *
 * データ保護: installLocalEditingMocks で /api/projects を全モック。
 */
import { expect, test, type Page } from "@playwright/test";
import { createDefaultLocations, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { SETTING_LINK_COLORS } from "../../app/lib/settingLinkGroups";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

type LocalEditingMockState = Awaited<ReturnType<typeof installLocalEditingMocks>>;
let mockState: LocalEditingMockState;

test.beforeEach(async ({ page }) => {
  mockState = await installLocalEditingMocks(page);
});

test.setTimeout(180_000);

function makeSwitch(
  id: string,
  switchNumber: string,
  switchName: string,
  settingLinkGroupId?: string,
) {
  return {
    ...createEmptySwitchEntry("lutronPd"),
    id,
    switchGroupId: `${id}-group`,
    switchNumber,
    switchName,
    buttonLabel: "B1",
    ...(settingLinkGroupId ? { settingLinkGroupId } : {}),
  };
}

/** SW1+SW2 link group a / SW3+SW4 link group b / SW5 unlinked. */
function makeProject(projectId: string, projectName: string, options?: { unlinked?: boolean }) {
  const now = new Date().toISOString();
  const [defaultBedroom, ...otherLocations] = createDefaultLocations();
  const bedroom = { ...defaultBedroom, id: `${projectId}-area`, name: "Bedroom", number: "1", code: "BR" };
  const roomType = {
    ...createNewRoomType("RT-A"),
    id: `${projectId}-room-a`,
    name: "RT-A",
    updatedAt: now,
    circuitIds: [`${projectId}-circuit-1`],
    rows: [],
    deviceAssignments: [
      {
        id: `${projectId}-assignment-zn1`,
        deviceGroupId: `${projectId}-device-group-1`,
        device: "QSN-4P20-D",
        deviceNum: "1",
        zoneAddress: "Zn1",
        circuitNumber: "1",
        detail: "",
        group: "",
      },
    ],
    switches: options?.unlinked
      ? [makeSwitch(`${projectId}-sw1`, "1", "PD-1"), makeSwitch(`${projectId}-sw2`, "2", "PD-2")]
      : [
          makeSwitch(`${projectId}-sw1`, "1", "PD-1", `${projectId}-link-a`),
          makeSwitch(`${projectId}-sw2`, "2", "PD-2", `${projectId}-link-a`),
          makeSwitch(`${projectId}-sw3`, "3", "PD-3", `${projectId}-link-b`),
          makeSwitch(`${projectId}-sw4`, "4", "PD-4", `${projectId}-link-b`),
          makeSwitch(`${projectId}-sw5`, "5", "PD-5"),
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
    circuits: [
      {
        id: `${projectId}-circuit-1`,
        circuitGroupId: `${projectId}-cg-1`,
        daliFixtureGroupId: "",
        designerNumber: "1",
        internalNumber: "1",
        dimmingType: "PWM",
        fixture: "FX-A",
        pcs: "2",
        detail: "Load PWM",
        area: bedroom.id,
        ffe: false,
        energySaving: false,
      },
    ],
    roomTypes: [roomType],
  };
}

async function openProject(page: Page, projectName: string): Promise<void> {
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
}

async function openCfsTab(page: Page): Promise<void> {
  const cfsTab = page.locator('[role="tab"]').filter({ hasText: /^CFS$/ }).first();
  await expect(cfsTab).toBeVisible({ timeout: 8000 });
  await cfsTab.click();
  await expect(page.locator("table.cfs-matrix-table")).toBeVisible({ timeout: 8000 });
}

function hexToRgb(hex: string): string {
  const num = parseInt(hex.replace("#", ""), 16);
  return `rgb(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255})`;
}

/**
 * Switch tab group color per group symbol (A, B, ...).
 *
 * T-62 removed the checkbox-cell 🔗 badge, so the symbols are read from the
 * Setting button text ("Link A" in first-appearance order) and the colors
 * come from the shared palette module both screens import
 * (app/lib/settingLinkGroups.ts). While here, assert the badge stays gone.
 */
async function switchTabGroupColors(page: Page): Promise<Record<string, string>> {
  await page.locator('[role="tab"]').filter({ hasText: /^Switch$/ }).first().click();
  const palladiomChip = page.locator('.scene-area-chip:has-text("Palladiom")').first();
  if (await palladiomChip.isVisible({ timeout: 2500 }).catch(() => false)) {
    await palladiomChip.click();
  }
  await expect(
    page.locator("table.switch-table .setting-status-button").filter({ hasText: /^Link\s/ }).first(),
  ).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".switch-setting-link-badge")).toHaveCount(0);
  const texts = await page
    .locator("table.switch-table tbody .setting-status-button")
    .allTextContents();
  const symbols: string[] = [];
  for (const text of texts) {
    const matched = text.trim().match(/^Link ([A-Z][0-9]*)/);
    if (matched && !symbols.includes(matched[1])) symbols.push(matched[1]);
  }
  const out: Record<string, string> = {};
  symbols.forEach((symbol, index) => {
    out[symbol] = hexToRgb(SETTING_LINK_COLORS[index % SETTING_LINK_COLORS.length]);
  });
  return out;
}

function menuTrigger(page: Page, label: string) {
  return page
    .locator(".cfs-matrix-controls .cfs-filter-menu-trigger")
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .first();
}

async function openLinkPanel(page: Page) {
  const trigger = menuTrigger(page, "Link");
  await expect(trigger).toBeVisible({ timeout: 5000 });
  await trigger.click();
  const panel = page.locator(".cfs-filter-list-portal").last();
  await expect(panel).toBeVisible({ timeout: 3000 });
  return panel;
}

/** Toggles group by panel position (groups are listed in symbol order). */
async function setGroupChecked(page: Page, groupIndex: number, checked: boolean): Promise<void> {
  const panel = await openLinkPanel(page);
  const checkbox = panel.locator(".cfs-link-menu-group input[type=checkbox]").nth(groupIndex);
  await expect(checkbox).toBeVisible({ timeout: 3000 });
  if (checked) await checkbox.check();
  else await checkbox.uncheck();
  await page.keyboard.press("Escape");
}

const LINE = "table.cfs-matrix-table .cfs-link-col-line";
// T-65: the header mark is the "Link <symbol>" text pill (was the 🔗 badge
// .cfs-header-link-badge before T-65).
const BADGE = "table.cfs-matrix-table thead .cfs-header-link-label";

/** Distinct backgroundColors of the currently rendered link lines. */
async function lineColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const colors = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("table.cfs-matrix-table .cfs-link-col-line"))) {
      colors.add(getComputedStyle(el).backgroundColor);
    }
    return Array.from(colors);
  });
}

test.describe("T-60 CFS Link button + panel + column highlight lines", () => {
  test("Link button right of Highlights; lines start at the button-name row (T-61) with Switch-tab colors; label on by default; no Display Link item", async ({ page }) => {
    mockState.projects = [makeProject("t60a", "T60-LINK-A")];
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openProject(page, "T60-LINK-A");

    // Reference: Switch tab group colors (source of truth since T-35;
    // T-62 reads them via the shared palette + "Link A" button symbols).
    const switchColors = await switchTabGroupColors(page);
    expect(Object.keys(switchColors)).toEqual(["A", "B"]);
    expect(switchColors.A).toBeTruthy();
    expect(switchColors.B).toBeTruthy();
    expect(switchColors.A).not.toBe(switchColors.B);

    await openCfsTab(page);

    // (1) Link trigger exists and sits immediately right of Highlights.
    const highlightsBox = await menuTrigger(page, "Highlights").boundingBox();
    const linkBox = await menuTrigger(page, "Link").boundingBox();
    expect(highlightsBox).toBeTruthy();
    expect(linkBox).toBeTruthy();
    expect(linkBox!.x).toBeGreaterThan(highlightsBox!.x);
    // Visual order (row-aware: the toolbar can wrap onto multiple lines).
    const triggerOrder = await page
      .locator(".cfs-matrix-controls .cfs-filter-menu-trigger")
      .evaluateAll((els) =>
        els
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return { label: (el.textContent || "").trim(), x: rect.x, y: rect.y };
          })
          .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x))
          .map((item) => item.label),
      );
    expect(triggerOrder.indexOf("Link")).toBe(triggerOrder.indexOf("Highlights") + 1);

    // (3) Display menu no longer contains a "Link" checkbox.
    await menuTrigger(page, "Display").click();
    const displayPanel = page.locator(".cfs-filter-list-portal").last();
    await expect(displayPanel).toBeVisible({ timeout: 3000 });
    await expect(displayPanel.locator("label.cfs-check").filter({ hasText: /^Link$/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // (4) T-65 header labels: 4 linked button headers carry a "Link <symbol>"
    // pill whose wording matches the Switch tab Setting buttons exactly and
    // whose fill color is the shared group color (white text).
    await expect(page.locator(BADGE)).toHaveCount(4);
    const labelFills = await page
      .locator(BADGE)
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(labelFills).toEqual([switchColors.A, switchColors.A, switchColors.B, switchColors.B]);
    const labelTexts = await page
      .locator(BADGE)
      .evaluateAll((els) => els.map((el) => (el.textContent || "").trim()));
    expect(labelTexts).toEqual(["Link A", "Link A", "Link B", "Link B"]);
    const labelTextColors = await page
      .locator(BADGE)
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    expect(new Set(labelTextColors)).toEqual(new Set(["rgb(255, 255, 255)"]));

    // (2) Default = every group checked -> lines present with EXACTLY the
    // Switch tab colors. SW1+SW2 (group A) and SW3+SW4 (group B) are adjacent
    // runs, so each run paints 1 left + 1 right line per covered row.
    const colors = await lineColors(page);
    expect(colors.sort()).toEqual([switchColors.A, switchColors.B].sort());

    // T-61: lines run from the BUTTON-NAME header row (row 2) to the last
    // body row. Header row 1 (SW group band + Scene/Command category band)
    // carries NO line spans; rows 2-4 and every body row carry spans for
    // both runs (2 runs x left+right = 4 spans per covered row).
    const coverage = await page.evaluate(() => {
      const table = document.querySelector("table.cfs-matrix-table");
      if (!table) return null;
      const headRows = Array.from(table.querySelectorAll("thead tr")).map(
        (tr) => tr.querySelectorAll(".cfs-link-col-line").length,
      );
      const bodyRows = Array.from(table.querySelectorAll("tbody tr:not(.cfs-scroll-end-row)")).map(
        (tr) => tr.querySelectorAll(".cfs-link-col-line").length,
      );
      return { headRows, bodyRows };
    });
    expect(coverage).toBeTruthy();
    expect(coverage!.headRows).toEqual([0, 4, 4, 4]);
    expect(coverage!.bodyRows.length).toBeGreaterThan(0);
    for (const count of coverage!.bodyRows) {
      expect(count).toBe(4);
    }

    // T-61 machine check: every line's TOP edge sits within ±2px of the
    // button-name row's top edge, i.e. clearly below the SW-group /
    // category band (row 1) instead of overlapping it.
    const topEdge = await page.evaluate(() => {
      const table = document.querySelector("table.cfs-matrix-table");
      if (!table) return null;
      const headRows = Array.from(table.querySelectorAll("thead tr"));
      const groupBandRect = headRows[0]?.getBoundingClientRect();
      const buttonRowRect = headRows[1]?.getBoundingClientRect();
      if (!groupBandRect || !buttonRowRect) return null;
      const lineTops = Array.from(table.querySelectorAll(".cfs-link-col-line")).map(
        (el) => el.getBoundingClientRect().top,
      );
      return {
        groupBandTop: groupBandRect.top,
        groupBandBottom: groupBandRect.bottom,
        buttonRowTop: buttonRowRect.top,
        minLineTop: Math.min(...lineTops),
        lineCount: lineTops.length,
      };
    });
    expect(topEdge).toBeTruthy();
    expect(topEdge!.lineCount).toBeGreaterThan(0);
    // Top edge of the highest line == button-name row top (±2px)...
    expect(Math.abs(topEdge!.minLineTop - topEdge!.buttonRowTop)).toBeLessThanOrEqual(2);
    // ...and strictly below the group/category band's own top edge.
    expect(topEdge!.minLineTop).toBeGreaterThan(topEdge!.groupBandTop + 2);

    // Uniform layout: while labels are shown the button-name row is taller
    // (T-65 padding is applied per-row, never per-cell), so every
    // button-header cell — linked or not — keeps ONE identical height, and
    // sticky base columns stay sticky.
    const headerInfo = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll("table.cfs-matrix-table thead .cfs-button-head"));
      return heads.map((th) => ({
        linked: th.classList.contains("cfs-header-link-cell"),
        height: Math.round(th.getBoundingClientRect().height * 100) / 100,
      }));
    });
    const unlinkedHeads = headerInfo.filter((head) => !head.linked);
    expect(headerInfo.filter((head) => head.linked).length).toBe(4);
    expect(unlinkedHeads.length).toBeGreaterThanOrEqual(4);
    for (const head of headerInfo) {
      expect(head.height).toBe(unlinkedHeads[0].height);
    }
    const stickyPositions = await page
      .locator("table.cfs-matrix-table thead .cfs-base-head")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).position));
    expect(stickyPositions.every((position) => position === "sticky")).toBe(true);

    // Maximize keeps lines and labels working.
    await page.getByRole("button", { name: /^Maximize$/ }).click();
    await expect(page.locator(BADGE)).toHaveCount(4);
    expect((await lineColors(page)).sort()).toEqual([switchColors.A, switchColors.B].sort());
    await page.getByRole("button", { name: /^Exit Maximize$/ }).click();
    await expect(page.locator("table.cfs-matrix-table")).toBeVisible();
  });

  test("panel lists groups+members; check/Select All/Clear control lines only; per-project persistence via hidden set", async ({ page }) => {
    mockState.projects = [
      makeProject("t60b", "T60-LINK-B"),
      makeProject("t60c", "T60-LINK-C"),
      makeProject("t60d", "T60-LINK-D", { unlinked: true }),
    ];
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Open project C first so it stores its own per-project entry.
    await openProject(page, "T60-LINK-C");
    await openCfsTab(page);
    await expect(page.locator(LINE).first()).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    await openProject(page, "T60-LINK-B");
    await openCfsTab(page);
    const switchColorsB = await (async () => {
      const colors = await lineColors(page);
      expect(colors.length).toBe(2);
      return colors;
    })();

    // Panel (T-65): group rows are "Link A" then "Link B" text pills filled
    // with the group color; member extraction as "switch name − button
    // name", unlinked PD-5 absent.
    const panel = await openLinkPanel(page);
    const groupsInfo = await panel.locator(".cfs-link-menu-group").evaluateAll((els) =>
      els.map((el) => {
        const pill = el.querySelector(".cfs-link-text-label");
        return {
          label: (pill?.textContent || "").trim(),
          swatch: pill ? getComputedStyle(pill).backgroundColor : "",
          members: Array.from(el.querySelectorAll(".cfs-link-menu-members li")).map(
            (li) => (li.textContent || "").trim(),
          ),
          checked: (el.querySelector("input[type=checkbox]") as HTMLInputElement).checked,
        };
      }),
    );
    expect(groupsInfo.map((group) => group.label)).toEqual(["Link A", "Link B"]);
    expect(groupsInfo[0].members).toEqual(["PD-1 − B1", "PD-2 − B1"]);
    expect(groupsInfo[1].members).toEqual(["PD-3 − B1", "PD-4 − B1"]);
    expect(groupsInfo.every((group) => group.checked)).toBe(true);
    expect(new Set(groupsInfo.map((group) => group.swatch))).toEqual(new Set(switchColorsB));
    expect(groupsInfo.some((group) => group.members.some((member) => member.includes("PD-5")))).toBe(false);
    await page.keyboard.press("Escape");

    // Uncheck group A -> only B lines remain; header labels are untouched.
    const groupASwatch = groupsInfo[0].swatch;
    await setGroupChecked(page, 0, false);
    const afterUncheck = await lineColors(page);
    expect(afterUncheck).not.toContain(groupASwatch);
    expect(afterUncheck.length).toBe(1);
    await expect(page.locator(BADGE)).toHaveCount(4);

    // Persistence model: v2 prefs store the HIDDEN set (so new link groups
    // default to visible) and no longer write the old T-58 field.
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem("cfs-view-preferences-v2");
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    });
    expect(stored).toBeTruthy();
    const byProject = (stored as { byProject?: Record<string, Record<string, unknown>> }).byProject ?? {};
    expect(byProject.t60b?.hiddenSettingLinkGroups).toEqual(["t60b-link-a"]);
    expect(JSON.stringify(stored)).not.toContain("showSettingLinkHeaders");

    // Reload -> project B keeps A hidden, panel checkbox reflects it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject(page, "T60-LINK-B");
    await openCfsTab(page);
    const reloaded = await lineColors(page);
    expect(reloaded).not.toContain(groupASwatch);
    expect(reloaded.length).toBe(1);
    const panelAfterReload = await openLinkPanel(page);
    const checkedStates = await panelAfterReload
      .locator(".cfs-link-menu-group input[type=checkbox]")
      .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).checked));
    expect(checkedStates).toEqual([false, true]);
    await page.keyboard.press("Escape");

    // Project C is untouched (both groups still lined).
    await openProject(page, "T60-LINK-C");
    await openCfsTab(page);
    expect((await lineColors(page)).length).toBe(2);

    // Back in B: Clear -> zero lines; Select All -> both groups return.
    await openProject(page, "T60-LINK-B");
    await openCfsTab(page);
    let panelB = await openLinkPanel(page);
    await panelB.locator("button").filter({ hasText: /^Clear$/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(LINE)).toHaveCount(0);
    await expect(page.locator(BADGE)).toHaveCount(4);
    panelB = await openLinkPanel(page);
    await panelB.locator("button").filter({ hasText: /^Select All$/ }).click();
    await page.keyboard.press("Escape");
    expect((await lineColors(page)).length).toBe(2);

    // Empty state: project without links shows the empty message, no lines.
    await openProject(page, "T60-LINK-D");
    await openCfsTab(page);
    await expect(page.locator(LINE)).toHaveCount(0);
    await expect(page.locator(BADGE)).toHaveCount(0);
    const panelD = await openLinkPanel(page);
    // T-62: panel texts are English.
    await expect(panelD.locator(".cfs-link-menu-empty")).toHaveText("No links");
    await expect(panelD.locator(".cfs-link-menu-group")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("T-61/T-65 Show labels checkbox: header labels toggle independently of lines (with the header-height gate); per-project persistence via hideSettingLinkBadges", async ({ page }) => {
    mockState.projects = [makeProject("t61a", "T61-BADGE-A"), makeProject("t61b", "T61-BADGE-B")];
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Open project B first so it stores its own per-project entry.
    await openProject(page, "T61-BADGE-B");
    await openCfsTab(page);
    await expect(page.locator(BADGE).first()).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    await openProject(page, "T61-BADGE-A");
    await openCfsTab(page);

    // Default = ON: checkbox sits in the Link panel next to Select All /
    // Clear, checked, and the 4 header labels are visible.
    let panel = await openLinkPanel(page);
    const badgeToggle = () => panel.locator(".cfs-link-menu-badge-toggle input[type=checkbox]");
    // T-65: the toggle is renamed to match the text labels.
    await expect(panel.locator(".cfs-link-menu-badge-toggle")).toHaveText(/Show labels/);
    await expect(panel.locator("button").filter({ hasText: /^Select All$/ })).toBeVisible();
    await expect(badgeToggle()).toBeChecked();
    await expect(page.locator(BADGE)).toHaveCount(4);
    expect((await lineColors(page)).length).toBe(2);
    const buttonRowHeight = () =>
      page.evaluate(() => {
        const row = document.querySelectorAll("table.cfs-matrix-table thead tr")[1];
        return row ? Math.round(row.getBoundingClientRect().height * 100) / 100 : null;
      });
    const rowHeightLabelsOn = await buttonRowHeight();

    // OFF -> every label disappears; the lines are untouched, and the
    // button-name row returns to its compact (pre-T-65) height because the
    // label padding is gated together with the labels.
    await badgeToggle().uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator(BADGE)).toHaveCount(0);
    expect((await lineColors(page)).length).toBe(2);
    const rowHeightLabelsOff = await buttonRowHeight();
    expect(rowHeightLabelsOn).toBeTruthy();
    expect(rowHeightLabelsOff).toBeTruthy();
    expect(rowHeightLabelsOff!).toBeLessThan(rowHeightLabelsOn!);

    // Independence: group line toggles and Select All / Clear never touch
    // the label state (and vice versa).
    await setGroupChecked(page, 0, false);
    await expect(page.locator(BADGE)).toHaveCount(0);
    expect((await lineColors(page)).length).toBe(1);
    panel = await openLinkPanel(page);
    await panel.locator("button").filter({ hasText: /^Clear$/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(LINE)).toHaveCount(0);
    await expect(page.locator(BADGE)).toHaveCount(0);
    panel = await openLinkPanel(page);
    await panel.locator("button").filter({ hasText: /^Select All$/ }).click();
    await expect(badgeToggle()).not.toBeChecked();
    await page.keyboard.press("Escape");
    expect((await lineColors(page)).length).toBe(2);
    await expect(page.locator(BADGE)).toHaveCount(0);

    // Persistence model: stored as the HIDDEN flag in the per-project entry.
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem("cfs-view-preferences-v2");
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    });
    expect(stored).toBeTruthy();
    const byProject = (stored as { byProject?: Record<string, Record<string, unknown>> }).byProject ?? {};
    expect(byProject.t61a?.hideSettingLinkBadges).toBe(true);
    expect(byProject.t61b?.hideSettingLinkBadges).toBe(false);

    // Reload -> project A keeps labels hidden (checkbox OFF), lines intact.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject(page, "T61-BADGE-A");
    await openCfsTab(page);
    await expect(page.locator(BADGE)).toHaveCount(0);
    expect((await lineColors(page)).length).toBe(2);
    panel = await openLinkPanel(page);
    await expect(badgeToggle()).not.toBeChecked();
    await page.keyboard.press("Escape");

    // Project B is untouched (labels still shown there).
    await openProject(page, "T61-BADGE-B");
    await openCfsTab(page);
    await expect(page.locator(BADGE)).toHaveCount(4);

    // Back in A: ON -> labels return.
    await openProject(page, "T61-BADGE-A");
    await openCfsTab(page);
    panel = await openLinkPanel(page);
    await badgeToggle().check();
    await page.keyboard.press("Escape");
    await expect(page.locator(BADGE)).toHaveCount(4);
  });
});
