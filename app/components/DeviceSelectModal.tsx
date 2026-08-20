"use client";

import { useEffect, useCallback } from "react";
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
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

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
        style={{ maxWidth: 480, width: "90%", maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 16px" }}>Select Device</h3>

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
