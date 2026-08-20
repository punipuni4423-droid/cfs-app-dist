"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

interface ComboboxProps {
  value: string;
  options: readonly ComboboxOptionInput[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  numeric?: boolean | "decimal";
  className?: string;
  ariaLabel?: string;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export type ComboboxOptionInput = string | {
  value: string;
  label: string;
};

interface ComboboxOption {
  value: string;
  label: string;
}

const ESTIMATED_OPTION_HEIGHT = 32;
const MAX_DROPDOWN_HEIGHT = 240;

// Combobox: <input> + caret-button + portal-rendered dropdown.
// The dropdown is rendered into document.body via React Portal so it can
// escape overflow:hidden table containers and float above other content
// using position:fixed coordinates derived from the trigger's bounding box.
export default function Combobox({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  numeric,
  className,
  ariaLabel,
}: ComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<DropdownPosition | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const normalizedOptions: ComboboxOption[] = options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );

  // SSR-safety: only render portal after mount.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Compute and track dropdown position while open.
  // R21: flip the list above the trigger when below has insufficient room.
  useLayoutEffect(() => {
    if (!open) return;
    function recompute(): void {
      const trig = wrapRef.current;
      if (!trig) return;
      const rect = trig.getBoundingClientRect();
      const margin = 8;
      const measured = listRef.current?.offsetHeight;
      const desiredH =
        measured && measured > 0
          ? measured
        : Math.min(normalizedOptions.length * ESTIMATED_OPTION_HEIGHT, MAX_DROPDOWN_HEIGHT);
      const width = Math.max(rect.width, 96);
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const flipUp = spaceBelow < desiredH && spaceAbove > spaceBelow;
      const availableHeight = Math.max(96, flipUp ? spaceAbove : spaceBelow);
      const maxHeight = Math.min(MAX_DROPDOWN_HEIGHT, availableHeight);
      const rawTop = flipUp ? rect.top - Math.min(desiredH, maxHeight) - 2 : rect.bottom + 2;
      setPos({
        top: Math.max(margin, Math.min(rawTop, window.innerHeight - maxHeight - margin)),
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
        width,
        maxHeight,
      });
    }
    recompute();
    // Re-measure once the list has actually rendered so we get a precise height.
    const raf = requestAnimationFrame(recompute);
    // capture-phase scroll catches scrollable ancestors as well.
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return (): void => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, normalizedOptions.length]);

  // Outside-click closes dropdown. Both trigger and portal list count as inside.
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(ev: globalThis.MouseEvent): void {
      const trig = wrapRef.current;
      const list = listRef.current;
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (trig && trig.contains(target)) return;
      if (list && list.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    return (): void => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  function handleToggle(ev: MouseEvent<HTMLButtonElement>): void {
    ev.preventDefault();
    if (disabled) return;
    setOpen((prev) => {
      const next = !prev;
      if (next) setActiveIndex(selectedOptionIndex());
      return next;
    });
    inputRef.current?.focus();
  }

  function selectedOptionIndex(): number {
    return normalizedOptions.findIndex((option) => option.value === value);
  }

  function moveActive(delta: number): void {
    const count = normalizedOptions.length;
    if (count === 0) return;
    setActiveIndex((current) => {
      const base = current >= 0 ? current : selectedOptionIndex();
      const start = base >= 0 ? base : delta > 0 ? -1 : 0;
      return (start + delta + count) % count;
    });
  }

  function handleKeyDown(ev: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) {
        setOpen(true);
        const selected = selectedOptionIndex();
        setActiveIndex(selected >= 0 ? selected : ev.key === "ArrowDown" ? 0 : normalizedOptions.length - 1);
        return;
      }
      moveActive(ev.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (ev.key === "Enter") {
      if (open && activeIndex >= 0 && activeIndex < normalizedOptions.length) {
        ev.preventDefault();
        handleSelect(normalizedOptions[activeIndex].value);
      }
      return;
    }
    if (ev.key === "Tab") {
      if (open) setOpen(false);
      return;
    }
    if (ev.key === "Escape") {
      if (open) {
        ev.preventDefault();
        setOpen(false);
      }
      return;
    }
  }

  function handleBlur(): void {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const trig = wrapRef.current;
      const list = listRef.current;
      if (active instanceof Node && trig?.contains(active)) return;
      if (active instanceof Node && list?.contains(active)) return;
      setOpen(false);
    });
  }

  function handleSelect(opt: string): void {
    onChange(opt);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  const wrapClassName = ["combobox-wrap", className].filter(Boolean).join(" ");

  const dropdown =
    open && normalizedOptions.length > 0 && pos ? (
      <ul
        ref={listRef}
        className="combobox-list combobox-list-portal"
        role="listbox"
        id={listId}
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
          zIndex: 6000,
        }}
        // Prevent global mousedown handler (and React table-row drag) from
        // firing before our option click is registered.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {normalizedOptions.map((opt, index) => {
          const selected = opt.value === value;
          const active = index === activeIndex;
          return (
            <li
              key={opt.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={selected}
              className={[
                "combobox-option",
                selected ? "combobox-option-selected" : "",
                active ? "combobox-option-active" : "",
              ].filter(Boolean).join(" ")}
              // mousedown so it fires before input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(opt.value);
              }}
            >
              {opt.label}
            </li>
          );
        })}
      </ul>
    ) : null;

  return (
    <div
      ref={wrapRef}
      className={wrapClassName}
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-haspopup="listbox"
    >
      <input
        ref={inputRef}
        className="combobox-input cell-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={numeric === "decimal" ? "decimal" : numeric ? "numeric" : undefined}
        aria-label={ariaLabel}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
      />
      <button
        type="button"
        className="combobox-trigger"
        onClick={handleToggle}
        disabled={disabled}
        aria-label="Show options"
        tabIndex={-1}
      >
        ▾
      </button>
      {mounted && dropdown ? createPortal(dropdown, document.body) : null}
    </div>
  );
}
