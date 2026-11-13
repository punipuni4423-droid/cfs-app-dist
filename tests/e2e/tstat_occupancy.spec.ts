import { test, expect } from "@playwright/test";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { createNewProject, normalizeProjectSave } from "../../app/lib/storage";
import { deriveTstatOccupancy, isActiveTstatControl, preserveThermostatNumberReservations, thermostatNumberForAssignment, tstatAreaChangeWarnings, tstatCommandReferenceLabel, updateTstatRegistration } from "../../app/lib/tstatOccupancy";
import { duplicateRoomType } from "../../app/lib/roomTypeCopy";
import { localRevisionRestore } from "../../app/lib/localRevisionRestore";
import type { HvacAssignment } from "../../app/types";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { setSettingsValue } from "../../app/lib/cfsValueResolver";
import { buildCfsLinkageGraph } from "../../app/lib/cfsLinkageGraph";

const assignment = (id: string, area = "area-a", role: HvacAssignment["thermostatRole"] = "Master") => ({ ...createEmptyHvacAssignment(), id, area, thermostatRole: role });

test("legacy TSTAT display derives shared blank logic without changing stored bytes", () => {
  const room = createNewRoomType("Old room"); room.hvacAssignments = [assignment("a"), assignment("b", "area-a", "Slave")];
  const before = JSON.stringify(room);
  const state = deriveTstatOccupancy(room);
  expect(JSON.stringify(room)).toBe(before);
  expect(state.switches).toHaveLength(1);
  expect(state.switches[0]).toMatchObject({ kind: "tstat", switchNumber: "TH1 / TH2", buttonFunction: "PIR", condition: "", backlightTarget: "", backlightCondition: "", tstatBinding: { areaId: "area-a", assignmentIds: ["a", "b"] } });
  expect(state.switches[0].buttonSetting.circuitSettings).toEqual([]);
  expect(deriveTstatOccupancy(room).switches).toEqual(state.switches);
});

test("CFS distinguishes an existing TH number without changing saved controls or Command references", () => {
  const room = createNewRoomType("Room");
  room.hvacAssignments = [{ ...assignment("a"), thermostatNumber: 8 }, assignment("b", "area-b")];
  const legacy = { ...createEmptySwitchEntry("lutronPd"), switchNumber: " th1 ", switchName: "Bedroom Thermostat" };
  const reserved = { ...createEmptySwitchEntry("lutronPd"), switchNumber: "TH1 (TSTAT)" };
  room.switches = [legacy, reserved];
  const before = JSON.stringify(room);
  const state = deriveTstatOccupancy(room);
  const [first, second] = state.switches.filter(row => row.kind === "tstat");
  const command = { ...createEmptySwitchEntry("command"), switchNumber: first.switchGroupId };
  expect(state.columnLabels.get(first.id)).toBe("TH1 (TSTAT 2)");
  expect(state.columnLabels.get(second.id)).toBe("TH2");
  expect(first.switchNumber).toBe("TH8");
  expect(tstatCommandReferenceLabel(command, state.switches, room.hvacAssignments)).toBe("TH1");
  const graph = buildCfsLinkageGraph({ roomType: room, circuits: [], locations: [] });
  expect(graph.nodes.find(node => node.id === `switch:${first.id}`)?.label).toContain("TH1 (TSTAT 2)");
  expect(state.switches[0]).toBe(legacy);
  expect(JSON.stringify(room)).toBe(before);
});

test("a shared TSTAT heading stays consistent across the group's functions", () => {
  const room = updateTstatRegistration(createNewRoomType("Room"), [assignment("a"), assignment("b")]);
  const control = room.switches[0];
  const nextFunction = { ...control, id: "additional-function" };
  const legacy = { ...createEmptySwitchEntry("lutronPd"), switchNumber: "TH2" };
  room.switches = [legacy, control, nextFunction];
  const { columnLabels, switches } = deriveTstatOccupancy(room);
  expect(columnLabels.get(control.id)).toBe("TH1 / TH2 (TSTAT)");
  expect(columnLabels.get(nextFunction.id)).toBe(columnLabels.get(control.id));
  expect(switches[1]).toBe(control);
});

