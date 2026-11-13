/** Excel's shared sheet-name contract; callers retain their own fallback. */
export function uniqueExcelSheetName(value: string, fallback: string, usedNames: Set<string>, ending = ""): string {
  const sanitize = (name: string) => name.replace(/[\[\]:*?\/\\\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ").replace(/^[\s']+|[\s']+$/g, "");
  const normalize = (name: string) => sanitize(name).slice(0, 31)
    .replace(/[\uD800-\uDBFF]$/, "").replace(/^[\s']+|[\s']+$/g, "");
  const cleaned = normalize(value) || normalize(fallback) || "Sheet";
  const reserved = sanitize(ending);
  const base = !reserved && cleaned.toLowerCase() === "history" ? `${cleaned}_` : cleaned;
  function fit(counter = ""): string {
    const limit = 31 - counter.length;
    if (!reserved) return `${base.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "").replace(/'+$/, "")}${counter}`;
    // If an unrestricted legacy revision exceeds the whole budget, keep the rightmost part (including the tab).
    const suffix = reserved.slice(-limit).replace(/^[\s'\uDC00-\uDFFF]+/, "");
    const prefix = base.slice(0, Math.max(0, limit - suffix.length - 1)).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
    return `${prefix ? `${prefix} ` : ""}${suffix}${counter}`;
  }
  let candidate = fit();
  for (let suffix = 2; usedNames.has(candidate.toLowerCase()); suffix += 1) {
    candidate = fit(` (${suffix})`);
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}
