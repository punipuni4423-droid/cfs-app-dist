import { expect, type Page, type Locator } from './safe-test';
import { installLocalEditingMocks } from './secure-sharing-mock';
import { createNewRoomType, createEmptySwitchEntry, createEmptyRoomScene, createEmptyCircuitEntry, createEmptyDeviceAssignment } from '../../../app/lib/constants';
import type { ProjectData, SwitchEntry } from '../../../app/types';

export const expectedTargets = ['PD-BY - By Scene', 'PD-LEGACY - Legacy By Scene'];
export function seed(): ProjectData {
  const room = createNewRoomType('T140 Room');
  const by = { ...createEmptySwitchEntry('lutronPd'), id: 't140-by-1', switchGroupId: 't140-by', switchNumber: 'PD-BY', switchName: 'By Scene', buttonCount: '2', buttonLabel: '1', backlightAssignment: '' };
  room.switches = [by,
    { ...by, id: 't140-by-2', buttonLabel: '2' },
    { ...createEmptySwitchEntry('lutronPd'), id: 't140-legacy', switchGroupId: 't140-legacy', switchNumber: 'PD-LEGACY', switchName: 'Legacy By Scene', buttonCount: '1', backlightAssignment: '__byScene' },
    { ...createEmptySwitchEntry('lutronPd'), id: 't140-fixed', switchGroupId: 't140-fixed', switchNumber: 'PD-FIXED', switchName: 'Fixed Sleep', buttonCount: '1', backlightAssignment: 'sleep' },
    { ...createEmptySwitchEntry('lutronPd'), id: 't140-base', switchGroupId: 't140-base', switchNumber: 'PD-BASE', switchName: 'Fixed Base', buttonCount: '1', backlightAssignment: 'base' },
    { ...createEmptySwitchEntry('lutronPico'), id: 't140-pico', switchNumber: 'PICO', switchName: 'Not Palladiom', buttonCount: '1' },
    { ...createEmptySwitchEntry('command'), id: 't140-command', switchNumber: 'CMD', switchName: 'T140 Command', backlightTarget: 't140-by,t140-legacy,t140-base,t140-fixed', backlightCondition: 'masterOn' },
  ];
  const circuit = { ...createEmptyCircuitEntry('T140-L1'), id: 't140-light', circuitGroupId: 't140-light-group', area: 't140-area', detail: 'T140 Light', dimmingType: '0-10V', pcs: '1' };
  room.circuitIds = [circuit.id];
  room.deviceAssignments = [{ ...createEmptyDeviceAssignment(), id: 't140-assignment', device: 'MQSE-4A1-D', deviceNum: '1', zoneAddress: 'Z1', circuitNumber: 'T140-L1' }];
  room.roomScenes = [
    { ...createEmptyRoomScene('Check In', 'T140 Arrival', '', 'Day', 'pms'), id: 't140-arrival', settings: [{ circuitId: circuit.id, percentage: '37' }] },
    { ...createEmptyRoomScene('Check Out', 'T140 Departure', '', 'Night', 'pms'), id: 't140-departure', settings: [{ circuitId: circuit.id, percentage: '62' }] },
  ];
  return { id: 't140-project', name: 'T140 Synthetic Project', updatedAt: new Date().toISOString(),
    locations: [{ id: 't140-area', code: '', name: 'T140 Area', number: '1', color: '#eeeeee' }], fixtures: [], circuits: [circuit], roomTypes: [room] };
}
export async function open(page: Page) {
  const state = await installLocalEditingMocks(page);
  state.projects = [seed() as unknown as Record<string, unknown>];
  await page.goto('/');
  const user = page.getByRole('button', { name: /^User:/ });
  if (await user.isVisible()) {
    await user.click();
    await page.getByPlaceholder('e.g. Okada').fill('T140 Synthetic Tester');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
  }
  await page.locator('button.screen-card').filter({ hasText: 'T140 Synthetic Project' }).click();
  const edit = page.getByRole('button', { name: 'Start editing', exact: true });
  if (await edit.isVisible()) await edit.click();
  await page.getByRole('tab', { name: 'Room Type', exact: true }).click();
  await page.locator('button.screen-card').filter({ hasText: 'T140 Room' }).click();
  await expect(page.getByRole('tab', { name: 'Scene', exact: true })).toBeVisible();
  return state;
}
export async function tab(page: Page, name: string) { await page.getByRole('tab', { name, exact: true }).click(); }
export function panel(page: Page) { return page.locator('.setting-overlay-panel'); }
export async function close(page: Page) { await panel(page).getByRole('button', { name: 'Close', exact: true }).click(); }
export async function targets(page: Page) { return (await panel(page).locator('.switch-target-option').allTextContents()).map(v => v.trim()).sort(); }
export async function readOnlyTargets(scope: Locator) {
  const inputs = scope.locator('.switch-target-list input');
  for (const input of await inputs.all()) { expect.soft(await input.isChecked()).toBeTruthy(); expect.soft(await input.isDisabled()).toBeTruthy(); }
  await expect.soft(scope.locator('.switch-target-list button:not([disabled]), .switch-target-list select:not([disabled])')).toHaveCount(0);
}
export async function scenePanel(page: Page, bulk: boolean) {
  await tab(page, 'Scene');
  if (bulk) {
    await page.locator('.room-scene-pms-table .switch-bulk-select-header input').check();
    await page.locator('.room-scene-bulk-toolbar').getByRole('button', { name: 'Backlight Setting', exact: true }).click();
  } else await page.locator('.room-scene-pms-table tbody tr').first().locator('.setting-status-button').nth(1).click();
  await expect(panel(page)).toBeVisible();
}
export async function save(page: Page) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save current project without a new revision', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('.revision-save-status')).toContainText('Saved');
}
export function assignments(project: Record<string, unknown>) {
  return (project as unknown as ProjectData).roomTypes[0].switches.map((sw: SwitchEntry) => [sw.id, sw.backlightAssignment]);
}
