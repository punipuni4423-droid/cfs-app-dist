"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ActionIcon } from "./ActionIconButton";

interface SettingOption {
  id: string;
  label: string;
}

interface CfsSettingNameButtonProps {
  label: string;
  title: string;
  disabled: boolean;
  options: SettingOption[];
  onSelect: (id: string) => void;
  children: ReactNode;
  iconOnly?: boolean;
}

export default function CfsSettingNameButton({
  label, title, disabled, options, onSelect, children, iconOnly = false,
}: CfsSettingNameButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    setOpen(false);
  }, [disabled, optionsKey]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 16);
    const height = Math.min(options.length * 38 + 12, 260);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const flip = below < height && above > below;
    const maxHeight = Math.max(38, Math.min(height, flip ? above : below));
    setPosition({
      top: Math.max(8, flip ? rect.top - maxHeight - 4 : rect.bottom + 4),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      maxHeight,
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open || !position) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={iconOnly ? "cfs-setting-icon-button" : "cfs-setting-name-button"}
        aria-label={label}
        title={title}
        disabled={disabled}
        aria-haspopup={options.length > 1 ? "menu" : "dialog"}
        aria-expanded={options.length > 1 ? open : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (options.length === 1) onSelect(options[0].id);
          else setOpen((value) => !value);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {iconOnly ? <ActionIcon name="edit" /> : children}
      </button>
      {open && !disabled && position ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Choose setting condition"
          className="cfs-setting-condition-menu"
          style={{ position: "fixed", ...position }}
          onKeyDown={(event) => {
            if (event.key === "Tab") { setOpen(false); return; }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onSelect(option.id); }}
            >
              {option.label}{options.filter((item) => item.label === option.label).length > 1 ? ` (${index + 1})` : ""}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
