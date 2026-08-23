"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import CfsView from "../components/CfsView";
import {
  cfsWindowChannelName,
  type CfsWindowMessage,
  type CfsWindowSnapshot,
} from "../lib/cfsWindowSync";

function CfsWindowContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project") ?? "";
  // "pinned": fixed room type chosen in this window (does not follow the
  // main window). Default "linked": mirrors the main window's active room type.
  const pinned = searchParams.get("mode") === "pinned";
  const [pinnedRoomTypeId, setPinnedRoomTypeId] = useState<string>(
    () => searchParams.get("roomType") ?? "",
  );
  const [snapshot, setSnapshot] = useState<CfsWindowSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>("");
  const connectedRef = useRef(false);

  useEffect(() => {
    if (!projectId || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(cfsWindowChannelName(projectId));
    let staleTimer = 0;
    const markAlive = (): void => {
      connectedRef.current = true;
      setConnected(true);
      window.clearTimeout(staleTimer);
      // The main window pings every 5s; treat a long silence as a lost link.
      staleTimer = window.setTimeout(() => {
        connectedRef.current = false;
        setConnected(false);
      }, 12000);
    };
    channel.onmessage = (event) => {
      const message = event.data as CfsWindowMessage | undefined;
      if (!message) return;
      if (message.type === "snapshot") {
        setSnapshot(message.snapshot);
        setLastUpdatedAt(new Date(message.snapshot.sentAt).toLocaleTimeString());
        markAlive();
      } else if (message.type === "ping") {
        markAlive();
      } else if (message.type === "closed") {
        connectedRef.current = false;
        setConnected(false);
      }
    };
    channel.postMessage({ type: "request" } satisfies CfsWindowMessage);
    const retry = window.setInterval(() => {
      if (!connectedRef.current) {
        channel.postMessage({ type: "request" } satisfies CfsWindowMessage);
      }
    }, 3000);
    return () => {
      window.clearTimeout(staleTimer);
      window.clearInterval(retry);
      channel.close();
    };
  }, [projectId]);

  const roomTypeEntries = useMemo(() => snapshot?.roomTypeEntries ?? [], [snapshot]);
  const pinnedEntry = useMemo(
    () => (pinned ? roomTypeEntries.find((entry) => entry.roomType.id === pinnedRoomTypeId) ?? null : null),
    [pinned, roomTypeEntries, pinnedRoomTypeId],
  );

  // Pinned mode falls back to the first room type when the requested one is
  // missing (deleted in the main window, or no roomType in the URL).
  useEffect(() => {
    if (!pinned || roomTypeEntries.length === 0) return;
    if (roomTypeEntries.some((entry) => entry.roomType.id === pinnedRoomTypeId)) return;
    setPinnedRoomTypeId(roomTypeEntries[0].roomType.id);
  }, [pinned, roomTypeEntries, pinnedRoomTypeId]);

  const view = useMemo(() => {
    if (pinned) {
      return pinnedEntry ? { roomType: pinnedEntry.roomType, circuits: pinnedEntry.circuits } : null;
    }
    return snapshot ? { roomType: snapshot.roomType, circuits: snapshot.circuits } : null;
  }, [pinned, pinnedEntry, snapshot]);

  useEffect(() => {
    document.title = snapshot && view
      ? `CFS - ${snapshot.projectName} / ${view.roomType.name}${pinned ? " (Fixed)" : ""}`
      : pinned ? "CFS - Fixed Window" : "CFS - Sub Window";
  }, [snapshot, view, pinned]);

  return (
    <main className="cfs-window-main">
      <div className="cfs-window-status-bar">
        <strong>{snapshot?.projectName ?? "-"}</strong>
        {pinned ? <span className="cfs-window-mode">Fixed</span> : null}
        {pinned && roomTypeEntries.length > 0 ? (
          <select
            className="cfs-window-room-select"
            aria-label="Room type"
            value={pinnedEntry ? pinnedRoomTypeId : ""}
            onChange={(event) => setPinnedRoomTypeId(event.target.value)}
          >
            {roomTypeEntries.map((entry) => (
              <option key={entry.roomType.id} value={entry.roomType.id}>
                {entry.roomType.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="cfs-window-room">{view?.roomType.name ?? "-"}</span>
        )}
        <span className="toolbar-spacer" />
        <span className={`cfs-window-status${connected ? " is-connected" : " is-disconnected"}`}>
          {connected ? "Linked" : "Waiting for the main window..."}
        </span>
        {lastUpdatedAt ? <span className="cfs-window-updated">Updated {lastUpdatedAt}</span> : null}
      </div>
      {!projectId ? (
        <p className="screen-empty">No project specified.</p>
      ) : snapshot && view ? (
        <CfsView
          key={view.roomType.id}
          projectName={snapshot.projectName}
          roomType={view.roomType}
          circuits={view.circuits}
          devices={snapshot.devices}
          locations={snapshot.locations}
          programmingNameSettings={snapshot.programmingNameSettings}
          canEdit={false}
        />
      ) : (
        <p className="screen-empty">
          Waiting for the main window. Keep the project open on the CFS tab in the main window.
        </p>
      )}
    </main>
  );
}

export default function CfsWindowPage() {
  return (
    <Suspense fallback={null}>
      <CfsWindowContent />
    </Suspense>
  );
}
