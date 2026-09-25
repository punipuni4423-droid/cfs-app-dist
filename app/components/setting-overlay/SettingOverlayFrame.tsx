"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface SettingOverlayFrameProps {
  title: string;
  activeTab: "sceneValue" | "backlight";
  onTabChange: (tab: "sceneValue" | "backlight") => void;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}

/** Shared presentation only: owners retain selection, bulk state and writes. */
export default function SettingOverlayFrame({ title, activeTab, onTabChange, onClose, actions, children }: SettingOverlayFrameProps) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="setting-overlay" role="dialog" aria-modal="true">
      <button type="button" className="setting-overlay-backdrop" aria-label="Close settings" onClick={onClose} />
      <div className="setting-overlay-panel">
        <div className="setting-overlay-header">
          <strong>{title}</strong>
          <div className="setting-overlay-actions">
            <button type="button" className={`btn btn-secondary btn-sm${activeTab === "sceneValue" ? " is-active" : ""}`} onClick={() => onTabChange("sceneValue")}>Scene Value</button>
            <button type="button" className={`btn btn-secondary btn-sm${activeTab === "backlight" ? " is-active" : ""}`} onClick={() => onTabChange("backlight")}>Backlight</button>
            {actions}
            <button type="button" className="btn btn-danger-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        {children}
      </div>
    </div>, document.body,
  );
}