test("registration numbers are stable and same-Area additions retain one existing settings group", () => {
  let room = updateTstatRegistration(createNewRoomType("Room"), [assignment("a"), assignment("b", "area-a", "Slave")]);
  room.switches[0].condition = "Occupied";
  room.switches[0].buttonSetting.circuitSettings = [{ circuitId: "light", percentage: "50% / Off", valueMode: "text" }];
  const groupId = room.switches[0].switchGroupId;
  room = updateTstatRegistration(room, [...room.hvacAssignments, assignment("c")]);
  expect(room.switches).toHaveLength(1); expect(room.switches[0].switchGroupId).toBe(groupId);
  expect(room.switches[0].condition).toBe("Occupied");
  expect(room.switches[0].buttonSetting.circuitSettings[0].valueMode).toBe("text");
  expect(room.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 2, 3]);
  room = updateTstatRegistration(room, room.hvacAssignments.filter((row) => row.id !== "c"));
  room = updateTstatRegistration(room, [{ ...assignment("d"), thermostatNumber: 1 }, ...room.hvacAssignments]);
  expect(room.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([4, 1, 2]);
  expect(thermostatNumberForAssignment(room.hvacAssignments, "a")).toBe("TH1");
});

test("unassigned devices do not share control and movement or deletion retains old logic", () => {
  let room = updateTstatRegistration(createNewRoomType("Room"), [assignment("a"), assignment("b", "area-b"), assignment("c", ""), assignment("d", "")]);
  const unassigned = deriveTstatOccupancy(room);
  expect(unassigned.switches).toHaveLength(4);
  expect(unassigned.warnings).toEqual([]);
  expect(room.switches).toHaveLength(2);
  const original = room.switches[0]; original.condition = "Keep original";
  room.switches[1].condition = "Target Area setting";
  expect(tstatAreaChangeWarnings(room, room.hvacAssignments.map((row) => row.id === "a" ? { ...row, area: "area-b" } : row), [{ id: "area-b", name: "Area B", number: "2", code: "", color: "" }])[0]).toContain("TH1 will use Area B's shared controls");
  room = updateTstatRegistration(room, room.hvacAssignments.map((row) => row.id === "a" ? { ...row, area: "area-b", thermostatRole: "Slave" } : row));
  expect(room.switches.find((row) => row.id === original.id)?.condition).toBe("Keep original");
  expect(isActiveTstatControl(room.switches.find((row) => row.id === original.id)!, room.hvacAssignments, room.switches)).toBe(false);
  const active = room.switches.filter((row) => isActiveTstatControl(row, room.hvacAssignments, room.switches));
  expect(active).toHaveLength(1); expect(active[0].condition).toBe("Target Area setting");
  expect(active[0].tstatBinding?.assignmentIds).toEqual(["a", "b"]);
  room = updateTstatRegistration(room, []);
  expect(room.switches.find((row) => row.id === original.id)?.condition).toBe("Keep original");
  expect(deriveTstatOccupancy(room).warnings).toEqual([]);
});

test("optional metadata survives save and RT copy remaps only identities", () => {
  const project = createNewProject("TSTAT metadata");
  project.roomTypes = [updateTstatRegistration(createNewRoomType("Room"), [assignment("a"), assignment("b")])];
  const legacy = { ...createEmptySwitchEntry("tstat"), condition: "Legacy annotation" };
  project.roomTypes[0].switches.push(legacy);
  const saved = normalizeProjectSave(project);
  expect(saved.roomTypes[0].hvacAssignments[1].thermostatNumber).toBe(2);
  expect(saved.roomTypes[0].nextThermostatNumber).toBe(3);
  expect(saved.roomTypes[0].switches[0].tstatBinding).toEqual({ areaId: "area-a", assignmentIds: ["a", "b"] });
  expect(saved.roomTypes[0].switches.find((row) => row.id === legacy.id)?.condition).toBe("Legacy annotation");
  expect(normalizeProjectSave(saved)).toEqual(saved);
  const copy = duplicateRoomType(saved, saved.roomTypes[0].id)!.project.roomTypes.at(-1)!;
  expect(copy.hvacAssignments.map((row) => row.thermostatNumber)).toEqual([1, 2]);
  expect(copy.switches[0].tstatBinding?.assignmentIds).toEqual(copy.hvacAssignments.map((row) => row.id));
  expect(copy.switches[0].tstatBinding?.assignmentIds).not.toContain("a");
});

test("duplicate Area groups retain data inactive and old revision cannot reuse TH numbers", () => {
  const project = createNewProject("TSTAT history");
  const room = updateTstatRegistration(createNewRoomType("Room"), [assignment("a")]);
  const second = { ...structuredClone(room.switches[0]), id: "duplicate-control", switchGroupId: "duplicate-group", condition: "Retain duplicate" };
  room.switches.push(second);
  expect(deriveTstatOccupancy(room).warnings.some((warning) => warning.includes("Multiple saved"))).toBe(true);
  expect(room.switches.every((row) => !isActiveTstatControl(row, room.hvacAssignments, room.switches))).toBe(true);
  expect(deriveTstatOccupancy(room).switches[1].condition).toBe("Retain duplicate");
  room.nextThermostatNumber = 8;
  room.revisions = [{ id: "old", revision: "1.00", savedAt: new Date().toISOString(), note: "", snapshot: JSON.stringify({ hvacAssignments: room.hvacAssignments, switches: [room.switches[0]], nextThermostatNumber: 2 }) }];
  project.roomTypes = [room];
  const restored = localRevisionRestore(project, { kind: "room-type-revision", roomTypeId: room.id, revisionId: "old" });
  expect(restored.roomTypes[0].nextThermostatNumber).toBe(8);
});

