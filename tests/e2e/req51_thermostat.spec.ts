import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType } from "../../app/lib/constants";
import type { CfsExcelSheetModel } from "../../app/lib/cfsExcelExport";
import { appendProjectExcelSheets } from "../../app/lib/projectExcelExport";
import { createNewProject } from "../../app/lib/storage";
import { tstatMasterReference } from "../../app/lib/tstatMasterReference";
import {
  deriveTstatOccupancy,
  isCfsSwitchControlActive,
  thermostatCollectionRows,
  thermostatControlDisplayNumber,
  thermostatNumberForAssignment,
  updateTstatRegistration,
} from "../../app/lib/tstatOccupancy";
import { buildCfsZoneRows } from "../../app/lib/useCfsZoneRows";
import type { RoomType } from "../../app/types";

function oldRoom(): RoomType {
  const room = createNewRoomType("RT-A");
  room.hvacAssignments = [2, 3, 4].map(number => ({
    ...createEmptyHvacAssignment(), id: `device-${number}`, thermostatNumber: number, area: "",
  }));
  room.nextThermostatNumber = 5;
  room.switches = [
    { ...createEmptySwitchEntry("tstat"), id: "legacy", switchNumber: "TH-1", switchName: "Thermostat rta", condition: "Keep legacy" },
    { ...createEmptySwitchEntry("tstat"), id: "removed", switchNumber: "TH1", switchName: "Sample Bedroom", tstatBinding: { areaId: "old-area", assignmentIds: ["removed-device"] } },
  ];
  return room;
}

test("old labels display in registration order while IDs and allocation metadata survive", () => {
  const room = oldRoom();
  const before = JSON.stringify(room);
  const derived = deriveTstatOccupancy(room).switches;
  expect(thermostatCollectionRows(derived, room.hvacAssignments).map(row => thermostatControlDisplayNumber(row, room.hvacAssignments)))
    .toEqual(["TH1", "TH2", "TH3"]);
  expect(derived.filter(row => isCfsSwitchControlActive(row, room.hvacAssignments, derived))).toEqual([]);
  const physical = buildCfsZoneRows({
    roomType: room, circuits: [], locations: [], locationById: new Map(), areaAddressByAssignmentCircuit: new Map(),
    palladiomBySceneTargets: new Map(), selectedAreaIds: new Set(), hiddenDeviceKeys: new Set(), sortMode: "device",
  }).filter(row => row.hvacMetric === "On/Off");
  expect(physical.map(row => [row.deviceNum, row.location, row.hvacSettingId])).toEqual([
    ["1", "Other", "hvac:device-2:On/Off"],
    ["2", "Other", "hvac:device-3:On/Off"],
    ["3", "Other", "hvac:device-4:On/Off"],
  ]);
  expect(JSON.stringify(room)).toBe(before);
  const added = { ...createEmptyHvacAssignment(), id: "new-device", area: "" };
  const updated = updateTstatRegistration(room, [...room.hvacAssignments, added]);
  expect(updated.hvacAssignments.map(row => row.thermostatNumber)).toEqual([2, 3, 4, 5]);
  expect(thermostatNumberForAssignment(updated.hvacAssignments, added.id)).toBe("TH4");
  expect(updated.switches).toEqual(expect.arrayContaining(room.switches));
});

test("project workbook omits old controls and uses the same number for registration, current controls and Master reference", async () => {
  const room = oldRoom();
  room.hvacAssignments[0] = { ...room.hvacAssignments[0], area: "area", thermostatRole: "Master" };
  room.hvacAssignments[1] = { ...room.hvacAssignments[1], thermostatRole: "Slave", masterAssignmentId: room.hvacAssignments[0].id };
  const derived = deriveTstatOccupancy(room).switches;
  const active = derived.filter(row => isCfsSwitchControlActive(row, room.hvacAssignments, derived));
  expect(active.map(row => thermostatControlDisplayNumber(row, room.hvacAssignments))).toEqual(["TH1"]);
  expect(tstatMasterReference(room.hvacAssignments[1], room.hvacAssignments, []).label).toBe("TH1");
  const project = { ...createNewProject("Anonymous"), roomTypes: [room] };
  const before = JSON.stringify(project);
  const blankCfs: CfsExcelSheetModel = {
    visibleBaseColumns: [], visibleFunctionColumns: [], displayedRows: [],
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false },
    expandedPirHeaderKeys: new Set(),
    resolvers: {
      baseValues: () => [], functionValues: () => [], baseColumnLabel: column => column.label,
      hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => false,
      hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false,
    },
  };
  const workbook = new ExcelJS.Workbook();
  const { index } = appendProjectExcelSheets(workbook, project, { devices: [], wattPerPdu: 3.3, buildCfsModel: () => blankCfs });
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const thermostat = reloaded.getWorksheet(index.find(entry => entry.tab === "TSTAT")!.sheetName)!;
  const switchSheet = reloaded.getWorksheet(index.find(entry => entry.tab === "Switch")!.sheetName)!;
  const numbers = (values: readonly unknown[]) => values.filter(value => typeof value === "string" && /^TH\d+$/.test(value));
  expect(numbers(thermostat.getColumn(1).values)).toEqual(["TH1", "TH2", "TH3"]);
  expect(numbers(switchSheet.getColumn(3).values)).toEqual(["TH1", "TH2", "TH3"]);
  expect(switchSheet.getColumn(4).values).not.toContain("Thermostat rta");
  expect(switchSheet.getColumn(4).values).not.toContain("Sample Bedroom");
  expect(JSON.stringify(project)).toBe(before);
});
