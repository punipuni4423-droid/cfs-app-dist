"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OperationClipboard, OperationPasteTarget } from "../lib/switchOperationClipboard";

/** Function and device paste share explicit, initially empty destination selection. */
export default function OperationPasteDialog({ clipboard, targets, canEdit, onClose, onPaste }: {
  clipboard: OperationClipboard; targets: readonly OperationPasteTarget[]; canEdit: boolean;
  onClose(): void; onPaste(ids: string[]): boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]), [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; panel.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
  if (typeof document === "undefined") return null;
  const scope = clipboard.kind === "command" ? "Command" : clipboard.scope === "function" ? "Function" : "Switch";
  const valid = selected.length > 0 && selected.every(id => targets.some(target => target.id === id && !target.reason));
  return createPortal(<div className="setting-overlay" role="dialog" aria-modal="true" aria-labelledby="operation-paste-title" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
  }}>
    <button type="button" className="setting-overlay-backdrop" aria-label="Cancel paste" onClick={onClose} />
    <div className="setting-overlay-panel" ref={panel} tabIndex={-1}>
      <div className="setting-overlay-header"><strong id="operation-paste-title">Paste {scope} Settings</strong><button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button></div>
      <div className="card-padded" style={{ minHeight: 0, overflow: "auto" }}>
        <p><strong>Copied source:</strong> {clipboard.label} ({clipboard.rows.length} function {clipboard.rows.length === 1 ? "row" : "rows"})</p>
        <p>{clipboard.scope === "function" ? "Replace only the selected function rows." : "Replace all function rows on each selected switch."} Function, Trigger Condition, Function Setting and Backlight action settings are copied. Destination registration, wiring, Area and backlight level assignments stay unchanged. Copies are independent of setting links.</p>
        {targets.length ? <div className="matrix-scroll" style={{ maxHeight: "45vh" }}><table className="matrix-table master-table"><thead><tr><th>Destination {scope.toLowerCase()}</th><th>Existing function rows</th></tr></thead><tbody>
          {targets.map(target => <tr key={target.id}><td><label><input type="checkbox" checked={selected.includes(target.id)} disabled={!canEdit || Boolean(target.reason)} onChange={event => { setError(""); setSelected(current => event.target.checked ? [...current, target.id] : current.filter(id => id !== target.id)); }} /> {target.label}</label>{target.reason ? <small className="muted-text"> {target.reason}</small> : null}</td><td>{target.functionCount}</td></tr>)}
        </tbody></table></div> : <p>No compatible destinations are available. Copy again if the source was removed.</p>}
        <p><strong>Selected:</strong> {targets.filter(target => selected.includes(target.id)).map(target => target.label).join("; ") || "None — select at least one destination."}</p>
        {error ? <p role="alert">{error}</p> : null}
        <button type="button" className="btn btn-primary" disabled={!canEdit || !valid} onClick={() => { if (canEdit && valid && !onPaste(selected)) setError("Paste could not be applied. Keep at least one non-priority function per button, and check that the source and destinations still exist."); }}>Replace settings on {selected.length} selected {clipboard.scope === "function" ? "function rows" : "switches"}</button>
      </div>
    </div>
  </div>, document.body);
}
