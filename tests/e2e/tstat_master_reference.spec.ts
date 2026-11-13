import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { createEmptyHvacAssignment, createNewRoomType, createDefaultRoomScenes } from "../../app/lib/constants";
import { createNewProject, migrateProjectsPayload, normalizeProjectSave } from "../../app/lib/storage";
import { canSelectTstatMaster, tstatMasterCandidates, tstatMasterReference } from "../../app/lib/tstatMasterReference";
import { updateTstatRegistration } from "../../app/lib/tstatOccupancy";
import { duplicateRoomType } from "../../app/lib/roomTypeCopy";
import { localRevisionRestore } from "../../app/lib/localRevisionRestore";
import { buildRevisionChangeEntries } from "../../app/lib/revisionChanges";
import { appendHvacSheets } from "../../app/lib/hvacExcelExport";
import { appendProjectExcelSheets } from "../../app/lib/projectExcelExport";
import { DOOR_MAGNET_SCENE_GROUP_KEY, roomSceneColumnGroupKey, roomSceneColumnGroupLabel, upgradeSceneColumnGroupKeys } from "../../app/lib/cfsSceneColumnGroups";
import type { HvacAssignment } from "../../app/types";
import { BASE_COLUMNS } from "../../app/lib/cfsTableModel";
import { buildCfsZoneRows, rowZoneValues } from "../../app/lib/useCfsZoneRows";

const locations = [{ id: "a", name: "Area A", number: "1", code: "A", color: "#fff" }, { id: "b", name: "Area B", number: "2", code: "B", color: "#fff" }];
function fixture() {
  const project = createNewProject("Master Reference QA"); project.locations = locations;
  const rows: HvacAssignment[] = [
    { ...createEmptyHvacAssignment(), id: "master-a", area: "a", protocol: "Modbus" },
    { ...createEmptyHvacAssignment(), id: "master-b", area: "b", protocol: "FCU" },
    { ...createEmptyHvacAssignment(), id: "slave", area: "a", protocol: "BACnet", thermostatRole: "Slave" },
  ];
  project.roomTypes = [updateTstatRegistration(createNewRoomType("Room"), rows)];
  return project;
}

test("physical Master selection is explicit, same-RT stable ID and independent of Area/protocol", () => {
  const rows = fixture().roomTypes[0].hvacAssignments, slave = rows[2];
  expect(slave.masterAssignmentId).toBeUndefined(); expect(tstatMasterReference(slave, rows, locations).status).toBe("unselected");
  expect(tstatMasterCandidates(slave, rows).map((row) => row.id)).toEqual(["master-a", "master-b"]);
  expect(canSelectTstatMaster(slave, "master-b", rows)).toBe(true);
  for (const id of ["slave", "missing", "other-room-master"]) expect(canSelectTstatMaster(slave, id, rows)).toBe(false);
  expect(canSelectTstatMaster(rows[0], "master-b", rows)).toBe(false);
  expect(canSelectTstatMaster(slave, "master-a", [...rows, { ...rows[0] }])).toBe(false);
  expect(tstatMasterReference({ ...slave, masterAssignmentId: "master-b" }, rows, locations).label).toBe("TH2");
});

test("missing, self, changed-role and inactive references retain bytes without UUID labels or rebinding", () => {
  const rows = fixture().roomTypes[0].hvacAssignments;
  const slave = { ...rows[2], masterAssignmentId: rows[0].id }; const baseline = JSON.stringify(slave);
  expect(tstatMasterReference(slave, rows.slice(1), locations)).toMatchObject({ status: "missing", label: "Unavailable Master" });
  expect(tstatMasterReference(slave, rows.map((row) => row.id === rows[0].id ? { ...row, thermostatRole: "Slave" } : row), locations).status).toBe("not-master");
  expect(tstatMasterReference({ ...slave, masterAssignmentId: slave.id }, rows, locations).status).toBe("self");
  expect(tstatMasterReference({ ...slave, thermostatRole: "Master" }, rows, locations).status).toBe("inactive");
  expect(tstatMasterReference(slave, [...rows, { ...rows[0] }], locations).status).toBe("ambiguous");
  expect(JSON.stringify(slave)).toBe(baseline);
});

test("optional reference roundtrips migration/save and RT copy remaps known identities only", () => {
  const project = fixture(); const room = project.roomTypes[0]; room.hvacAssignments[2].masterAssignmentId = "master-a";
  room.hvacAssignments.push({ ...createEmptyHvacAssignment(), id: "orphan", thermostatRole: "Slave", masterAssignmentId: "missing-original" });
  const saved = migrateProjectsPayload({ projects: [normalizeProjectSave(project)] })[0];
  expect(saved.roomTypes[0].hvacAssignments.map((row) => row.masterAssignmentId)).toEqual([undefined, undefined, "master-a", "missing-original"]);
  const copied = duplicateRoomType(saved, room.id)!.copy;
  expect(copied.hvacAssignments[2].masterAssignmentId).toBe(copied.hvacAssignments[0].id);
  expect(copied.hvacAssignments[2].masterAssignmentId).not.toBe("master-a");
  expect(copied.hvacAssignments[3].masterAssignmentId).toBe("missing-original");
  const legacy = fixture(); expect(migrateProjectsPayload({ projects: [legacy] })[0].roomTypes[0].hvacAssignments[2]).not.toHaveProperty("masterAssignmentId");
});

