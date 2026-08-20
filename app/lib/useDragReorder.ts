"use client";

import { useEffect, useRef, useState } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";

type DropPosition = "before" | "after";

interface DragOverInfo {
  targetKey: string;
  position: DropPosition;
}

export function useDragReorder<T>(
  items: T[],
  onChange: (next: T[]) => void,
  getItemKey: (item: T) => string,
  getBlockKey?: (item: T) => string,
) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOverInfo, setDragOverInfo] = useState<DragOverInfo | null>(null);
  const draggingKeyRef = useRef<string | null>(null);
  const itemsRef = useRef(items);
  const onChangeRef = useRef(onChange);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const lastPointerTargetRef = useRef<DragOverInfo | null>(null);

  itemsRef.current = items;
  onChangeRef.current = onChange;

  useEffect(() => {
    return () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
    };
  }, []);

  function blockKey(item: T): string {
    return getBlockKey?.(item) || getItemKey(item);
  }

  function onDragStart(e: DragEvent<HTMLElement>, key: string): void {
    draggingKeyRef.current = key;
    setDraggingKey(key);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", key);
    } catch {
      /* noop */
    }
  }

  function onDragOver(e: DragEvent<HTMLElement>, key: string): void {
    if (!draggingKeyRef.current && !draggingKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position: DropPosition =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDragOverInfo((prev) =>
      prev?.targetKey === key && prev.position === position
        ? prev
        : { targetKey: key, position },
    );
  }

  function elementDropPosition(element: Element, clientY: number): DropPosition {
    const rect = element.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function targetAtPoint(clientX: number, clientY: number): DragOverInfo | null {
    if (typeof document === "undefined") return null;
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      if (!(element instanceof HTMLElement)) continue;
      const target = element.closest<HTMLElement>("[data-drag-reorder-key]");
      const targetKey = target?.dataset.dragReorderKey;
      if (!target || !targetKey) continue;
      return {
        targetKey,
        position: elementDropPosition(target, clientY),
      };
    }
    return null;
  }

  function applyReorder(activeDraggingKey: string, targetKey: string, position: DropPosition): void {
    if (!activeDraggingKey || activeDraggingKey === targetKey) return;
    const currentItems = itemsRef.current;
    const dragged = currentItems.filter((item) => blockKey(item) === activeDraggingKey);
    const remaining = currentItems.filter((item) => blockKey(item) !== activeDraggingKey);
    const targetIndex = remaining.findIndex((item) => blockKey(item) === targetKey);
    if (dragged.length === 0 || targetIndex === -1) return;

    let insertAt = targetIndex;
    if (position === "after") {
      let lastIndex = targetIndex;
      for (let i = targetIndex + 1; i < remaining.length; i += 1) {
        if (blockKey(remaining[i]) !== targetKey) break;
        lastIndex = i;
      }
      insertAt = lastIndex + 1;
    }

    onChangeRef.current([
      ...remaining.slice(0, insertAt),
      ...dragged,
      ...remaining.slice(insertAt),
    ]);
  }

  function onDrop(e: DragEvent<HTMLElement>, targetKey: string): void {
    e.preventDefault();
    const activeDraggingKey = draggingKeyRef.current || draggingKey || e.dataTransfer.getData("text/plain");
    if (!activeDraggingKey || activeDraggingKey === targetKey) {
      onDragEnd();
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const dropPosition: DropPosition =
      dragOverInfo?.targetKey === targetKey
        ? dragOverInfo.position
        : e.clientY < rect.top + rect.height / 2
          ? "before"
          : "after";

    applyReorder(activeDraggingKey, targetKey, dropPosition);
    onDragEnd();
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, key: string): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pointerCleanupRef.current?.();
    draggingKeyRef.current = key;
    lastPointerTargetRef.current = null;
    setDraggingKey(key);
    setDragOverInfo(null);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Pointer capture is best-effort. */
    }

    const handleMove = (event: PointerEvent): void => {
      const target = targetAtPoint(event.clientX, event.clientY);
      if (!target || target.targetKey === key) {
        setDragOverInfo(null);
        return;
      }
      lastPointerTargetRef.current = target;
      setDragOverInfo((prev) =>
        prev?.targetKey === target.targetKey && prev.position === target.position
          ? prev
          : target,
      );
    };
    const finish = (event: PointerEvent): void => {
      const target = targetAtPoint(event.clientX, event.clientY) ?? lastPointerTargetRef.current;
      if (target && target.targetKey !== key) {
        applyReorder(key, target.targetKey, target.position);
      }
      onDragEnd();
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishAndCleanup);
      window.removeEventListener("pointercancel", finishAndCleanup);
      pointerCleanupRef.current = null;
    };
    function finishAndCleanup(event: PointerEvent): void {
      cleanup();
      finish(event);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishAndCleanup);
    window.addEventListener("pointercancel", finishAndCleanup);
    pointerCleanupRef.current = cleanup;
  }

  function onDragEnd(): void {
    pointerCleanupRef.current?.();
    pointerCleanupRef.current = null;
    draggingKeyRef.current = null;
    lastPointerTargetRef.current = null;
    setDraggingKey(null);
    setDragOverInfo(null);
  }

  return {
    draggingKey,
    dragOverInfo,
    onDragStart,
    onDragOver,
    onDrop,
    onPointerDown,
    onDragEnd,
  };
}
