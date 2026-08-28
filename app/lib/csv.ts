import type { CircuitEntry, FixtureMaster, LocationMaster } from '../types';
import { FIXTURE_TYPE_OPTIONS, createEmptyCircuitEntry } from './constants';
import { createAppId } from './id';

type CsvPrimitive = string | number | boolean | null | undefined;
type GenericCsvRow = Record<string, CsvPrimitive>;

const UTF8_BOM = '\ufeff';
const LEGACY_BOM_MARKERS = ['ï»¿', '・ｿ'] as const;

export function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stripCsvBom(text: string): string {
  let next = text.replace(/^\ufeff/, '');
  for (const marker of LEGACY_BOM_MARKERS) {
    if (next.startsWith(marker)) next = next.slice(marker.length);
  }
  return next;
}

function decodeBytes(bytes: Uint8Array, label: string, fatal = false): string {
  return new TextDecoder(label, { fatal }).decode(bytes);
}

function countReplacementCharacters(text: string): number {
  return (text.match(/\ufffd/g) ?? []).length;
}

function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripCsvBom(decodeBytes(bytes, 'utf-8'));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripCsvBom(decodeBytes(bytes, 'utf-16le'));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripCsvBom(decodeBytes(bytes, 'utf-16be'));
  }

  try {
    return stripCsvBom(decodeBytes(bytes, 'utf-8', true));
  } catch {
    const utf8 = decodeBytes(bytes, 'utf-8');
    try {
      const shiftJis = decodeBytes(bytes, 'shift_jis');
      return stripCsvBom(
        countReplacementCharacters(shiftJis) < countReplacementCharacters(utf8)
          ? shiftJis
          : utf8,
      );
    } catch {
      return stripCsvBom(utf8);
    }
  }
}

export async function readCsvFileText(file: File): Promise<string> {
  return decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_./#:-]+/g, '');
}

function fieldValue(row: GenericCsvRow, aliases: readonly string[]): string {
  const normalized = new Map<string, CsvPrimitive>();
  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeHeader(key), value);
  }

  for (const alias of aliases) {
    const value = normalized.get(normalizeHeader(alias));
    if (value !== undefined && value !== null) {
      const text = String(value).trim();
      if (text !== '') return text;
    }
  }
  return '';
}

function rowHasField(row: GenericCsvRow, aliases: readonly string[]): boolean {
  const normalized = new Set(Object.keys(row).map(normalizeHeader));
  return aliases.some((alias) => normalized.has(normalizeHeader(alias)));
}

function parseCsvBoolean(value: string): boolean {
  return /^(1|true|yes|y|on|対象|あり|有り|はい|真|オン)$/i.test(value.trim());
}

function inferDimmingType(explicitValue: string, fallbackText: string): string {
  const value = explicitValue.trim();
  if (value) return value;
  if (/dali/i.test(fallbackText)) return 'DALI';
  if (/pwm/i.test(fallbackText)) return 'PWM';
  if (/phase|位相/i.test(fallbackText)) return 'Phase';
  if (/on\s*\/?\s*off|オン\s*\/?\s*オフ|オンオフ/i.test(fallbackText)) return 'On/Off';
  return '';
}

function compactJoin(values: readonly string[]): string {
  return values.filter((value) => value.trim() !== '').join(' / ');
}

function parseCsvRows(text: string): GenericCsvRow[] {
  const source = stripCsvBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0 || source.endsWith(',')) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const [headerRow, ...bodyRows] = rows;
  if (!headerRow) return [];
  const headers = headerRow.map((header, index) => header.trim() || `Column ${index + 1}`);
  return bodyRows
    .filter((values) => values.some((value) => value.trim() !== ''))
    .map((values) => {
      const item: GenericCsvRow = {};
      headers.forEach((header, index) => {
        item[header] = values[index] ?? '';
      });
      return item;
    });
}

function comparableValue(value: string | boolean): string {
  return String(value).trim().replace(/\r\n?/g, '\n');
}

