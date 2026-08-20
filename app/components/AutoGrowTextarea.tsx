"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

interface AutoGrowTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export default function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  className = "",
  disabled = false,
}: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    const minHeight = Number.parseFloat(window.getComputedStyle(el).minHeight) || 32;
    el.style.height = "auto";
    el.style.height = `${el.value.trim() ? Math.max(el.scrollHeight, minHeight) : minHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  return (
    <textarea
      ref={ref}
      className={["cell-input", "cell-textarea", className].filter(Boolean).join(" ")}
      rows={1}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        requestAnimationFrame(resize);
      }}
      onInput={resize}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
