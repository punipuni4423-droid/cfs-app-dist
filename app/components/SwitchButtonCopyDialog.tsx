"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SwitchButtonCopyTarget } from "../lib/switchButtonCopy";

interface Props {
  source: string;
  functionCount: number;
  targets: SwitchButtonCopyTarget[];
  canEdit: boolean;
  onClose: () => void;
  onCopy: (ids: string[]) => void;
}

export default function SwitchButtonCopyDialog({ source, functionCount, targets, canEdit, onClose, onCopy }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);
  const valid = selected.length > 0 && selected.every(id => targets.some(target => target.id === id && !target.reason));
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="setting-overlay" role="dialog" aria-modal="true" aria-labelledby="switch-button-copy-title" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }}>
      <button type="button" className="setting-overlay-backdrop" aria-label="Cancel button copy" onClick={onClose} />
      <div className="setting-overlay-panel" ref={panel} tabIndex={-1}>
        <div className="setting-overlay-header">
          <strong id="switch-button-copy-title">Copy Button Settings</strong>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        </div>
        <div className="card-padded" style={{ minHeight: 0, overflow: "auto" }}>
          <p><strong>Source:</strong> {source} ({functionCount} function {functionCount === 1 ? "row" : "rows"})</p>
          <p>Select destination buttons. All existing function rows on each selected button will be replaced, including Function, Trigger Condition, Function Setting and Backlight action settings. Device registration and backlight level assignments stay unchanged. Copies are independent of setting links.</p>
          {targets.length === 0 ? <p>No compatible destination buttons are available.</p> : (
            <div className="matrix-scroll" style={{ maxHeight: "45vh" }}>
              <table className="matrix-table master-table">
                <thead><tr><th>Destination button</th><th>Existing function rows</th></tr></thead>
                <tbody>{targets.map(target => <tr key={target.id}>
                  <td><label><input type="checkbox" checked={selected.includes(target.id)} disabled={!canEdit || Boolean(target.reason)} onChange={event => setSelected(current => event.target.checked ? [...current, target.id] : current.filter(id => id !== target.id))} /> {target.label}</label>{target.reason ? <small className="muted-text"> {target.reason}</small> : null}</td>
                  <td>{target.functionCount}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
          <p><strong>Selected:</strong> {targets.filter(target => selected.includes(target.id)).map(target => target.label).join("; ") || "None — select at least one destination button."}</p>
          <button type="button" className="btn btn-primary" disabled={!canEdit || !valid} onClick={() => { if (canEdit && valid) onCopy(selected); }}>Replace settings on {selected.length} selected {selected.length === 1 ? "button" : "buttons"}</button>
        </div>
      </div>
    </div>, document.body,
  );
}
