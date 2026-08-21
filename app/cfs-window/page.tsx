"use client";

import { Suspense, useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    document.title = snapshot
      ? `CFS - ${snapshot.projectName} / ${snapshot.roomType.name}`
      : "CFS - Sub Window";
  }, [snapshot]);

  return (
    <main className="cfs-window-main">
      <div className="cfs-window-status-bar">
        <strong>{snapshot?.projectName ?? "-"}</strong>
        <span className="cfs-window-room">{snapshot?.roomType.name ?? "-"}</span>
        <span className="toolbar-spacer" />
        <span className={`cfs-window-status${connected ? " is-connected" : " is-disconnected"}`}>
          {connected ? "Linked" : "Waiting for the main window..."}
        </span>
        {lastUpdatedAt ? <span className="cfs-window-updated">Updated {lastUpdatedAt}</span> : null}
      </div>
      {!projectId ? (
        <p className="screen-empty">No project specified.</p>
      ) : snapshot ? (
        <CfsView
          projectName={snapshot.projectName}
          roomType={snapshot.roomType}
          circuits={snapshot.circuits}
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
