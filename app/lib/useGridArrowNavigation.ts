"use client";

import { useEffect } from "react";

type GridFocusableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
type GridNavigationTarget = GridFocusableControl;
type Direction = "up" | "down" | "left" | "right";

function isGridNavigationTarget(target: EventTarget | null): target is GridNavigationTarget {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLButtonElement;
}

function canLeaveHorizontal(target: HTMLInputElement | HTMLTextAreaElement, key: string): boolean {
  const selectionStart = target.selectionStart ?? 0;
  const selectionEnd = target.selectionEnd ?? selectionStart;
  if (selectionStart !== selectionEnd) return false;
  if (key === "ArrowLeft") return selectionStart === 0;
  return selectionStart === target.value.length;
}

function isVisibleControl(control: HTMLElement): boolean {
  const rect = control.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function focusableControls(container: ParentNode | null): GridFocusableControl[] {
  return Array.from(
    container?.querySelectorAll<GridFocusableControl>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
    ) ?? [],
  ).filter((control) =>
    isVisibleControl(control) &&
    control.tabIndex >= 0 &&
    !control.classList.contains("drag-handle")
  );
}

function canSetTextSelection(input: HTMLInputElement): boolean {
  return ["", "text", "search", "url", "tel", "email", "password"].includes(input.type);
}

function focusControl(control: GridFocusableControl): void {
  control.focus();
  if (control instanceof HTMLTextAreaElement || (control instanceof HTMLInputElement && canSetTextSelection(control))) {
    const end = control.value.length;
    control.setSelectionRange?.(end, end);
  }
}

function controlIndexInCell(control: GridNavigationTarget, cell: HTMLTableCellElement | null): number {
  return focusableControls(cell).indexOf(control);
}

function buttonLabel(button: HTMLButtonElement): string {
  return (
    button.textContent?.trim() ||
    button.getAttribute("aria-label") ||
    button.getAttribute("title") ||
    ""
  );
}

function buttonsMatchForVertical(current: HTMLButtonElement, candidate: HTMLButtonElement): boolean {
  const currentLabel = buttonLabel(current);
  if (currentLabel && currentLabel === buttonLabel(candidate)) return true;
  const currentClass = current.className.trim();
  const candidateClass = candidate.className.trim();
  if (currentClass && currentClass === candidateClass) return true;
  const currentTitle = current.getAttribute("title");
  if (currentTitle && currentTitle === candidate.getAttribute("title")) return true;
  const currentAria = current.getAttribute("aria-label");
  if (currentAria && currentAria === candidate.getAttribute("aria-label")) return true;
  return current.classList.contains("collapse-toggle") && candidate.classList.contains("collapse-toggle");
}

function isComboboxInput(target: GridNavigationTarget): boolean {
  return target instanceof HTMLInputElement && target.classList.contains("combobox-input");
}

function usesNativeVerticalOptions(target: GridNavigationTarget): boolean {
  return target instanceof HTMLSelectElement || isComboboxInput(target);
}

function focusControlInCell(
  cell: HTMLTableCellElement | null,
  direction: Direction,
  preferredIndex = -1,
  current?: GridNavigationTarget,
): boolean {
  const controls = focusableControls(cell);
  if (controls.length === 0) return false;
  if ((direction === "up" || direction === "down") && current instanceof HTMLButtonElement) {
    const matchingButton = controls.find((control) =>
      control instanceof HTMLButtonElement && buttonsMatchForVertical(current, control)
    );
    if (matchingButton) {
      focusControl(matchingButton);
      return true;
    }
  }
  let index = preferredIndex;
  if (index < 0) index = direction === "left" ? controls.length - 1 : 0;
  const control = controls[Math.min(index, controls.length - 1)];
  if (!control) return false;
  focusControl(control);
  return true;
}