function findLocationByCsvValue(value: string, locations: ReadonlyArray<LocationMaster>): LocationMaster | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return locations.find((location) => {
    return (
      location.id === normalized ||
      location.name.trim() === normalized ||
      location.number.trim() === normalized
    );
  });
}

function circuitAreaToCsvValue(areaId: string, locations: ReadonlyArray<LocationMaster>): string {
  const location = locations.find((candidate) => candidate.id === areaId);
  return location?.name.trim() || areaId;
}

function csvValueToCircuitArea(value: string, locations: ReadonlyArray<LocationMaster>): string {
  return findLocationByCsvValue(value, locations)?.id ?? value;
}

export function fixturesToCsv(fixtures: ReadonlyArray<FixtureMaster>): string {
  const header = ['Fixture', 'Type', 'Power Mode', 'VA/W@', 'Power Factor'];
  const rows = fixtures.map((fx) => [fx.fixture, fx.fixtureType, fx.powerMode, fx.watt, fx.powerFactor]);
  return [header, ...rows]
    .map((row) => row.map(escapeCsvField).join(','))
    .join('\r\n');
}

export async function csvToFixtures(text: string): Promise<FixtureMaster[]> {
  const rows = parseCsvRows(text);

  return rows
    .map((row) => {
      const fixture = fieldValue(row, ['Fixture', 'fixture', '照明器具', '器具', '器具名']);
      const fixtureType = fieldValue(row, [
        'Type',
        'type',
        'fixtureType',
        'FixtureType',
        '種別',
        'タイプ',
      ]) || 'DL';
      const watt = fieldValue(row, ['VA/W@', 'VA / W@', 'W@', 'Watt', 'watt', 'W', '容量']);
      const powerModeRaw = fieldValue(row, [
        'Power Mode',
        'powerMode',
        'Mode',
        '電力モード',
        '単位',
      ]).toUpperCase();
      const powerMode: FixtureMaster['powerMode'] = powerModeRaw === 'W' ? 'W' : 'VA';
      const powerFactor = fieldValue(row, [
        'Power Factor',
        'powerFactor',
        'Correction',
        '力率',
        '補正',
      ]);
      return {
        id: createAppId(),
        fixture,
        // The Type column carries FFE / Night Lamp as first-class fixture types.
        fixtureType: FIXTURE_TYPE_OPTIONS.includes(fixtureType) ? fixtureType : 'DL',
        powerMode,
        watt,
        powerFactor: powerFactor || '0.7',
      };
    })
    .filter((fx) => fx.fixture !== '');
}

export function circuitsToCsv(
  circuits: ReadonlyArray<CircuitEntry>,
  locations: ReadonlyArray<LocationMaster> = [],
): string {
  const header = [
    'Circuit Group ID',
    'DALI Fixture Group ID',
    'Designer #',
    'Internal #',
    'Dimming Type',
    'Area',
    'Fixture',
    'pcs',
    'Detail',
    'FFE',
    'Energy Saving',
  ];
  const rows = circuits.map((c) => [
    c.circuitGroupId,
    c.daliFixtureGroupId,
    c.designerNumber,
    c.internalNumber,
    c.dimmingType,
    circuitAreaToCsvValue(c.area, locations),
    c.fixture,
    c.pcs,
    c.detail,
    c.ffe ? 'TRUE' : '',
    c.energySaving ? 'TRUE' : '',
  ]);
  return [header, ...rows]
    .map((row) => row.map(escapeCsvField).join(','))
    .join('\r\n');
}

