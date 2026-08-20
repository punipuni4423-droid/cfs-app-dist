import type { ProjectData, RoomType } from '../types';
import { CFS_COLUMNS } from './constants';

function safeSheetName(name: string, used: Set<string>): string {
  const sanitized = name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
  let candidate = sanitized;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = `_${i}`;
    candidate = sanitized.slice(0, 31 - suffix.length) + suffix;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function safeFilePart(value: string, fallback: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_') || fallback;
}

function triggerWorkbookDownload(buffer: ArrayBuffer, filename: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

export function exportRoomTypeToExcel(
  project: ProjectData,
  roomType: RoomType,
): void {
  void exportRoomTypeToExcelAsync(project, roomType);
}

export async function exportRoomTypeToExcelAsync(
  project: ProjectData,
  roomType: RoomType,
): Promise<void> {
  const ExcelJSModule = await import('exceljs');
  const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();

  const wsCfs = workbook.addWorksheet(safeSheetName(roomType.name, used));
  wsCfs.columns = [
    { header: 'No', key: 'No', width: 8 },
    ...CFS_COLUMNS.map((col) => ({ header: col.label, key: col.key, width: 18 })),
  ];
  roomType.rows.forEach((row, index) => {
    const item: Record<string, string | number> = { No: index + 1 };
    for (const col of CFS_COLUMNS) {
      const raw = row[col.key];
      if (col.type === 'number' && raw !== '') {
        const parsed = Number.parseFloat(raw);
        item[col.key] = Number.isFinite(parsed) ? parsed : raw;
      } else {
        item[col.key] = raw;
      }
    }
    wsCfs.addRow(item);
  });

  const wsMeta = workbook.addWorksheet(safeSheetName('Metadata', used));
  wsMeta.columns = [
    { header: 'Field', key: 'field', width: 18 },
    { header: 'Value', key: 'value', width: 36 },
  ];
  wsMeta.addRows([
    { field: 'ProjectName', value: project.name },
    { field: 'RoomType', value: roomType.name },
    { field: 'UpdatedAt', value: roomType.updatedAt },
    { field: 'ExportedAt', value: new Date().toISOString() },
    { field: 'RowCount', value: roomType.rows.length },
  ]);

  const safeProject = safeFilePart(project.name, 'Project');
  const safeRoom = safeFilePart(roomType.name, 'RoomType');
  const buffer = await workbook.xlsx.writeBuffer();
  triggerWorkbookDownload(buffer as ArrayBuffer, `${safeProject}_${safeRoom}_CFS.xlsx`);
}
