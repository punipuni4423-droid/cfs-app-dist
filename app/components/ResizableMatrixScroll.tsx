"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";

interface ResizableMatrixScrollProps {
  children: ReactNode;
  className?: string;
  variant?: "standard" | "large" | "compact";
}

const MIN_WIDTH = 448;
const MIN_HEIGHT = 192;
// Bottom gap kept between the container and the viewport edge when auto-fitting.
const FIT_BOTTOM_MARGIN = 14;

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
  const manualHeightRef = useRef(false);
  const [fitHeight, setFitHeight] = useState<number | undefined>(undefined);
  const [endSpace, setEndSpace] = useState(0);

  // Single-scroll layout: default the container height to "rest of the
  // viewport" so the page itself does not need to scroll, and pad the end of
  // the content so the last row can be scrolled up until it sits right under
  // the sticky header row.
  useLayoutEffect(() => {
    function recompute(): void {
      const element = scrollRef.current;
      if (!element) return;
      if (!manualHeightRef.current) {
        const rect = element.getBoundingClientRect();
        // Chrome below the container also has to fit into the viewport for
        // the page to stop scrolling. Measured from the shell's content
        // bottom - documentElement.scrollHeight is floored at the viewport
        // height and would drift the fit.
        const shellBottom = element.closest("main")?.getBoundingClientRect().bottom ?? rect.bottom;
        const belowGap = Math.max(0, shellBottom - rect.bottom);
        const minHeight = variant === "compact" ? MIN_HEIGHT : variant === "large" ? 320 : 256;
        const next = Math.max(
          minHeight,
          Math.floor(window.innerHeight - rect.top - Math.max(belowGap, FIT_BOTTOM_MARGIN)),
        );
        setFitHeight((prev) => (prev !== undefined && Math.abs(prev - next) < 2 ? prev : next));
      }
      const table = element.querySelector("table");
      const head = table?.tHead;
      const bodyRows = table?.tBodies?.[0]?.rows;
      const lastRow = bodyRows && bodyRows.length > 0 ? bodyRows[bodyRows.length - 1] : null;
      if (!head || !lastRow) {
        setEndSpace(0);
        return;
      }
      const spare = Math.floor(
        element.clientHeight -
          head.getBoundingClientRect().height -
          lastRow.getBoundingClientRect().height,
      );
      const next = Math.max(0, spare);
      setEndSpace((prev) => (Math.abs(prev - next) < 2 ? prev : next));
    }

    recompute();
    const frame = requestAnimationFrame(recompute);
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(recompute) : null;
    if (resizeObserver) {
      const element = scrollRef.current;
      if (element) {
        resizeObserver.observe(element);
        const table = element.querySelector("table");
        if (table) resizeObserver.observe(table);
      }
      // Track layout shifts above the container (banners, wrapping toolbars)
      // that move its top edge.
      resizeObserver.observe(document.body);
    }
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [variant]);

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
    const maxHeight = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.9));

    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent): void => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, minWidth, maxWidth);
      const nextHeight = clamp(startHeight + moveEvent.clientY - startY, MIN_HEIGHT, maxHeight);
      manualHeightRef.current = true;
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
    ...(size.height
      ? { blockSize: size.height }
      : fitHeight
        ? { blockSize: fitHeight, maxBlockSize: "none" }
        : null),
    ...(endSpace > 0 ? { paddingBlockEnd: endSpace } : null),
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
