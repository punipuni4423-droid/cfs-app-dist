/**
 * T-22/T-24 — Circuit FFE is driven by fixture Type transitions.
 *
 * ON  : the newly selected fixture has Type=FFE.
 * OFF : the previous fixture had Type=FFE and the new one does not.
 * KEEP: any other transition leaves the stored value alone
 *       (a manually-flagged row keeps its check across DL→DL changes).
 * The manual FFE checkbox (restored by T-25) coexists: it can toggle at any
 * time and is only overwritten by an actual FFE-relevant fixture transition.
 * Propagation covers the whole circuit group (multi-row) in both directions.
 */
import { expect, test, type Page } from "@playwright/test";
import { STORAGE_KEY, createDefaultLocations, createNewRoomType } from "../../app/lib/constants";
import type { CircuitEntry, ProjectData } from "../../app/types";
import { installLocalEditingMocks } from "./support/secure-sharing-mock";

const PROJECT_DRAFT_STORAGE_KEY = "cfs-project-drafts-v2";
const PROJECT_ID = "project-ffe-type-transitions";

function makeCircuit(overrides: Partial<CircuitEntry>): CircuitEntry {
  return {
    id: "",
    circuitGroupId: "",
    daliFixtureGroupId: "",
    designerNumber: "",
    internalNumber: "",
    dimmingType: "PWM",
    fixture: "",
    pcs: "1",
    detail: "",
    area: "",
    ffe: false,
    energySaving: false,
    ...overrides,
  };
}

function makeProject(): ProjectData {
  const now = new Date().toISOString();
  const [bedroom, ...otherLocations] = createDefaultLocations();
  const locations = [
    { ...bedroom, id: "area-bedroom", name: "Bedroom", number: "1", code: "BD" },
    ...otherLocations,
  ];
  const circuits = [
    // Legacy manually-flagged group: DL fixture with ffe=true carried in data.
    makeCircuit({
      id: "circuit-a1",
      circuitGroupId: "group-a",
      designerNumber: "TP-01",
      internalNumber: "A",
      fixture: "FX-DL",
      ffe: true,
      area: "area-bedroom",
    }),
    makeCircuit({
      id: "circuit-a2",
      circuitGroupId: "group-a",
      designerNumber: "TP-01",
      internalNumber: "B",
      fixture: "FX-DL",
      ffe: true,
      area: "area-bedroom",
    }),
    // Plain group used for the ON / FFE→FFE / OFF transitions.
    makeCircuit({
      id: "circuit-b1",
      circuitGroupId: "group-b",
      designerNumber: "TP-02",
      internalNumber: "C",
      fixture: "FX-DL",
      area: "area-bedroom",
    }),
  ];
  const roomType = {
    ...createNewRoomType("T2T"),
    id: "room-type-t2t",
    updatedAt: now,
    circuitIds: circuits.map((circuit) => circuit.id),
  };
  return {
    id: PROJECT_ID,
    name: "FFE Type Transitions",
    updatedAt: now,
    locations,
    fixtures: [
      { id: "fx-ffe", fixture: "FX-FFE", fixtureType: "FFE", powerMode: "VA", watt: "10", powerFactor: "0.7" },
      { id: "fx-ffe2", fixture: "FX-FFE2", fixtureType: "FFE", powerMode: "VA", watt: "8", powerFactor: "0.7" },
      { id: "fx-dl", fixture: "FX-DL", fixtureType: "DL", powerMode: "VA", watt: "12", powerFactor: "0.7" },
      { id: "fx-dl2", fixture: "FX-DL2", fixtureType: "DL", powerMode: "VA", watt: "6", powerFactor: "0.7" },
    ],
    circuits,
    roomTypes: [roomType],
  };
}

async function openCircuitTab(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const projectCard = page.locator("button.screen-card").filter({ hasText: "FFE Type Transitions" }).first();
  await projectCard.waitFor({ state: "visible", timeout: 10_000 });
  await projectCard.click();
  await page.getByRole("tab", { name: "Room Type", exact: true }).click();
  await page.getByRole("tab", { name: "T2T", exact: true }).click();
  await page.getByRole("tab", { name: "Circuit", exact: true }).click();
}

function fixtureSelect(page: Page, designer: string) {
  return page
    .getByRole("row", { name: new RegExp(designer) })
    .first()
    .locator("select")
    .filter({ has: page.locator('option[value="FX-FFE"]') })
    .first();
}

