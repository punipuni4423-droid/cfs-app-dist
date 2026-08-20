"use client";

import { useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";

interface ResizableMatrixScrollProps {
  children: ReactNode;
  className?: string;
  variant?: "standard" | "large" | "compact";
}

const MIN_WIDTH = 448;
const MIN_HEIGHT = 192;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function ResizableMatrixScroll({
  children,
  className = "",
  variant = "standard",
}: ResizableMatrixScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width?: number; height?: number }>({});

  function startResize(event: ReactMouseEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    const element = scrollRef.current;
    if (!element) return;

    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const parentWidth = element.parentElement?.clientWidth ?? window.innerWidth;
    const maxWidth = Math.max(280, parentWidth);
    const minWidth = Math.min(MIN_WIDTH, maxWidth);
    const maxHeight = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.78));

    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent): void => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, minWidth, maxWidth);
      const nextHeight = clamp(startHeight + moveEvent.clientY - startY, MIN_HEIGHT, maxHeight);
      setSize({ width: nextWidth, height: nextHeight });
    };

    const stopResize = (): void => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopResize);
  }

  const style: CSSProperties = {
    ...(size.width ? { inlineSize: size.width } : null),
    ...(size.height ? { blockSize: size.height } : null),
  };

  return (
    <div
      ref={scrollRef}
      className={[
        "matrix-scroll",
        "resizable-matrix-scroll",
        variant !== "standard" ? `resizable-matrix-scroll-${variant}` : "",
        className,
      ].filter(Boolean).join(" ")}
      style={style}
    >
      {children}
      <button
        type="button"
        className="resizable-matrix-handle"
        aria-label="Resize table area"
        title="Resize table area"
        onMouseDown={startResize}
      />
    </div>
  );
}
