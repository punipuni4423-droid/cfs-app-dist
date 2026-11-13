"use client";

import type { ReactNode } from "react";
import SectionHeading from "./SectionHeading";

/** The operational table and overlays are the existing scoped SwitchView. */
export default function TstatControlView({ children, warnings = [] }: { children: ReactNode; warnings?: readonly string[] }) {
  return (
    <section aria-label="TSTAT Control">
      <SectionHeading>Thermostat Collection</SectionHeading>
      {warnings.map((warning) => <p className="muted-text" key={warning}>{warning}</p>)}
      {children}
    </section>
  );
}
