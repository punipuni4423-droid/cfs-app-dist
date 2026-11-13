import { expect, test } from "@playwright/test";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import {
  deriveTstatOccupancy,
  thermostatNumberForAssignment,
  tstatAreaChangeWarnings,
  tstatCommandReferenceLabel,
  updateTstatRegistration,
} from "../../app/lib/tstatOccupancy";
import { tstatMasterReference } from "../../app/lib/tstatMasterReference";
import { TSTAT_QUARANTINE_WARNING } from "../../app/lib/tstatBindingQuarantine";

function assignment(id: string, area = "a") {
  return { ...createEmptyHvacAssignment(), id, area };
}

test("deletion compacts TH numbers and keeps the physical Master ID", () => {
  const master = assignment("master");
  const slave = { ...assignment("slave"), thermostatRole: "Slave" as const, masterAssignmentId: master.id };
  const before = updateTstatRegistration(createNewRoomType("Room"), [assignment("remove", "b"), master, slave]);
  const room = updateTstatRegistration(before, before.hvacAssignments.slice(1));
  expect(room.hvacAssignments.map(row => [row.id, row.thermostatNumber])).toEqual([["master", 1], ["slave", 2]]);
  expect(room.nextThermostatNumber).toBe(3);
  expect(room.hvacAssignments[1].masterAssignmentId).toBe("master");
  expect(tstatMasterReference(room.hvacAssignments[1], room.hvacAssignments, []).label).toContain("TH1");
  expect(tstatMasterReference({ ...room.hvacAssignments[1], masterAssignmentId: "" }, room.hvacAssignments, []))
    .toEqual({ status: "unselected", label: "-" });
  expect(tstatMasterReference({ ...room.hvacAssignments[1], masterAssignmentId: "missing" }, room.hvacAssignments, []))
    .toMatchObject({ status: "missing", label: "Unavailable Master", warning: expect.stringContaining("The saved Master is unavailable.") });
  expect(updateTstatRegistration(room, [...room.hvacAssignments, assignment("added")]).hvacAssignments.at(-1)?.thermostatNumber).toBe(3);
  expect(before.hvacAssignments.map(row => row.thermostatNumber)).toEqual([1, 2, 3]);
});

test("shared control survives a member deletion and its label follows the remaining assignment", () => {
  const before = updateTstatRegistration(createNewRoomType("Room"), [assignment("one"), assignment("two")]);
  const control = before.switches[0];
  control.condition = "Keep configured condition";
  const cmd = { ...createEmptySwitchEntry("command"), switchNumber: control.switchGroupId };
  before.switches.push(cmd);
  const next = before.hvacAssignments.slice(1);
  expect(tstatAreaChangeWarnings(before, next, [])).toEqual([]);
  const room = updateTstatRegistration(before, next);
  expect(room.switches.find(row => row.id === control.id)).toMatchObject({
    condition: control.condition, tstatBinding: { areaId: "a", assignmentIds: ["two"] }, switchNumber: "TH1",
  });
  expect(tstatCommandReferenceLabel(cmd, room.switches)).toBe("TH1");
  expect(thermostatNumberForAssignment(room.hvacAssignments, "two")).toBe("TH1");
});

test("last member deletion warns before removing configured controls and unlinking only affected commands", () => {
  const room = updateTstatRegistration(createNewRoomType("Room"), [assignment("one")]);
  const control = room.switches[0];
  control.buttonSetting.circuitSettings = [{ circuitId: "c1", percentage: "50" }];
  const linked = { ...createEmptySwitchEntry("command"), switchNumber: control.switchGroupId, condition: "Keep command body" };
  const other = { ...createEmptySwitchEntry("command"), switchNumber: "TH1" };
  const legacy = { ...createEmptySwitchEntry("tstat"), condition: "Keep legacy" };
  const quarantine = { ...createEmptySwitchEntry("tstat"), tstatBindingQuarantine: { raw: "opaque" } };
  const orphan = { ...createEmptySwitchEntry("tstat"), tstatBinding: { areaId: "old", assignmentIds: ["already-missing"] } };
  room.switches.push(linked, other, legacy, quarantine, orphan);
  const original = structuredClone(room);
  expect(tstatAreaChangeWarnings(room, [], [])).toEqual([
    "Deleting this Thermostat will remove its configured controls and settings.",
    "Commands linked to the removed controls will be unlinked.",
  ]);
  expect(room).toEqual(original);
  const after = updateTstatRegistration(room, []);
  expect(after.hvacAssignments).toEqual([]);
  expect(after.nextThermostatNumber).toBe(1);
  expect(after.switches).toEqual([{ ...linked, switchNumber: "" }, other, legacy, quarantine, orphan]);
  expect(deriveTstatOccupancy(after).warnings).toEqual([TSTAT_QUARANTINE_WARNING]);
  expect(room).toEqual(original);
});

test("deletion preserves ambiguous groups and removes only the matching unassigned control", () => {
  const original = updateTstatRegistration(createNewRoomType("Room"), [assignment("area"), assignment("unassigned", "")]);
  const scaffold = deriveTstatOccupancy(original).switches.find(row => row.tstatBinding?.areaId === "")!;
  const ambiguous = { ...original.switches[0], id: "duplicate", switchGroupId: "other-group", condition: "Keep duplicate" };
  original.switches.push(ambiguous, { ...scaffold, condition: "Unassigned setting" });
  const result = updateTstatRegistration(original, []);
  expect(result.switches.map(row => row.id)).toEqual([original.switches[0].id, "duplicate"]);
  expect(result.switches[1].condition).toBe("Keep duplicate");
  expect(tstatAreaChangeWarnings(original, [], [])).toEqual(["Deleting this Thermostat will remove its configured controls and settings."]);
});
