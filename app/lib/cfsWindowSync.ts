import type {
  CircuitEntry,
  DeviceMaster,
  LocationMaster,
  ProgrammingNameSettings,
  RoomType,
} from "../types";

// Read-only CFS sub-window sync. The main window (ProjectScreen) broadcasts
// state snapshots over a BroadcastChannel; the /cfs-window route renders them
// with CfsView in view-only mode. Same-browser/same-origin only by design.

export interface CfsWindowRoomTypeEntry {
  roomType: RoomType;
  circuits: CircuitEntry[];
}

export interface CfsWindowSnapshot {
  projectName: string;
  // Active room type in the main window (linked mode follows this).
  roomType: RoomType;
  circuits: CircuitEntry[];
  // Every room type of the project (revision snapshots stripped) so a
  // pinned-mode window can show a fixed room type and switch on its own.
  roomTypeEntries?: CfsWindowRoomTypeEntry[];
  devices: DeviceMaster[];
  locations: LocationMaster[];
  programmingNameSettings?: ProgrammingNameSettings;
  sentAt: number;
}

export type CfsWindowMessage =
  | { type: "request" }
  | { type: "ping" }
  | { type: "closed" }
  | { type: "snapshot"; snapshot: CfsWindowSnapshot };

export function cfsWindowChannelName(projectId: string): string {
  return `cfs-window-sync-${projectId}`;
}

export type CfsWindowMode = "linked" | "pinned";

// Strip bulky revision snapshots before broadcasting a room type.
export function stripRoomTypeForWindow(roomType: RoomType): RoomType {
  return { ...roomType, revisions: [] };
}

export function cfsWindowUrl(projectId: string, mode: CfsWindowMode, roomTypeId?: string): string {
  const params = new URLSearchParams({ project: projectId });
  if (mode === "pinned") {
    params.set("mode", "pinned");
    if (roomTypeId) params.set("roomType", roomTypeId);
  }
  return `/cfs-window?${params.toString()}`;
}
