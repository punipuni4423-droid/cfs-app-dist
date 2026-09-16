import { test, expect } from '@playwright/test';
import { test as browserTest } from './support/safe-test';
import { installLocalEditingMocks } from './support/secure-sharing-mock';
import { createEmptyCircuitEntry, createEmptyCurtainAssignment, createEmptyDeviceAssignment, createEmptyHvacAssignment, createEmptySwitchEntry, createNewRoomType } from '../../app/lib/constants';
import { createNewProject } from '../../app/lib/storage';
import { buildCfsZoneRows, isReservedCfsRow } from '../../app/lib/useCfsZoneRows';
import { appendCfsSheet, type CfsExcelSheetModel } from '../../app/lib/cfsExcelExport';
import type { CfsZoneRow } from '../../app/lib/cfsTableModel';
import type { DeviceAssignment, ProjectData } from '../../app/types';
import ExcelJS from 'exceljs';

const devices = ['MQSE-4S1-D', 'QSE-IO', 'QSE-CI-WCI'];
const bedroom = { id: 't137-bedroom', name: 'Bedroom', number: '1', code: 'BR', color: '#C7D2FE' };
function assignment(id: string, values: Partial<DeviceAssignment> = {}): DeviceAssignment {
  return { ...createEmptyDeviceAssignment(), id, deviceGroupId: id, device: 'MQSE-4S1-D', deviceNum: '1', zoneAddress: 'CCO', area: bedroom.id, ...values };
}
function projectWith(assignments: DeviceAssignment[]): ProjectData {
  const circuit = { ...createEmptyCircuitEntry('L-1'), id: 't137-light', circuitGroupId: 't137-light', designerNumber: 'L-1', internalNumber: '1', dimmingType: 'On/Off', detail: 'Synthetic light', area: bedroom.id };
  const room = { ...createNewRoomType('T137 Room'), id: 't137-room', rows: [], roomScenes: [], deviceAssignments: assignments, circuitIds: [circuit.id] };
  return { ...createNewProject('T137 Synthetic'), id: 't137-project', locations: [bedroom], circuits: [circuit], roomTypes: [room] };
}
function rowsOf(project: ProjectData): CfsZoneRow[] {
  return buildCfsZoneRows({ roomType: project.roomTypes[0], circuits: project.circuits, locations: project.locations,
    locationById: new Map(project.locations.map(location => [location.id, location])), areaAddressByAssignmentCircuit: new Map(),
    palladiomBySceneTargets: new Map(project.roomTypes[0].switches.map(sw => [sw.switchGroupId, sw])), selectedAreaIds: new Set(), hiddenDeviceKeys: new Set(), sortMode: 'device', showCciRows: true });
}

for (const device of devices) {
  for (const zoneAddress of ['CCO', 'CCI']) {
    for (const circuitNumber of ['', 'Reserved']) {
      test(`Area-only ${device} ${zoneAddress} ${circuitNumber || 'empty'} is Reserved`, () => {
        const [row] = rowsOf(projectWith([assignment('empty', { device, zoneAddress, circuitNumber, detail: ' \t ' })]));
        expect(row.location).toBe('Bedroom');
        expect(row.circuits).toHaveLength(0);
        expect(row.assignmentValue).toBe('');
        expect(isReservedCfsRow(row)).toBe(true);
      });
    }
  }
  for (const detail of ['Bedroom', 'On/Off', 'Sheer Open', 'DND Indicator', 'MUR Indicator', 'Defogger']) {
    test(`preserve Detail ${device} ${detail}`, () => {
      const [row] = rowsOf(projectWith([assignment('detail', { device, detail })]));
      expect(isReservedCfsRow(row)).toBe(false);
      if (detail === 'Bedroom') {
        expect(row.assignmentDetail).toBe('');
        expect(row.location).toBe('Bedroom');
      } else expect(row.assignmentDetail).toBe(detail);
    });
  }
}

function mixedProject() {
  const project = projectWith([
    assignment('empty-4s-cco', { deviceNum: '2' }),
    assignment('empty-io-cci', { device: 'QSE-IO', zoneAddress: 'CCI1' }),
    assignment('empty-wci', { device: 'QSE-CI-WCI', zoneAddress: 'CCI1', circuitNumber: 'Reserved' }),
    assignment('detail-location', { deviceNum: '3', detail: 'Bedroom' }),
    assignment('detail-operation', { deviceNum: '4', detail: 'On/Off' }),
    assignment('dnd', { device: 'QSE-IO', zoneAddress: 'CCO1', circuitNumber: 'DND Indicator', detail: 'Entrance DND' }),
    assignment('lighting', { deviceNum: '5', circuitNumber: 'L-1', ccoLighting: true }),
    assignment('cci', { deviceNum: '6', zoneAddress: 'CCI', circuitNumber: 'Door Magnet', detail: 'Entry door' }),
    assignment('zone', { deviceNum: '7', zoneAddress: 'Zn1', circuitNumber: 'L-1' }),
    assignment('empty-zone', { deviceNum: '8', zoneAddress: 'Zn1' }),
  ]);
  const room = project.roomTypes[0];
  room.hvacAssignments = [{ ...createEmptyHvacAssignment(), id: 't137-hvac', area: bedroom.id }];
  room.curtainAssignments = [{ ...createEmptyCurtainAssignment(), id: 't137-curtain', area: bedroom.id, detail: 'Window' }];
  const target = { ...createEmptySwitchEntry('lutronPd'), id: 't137-target', switchGroupId: 't137-target-group', switchNumber: 'SW1', switchName: 'Bedside', buttonCount: '1', buttonLabel: 'B1', buttonFunction: 'Scene' };
  const source = { ...createEmptySwitchEntry('lutronPd'), id: 't137-source', switchGroupId: 't137-source-group', switchNumber: 'SW2', switchName: 'Entry', buttonCount: '1', buttonLabel: 'B1', buttonFunction: 'Scene', backlightTarget: target.switchGroupId, backlightCondition: 'Base' };
  room.switches = [target, source];
  return project;
}

