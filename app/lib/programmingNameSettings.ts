import type {
  ProgrammingNameBracketStyle,
  ProgrammingNameSettings,
  ProgrammingNameToken,
  ProjectSettings,
} from "../types";

export const PROGRAMMING_NAME_TOKEN_OPTIONS: ReadonlyArray<{
  id: ProgrammingNameToken;
  label: string;
}> = [
  { id: "locationNumber", label: "Location Number" },
  { id: "designerNumber", label: "Designer Number" },
  { id: "area", label: "Area" },
  { id: "address", label: "Address" },
  { id: "device", label: "Device" },
];

export const PROGRAMMING_NAME_BRACKET_OPTIONS: ReadonlyArray<{
  id: ProgrammingNameBracketStyle;
  label: string;
}> = [
  { id: "square", label: "[ ]" },
  { id: "round", label: "( )" },
  { id: "curly", label: "{ }" },
  { id: "angle", label: "< >" },
  { id: "none", label: "None" },
];

export const PROGRAMMING_NAME_SEPARATOR_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "None" },
  { value: " ", label: "Space" },
  { value: "-", label: "-" },
  { value: "_", label: "_" },
  { value: "/", label: "/" },
];

export const DEFAULT_PROGRAMMING_NAME_SETTINGS: ProgrammingNameSettings = {
  tokens: ["locationNumber", "designerNumber", "area", "address", "device"],
  bracketStyle: "square",
  tokenSeparator: "",
  detailSeparator: " ",
};

const PROGRAMMING_NAME_TOKEN_SET = new Set(
  PROGRAMMING_NAME_TOKEN_OPTIONS.map((option) => option.id),
);
const PROGRAMMING_NAME_BRACKET_SET = new Set(
  PROGRAMMING_NAME_BRACKET_OPTIONS.map((option) => option.id),
);

function uniqueValidTokens(value: unknown): ProgrammingNameToken[] {
  if (!Array.isArray(value)) return [...DEFAULT_PROGRAMMING_NAME_SETTINGS.tokens];
  const tokens: ProgrammingNameToken[] = [];
  for (const token of value) {
    const incoming = String(token);
    const expandedTokens =
      incoming === "areaAddress"
        ? (["area", "address"] satisfies ProgrammingNameToken[])
        : [incoming as ProgrammingNameToken];
    for (const expanded of expandedTokens) {
      if (!PROGRAMMING_NAME_TOKEN_SET.has(expanded)) continue;
      if (tokens.includes(expanded)) continue;
      tokens.push(expanded);
    }
  }
  return tokens;
}

function limitedSeparator(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.slice(0, 8);
}

export function normalizeProgrammingNameSettings(value: unknown): ProgrammingNameSettings {
  if (value === null || typeof value !== "object") {
    return {
      ...DEFAULT_PROGRAMMING_NAME_SETTINGS,
      tokens: [...DEFAULT_PROGRAMMING_NAME_SETTINGS.tokens],
    };
  }
  const raw = value as Record<string, unknown>;
  return {
    tokens: uniqueValidTokens(raw.tokens),
    bracketStyle: PROGRAMMING_NAME_BRACKET_SET.has(raw.bracketStyle as ProgrammingNameBracketStyle)
      ? (raw.bracketStyle as ProgrammingNameBracketStyle)
      : DEFAULT_PROGRAMMING_NAME_SETTINGS.bracketStyle,
    tokenSeparator: limitedSeparator(raw.tokenSeparator, DEFAULT_PROGRAMMING_NAME_SETTINGS.tokenSeparator),
    detailSeparator: limitedSeparator(raw.detailSeparator, DEFAULT_PROGRAMMING_NAME_SETTINGS.detailSeparator),
  };
}

export function isProgrammingNameSettings(value: unknown): value is ProgrammingNameSettings {
  if (value === null || typeof value !== "object") return false;
  const normalized = normalizeProgrammingNameSettings(value);
  const raw = value as Record<string, unknown>;
  return (
    Array.isArray(raw.tokens) &&
    raw.tokens.length === normalized.tokens.length &&
    raw.tokens.every((token, index) => token === normalized.tokens[index]) &&
    raw.bracketStyle === normalized.bracketStyle &&
    raw.tokenSeparator === normalized.tokenSeparator &&
    raw.detailSeparator === normalized.detailSeparator
  );
}

export function migrateProjectSettings(value: unknown): ProjectSettings | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    programmingName: normalizeProgrammingNameSettings(raw.programmingName),
  };
}

export function isProjectSettings(value: unknown): value is ProjectSettings {
  if (value === null || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return isProgrammingNameSettings(raw.programmingName);
}

export function wrapProgrammingNameToken(value: string, bracketStyle: ProgrammingNameBracketStyle): string {
  if (bracketStyle === "none") return value;
  if (bracketStyle === "round") return `(${value})`;
  if (bracketStyle === "curly") return `{${value}}`;
  if (bracketStyle === "angle") return `<${value}>`;
  return `[${value}]`;
}

export function formatProgrammingName(
  values: Readonly<Record<ProgrammingNameToken, string>>,
  detail: string,
  settings: ProgrammingNameSettings,
): string {
  const normalized = normalizeProgrammingNameSettings(settings);
  const prefix = normalized.tokens
    .map((token) => values[token].trim())
    .filter(Boolean)
    .map((value) => wrapProgrammingNameToken(value, normalized.bracketStyle))
    .join(normalized.tokenSeparator);
  const trimmedDetail = detail.trim();
  if (!prefix) return trimmedDetail;
  if (!trimmedDetail) return prefix;
  return `${prefix}${normalized.detailSeparator}${trimmedDetail}`;
}
