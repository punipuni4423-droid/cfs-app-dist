"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SceneValueMode } from "../types";
import { canUseStandardValue } from "../lib/sceneValueMode";

interface Props {
  standardOnly?: boolean;
  value: string;
  mode: SceneValueMode;
  dimmingType: string;
  label: string;
  disabled?: boolean;
  standardAllowed?: boolean;
  onModeChange?(mode: SceneValueMode): void;
  onChange(value: string, mode: SceneValueMode): void;
  children: ReactNode;
}

/** Text stays literal unless the user confirms clearing it to return to Standard. */
export default function SceneTextValueControl(props: Props) {
  if (props.standardOnly) {
    const { value, mode, dimmingType, label, children } = props;
    if (mode === "text") {
      return <span className="cell-readonly" aria-label={`Saved text ${label}`} style={{ whiteSpace: "pre-wrap" }}>{value || "—"}</span>;
    }
    return (
      <div onChangeCapture={(event) => {
        if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) return;
        if (canUseStandardValue(event.target.value, dimmingType)) return;
        event.stopPropagation();
        event.target.value = value;
      }}>
        {children}
      </div>
    );
  }
  return <SceneTextModeControl {...props} />;
}

function SceneTextModeControl({ value, mode, dimmingType, label, disabled, standardAllowed, onModeChange, onChange, children }: Props) {
  const canSelectStandard = standardAllowed ?? canUseStandardValue(value, dimmingType);
  const [validationError, setValidationError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  type Anchor = { x: number; y: number; containers: Array<{ element: HTMLElement; left: number; top: number }>; fieldFocused: boolean; start: number | null; end: number | null };
  const pointerAnchor = useRef<Anchor | null>(null), pendingAnchor = useRef<Anchor | null>(null);
  function captureAnchor(): Anchor {
    const active = document.activeElement;
    const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    const containers: Anchor["containers"] = [];
    for (let element = root.current?.parentElement; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) containers.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    return { x: window.scrollX, y: window.scrollY, containers, fieldFocused: Boolean(field && root.current?.contains(field)), start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null };
  }
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current; pendingAnchor.current = null;
    if (!anchor) return;
    if (anchor.fieldFocused) {
      const field = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-value-pane="${mode}"] input:not([disabled]), [data-value-pane="${mode}"] textarea:not([disabled])`);
      field?.focus({ preventScroll: true });
      if (field && field.selectionStart !== null && anchor.start !== null) field.setSelectionRange(Math.min(anchor.start, field.value.length), Math.min(anchor.end ?? anchor.start, field.value.length));
    }
    for (const item of anchor.containers) { item.element.scrollLeft = item.left; item.element.scrollTop = item.top; }
    window.scrollTo(anchor.x, anchor.y);
  }, [mode]);
  function selectMode(next: SceneValueMode): boolean {
    if (disabled || next === mode) return false;
    const anchor = pointerAnchor.current ?? captureAnchor();
    pointerAnchor.current = null;
    const clearText = next === "standard" && !canSelectStandard;
    if (clearText && !window.confirm("Clear the current setting values and switch to Standard?")) return false;

    pendingAnchor.current = anchor;
    setValidationError("");
    if (clearText) onChange("", "standard");
    else if (onModeChange) onModeChange(next);
    else onChange(value, next);
    return true;
  }
  return (
    <div className="scene-value-mode-control" ref={root}>
      <div className="scene-value-mode-buttons" role="radiogroup" aria-label={`Input mode ${label}`}>
        {(["standard", "text"] as const).map((option) => <button key={option} type="button" role="radio"
          className={`btn btn-sm ${mode === option ? "btn-primary" : "btn-secondary"}`}
          aria-checked={mode === option} tabIndex={mode === option ? 0 : -1}
          aria-label={option === "text" ? "Text" : "Standard"}
          title={option === "text" ? "Text notes (Ab)" : "Standard values (123)"}
          disabled={disabled}
          onPointerDown={(event) => {
            if (option !== mode && !disabled) {
              pointerAnchor.current = captureAnchor();
              if (pointerAnchor.current.fieldFocused) event.preventDefault();
            }
          }}
          onPointerCancel={() => { pointerAnchor.current = null; }}
          onClick={() => selectMode(option)} onKeyDown={(event) => {
            pointerAnchor.current = null;
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); const next = option === "text" ? "standard" : "text";
            if (selectMode(next)) {
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-value-mode="${next}"]`)?.focus({ preventScroll: true });
            }
          }} data-value-mode={option}><span aria-hidden="true">{option === "text" ? "Ab" : "123"}</span></button>)}
      </div>
      <div className="scene-value-mode-body" onChangeCapture={(event) => {
        if ((event.target as HTMLElement).closest<HTMLElement>("[data-value-pane]")?.dataset.valuePane !== mode) { event.stopPropagation(); return; }
        if (mode !== "standard" || !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
        if (!canUseStandardValue(event.target.value, dimmingType)) {
          event.stopPropagation(); event.target.value = value;
          setValidationError("Use a supported Standard value, or switch to Text.");
        } else setValidationError("");
      }}>
      <div className={`scene-value-mode-pane${mode === "standard" ? " is-active" : ""}`} data-value-pane="standard" aria-hidden={mode !== "standard"} inert={mode !== "standard"}>
        {children}
      </div>
      <div className={`scene-value-mode-pane${mode === "text" ? " is-active" : ""}`} data-value-pane="text" aria-hidden={mode !== "text"} inert={mode !== "text"}>
          <textarea className="cell-input cell-textarea scene-text-value-input" rows={3} value={value}
            aria-label={`Text value ${label}`} disabled={disabled || mode !== "text"}
            onChange={(event) => { setValidationError(""); onChange(event.target.value, "text"); }} />
      </div>
      <small className="muted-text scene-value-mode-feedback" role={validationError || (mode === "text" && !canSelectStandard) ? "status" : undefined}
        aria-hidden={!validationError && !(mode === "text" && !canSelectStandard)}
        title={validationError || "Keep Text to preserve this note. Standard requires a single supported value."}
        style={{ visibility: validationError || (mode === "text" && !canSelectStandard) ? "visible" : "hidden" }}>Use Ab for notes.</small>
      </div>
    </div>
  );
}
