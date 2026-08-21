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

// Hex form of the pale color, for <input type="color"> defaults.
export function backlightPaleHex(label: string): string | null {
  const hue = backlightHue(label);
  if (hue === null) return null;
  return hslToHex(hue, 0.7, 0.9);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [chroma, second, 0];
  else if (hue < 120) rgb = [second, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, second];
  else if (hue < 240) rgb = [0, second, chroma];
  else if (hue < 300) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];
  return `#${rgb
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}