function moveSelectOption(select: HTMLSelectElement, direction: "up" | "down"): boolean {
  const step = direction === "down" ? 1 : -1;
  for (
    let nextIndex = select.selectedIndex + step;
    nextIndex >= 0 && nextIndex < select.options.length;
    nextIndex += step
  ) {
    if (select.options[nextIndex]?.disabled) continue;
    select.selectedIndex = nextIndex;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

function cellHasFocusableControl(cell: HTMLTableCellElement | null): boolean {
  return focusableControls(cell).length > 0;
}

function cellHasMatchingButton(cell: HTMLTableCellElement | null, button: HTMLButtonElement): boolean {
  return focusableControls(cell).some((control) =>
    control instanceof HTMLButtonElement && buttonsMatchForVertical(button, control)
  );
}

function tableCellGrid(rows: HTMLTableRowElement[]): HTMLTableCellElement[][] {
  const grid: HTMLTableCellElement[][] = rows.map(() => []);
  rows.forEach((row, rowIndex) => {
    let columnIndex = 0;
    Array.from(row.cells).forEach((cell) => {
      while (grid[rowIndex]?.[columnIndex]) columnIndex += 1;
      const rowSpan = Math.max(cell.rowSpan || 1, 1);
      const colSpan = Math.max(cell.colSpan || 1, 1);
      for (
        let targetRowIndex = rowIndex;
        targetRowIndex < Math.min(rowIndex + rowSpan, rows.length);
        targetRowIndex += 1
      ) {
        for (let targetColumnIndex = columnIndex; targetColumnIndex < columnIndex + colSpan; targetColumnIndex += 1) {
          grid[targetRowIndex][targetColumnIndex] = cell as HTMLTableCellElement;
        }
      }
      columnIndex += colSpan;
    });
  });
  return grid;
}

function visualCellIndex(
  grid: HTMLTableCellElement[][],
  rowIndex: number,
  cell: HTMLTableCellElement,
): number {
  return grid[rowIndex]?.findIndex((candidate) => candidate === cell) ?? -1;
}

function focusSiblingControlInCell(
  current: GridNavigationTarget,
  cell: HTMLTableCellElement | null,
  direction: Direction,
): boolean {
  if (direction !== "left" && direction !== "right") return false;
  const controls = focusableControls(cell);
  const currentIndex = controls.indexOf(current);
  if (currentIndex < 0) return false;
  const next = controls[currentIndex + (direction === "right" ? 1 : -1)];
  if (!next) return false;
  focusControl(next);
  return true;
}

function navigationDirection(event: KeyboardEvent, target: GridNavigationTarget): Direction | null {
  if (event.key === "Home") return "left";
  if (event.key === "End") return "right";
  if (event.key === "PageUp") return "up";
  if (event.key === "PageDown") return "down";
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return null;
  if (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    if (event.key === "ArrowUp") return "up";
    if (event.key === "ArrowDown") return "down";
    if (event.key === "ArrowLeft") return "left";
    return "right";
  }
  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    !usesNativeVerticalOptions(target)
  ) {
    return event.key === "ArrowUp" ? "up" : "down";
  }
  const fnNavigation =
    event.getModifierState?.("Fn") ||
    event.getModifierState?.("FnLock") ||
    target instanceof HTMLButtonElement ||
    (target instanceof HTMLInputElement && target.type === "checkbox");
  if (!fnNavigation) return null;
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  if (event.key === "ArrowLeft") return "left";
  return "right";
}

export function useGridArrowNavigation(): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!isGridNavigationTarget(event.target)) return;
      if (
        event.target instanceof HTMLSelectElement &&
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.getModifierState?.("Fn")
      ) {
        if (moveSelectOption(event.target, event.key === "ArrowDown" ? "down" : "up")) {
          event.preventDefault();
        }
        return;
      }
      const direction = navigationDirection(event, event.target);
      if (!direction) return;
      const ctrlArrowMove =
        event.ctrlKey &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey;
      if (event.altKey || event.metaKey || event.shiftKey || (event.ctrlKey && !ctrlArrowMove)) return;
      const selectHorizontalMove =
        event.target instanceof HTMLSelectElement && (direction === "left" || direction === "right");

      if (
        (direction === "left" || direction === "right") &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !ctrlArrowMove &&
        (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) &&
        !canLeaveHorizontal(event.target, event.key)
      ) {
        return;
      }

      const cell = event.target.closest("td, th") as HTMLTableCellElement | null;
      const row = cell?.parentElement as HTMLTableRowElement | null;
      const section = row?.parentElement;
      if (!cell || !row || !section) {
        return;
      }
      if (
        selectHorizontalMove ||
        event.target instanceof HTMLButtonElement ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        direction === "up" ||
        direction === "down"
      ) {
        event.preventDefault();
      }

      const rows = Array.from(section.querySelectorAll<HTMLTableRowElement>("tr"));
      const rowIndex = rows.indexOf(row);
      const grid = tableCellGrid(rows);
      const cellIndex = visualCellIndex(grid, rowIndex, cell);
      const currentControlIndex = controlIndexInCell(event.target, cell);
      let targetCell: HTMLTableCellElement | null = null;

      if (direction === "left" || direction === "right") {
        if (focusSiblingControlInCell(event.target, cell, direction)) {
          event.preventDefault();
          return;
        }
        const step = direction === "right" ? 1 : -1;
        for (let nextIndex = cellIndex + step; nextIndex >= 0 && nextIndex < (grid[rowIndex]?.length ?? 0); nextIndex += step) {
          const candidate = grid[rowIndex]?.[nextIndex] ?? null;
          if (candidate && candidate !== cell && cellHasFocusableControl(candidate)) {
            targetCell = candidate;
            break;
          }
        }
      } else {
        const step = direction === "down" ? 1 : -1;
        for (let nextRowIndex = rowIndex + step; nextRowIndex >= 0 && nextRowIndex < rows.length; nextRowIndex += step) {
          const candidate = grid[nextRowIndex]?.[cellIndex] ?? null;
          if (!candidate || candidate === cell) continue;
          if (event.target instanceof HTMLButtonElement) {
            if (cellHasMatchingButton(candidate, event.target)) {
              targetCell = candidate;
              break;
            }
            continue;
          }
          if (cellHasFocusableControl(candidate)) {
            targetCell = candidate;
            break;
          }
        }
      }

      if (focusControlInCell(
        targetCell,
        direction,
        direction === "up" || direction === "down" ? currentControlIndex : -1,
        event.target,
      )) {
        event.preventDefault();
      } else if (selectHorizontalMove) {
        event.preventDefault();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
