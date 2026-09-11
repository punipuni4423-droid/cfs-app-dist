"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function PendingCfsDialog({ canConfirm, onChoice }: {
  canConfirm: boolean;
  onChoice: (choice: "confirm" | "discard" | "cancel") => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(
    <div className="cfs-inspection-dialog-backdrop" role="presentation">
      <section ref={panelRef} className="cfs-inspection-dialog" role="dialog" aria-modal="true"
        aria-label="Pending Low/High End changes" onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onChoice("cancel"); }
          if (event.key !== "Tab") return;
          const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
          event.preventDefault(); next?.focus();
        }}>
        <div className="cfs-inspection-dialog-head"><h3>Pending Low/High End changes</h3></div>
        <p>Apply the pending values before continuing, discard them, or cancel to keep editing.</p>
        {!canConfirm ? <p>Confirm is unavailable without edit permission or when a target no longer exists. Cancel keeps your pending values.</p> : null}
        <div className="cfs-inspection-dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onChoice("cancel")}>Cancel</button>
          <button type="button" className="btn btn-secondary" onClick={() => onChoice("discard")}>Discard</button>
          <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={() => onChoice("confirm")}>Confirm</button>
        </div>
      </section>
    </div>, document.body,
  );
}
