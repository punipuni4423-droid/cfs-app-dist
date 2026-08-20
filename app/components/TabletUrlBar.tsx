"use client";

import { useEffect, useState } from "react";

interface TabletUrlResponse {
  url?: string;
}

export default function TabletUrlBar() {
  const [tabletUrl, setTabletUrl] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tablet-url", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: TabletUrlResponse | null) => {
        if (!cancelled && payload?.url) setTabletUrl(payload.url);
      })
      .catch(() => {
        if (!cancelled) setTabletUrl(window.location.origin);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function copyUrl(): Promise<void> {
    if (!tabletUrl) return;
    try {
      await navigator.clipboard.writeText(tabletUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  return (
    <div className="tablet-url-bar" aria-label="Tablet access URL">
      <span className="tablet-url-label">Tablet URL</span>
      <input
        className="tablet-url-input"
        type="text"
        readOnly
        value={tabletUrl || "Loading..."}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="Tablet URL"
      />
      <button
        type="button"
        className="tablet-url-copy"
        onClick={() => void copyUrl()}
        disabled={!tabletUrl}
      >
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select" : "Copy"}
      </button>
    </div>
  );
}
