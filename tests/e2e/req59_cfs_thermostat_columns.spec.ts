import { expect, test } from "@playwright/test";
import { excludedCfsThermostatSwitchIds } from "../../app/lib/cfsThermostatColumns";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import { hvacSettingId } from "../../app/lib/settingTargets";
import { deriveTstatOccupancy, tstatCommandReferenceLabel } from "../../app/lib/tstatOccupancy";
import type { SwitchEntry } from "../../app/types";

const assignment = (id: string, area: string) => ({ ...createEmptyHvacAssignment(), id, area });
const fan = (id: string, groupId = "legacy"): SwitchEntry => {
  const row = createEmptySwitchEntry("lutronPd");
  return {
    ...row, id, switchGroupId: groupId, switchNumber: "TH1", switchName: "Bedroom Thermostat",
    buttonFunction: "Fan Speed", condition: "Cycle / Medium",
    buttonSetting: { ...row.buttonSetting, circuitSettings: [{ circuitId: hvacSettingId("bedroom", "Fan Mode"), percentage: "Middle" }] },
  };
};

test("CFS omits only the blank duplicate and keeps the existing fan and occupancy operations", () => {
  const room = createNewRoomType("Room");
  room.hvacAssignments = [assignment("bedroom", "area-1")];
  const fanRow = fan("fan");
  const occupancy = { ...fanRow, id: "pir", buttonFunction: "PIR (TSTAT)", condition: "Occupancy Detection" };
  const command = { ...createEmptySwitchEntry("command"), switchNumber: "TH1" };
  room.switches = [fanRow, occupancy, command];
  const original = JSON.stringify(room);
  const { switches } = deriveTstatOccupancy(room);
  const derived = switches.find(row => row.kind === "tstat")!;
  expect(excludedCfsThermostatSwitchIds(room, switches)).toEqual(new Set([derived.id]));
  expect(tstatCommandReferenceLabel(command, switches, room.hvacAssignments)).toBe("TH1");
  expect(JSON.stringify(room)).toBe(original);
});

test("CFS retains controls shared by several assignments and does not infer ambiguous matches", () => {
  const room = createNewRoomType("Room");
  room.hvacAssignments = [assignment("bedroom", "area-1"), assignment("living", "area-1")];
  room.switches = [fan("fan")];
  expect(excludedCfsThermostatSwitchIds(room, deriveTstatOccupancy(room).switches)).toEqual(new Set());
  room.hvacAssignments.pop();
  room.switches.push(fan("ambiguous", "second-legacy"));
  expect(excludedCfsThermostatSwitchIds(room, deriveTstatOccupancy(room).switches)).toEqual(new Set());
});

test("CFS retains stored TSTAT controls and all saved fan actions", () => {
  const room = createNewRoomType("Room");
  room.hvacAssignments = [assignment("bedroom", "area-1")];
  room.switches = [fan("legacy-fan")];
  const derived = deriveTstatOccupancy(room).switches.find(row => row.kind === "tstat")!;
  expect(excludedCfsThermostatSwitchIds(room, deriveTstatOccupancy(room).switches)).toEqual(new Set([derived.id]));
  const managed = { ...createEmptySwitchEntry("tstat"), id: "managed", switchNumber: "TH1",
    tstatBinding: { areaId: "area-1", assignmentIds: ["bedroom"] } };
  const storedFan = { ...managed, id: "managed-fan", buttonFunction: "Fan Speed", condition: "Cycle / Medium",
    buttonSetting: fan("sample").buttonSetting };
  room.switches = [fan("legacy-fan"), managed, storedFan];
  expect(excludedCfsThermostatSwitchIds(room, deriveTstatOccupancy(room).switches)).toEqual(new Set());
});