test("Inspection materializes only an edited virtual source and baseline retains the original absence", () => {
  const storedRoomType = createNewRoomType("Legacy room"); storedRoomType.hvacAssignments = [assignment("a")];
  const roomType = { ...storedRoomType, switches: deriveTstatOccupancy(storedRoomType).switches };
  const source = readFileSync("app/components/CfsView.tsx", "utf8");
  const ast = ts.createSourceFile("CfsView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && ["updateSwitchValue", "captureInspectionSessionBaseline"].includes(node.name?.text ?? "")) functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(functions).toHaveLength(2);
  const context = vm.createContext({ storedRoomType, roomType, setSettingsValue, inspectionMarkList: [], cloneInspectionData: structuredClone });
  vm.runInContext(ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const baseline = vm.runInContext("captureInspectionSessionBaseline()", context);
  expect(baseline.switches).toEqual([]);
  const rows = vm.runInContext(`updateSwitchValue([], ${JSON.stringify(roomType.switches[0].id)}, "light", "Occupied: 50%\\nVacant: Off", "text")`, context);
  expect(rows).toHaveLength(1);
  expect(rows[0].buttonSetting.circuitSettings[0]).toMatchObject({ circuitId: "light", percentage: "Occupied: 50%\nVacant: Off", valueMode: "text" });
  expect(storedRoomType.switches).toEqual([]);
  expect(baseline.switches).toEqual([]);
});

test("managed Command references copy with their group while legacy labels stay unchanged", () => {
  const project = createNewProject("TH copy"); const room = updateTstatRegistration(createNewRoomType("Room"), [assignment("a")]);
  const sourceId = room.switches[0].switchGroupId;
  room.switches.push({ ...createEmptySwitchEntry("command"), id: "command-th", switchNumber: sourceId, switchName: "Occupancy command" });
  room.switches.push({ ...createEmptySwitchEntry("command"), id: "command-old", switchNumber: "SW1" }); project.roomTypes = [room];
  const copied = duplicateRoomType(project, room.id)!.project.roomTypes.at(-1)!;
  expect(copied.switches.find((row) => row.switchName === "Occupancy command")?.switchNumber).toBe(copied.switches.find((row) => row.tstatBinding)?.switchGroupId);
  expect(copied.switches.find((row) => row.switchNumber === "SW1")).toBeTruthy();
  expect(tstatCommandReferenceLabel(room.switches[1], room.switches)).toBe("TH1");
  expect(tstatCommandReferenceLabel({ ...room.switches[1], switchNumber: "tstat-control:missing" }, room.switches)).toBe("Unresolved control");
});

test("Undo reservation and optional-counter revision restore reserve prior physical numbers", () => {
  const project = createNewProject("TH Undo"); const first = updateTstatRegistration(createNewRoomType("Room"), [assignment("a")]); project.roomTypes = [first];
  const current = { ...project, roomTypes: [updateTstatRegistration(first, [...first.hvacAssignments, assignment("b")])] };
  const undone = preserveThermostatNumberReservations(project, current);
  expect(undone.roomTypes[0].hvacAssignments).toHaveLength(1);
  expect(updateTstatRegistration(undone.roomTypes[0], [...undone.roomTypes[0].hvacAssignments, assignment("c")]).hvacAssignments[1].thermostatNumber).toBe(3);
  const withoutCounter = structuredClone(current); delete withoutCounter.roomTypes[0].nextThermostatNumber;
  withoutCounter.roomTypes[0].revisions = [{ id: "old", revision: "1.00", savedAt: new Date().toISOString(), note: "", snapshot: JSON.stringify({ hvacAssignments: first.hvacAssignments, switches: first.switches, nextThermostatNumber: 2 }) }];
  const restored = localRevisionRestore(withoutCounter, { kind: "room-type-revision", roomTypeId: first.id, revisionId: "old" });
  expect(updateTstatRegistration(restored.roomTypes[0], [...restored.roomTypes[0].hvacAssignments, assignment("c")]).hvacAssignments[1].thermostatNumber).toBe(3);
});
