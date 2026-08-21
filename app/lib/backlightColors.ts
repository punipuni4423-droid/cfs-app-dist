// Deterministic color pair per backlight level label. The same label always
// maps to the same hue so CFS cells (pale fill) and setting buttons (strong
// fill) stay visually linked across tabs, sessions, and users without any
// stored color configuration.

const DEFAULT_HUES: Record<string, number> = {
  base: 145,
  bright: 48,
  relax: 25,
  mood: 280,
  sleep: 210,
};

function hashHue(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export function backlightHue(label: string): number | null {
  const trimmed = label.trim().toLowerCase();
  if (!trimmed || trimmed === "-") return null;
  return DEFAULT_HUES[trimmed] ?? hashHue(trimmed);
}

export function backlightPaleColor(label: string): string | null {
  const hue = backlightHue(label);
  return hue === null ? null : `hsl(${hue}, 70%, 90%)`;
}

export function backlightStrongColor(label: string): string | null {
  const hue = backlightHue(label);
  return hue === null ? null : `hsl(${hue}, 55%, 36%)`;
}
