"use client";

import { useState } from "react";
import { ActionIcon } from "./ActionIconButton";
import { useAppBuildInfo } from "./AppBuildInfoProvider";
import { appVersionCopyText, appVersionTitle, formatAppVersionLabel, splitAppVersionLabel } from "../lib/appBuildVersion";

interface AppVersionBadgeProps {
  compact?: boolean;
}

/**
 * Shows the version of the running build (from .cfs-build-info.json) with a
 * copy button. Labelled "App" so it is never confused with a Room Type
 * revision; shows "Version unknown" when build metadata is unavailable.
 */
export default function AppVersionBadge({ compact = false }: AppVersionBadgeProps) {
  const info = useAppBuildInfo();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const label = formatAppVersionLabel(info);
  const { prefix, visible, suffix } = splitAppVersionLabel(info);
  const copyText = appVersionCopyText(info);
  const title = appVersionTitle(info);
  const known = copyText.length > 0;

  async function copyVersion(): Promise<void> {
    if (!known) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy app version";

  return (
    <div
      className={`app-version-badge${compact ? " is-compact" : ""}${known ? "" : " is-unknown"}`}
      title={title}
      aria-label={`App version ${label}`}
      data-testid="app-version-badge"
    >
      <span className="app-version-label" aria-hidden="true">App</span>
      <code className="app-version-value" data-testid="app-version-value">
        {prefix ? <span className="app-version-value-wide-only">{prefix}</span> : null}
        {visible}
        {suffix ? <span className="app-version-value-wide-only">{suffix}</span> : null}
      </code>
      <button
        type="button"
        className={`history-button history-icon-button app-version-copy${copyState === "copied" ? " is-copied" : ""}`}
        onClick={() => void copyVersion()}
        disabled={!known}
        title={copyLabel}
        aria-label={copyLabel}
        data-testid="app-version-copy"
      >
        <ActionIcon name="copy" />
        <span className="app-version-copy-feedback" aria-live="polite">{copyState === "copied" ? "Copied" : ""}</span>
      </button>
    </div>
  );
}
