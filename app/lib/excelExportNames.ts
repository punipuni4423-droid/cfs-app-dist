import type { RoomType } from "../types";
import { uniqueExcelSheetName } from "./excelSheetName";

type RoomName = Pick<RoomType, "name" | "revision">;

export function excelRevisionPart(room: Pick<RoomType, "revision">): string {
  return `Rev${room.revision.trim() || "1.00"}`;
}

export function roomTypeIndexLabel(room: RoomName, fallback = "Room"): string {
  return `${room.name.trim() || fallback} ${excelRevisionPart(room)}`;
}

export function uniqueRoomTypeExcelSheetName(room: RoomName, used: Set<string>, tab?: string, fallback = "Room"): string {
  const revision = room.revision.trim() || "1.00";
  const ending = `R${revision}${tab ? ` - ${tab}` : ""}`;
  return uniqueExcelSheetName(room.name, fallback, used, ending);
}

export function excelExportDatePart(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}`;
}

function safeExcelFilePart(value: string, fallback: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || fallback;
}

export function roomTypeExcelFilename(project: string, room: RoomName, kind: "CFS_view" | "TSTAT" | "Backlight"): string {
  return `${safeExcelFilePart(project, "Project")}_${safeExcelFilePart(room.name, "Room")}_${safeExcelFilePart(excelRevisionPart(room), "Rev1.00")}_${kind}.xlsx`;
}

export function projectExcelFilename(project: string, kind: "CFS_ALL" | "Project", date: Date): string {
  return `${safeExcelFilePart(project, "Project")}_${kind}_${excelExportDatePart(date)}.xlsx`;
}