test('mixed assignments retain lighting, CCI, zones, HVAC, Curtain and Backlight', () => {
  const rows = rowsOf(mixedProject());
  const reserved = rows.filter(isReservedCfsRow).map(row => row.id).sort();
  expect(reserved).toEqual(['empty-4s-cco', 'empty-io-cci', 'empty-wci', 'empty-zone']);
  expect(rows.some(row => row.ccoLighting && row.circuits.length === 1)).toBe(true);
  expect(rows.filter(row => row.isHvac)).toHaveLength(4);
  expect(rows.filter(row => row.isCurtain)).toHaveLength(1);
  expect(rows.filter(row => row.isBacklight)).toHaveLength(1);
});

test('Excel gray rows equal Reserved rows for the same generated model', async () => {
  const rows = rowsOf(mixedProject());
  const workbook = new ExcelJS.Workbook();
  const model: CfsExcelSheetModel = {
    visibleBaseColumns: [{ key: 'detail', label: 'Detail', minWidth: 170 }], visibleFunctionColumns: [], displayedRows: rows,
    headerGroups: { switchGroups: [], buttonGroups: [], functionNameGroups: [], conditionGroups: [] },
    mergeInfo: { device: new Map(), dimming: new Map(), designer: new Map(), zone: new Map(), daliGroup: new Map(), backlight: new Map() },
    highlights: { ffe: false, energySaving: false, areaScene: false, individualOverride: false, inspectionMark: false }, expandedPirHeaderKeys: new Set(),
    resolvers: { baseValues: row => [row.id], functionValues: () => [], baseColumnLabel: col => col.label,
      hasChangedBaseCell: () => false, hasChangedFunctionCell: () => false, hasAreaSceneValueCell: () => false,
      hasSceneDifferentOverride: () => false, hasInspectionMarkForCell: () => false, isPriorityTriggerColumn: () => false },
  };
  appendCfsSheet(workbook, 'All', model);
  appendCfsSheet(workbook, 'Hidden', { ...model, displayedRows: rows.filter(row => !isReservedCfsRow(row)) });
  const roundtrip = new ExcelJS.Workbook();
  await roundtrip.xlsx.load(await workbook.xlsx.writeBuffer());
  const gray: string[] = [];
  roundtrip.getWorksheet('All')!.eachRow(row => {
    const cell = row.getCell(1);
    if (cell.fill.type === 'pattern' && cell.fill.fgColor?.argb === 'FFC4C9CF') gray.push(String(cell.value));
  });
  expect(gray.sort()).toEqual(['empty-4s-cco', 'empty-io-cci', 'empty-wci', 'empty-zone']);
  expect(gray.sort()).toEqual(rows.filter(isReservedCfsRow).map(row => row.id).sort());
});

for (const width of [1280, 390]) {
  browserTest(`CFS Hide Reserved and Excel visible rows at ${width}`, async ({ page }, info) => {
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const project = mixedProject();
    const state = await installLocalEditingMocks(page);
    // View mode prevents Device Assign normalization from altering the synthetic input.
    await page.context().route('**/api/collaboration/status**', route => route.fulfill({ json: { enabled: true, mode: 'view', projectId: project.id, lock: null, locks: [], lastUpdatedBy: null, leaseSeconds: 90, heartbeatMs: 20000, idleMs: 900000 } }));
    state.projects = [{ ...project }];
    await page.goto('/');
    await page.locator('button.screen-card').filter({ hasText: project.name }).click();
    await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
    await page.locator('button.screen-card').filter({ hasText: 'T137 Room' }).click();
    await page.getByRole('tab', { name: 'CFS', exact: true }).click();
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
    await page.getByRole('button', { name: 'Show CCI', exact: true }).click();
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
    const display = page.locator('.cfs-matrix-controls .cfs-filter-menu-trigger').filter({ hasText: /^\s*Display\s*$/ });
    await display.click();
    await page.getByLabel('Hide Reserved', { exact: true }).uncheck();
    await display.click();
    const rows = page.locator('.cfs-matrix-table tbody tr.cfs-fixture-row');
    await expect(rows.filter({ hasText: 'Entrance DND' })).toHaveCount(1);
    await expect(page.locator('.cfs-matrix-table tbody tr.cfs-reserved-row')).toHaveCount(4);
    const allCount = await rows.count();
    await page.screenshot({ path: info.outputPath(`cfs-${width}-hide-off.png`), fullPage: true });
    await display.click();
    await page.getByLabel('Hide Reserved', { exact: true }).check();
    await display.click();
    await expect(rows).toHaveCount(allCount - 4);
    await expect(page.locator('.cfs-matrix-table tbody tr.cfs-reserved-row')).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Entrance DND' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Entry door' })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`cfs-${width}-hide-on.png`), fullPage: true });
    for (const exportName of ['This Room Type', 'All Rooms']) {
      await page.getByRole('button', { name: 'Excel Export', exact: true }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: exportName, exact: true }).click();
      const file = info.outputPath(`${width}-${exportName.replaceAll(' ', '-')}.xlsx`);
      await (await download).saveAs(file);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(file);
      expect(workbook.worksheets[0].rowCount - 4).toBe(allCount - 4);
    }
    await display.click();
    await page.getByLabel('Hide Reserved', { exact: true }).uncheck();
    await display.click();
    await expect(rows).toHaveCount(allCount);
    expect(errors).toEqual([]);
    expect(state.projects).toEqual([project]);
  });
}