test("revision restore/diff preserves physical reference and describes it without internal IDs", () => {
  const project = fixture(), room = project.roomTypes[0]; const before = structuredClone(room);
  room.hvacAssignments[2].masterAssignmentId = "master-a";
  const selected = structuredClone(room);
  room.revisions = [{ id: "selected", revision: "1.00", savedAt: new Date().toISOString(), note: "", snapshot: JSON.stringify(selected) }];
  room.hvacAssignments[2].masterAssignmentId = "master-b";
  const restored = localRevisionRestore(project, { kind: "room-type-revision", roomTypeId: room.id, revisionId: "selected" });
  expect(restored.roomTypes[0].hvacAssignments[2].masterAssignmentId).toBe("master-a");
  const diff = JSON.stringify(buildRevisionChangeEntries(before, selected, { locations, devices: [] }));
  expect(diff).toContain("Reference Master"); expect(diff).toContain("TH1"); expect(diff).not.toContain('"master-a"');
});

test("physical reference changes preserve Area common occupancy settings and typed HVAC values", () => {
  const project = fixture(), room = project.roomTypes[0]; room.switches[0].condition = "Occupied / Vacant";
  room.switches[0].buttonSetting.circuitSettings = [{ circuitId: "light", percentage: "Occupied: 50%\nVacant: Off", valueMode: "text" }];
  const before = JSON.stringify(room.switches);
  const selected = updateTstatRegistration(room, room.hvacAssignments.map((row) => row.id === "slave" ? { ...row, masterAssignmentId: "master-b" } : row));
  expect(JSON.stringify(selected.switches)).toBe(before);
  expect(selected.hvacAssignments[2]).toMatchObject({ masterAssignmentId: "master-b", lowEnd: "20", highEnd: "28" });
});

test("CFS HVAC display resolves the physical Master without changing metric identities", () => {
  const project = fixture(), roomType = project.roomTypes[0]; roomType.hvacAssignments[2].masterAssignmentId = "master-a";
  const rows = buildCfsZoneRows({ roomType, circuits: [], locations, locationById: new Map(locations.map((row) => [row.id, row])),
    areaAddressByAssignmentCircuit: new Map(), palladiomBySceneTargets: new Map(), selectedAreaIds: new Set(locations.map((row) => row.id)), hiddenDeviceKeys: new Set(), sortMode: "device" });
  const slave = rows.find((row) => row.hvacSettingId === "hvac:slave:Setpoint")!;
  expect(slave.device).toBe("Thermostat");
  expect(slave.zone).toBe("Slave"); expect(rowZoneValues(slave)).toEqual(["Slave\nMaster: TH1"]);
  expect(rowZoneValues(slave).join("")).not.toContain("master-a");
});

test("Door label changes without changing persisted group key or legacy visibility migration", () => {
  const scenes = createDefaultRoomScenes(); const door = scenes.find((scene) => roomSceneColumnGroupKey(scene) === DOOR_MAGNET_SCENE_GROUP_KEY)!;
  expect(roomSceneColumnGroupLabel(door)).toBe("Door Magnet Scene");
  expect(roomSceneColumnGroupKey(door)).toBe("scene\u0000DoorMagnetScene");
  expect(upgradeSceneColumnGroupKeys(["scene\u0000Scene"])).toEqual(["scene\u0000Scene", DOOR_MAGNET_SCENE_GROUP_KEY]);
  expect(upgradeSceneColumnGroupKeys([DOOR_MAGNET_SCENE_GROUP_KEY], 2)).toEqual([DOOR_MAGNET_SCENE_GROUP_KEY]);
});

test("TSTAT and Project actual xlsx keep concise TH Master labels, notes and missing-reference warnings", async ({}, info) => {
  const project = fixture(), room = project.roomTypes[0]; room.hvacAssignments[2].masterAssignmentId = "master-a";
  room.hvacAssignments[2].note = "=literal\nSecond line";
  room.hvacAssignments.push({ ...createEmptyHvacAssignment(), id: "orphan", thermostatRole: "Slave", masterAssignmentId: "missing-original" });
  const book = new ExcelJS.Workbook(); appendHvacSheets(book, { assignments: room.hvacAssignments, seasons: room.hvacSeasons, locations });
  const projectBook = new ExcelJS.Workbook(); const exportResult = appendProjectExcelSheets(projectBook, project, { devices: [], wattPerPdu: 3.3,
    buildCfsModel: () => ({ visibleBaseColumns: BASE_COLUMNS.filter((column) => column.key === "detail"), visibleFunctionColumns: [], displayedRows: [],
      headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
      mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map() },
      highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
      resolvers: { baseValues: () => [], functionValues: () => [], baseColumnLabel: (column) => column.label, hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false,
        hasAreaSceneValueCell: () => false, hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false } }) });
  const individual = info.outputPath("reference-tstat.xlsx"), all = info.outputPath("reference-project.xlsx");
  await book.xlsx.writeFile(individual); await projectBook.xlsx.writeFile(all);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(individual);
  expect(loaded.worksheets[0].getCell("I4").value).toBe("TH1");
  expect(loaded.worksheets[0].getCell("H4").value).toBe("=literal\nSecond line");
  expect(loaded.worksheets[0].getCell("I5").value).toBe("Unavailable Master");
  expect(loaded.worksheets[0].getCell("I4").alignment.wrapText).toBe(true);
  expect(exportResult.index.some((entry) => entry.tab === "Door Magnet Scene")).toBe(true);
  const projectLoaded = new ExcelJS.Workbook(); await projectLoaded.xlsx.readFile(all);
  const tstat = projectLoaded.worksheets.find((sheet) => sheet.name.endsWith(" - TSTAT"))!;
  expect(tstat.getCell("I4").value).toBe("TH1");
  expect(JSON.stringify(tstat.getSheetValues())).not.toContain("master-a");
});
