function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(canonicalize(value));
}

export function valuesDiffer(before: unknown, after: unknown): boolean {
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  return canonicalJson(before) !== canonicalJson(after);
}
