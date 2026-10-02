// Pure tests: no browser, server, API, project store or user data access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { formatProgrammingName, normalizeProgrammingNameSettings, isProgrammingNameSettings } = require('../../app/lib/programmingNameSettings.ts');
const { cfsRowProgrammingNameValues } = require('../../app/lib/cfsBaseColumnValues.ts');
const { buildLutronAutomationSpec } = require('../../app/lib/lutronSpec.ts');
const { createDefaultDevices } = require('../../app/lib/constants.ts');
const { OTHER_AREA_ID } = require('../../app/lib/cfsTableModel.ts');

const values = { locationNumber: '16', designerNumber: '2', area: 'BM', address: '1', device: 'A1-ZN1', areaAddress: 'BM1' };
function settings(tokens = ['area', 'address'], extra = {}) {
  return normalizeProgrammingNameSettings({ tokens, bracketStyle: 'square', tokenSeparator: '', detailSeparator: ' ', ...extra });
}
function row(areaAddress = 'BM1', locationId = 'area-1', location = 'Bedroom') {
  return {
    id: 'row-1', orderIndex: 0, device: 'MQSE-4A1-D', deviceNum: '1', zone: 'Zn1', group: '', address: 'Zn1', daliLine: '', isDali: false,
    location, locationId, locationColor: '', circuits: [{ id: 'circuit-1', designerNumber: '1', internalNumber: '', dimmingType: 'Phase',
      location, locationId, locationColor: '', areaAddress, detail: 'Downlight', circuit: {} }],
  };
}
function project(locations, area = locations[0].id) {
  return {
    id: 'synthetic-programming', name: 'Programming pure test', updatedAt: '2026-10-02T00:00:00.000Z', locations,
    fixtures: [{ id: 'fixture-1', fixture: 'DL-1', fixtureType: 'DL', powerMode: 'VA', watt: '10', powerFactor: '1' }],
    circuits: [{ id: 'circuit-1', circuitGroupId: 'group-1', daliFixtureGroupId: '', designerNumber: '1', internalNumber: '',
      dimmingType: 'Phase', fixture: 'DL-1', pcs: '1', detail: 'Downlight', area, ffe: false, energySaving: false }],
    roomTypes: [{ id: 'room-1', name: 'A', updatedAt: '2026-10-02T00:00:00.000Z', revision: '1.00', revisions: [], rows: [],
      deviceAssignments: [{ id: 'assignment-1', deviceGroupId: 'device-1', device: 'MQSE-4A1-D', deviceNum: '1', zoneAddress: 'Zn1', circuitNumber: '1', detail: 'Downlight', group: '' }],
      hvacAssignments: [], hvacSeasons: [], scenes: [], roomScenes: [], switches: [], pduDeviceCounts: [], inspectionMarks: [] }],
  };
}

test('all bracket and separator choices wrap the combined address once', () => {
  for (const [bracketStyle, left, right] of [['square', '[', ']'], ['round', '(', ')'], ['curly', '{', '}'], ['angle', '<', '>'], ['none', '', '']]) {
    for (const tokenSeparator of ['', ' ', '-', '_', '/']) {
      const configured = settings(['area', 'address', 'device'], { bracketStyle, tokenSeparator, detailSeparator: ' / ' });
      assert.equal(formatProgrammingName(values, '  Foyer DL  ', configured), `${left}BM1${right}${tokenSeparator}${left}A1-ZN1${right} / Foyer DL`);
    }
  }
});

test('default and legacy combined token change, explicit single/reordered selections do not', () => {
  assert.equal(formatProgrammingName(values, 'Downlight', normalizeProgrammingNameSettings()), '[16][2][BM1][A1-ZN1] Downlight');
  for (const [tokens, expected] of [
    [['areaAddress', 'designerNumber'], '[BM1]_[2]'], [['area'], '[BM]'], [['address'], '[1]'],
    [['address', 'area'], '[1]_[BM]'], [['area', 'device', 'address'], '[BM]_[A1-ZN1]_[1]'], [[], ''],
  ]) {
    const configured = settings(tokens, { tokenSeparator: '_' });
    const before = JSON.stringify(configured);
    assert.equal(formatProgrammingName(values, '', configured), expected);
    assert.equal(JSON.stringify(configured), before);
    assert.equal(isProgrammingNameSettings(configured), true);
  }
  assert.deepEqual(settings(['areaAddress']).tokens, ['area', 'address']);
  assert.equal(formatProgrammingName(values, ' Detail ', settings([])), 'Detail');
});