export async function csvToCircuits(
  text: string,
  locations: ReadonlyArray<LocationMaster> = [],
): Promise<CircuitEntry[]> {
  const rows = parseCsvRows(text);
  const groupIdByDesigner = new Map<string, string>();

  return rows
    .map((row) => {
      const designerNumber = fieldValue(row, [
        'Designer #',
        'Designer#',
        'Designer Number',
        'Symbol',
        'Circuit #',
        'Circuit',
        'Code',
        '記号',
      ]);
      const internalNumber = fieldValue(row, [
        'Internal #',
        'Internal#',
        'Internal Number',
        'Internal',
        '内部番号',
      ]);
      const fixture = fieldValue(row, [
        'Fixture',
        'Fixture Code',
        'Fixture Type',
        'Fixture Name',
        'Model',
        'Model Number',
        '照明器具',
        '器具',
        '器具名',
        '型番',
      ]);
      const explicitCircuitGroupId = fieldValue(row, [
        'Circuit Group ID',
        'CircuitGroupId',
        'Circuit Group',
        'Group ID',
        'Group',
      ]);
      const daliFixtureGroupId = fieldValue(row, [
        'DALI Fixture Group ID',
        'DaliFixtureGroupId',
        'DALI Fixture Group',
        'Fixture Group ID',
      ]);
      const quantityAliases = [
        'pcs',
        'Qty',
        'Quantity',
        'Count',
        '数量',
        '台数',
      ] as const;
      const quantity = fieldValue(row, quantityAliases);
      const name = fieldValue(row, ['Name', 'Fixture Name', '器具名', '名称']);
      const model = fieldValue(row, ['Model', 'Model Number', '型番']);
      const manufacturer = fieldValue(row, ['Manufacturer', 'Maker', 'メーカー']);
      const note = fieldValue(row, ['Note', 'Remarks', '備考']);
      const detail = fieldValue(row, ['Detail', '詳細']) ||
        compactJoin([name, model, manufacturer, note]);
      const dimmingType = inferDimmingType(
        fieldValue(row, ['Dimming Type', 'Dimming', 'Control', '調光', '制御']),
        compactJoin([detail, note]),
      );

      if (!designerNumber && !fixture && !detail) return null;

      let circuitGroupId = explicitCircuitGroupId;
      if (!circuitGroupId) {
        const designerKey = designerNumber.trim();
        if (designerKey) {
          circuitGroupId = groupIdByDesigner.get(designerKey) ?? createAppId();
          groupIdByDesigner.set(designerKey, circuitGroupId);
        }
      }

      const circuit = createEmptyCircuitEntry(designerNumber, circuitGroupId || undefined);
      circuit.daliFixtureGroupId = daliFixtureGroupId;
      circuit.internalNumber = internalNumber;
      circuit.dimmingType = dimmingType;
      circuit.area = csvValueToCircuitArea(
        fieldValue(row, ['Area', 'Location', 'Room', 'エリア', '場所']),
        locations,
      );
      circuit.fixture = fixture || designerNumber;
      circuit.pcs = quantity || (rowHasField(row, quantityAliases) ? '' : '1');
      circuit.detail = detail;
      circuit.ffe = parseCsvBoolean(fieldValue(row, ['FFE']));
      circuit.energySaving = parseCsvBoolean(
        fieldValue(row, ['Energy Saving', 'EnergySaving', 'Energy Save', '省エネ']),
      );
      return circuit;
    })
    .filter((circuit): circuit is CircuitEntry => circuit !== null);
}

export function fixtureCsvSignature(fixture: FixtureMaster): string {
  return JSON.stringify([
    comparableValue(fixture.fixture),
    comparableValue(fixture.fixtureType),
    comparableValue(fixture.powerMode),
    comparableValue(fixture.watt),
    comparableValue(fixture.powerFactor),
  ]);
}

export function circuitCsvSignature(circuit: CircuitEntry): string {
  return JSON.stringify([
    comparableValue(circuit.designerNumber),
    comparableValue(circuit.internalNumber),
    comparableValue(circuit.dimmingType),
    comparableValue(circuit.area),
    comparableValue(circuit.fixture),
    comparableValue(circuit.pcs),
    comparableValue(circuit.detail),
    comparableValue(circuit.ffe),
    comparableValue(circuit.energySaving),
  ]);
}

export function uniqueByCsvSignature<T>(
  existing: ReadonlyArray<T>,
  imported: ReadonlyArray<T>,
  signature: (item: T) => string,
): { added: T[]; skipped: number } {
  const seen = new Set(existing.map(signature));
  const added: T[] = [];
  let skipped = 0;

  for (const item of imported) {
    const key = signature(item);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    added.push(item);
  }

  return { added, skipped };
}

export function downloadCsv(filename: string, content: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([UTF8_BOM, content], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
