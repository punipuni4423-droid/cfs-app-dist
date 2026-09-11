"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { DeviceMaster } from "../types";
import { getDeviceAddresses } from "../lib/constants";

interface DeviceSelectModalProps {
  devices: DeviceMaster[];
  onSelect: (device: DeviceMaster) => void;
  onClose: () => void;
}

export default function DeviceSelectModal({
  devices,
  onSelect,
  onClose,
}: DeviceSelectModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    function controls(): HTMLButtonElement[] {
      return Array.from(panel?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])
        .filter((button) => button.tabIndex >= 0 && button.getClientRects().length > 0);
    }
    (controls()[0] ?? panel)?.focus({ preventScroll: true });
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = controls();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel?.focus({ preventScroll: true });
      } else if (!panel?.contains(document.activeElement) || document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  function handleSelect(device: DeviceMaster): void {
    onSelect(device);
    onClose();
  }

  const modal = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 9200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        className="card card-padded"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: 480, width: "90%", maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} style={{ margin: "0 0 16px" }}>Select Device</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {devices.map((d) => {
            const addressCount = getDeviceAddresses(d.model).length;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => handleSelect(d)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "12px 8px",
                  borderBottom: "1px solid var(--border)",
                  background: "none",
                  border: "none",
                  borderBlockEnd: "1px solid var(--border)",
                  cursor: "pointer",
                  borderRadius: 0,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "var(--bg-hover, rgba(0,0,0,0.04))";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "none";
                }}
              >
                <div style={{ fontWeight: 700 }}>{d.model}</div>
                <div style={{ fontSize: "0.85em", opacity: 0.7, marginTop: 2 }}>
                  {d.control} &middot; {addressCount} zones
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(modal, document.body);
}
