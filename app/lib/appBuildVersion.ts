// Client-safe helpers for the "App version" badge. The value comes from the
// build metadata written by scripts/write-cfs-build-info.mjs next to the app
// folder (never from Git HEAD or the remote), so what the user sees and copies
// is the build that is actually serving the page.

export interface AppBuildVersion {
  gitSha: string;
  builtAt?: string;
  packageVersion?: string;
}

export const APP_VERSION_UNKNOWN_LABEL = "Version unknown";
export const APP_VERSION_SHORT_SHA_LENGTH = 12;
// Characters kept visible when the project toolbar is too narrow for the full
// 12-character label (T-139). Tooltip, aria-label and copy keep the full SHA.
export const APP_VERSION_COMPACT_SHA_LENGTH = 7;

export function shortBuildSha(value: string): string {
  return value.length > APP_VERSION_SHORT_SHA_LENGTH ? value.slice(0, APP_VERSION_SHORT_SHA_LENGTH) : value;
}

/** Calendar release number, with the same grammar as bump-cfs-version.mjs. */
export function isCalendarAppVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^([1-9]\d)\.([1-9]|1[0-2])\.([1-9]\d*)$/.exec(value);
  return Boolean(match && Number.isSafeInteger(Number(match[3])));
}

/** Pill text: release number, legacy SHA, or "Version unknown". */
export function formatAppVersionLabel(info: AppBuildVersion | null): string {
  if (!info?.gitSha) return APP_VERSION_UNKNOWN_LABEL;
  if (isCalendarAppVersion(info.packageVersion)) return `v${info.packageVersion}`;
  return shortBuildSha(info.gitSha);
}

export interface AppVersionLabelParts {
  /** Rendered only on wide toolbars ("Version " of the unknown label). */
  prefix: string;
  /** Always rendered: the release number, 7-character SHA prefix, or "unknown". */
  visible: string;
  /** Rendered only on wide toolbars (characters 8-12 of the SHA). */
  suffix: string;
}

/**
 * Pill text split for narrow toolbars. `prefix` + `visible` + `suffix` is the
 * full label, so the element's textContent, aria-label, tooltip and copy text
 * keep the complete identifier while CSS may hide the prefix and suffix.
 */
export function splitAppVersionLabel(info: AppBuildVersion | null): AppVersionLabelParts {
  const label = formatAppVersionLabel(info);
  if (!info?.gitSha) {
    const visible = label.slice(label.lastIndexOf(" ") + 1);
    return { prefix: label.slice(0, label.length - visible.length), visible, suffix: "" };
  }
  if (isCalendarAppVersion(info.packageVersion)) return { prefix: "", visible: label, suffix: "" };
  return { prefix: "", visible: label.slice(0, APP_VERSION_COMPACT_SHA_LENGTH), suffix: label.slice(APP_VERSION_COMPACT_SHA_LENGTH) };
}

/** Text placed on the clipboard. Full SHA plus build time; no paths. */
export function appVersionCopyText(info: AppBuildVersion | null): string {
  if (!info?.gitSha) return "";
  if (isCalendarAppVersion(info.packageVersion)) return `v${info.packageVersion} (${info.gitSha})`;
  return info.builtAt ? `CFS app build ${info.gitSha} (built ${info.builtAt})` : `CFS app build ${info.gitSha}`;
}

/** Tooltip text. Mentions the build origin so it is not mistaken for a Room Type revision. */
export function appVersionTitle(info: AppBuildVersion | null): string {
  if (!info?.gitSha) {
    return "App version: unknown. Build metadata was not found for the running build.";
  }
  const identifier = isCalendarAppVersion(info.packageVersion) ? `v${info.packageVersion} (${info.gitSha})` : info.gitSha;
  const parts = [`App version (running build): ${identifier}`];
  if (info.builtAt) parts.push(`Built at: ${info.builtAt}`);
  parts.push("Click Copy to copy the full build identifier.");
  return parts.join("\n");
}

export function isAppBuildVersion(value: unknown): value is AppBuildVersion {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.gitSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(item.gitSha)) return false;
  for (const key of ["builtAt", "packageVersion"]) {
    if (item[key] !== undefined && typeof item[key] !== "string") return false;
  }
  return true;
}
