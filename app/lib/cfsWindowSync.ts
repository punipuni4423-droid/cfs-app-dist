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

export interface CfsWindowSnapshot {
  projectName: string;
  roomType: RoomType;
  circuits: CircuitEntry[];
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
