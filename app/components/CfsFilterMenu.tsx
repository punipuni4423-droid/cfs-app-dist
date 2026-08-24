"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

interface FloatingPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface CfsFilterMenuProps {
  label: string;
  displayLabel?: string;
  toolbarOrder?: number;
  wide?: boolean;
  panelMinWidth?: number;
  panelMaxHeight?: number;
  onOpen?: () => void;
  highlighted?: boolean;
  testId?: string;
  children: ReactNode;
}

function computeFloatingPosition(
  trigger: HTMLElement,
  panel: HTMLElement | null,
  minWidth: number,
  maxPanelHeight: number,
): FloatingPosition {
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, minWidth), viewportWidth - margin * 2);
  const measuredHeight = panel?.offsetHeight || maxPanelHeight;
  const desiredHeight = Math.min(measuredHeight, maxPanelHeight);
  const spaceBelow = viewportHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const flipUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
  const availableHeight = Math.max(96, flipUp ? spaceAbove : spaceBelow);
  const maxHeight = Math.min(maxPanelHeight, availableHeight);
  const rawTop = flipUp ? rect.top - Math.min(desiredHeight, maxHeight) - 4 : rect.bottom + 4;
  return {
    top: Math.max(margin, Math.min(rawTop, viewportHeight - maxHeight - margin)),
    left: Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)),
    width,
    maxHeight,
  };
}

export default function CfsFilterMenu({
  label,
  displayLabel,
  toolbarOrder,
  wide = false,
  panelMinWidth,
  panelMaxHeight,
  onOpen,
  highlighted = false,
  testId,
  children,
}: CfsFilterMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function recompute(): void {
      const trigger = wrapRef.current;
      if (!trigger) return;
      setPosition(
        computeFloatingPosition(
          trigger,
          panelRef.current,
          panelMinWidth ?? (wide ? 288 : 208),
          panelMaxHeight ?? 320,
        ),
      );
    }
    recompute();
    const raf = requestAnimationFrame(recompute);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, panelMaxHeight, panelMinWidth, wide]);

  useEffect(() => {
    if (!open || !position) return;
    const raf = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const panel = open && position ? (
    <div
      ref={panelRef}
      className={`cfs-filter-list cfs-filter-list-portal${wide ? " cfs-filter-list-wide" : ""}`}
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        zIndex: 6000,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  ) : null;

  const wrapStyle: CSSProperties | undefined =
    typeof toolbarOrder === "number" ? { order: toolbarOrder } : undefined;

  return (
    <div className="cfs-filter-menu" ref={wrapRef} style={wrapStyle} data-testid={testId}>
      <button
        type="button"
        className={`cfs-filter-menu-trigger${highlighted ? " revision-changed-cell" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((prev) => !prev)}
      >
        {displayLabel ?? label}
      </button>
      {mounted && panel ? createPortal(panel, document.body) : null}
    </div>
  );
}
