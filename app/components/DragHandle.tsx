"use client";

import type React from "react";

/**
 * Shared drag handle (T-34).
 *
 * Unifies the look and markup of the 4-dot ("::") drag handles across all tabs.
 * - variant "table": 30x30 box handle used inside table rows (current standard).
 * - variant "menu":  compact boxless handle used in the CFS column menus.
 *
 * The element is always a <span>. The class name "drag-handle" must be kept:
 * app/lib/useGridArrowNavigation.ts checks classList.contains("drag-handle")
 * to exclude handles from grid arrow-key navigation, and Playwright specs
 * locate handles via the ".drag-handle" selector.
 *
 * This component only unifies appearance/markup. Each view keeps its own
 * DnD logic and passes its existing handlers through unchanged.
 */

export type DragHandleVariant = "table" | "menu";

export interface DragHandleProps {
  variant?: DragHandleVariant;
  /**
   * Mirrors the HTML draggable attribute. Omit (undefined) for handles whose
   * parent row is the draggable element (CFS column menus). When false, the
   * base CSS renders the disabled look (opacity 0.45, default cursor).
   */
  draggable?: boolean;
  tabIndex?: number;
  glyph?: string;
  title?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
  /** Extra class names (e.g. "cfs-function-group-drag"). "drag-handle" is always kept. */
  className?: string;
  onDragStart?: React.DragEventHandler<HTMLSpanElement>;
  onDragOver?: React.DragEventHandler<HTMLSpanElement>;
  onDrop?: React.DragEventHandler<HTMLSpanElement>;
  onDragEnd?: React.DragEventHandler<HTMLSpanElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLSpanElement>;
  onPointerDown?: React.PointerEventHandler<HTMLSpanElement>;
  onMouseDown?: React.MouseEventHandler<HTMLSpanElement>;
  onMouseMove?: React.MouseEventHandler<HTMLSpanElement>;
}

const DRAG_HANDLE_GLYPH = "::";

export default function DragHandle({
  variant = "table",
  draggable,
  tabIndex,
  glyph = DRAG_HANDLE_GLYPH,
  title,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
  className,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onKeyDown,
  onPointerDown,
  onMouseDown,
  onMouseMove,
}: DragHandleProps): React.JSX.Element {
  const classes = ["drag-handle", variant === "menu" ? "drag-handle--menu" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      draggable={draggable}
      tabIndex={tabIndex}
      title={title}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    >
      {glyph}
    </span>
  );
}