test('missing optional input and empty parts retain useful legacy values', () => {
  const { areaAddress, ...legacy } = values;
  assert.equal(formatProgrammingName(legacy, '', settings()), '[BM1]');
  assert.equal(formatProgrammingName({ ...legacy, areaAddress: '', address: '' }, '', settings()), '[BM]');
  assert.equal(formatProgrammingName({ ...legacy, area: '', address: '1' }, '', settings()), '[1]');
  assert.equal(formatProgrammingName({ ...legacy, area: '', address: '' }, 'Detail', settings()), 'Detail');
});

test('CFS and Lutron use canonical addresses after duplicate code resolution without mutating input', () => {
  const locations = [
    { id: 'area-1', name: 'Bedroom', code: 'BE', number: '1', color: '' },
    { id: 'area-2', name: 'Bathroom', code: 'BE', number: '2', color: '' },
  ];
  const input = project(locations, 'area-2');
  const before = JSON.stringify(input);
  const devices = createDefaultDevices();
  const spec = buildLutronAutomationSpec({ project: input, roomTypeId: 'room-1', devices });
  const zone = spec.zones.find(item => item.kind === 'lighting');
  assert.deepEqual(zone.areaAddresses, ['B11']);
  assert.deepEqual(zone.programmingNames, ['[2][1][B11][A1-1] Downlight']);
  assert.deepEqual(cfsRowProgrammingNameValues(row('B11', 'area-2', 'Bathroom'), { locations, devices }), zone.programmingNames);
  assert.equal(JSON.stringify(input), before);
});

test('Other keeps 99 and suppresses the area when Location Number is selected', () => {
  const locations = [{ id: OTHER_AREA_ID, name: 'Other', code: 'OT', number: '', color: '' }];
  const devices = createDefaultDevices();
  const sourceRow = row('OT1', OTHER_AREA_ID, 'Other');
  for (const [tokens, expected] of [
    [['area', 'address'], '[991] Downlight'], [['locationNumber', 'area', 'address'], '[99][1] Downlight'],
    [['area'], '[99] Downlight'], [['address'], '[1] Downlight'],
  ]) {
    const programmingNameSettings = settings(tokens);
    assert.deepEqual(cfsRowProgrammingNameValues(sourceRow, { locations, devices, programmingNameSettings }), [expected]);
    const input = project(locations);
    input.settings = { programmingName: programmingNameSettings };
    const spec = buildLutronAutomationSpec({ project: input, roomTypeId: 'room-1', devices });
    assert.deepEqual(spec.zones.find(item => item.kind === 'lighting').programmingNames, [expected]);
  }
  assert.deepEqual(cfsRowProgrammingNameValues(row('', OTHER_AREA_ID, 'Other'), { locations, devices, programmingNameSettings: settings() }), ['[99] Downlight']);
  const namedOther = [{ ...locations[0], id: 'named-other', code: '', number: '7' }];
  assert.deepEqual(cfsRowProgrammingNameValues(row('OTHER1', 'named-other', 'Other'), { locations: namedOther, devices, programmingNameSettings: settings(['locationNumber', 'area', 'address']) }), ['[7][1] Downlight']);
});

test('DALI, CCI and CCO device tokens and multi-circuit order remain unchanged', () => {
  const locations = [{ id: 'area-1', name: 'Bedroom', code: 'BM', number: '16', color: '' }];
  const base = row();
  for (const [zone, isDali, code, expectedDevice] of [
    ['Zn1', false, 'A', 'A1-1'], ['CCI2', false, 'A', 'A1-I2'], ['CCO3', false, 'A', 'A1-O3'],
    ['Zn7', true, '2D', '2D1-2-G3-7'], ['Zn7', true, '1D', '1D1-G3-7'],
  ]) {
    const sourceRow = { ...base, zone, isDali, daliLine: '2', group: 'G3' };
    sourceRow.circuits = [...base.circuits, { ...base.circuits[0], id: 'circuit-2', areaAddress: 'BM2', detail: 'Second' }];
    assert.deepEqual(cfsRowProgrammingNameValues(sourceRow, { locations, devices: [{ model: base.device, programmingCode: code }], programmingNameSettings: settings(['area', 'address', 'device']) }),
      [`[BM1][${expectedDevice}] Downlight`, `[BM2][${expectedDevice}] Second`]);
  }
});
