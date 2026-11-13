import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType, normalizeBacklightLevels } from "../../app/lib/constants";
import { buildCfsZoneRows, isPalladiomBacklightTarget } from "../../app/lib/useCfsZoneRows";
import { normalizeProjectSave, createNewProject } from "../../app/lib/storage";
import { reorderSwitchButtonFunction } from "../../app/lib/switchButtonCopy";
import { registeredThermostatSwitches } from "../../app/lib/tstatOccupancy";
import type { SwitchEntry } from "../../app/types";

function pd(id: string, fields: Partial<SwitchEntry> = {}): SwitchEntry {
  return { ...createEmptySwitchEntry("lutronPd"), id, switchGroupId: "panel", switchNumber: "PD1", buttonLabel: "M1", ...fields };
}

test("only matching registration exposes a TSTAT control without deleting stored controls", () => {
  const legacy = { ...createEmptySwitchEntry("tstat"), id: "legacy", switchNumber: "TH1" };
  const rows = [legacy, pd("other")];
  expect(registeredThermostatSwitches(rows, [])).toEqual([rows[1]]);
  expect(rows[0]).toBe(legacy);
  const assignment = createEmptyHvacAssignment();
  expect(registeredThermostatSwitches(rows, [assignment])).toEqual([rows[1]]);
  const linked = { ...legacy, tstatBinding: { areaId: assignment.area, assignmentIds: [assignment.id] } };
  expect(registeredThermostatSwitches([linked, ...rows], [assignment])).toEqual([linked, rows[1]]);
});

test("a saved renamed Base label resolves to the same CFS target after save and reload", () => {
  const room = createNewRoomType("RT-B");
  room.backlightLevels = normalizeBacklightLevels([{ key: "base", name: "Base Night" }]);
  room.switches = [pd("s", { backlightAssignment: "Base Night", backlightTarget: "panel", backlightCondition: "relax", backlightLevels: room.backlightLevels })];
  const project = { ...createNewProject("Backlight"), roomTypes: [room] };
  const reloaded = normalizeProjectSave(JSON.parse(JSON.stringify(normalizeProjectSave(project)))).roomTypes[0];
  function projected(assignment: string) {
    const target = { ...reloaded.switches[0], backlightAssignment: assignment };
    return buildCfsZoneRows({
      roomType: { ...reloaded, switches: [target] },
      circuits: [], locations: [], locationById: new Map(), areaAddressByAssignmentCircuit: new Map(),
      palladiomBySceneTargets: isPalladiomBacklightTarget(target) ? new Map([["panel", target]]) : new Map(),
      selectedAreaIds: new Set(), hiddenDeviceKeys: new Set(), sortMode: "device",
    }).filter(row => row.isBacklight);
  }
  expect(reloaded.switches[0].backlightAssignment).toBe("Base Night");
  for (const name of ["Base Night", "base", ""]) {
    expect(projected(name)).toEqual([expect.objectContaining({ id: "backlight:panel", backlightValue: "Relax" })]);
  }
  expect(projected("sleep")).toEqual([]);
});

test("Function reorder moves only whole rows of the same button and preserves their IDs and settings", () => {
  const first = pd("first", { backlightTarget: "chosen" });
  const otherButton = pd("other", { buttonLabel: "M2" });
  const second = pd("second");
  const otherPanel = pd("separate", { switchGroupId: "separate" });
  const rows = [first, otherButton, second, otherPanel];
  expect(reorderSwitchButtonFunction(rows, "second", "first", "before")).toEqual([second, otherButton, first, otherPanel]);
  expect(reorderSwitchButtonFunction(rows, "first", "second", "before")).toBe(rows);
  expect(reorderSwitchButtonFunction(rows, "first", "other", "after")).toBe(rows);
  expect(reorderSwitchButtonFunction(rows, "first", "separate", "after")).toBe(rows);
});

function handlers(path: string, names: string[], context: Record<string, unknown>): Record<string, (...args: unknown[]) => unknown> {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(declarations).toHaveLength(names.length);
  const script = declarations.join("\n") + "\n({" + names.join(",") + "});";
  return runInNewContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}

test("one Inspection Reset removes the live draft and restores the starting value without adding a mark", () => {
  const changed = { key: "edited", sourceType: "areaScene", sourceId: "scene", targetId: "c1", value: "75", previousValue: "20" };
  const other = { ...changed, key: "other", targetId: "c2", value: "60" };
  const refs = [{ key: "edited" }];
  let drafts = { edited: changed, other };
  let starting = { edited: "20", other: "30" };
  const touched = { current: false };
  const original = { scenes: [{ id: "scene", settings: { c1: "20", c2: "30" } }], roomScenes: [], switches: [], inspectionMarks: ["preexisting"] };
  let undo = 0;
  let closed = false;
  const fn = handlers("app/components/CfsView.tsx", ["resetInspectionPopoverCell", "hasInspectionMarkForCell", "buildInspectionAppliedState"], {
    inspectionSessionBaseline: original, inspectionDrafts: drafts, inspectionMode: true,
    inspectionBaselineMarkKeys: new Set(["preexisting"]), inspectionMarksByKey: new Map([["edited", {}]]),
    inspectionDraftsTouchedRef: touched, allInspectionDraftRefsForCell: () => refs,
    pushInspectionHistorySnapshot: () => { undo += 1; },
    setInspectionDrafts: (mutate: (old: typeof drafts) => typeof drafts) => {
      const next = mutate(drafts);
      Object.keys(drafts).forEach(key => delete drafts[key as keyof typeof drafts]);
      Object.assign(drafts, next);
    },
    setInspectionBaselineValues: (mutate: (old: typeof starting) => typeof starting) => { starting = mutate(starting); },
    setInspectionPopover: () => { closed = true; },
    updateSceneValue: (scenes: typeof original.scenes, id: string, target: string, value: string) =>
      scenes.map(scene => scene.id === id ? { ...scene, settings: { ...scene.settings, [target]: value } } : scene),
    inspectionMarksWithDrafts: (drafts: typeof changed[]) => [...original.inspectionMarks, ...drafts.map(draft => draft.key)],
  });
  expect(fn.hasInspectionMarkForCell(null, null)).toBe(true);
  fn.resetInspectionPopoverCell(null, null);
  expect(fn.buildInspectionAppliedState(Object.values(drafts))).toMatchObject({
    scenes: [{ settings: { c1: "20", c2: "60" } }], inspectionMarks: ["preexisting", "other"],
  });
  expect(fn.hasInspectionMarkForCell(null, null)).toBe(false);
  expect(starting).toEqual({ other: "30" });
  expect(undo).toBe(1);
  expect(touched.current).toBe(true);
  expect(closed).toBe(true);
});

test("Clear removes both clipboard sources and their pending paste state", () => {
  const state: Record<string, unknown> = { operation: { sourceId: "function" }, button: { sourceId: "button" }, scope: "switch", error: "blocked" };
  const set = (key: string) => (value: unknown) => { state[key] = value; };
  const { cancelCopy } = handlers("app/components/SwitchView.tsx", ["cancelCopy"], {
    canEdit: true, setOperationClipboard: set("operation"), setButtonClipboard: set("button"),
    setPasteScope: set("scope"), setPasteError: set("error"),
  });
  cancelCopy();
  expect(state).toEqual({ operation: null, button: null, scope: null, error: "" });
});