type PersistedRow = { fixture: string; ffe: boolean };

// Returns fixture+ffe pairs from the SAME persisted snapshot. Assertions must
// include the changed fixture name so a poll cannot succeed trivially against
// the pre-save (debounced) state.
async function persistedGroup(page: Page, groupId: string): Promise<PersistedRow[]> {
  return page.evaluate(
    ({ storageKey, draftKey, projectId, group }) => {
      function parseProjects(raw: string | null): Array<{
        id?: string;
        circuits?: Array<{ circuitGroupId?: string; fixture?: string; ffe?: boolean }>;
      }> {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw) as unknown;
          return Array.isArray(parsed)
            ? (parsed as Array<{ id?: string; circuits?: Array<{ circuitGroupId?: string; fixture?: string; ffe?: boolean }> }>)
            : [];
        } catch {
          return [];
        }
      }
      for (const key of [draftKey, storageKey]) {
        const project = parseProjects(window.localStorage.getItem(key)).find((candidate) => candidate.id === projectId);
        if (project?.circuits) {
          return project.circuits
            .filter((c) => c.circuitGroupId === group)
            .map((c) => ({ fixture: String(c.fixture ?? ""), ffe: c.ffe === true }));
        }
      }
      return [];
    },
    { storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY, projectId: PROJECT_ID, group: groupId },
  );
}

