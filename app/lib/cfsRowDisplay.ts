import type { CfsRowDisplaySettings, CfsRowKind } from "../types";

export const DEFAULT_CFS_ROW_ORDER: readonly CfsRowKind[] = [
  "lighting",
  "cco",
  "curtain",
  "hvac",
  "backlight",
] as const;

export const CFS_ROW_DISPLAY_OPTIONS: readonly { id: CfsRowKind; label: string }[] = [
  { id: "lighting", label: "Lighting" },
  { id: "cco", label: "CCO" },
  { id: "curtain", label: "Curtain" },
  { id: "hvac", label: "HVAC" },
  { id: "backlight", label: "Backlight" },
] as const;

export function isCfsRowKind(value: unknown): value is CfsRowKind {
  return typeof value === "string" && DEFAULT_CFS_ROW_ORDER.includes(value as CfsRowKind);
}

export function normalizeCfsRowDisplaySettings(value: unknown): CfsRowDisplaySettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const order = Array.isArray(source.order)
    ? source.order.filter(isCfsRowKind)
    : [];
  const hidden = Array.isArray(source.hidden)
    ? source.hidden.filter(isCfsRowKind)
    : [];
  const seen = new Set<CfsRowKind>();
  const normalizedOrder = [
    ...order.filter((kind) => {
      if (seen.has(kind)) return false;
      seen.add(kind);
      return true;
    }),
    ...DEFAULT_CFS_ROW_ORDER.filter((kind) => !seen.has(kind)),
  ];
  return {
    order: normalizedOrder,
    hidden: Array.from(new Set(hidden)),
  };
}
