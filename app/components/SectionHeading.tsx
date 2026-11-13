import type { ReactNode } from "react";

/** Compact section titles use the existing toolbar strong text, without per-screen sizing. */
export default function SectionHeading({ children }: { children: ReactNode }) {
  return <strong role="heading" aria-level={3}>{children}</strong>;
}