test.describe("Circuit FFE fixture-type transitions", () => {
  test("keep on DL→DL, ON on →FFE, keep on FFE→FFE, OFF on FFE→non-FFE", async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    state.projects = [makeProject() as unknown as Record<string, unknown>];

    await openCircuitTab(page);

    // (1) Legacy manual ON survives a DL→DL fixture change (whole group keeps true).
    // The expected value includes the NEW fixture name, so the poll only
    // resolves after the debounced save actually landed.
    await fixtureSelect(page, "TP-01").selectOption("FX-DL2");
    await expect
      .poll(() => persistedGroup(page, "group-a"), { timeout: 8_000 })
      .toEqual([
        { fixture: "FX-DL2", ffe: true },
        { fixture: "FX-DL", ffe: true },
      ]);

    // (2a) Selecting a Type=FFE fixture turns the group ON.
    await fixtureSelect(page, "TP-02").selectOption("FX-FFE");
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-FFE", ffe: true }]);

    // (3) FFE→FFE keeps it ON.
    await fixtureSelect(page, "TP-02").selectOption("FX-FFE2");
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-FFE2", ffe: true }]);

    // (2b) FFE→non-FFE turns it OFF.
    await fixtureSelect(page, "TP-02").selectOption("FX-DL2");
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-DL2", ffe: false }]);

    // (1') And a further DL→DL change stays OFF (transition rule leaves it alone).
    await fixtureSelect(page, "TP-02").selectOption("FX-DL");
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-DL", ffe: false }]);

    // (4) Manual checkbox (T-25) coexists: toggle ON, then a DL→DL change keeps it.
    const ffeCheckbox = page
      .getByRole("row", { name: /TP-02/ })
      .first()
      .locator('input[aria-label="FFE"]');
    await ffeCheckbox.check();
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-DL", ffe: true }]);
    await fixtureSelect(page, "TP-02").selectOption("FX-DL2");
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-DL2", ffe: true }]);
    await ffeCheckbox.uncheck();
    await expect
      .poll(() => persistedGroup(page, "group-b"), { timeout: 8_000 })
      .toEqual([{ fixture: "FX-DL2", ffe: false }]);
  });

  // T-26/T-28: changing an existing fixture's Type on the Fixture tab
  // retroactively drives FFE on every circuit using it (all room types,
  // group + DALI-block propagation): became FFE → check, left FFE → uncheck.
  // Circuits using other fixtures (incl. manually checked rows) are untouched.
  test("fixture tab Type→FFE retroactively checks circuits using the fixture", async ({ page }) => {
    const state = await installLocalEditingMocks(page);
    const now = new Date().toISOString();
    const [bedroom, ...otherLocations] = createDefaultLocations();
    const circuits = [
      makeCircuit({ id: "r-a1", circuitGroupId: "grp-a", designerNumber: "RA-01", internalNumber: "A", fixture: "FX-DL", area: "area-r" }),
      makeCircuit({ id: "r-a2", circuitGroupId: "grp-a", designerNumber: "RA-01", internalNumber: "B", fixture: "FX-OTHER", area: "area-r" }),
      makeCircuit({ id: "r-d1", circuitGroupId: "grp-d", daliFixtureGroupId: "dali-d", dimmingType: "DALI", designerNumber: "RD-01", internalNumber: "C", fixture: "FX-DL", area: "area-r" }),
      makeCircuit({ id: "r-d2", circuitGroupId: "grp-d", daliFixtureGroupId: "dali-d", dimmingType: "DALI", designerNumber: "RD-01", internalNumber: "C", fixture: "FX-DL", area: "area-r" }),
      makeCircuit({ id: "r-b1", circuitGroupId: "grp-b", designerNumber: "RB-01", internalNumber: "D", fixture: "FX-OTHER", area: "area-r" }),
      // Manually checked row on an unrelated fixture: retroactive ON/OFF must not touch it.
      makeCircuit({ id: "r-c1", circuitGroupId: "grp-c", designerNumber: "RC-01", internalNumber: "E", fixture: "FX-OTHER", area: "area-r", ffe: true }),
    ];
    const roomType1 = { ...createNewRoomType("RT-A"), id: "rt-a", updatedAt: now, circuitIds: ["r-a1", "r-a2", "r-d1", "r-d2"] };
    const roomType2 = { ...createNewRoomType("RT-B"), id: "rt-b", updatedAt: now, circuitIds: ["r-b1", "r-c1"] };
    const project: ProjectData = {
      id: PROJECT_ID,
      name: "FFE Type Transitions",
      updatedAt: now,
      locations: [{ ...bedroom, id: "area-r", name: "Bedroom", number: "1", code: "BD" }, ...otherLocations],
      fixtures: [
        { id: "fx-dl", fixture: "FX-DL", fixtureType: "DL", powerMode: "VA", watt: "12", powerFactor: "0.7" },
        { id: "fx-other", fixture: "FX-OTHER", fixtureType: "DL", powerMode: "VA", watt: "6", powerFactor: "0.7" },
      ],
      circuits,
      roomTypes: [roomType1, roomType2],
    };
    state.projects = [project as unknown as Record<string, unknown>];

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("button.screen-card").filter({ hasText: "FFE Type Transitions" }).first().click();
    await page.getByRole("tab", { name: "Fixture", exact: true }).click();

    const fxDlRow = page.getByRole("row", { name: /FX-DL\b/ }).first();
    const typeSelect = fxDlRow
      .locator("select")
      .filter({ has: page.locator("option", { hasText: /^FFE$/ }) })
      .first();

    const readState = () =>
      page.evaluate(
        ({ storageKey, draftKey, projectId }) => {
          for (const key of [draftKey, storageKey]) {
            try {
              const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as Array<{
                id?: string;
                fixtures?: Array<{ id?: string; fixtureType?: string }>;
                circuits?: Array<{ id?: string; ffe?: boolean }>;
              }>;
              const proj = Array.isArray(parsed) ? parsed.find((p) => p.id === projectId) : undefined;
              if (proj?.circuits && proj.fixtures) {
                return {
                  fxType: proj.fixtures.find((f) => f.id === "fx-dl")?.fixtureType ?? "?",
                  ffe: Object.fromEntries(proj.circuits.map((c) => [c.id, c.ffe === true])),
                };
              }
            } catch {
              // fall through
            }
          }
          return null;
        },
        { storageKey: STORAGE_KEY, draftKey: PROJECT_DRAFT_STORAGE_KEY, projectId: PROJECT_ID },
      );

    // Type -> FFE: group grp-a (both rows, propagation), DALI block grp-d (both
    // rows), across room types; grp-b (unrelated) stays off, manually checked
    // grp-c stays on.
    await typeSelect.selectOption("FFE");
    await expect.poll(readState, { timeout: 8_000 }).toEqual({
      fxType: "FFE",
      ffe: { "r-a1": true, "r-a2": true, "r-d1": true, "r-d2": true, "r-b1": false, "r-c1": true },
    });

    // T-28: Type back to DL retroactively UNchecks the rows using the fixture
    // (same propagation), while the manually checked unrelated row keeps its check.
    await typeSelect.selectOption("DL");
    await expect.poll(readState, { timeout: 8_000 }).toEqual({
      fxType: "DL",
      ffe: { "r-a1": false, "r-a2": false, "r-d1": false, "r-d2": false, "r-b1": false, "r-c1": true },
    });
  });
});
