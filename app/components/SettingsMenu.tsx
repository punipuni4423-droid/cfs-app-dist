"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AppSettingsPanel from "./AppSettingsPanel";

export default function SettingsMenu() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const previousOverflow = document.body.style.overflow;
    const opener = buttonRef.current;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function focusableElements(): HTMLElement[] {
      const panel = panelRef.current;
      if (!panel) return [];
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableElements();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [settingsOpen]);

  return (
    <div className="settings-menu">
      <button
        ref={buttonRef}
        type="button"
        className="settings-button"
        title="Settings"
        aria-label="Open app settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden focusable="false">
          <path
            fill="currentColor"
            d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.65l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.45 7.45 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.43h-3.84a.5.5 0 0 0-.5.43l-.36 2.54a7.5 7.5 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.71 8.83a.5.5 0 0 0 .12.65L4.86 11.06a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.65l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.43h3.84a.5.5 0 0 0 .5-.43l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.65zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5"
          />
        </svg>
      </button>
      {settingsOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="app-settings-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="app-settings-overlay-title"
            >
              <button
                type="button"
                className="app-settings-overlay-backdrop"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              />
              <div className="app-settings-overlay-panel" ref={panelRef}>
                <div className="app-settings-overlay-header">
                  <strong>App Settings</strong>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSettingsOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="app-settings-overlay-body">
                  <AppSettingsPanel embedded />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
