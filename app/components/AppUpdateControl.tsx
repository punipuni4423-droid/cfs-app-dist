"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AppUpdateState =
  | "current"
  | "available"
  | "build_required"
  | "blocked"
  | "not_configured"
  | "checking_failed";

interface AppUpdateStatus {
  enabled: boolean;
  state: AppUpdateState;
  message: string;
  branch?: string;
  upstream?: string;
  localSha?: string;
  remoteSha?: string;
  buildSha?: string;
  buildBuiltAt?: string;
  buildDistDir?: string;
  buildInfoPath?: string;
  buildStale?: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  checkedAt: string;
  appDir?: string;
  gitPath?: string;
  lastRun?: {
    state?: string;
    currentStep?: string;
    progress?: number;
    message?: string;
    updatedAt?: string;
  };
}

const UPDATE_SESSION_KEY = "cfs-self-update-active";

const STEP_LABELS: Record<string, string> = {
  queued: "Starting update",
  start: "Preparing update",
  "git-check": "Checking Git repository",
  "git-fetch": "Fetching update",
  "git-pull": "Applying files",
  "npm-install": "Installing dependencies",
  build: "Building app",
  restart: "Restarting app",
  done: "Completed",
  failed: "Failed",
  launch: "Launching updater",
};

const STEP_PROGRESS: Record<string, number> = {
  queued: 1,
  start: 5,
  "git-check": 10,
  "git-fetch": 25,
  "git-pull": 40,
  "npm-install": 58,
  build: 78,
  restart: 94,
  done: 100,
  failed: 100,
  launch: 2,
};

function boundedProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function shortSha(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

function statusLabel(status: AppUpdateStatus | null, busy: boolean): string {
  if (busy) return "Checking...";
  if (!status) return "Check Update";
  if (status.lastRun?.state === "running") return "Updating...";
  switch (status.state) {
    case "available":
      return "Update Available";
    case "build_required":
      return "Rebuild Required";
    case "current":
      return status.ahead > 0 ? "Local Ahead" : "Latest";
    case "blocked":
      return "Update Blocked";
    case "not_configured":
      return "Git Setup Needed";
    case "checking_failed":
      return "Retry Check";
    default:
      return "Check Update";
  }
}

function statusMessage(status: AppUpdateStatus | null, applyStarted: boolean): string | null {
  if (applyStarted) return "Update is running. Please wait.";
  if (!status) return null;
  if (status.lastRun?.state === "running") {
    return status.lastRun.currentStep ? `Running: ${status.lastRun.currentStep}` : "Update is running.";
  }
  if (status.state === "available") {
    return `${status.behind} Git update${status.behind === 1 ? "" : "s"} ready.`;
  }
  if (status.state === "build_required") {
    return "Git is latest, but this running build is older.";
  }
  if (status.state === "blocked") {
    return status.message || "Commit or discard local tracked changes before updating.";
  }
  if (status.state === "checking_failed") {
    return status.message || "Could not check Git updates. Click Retry Check to try again.";
  }
  if (status.state === "not_configured") {
    return status.message;
  }
  if (status.state === "current") {
    return status.ahead > 0 ? status.message : "Latest version installed. Safe to use.";
  }
  return null;
}

function runStepLabel(status: AppUpdateStatus | null, updateSessionActive: boolean): string {
  if (status?.state === "checking_failed" && updateSessionActive) return "Restarting / reconnecting";
  const step = status?.lastRun?.currentStep;
  if (!step) return updateSessionActive ? "Starting update" : "Checking update";
  return STEP_LABELS[step] ?? step;
}

function runProgress(status: AppUpdateStatus | null, updateSessionActive: boolean): number {
  const progress = status?.lastRun?.progress;
  if (typeof progress === "number" && Number.isFinite(progress)) return boundedProgress(progress);
  if (status?.state === "checking_failed" && updateSessionActive) return 96;
  const step = status?.lastRun?.currentStep;
  if (step && STEP_PROGRESS[step] !== undefined) return STEP_PROGRESS[step];
  return updateSessionActive ? 2 : 0;
}

function overlayTitle(status: AppUpdateStatus | null): string {
  if (status?.lastRun?.state === "completed") return "Update completed";
  if (status?.lastRun?.state === "failed") return "Update failed";
  return "Updating CFS app";
}

function overlayMessage(status: AppUpdateStatus | null, updateSessionActive: boolean): string {
  if (status?.lastRun?.message) return status.lastRun.message;
  if (status?.state === "checking_failed" && updateSessionActive) {
    return "The app is restarting. This page will reconnect and reload automatically.";
  }
  return "Please do not edit, import, export, or save while the update is running.";
}

export default function AppUpdateControl() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyStarted, setApplyStarted] = useState(false);
  const [updateSessionActive, setUpdateSessionActive] = useState(false);
  const checkingRef = useRef(false);
  const statusRef = useRef<AppUpdateStatus | null>(null);
  const updateSessionActiveRef = useRef(false);

  const title = useMemo(() => {
    if (updateSessionActive || applyStarted) return "Update is running. The app will reload automatically.";
    if (!status) return "Check Git for CFS app updates.";
    const parts = [status.message];
    if (status.upstream) parts.push(`Remote: ${status.upstream}`);
    if (status.appDir) parts.push(`App folder: ${status.appDir}`);
    if (status.gitPath) parts.push(`Git: ${status.gitPath}`);
    const local = shortSha(status.localSha);
    const remote = shortSha(status.remoteSha);
    const build = shortSha(status.buildSha);
    if (local) parts.push(`Local: ${local}`);
    if (remote) parts.push(`Remote SHA: ${remote}`);
    if (build) parts.push(`Build SHA: ${build}`);
    if (status.buildBuiltAt) parts.push(`Built at: ${status.buildBuiltAt}`);
    if (status.buildInfoPath) parts.push(`Build info: ${status.buildInfoPath}`);
    if (status.behind > 0) parts.push(`${status.behind} update commit(s) behind.`);
    if (status.ahead > 0) parts.push(`${status.ahead} local commit(s) ahead.`);
    if (status.lastRun?.message) parts.push(`Last update: ${status.lastRun.message}`);
    return parts.join(" ");
  }, [applyStarted, status, updateSessionActive]);
  const message = statusMessage(status, applyStarted);
  const overlayVisible = updateSessionActive || status?.lastRun?.state === "running";
  const progress = runProgress(status, updateSessionActive);
  const stepLabel = runStepLabel(status, updateSessionActive);

  useEffect(() => {
    const active = window.sessionStorage.getItem(UPDATE_SESSION_KEY) === "1";
    setUpdateSessionActive(active);
    updateSessionActiveRef.current = active;
  }, []);

  useEffect(() => {
    updateSessionActiveRef.current = updateSessionActive;
  }, [updateSessionActive]);

  const refreshStatus = useCallback(async (options: { quiet?: boolean; fetchRemote?: boolean } = {}): Promise<AppUpdateStatus | null> => {
    if (checkingRef.current) return statusRef.current;
    checkingRef.current = true;
    if (!options.quiet) setBusy(true);
    try {
      const query = options.fetchRemote === true ? "?fetchRemote=1" : "?fetchRemote=0";
      const response = await fetch(`/api/app-update/status${query}`, { cache: "no-store" });
      const payload = (await response.json()) as AppUpdateStatus;
      statusRef.current = payload;
      setStatus(payload);
      return payload;
    } catch {
      const failed: AppUpdateStatus = {
        enabled: true,
        state: "checking_failed",
        message: updateSessionActiveRef.current
          ? "Waiting for the app to restart."
          : "Could not contact the update API.",
        ahead: 0,
        behind: 0,
        dirty: false,
        checkedAt: new Date().toISOString(),
        appDir: statusRef.current?.appDir,
        gitPath: statusRef.current?.gitPath,
      };
      statusRef.current = failed;
      setStatus(failed);
      return failed;
    } finally {
      checkingRef.current = false;
      if (!options.quiet) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus({ fetchRemote: true });
  }, [refreshStatus]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshStatus({ quiet: true, fetchRemote: true });
    }, 5 * 60 * 1000);

    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        void refreshStatus({ quiet: true, fetchRemote: true });
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!updateSessionActive && !applyStarted && status?.lastRun?.state !== "running") return;
    const intervalId = window.setInterval(() => {
      void refreshStatus({ quiet: true });
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [applyStarted, refreshStatus, status?.lastRun?.state, updateSessionActive]);

  useEffect(() => {
    if (!updateSessionActive || status?.lastRun?.state !== "completed") return;
    const timeoutId = window.setTimeout(() => {
      window.sessionStorage.removeItem(UPDATE_SESSION_KEY);
      window.location.reload();
    }, 1600);
    return () => window.clearTimeout(timeoutId);
  }, [status?.lastRun?.state, updateSessionActive]);

  async function handleClick(): Promise<void> {
    if (busy || updateSessionActive || applyStarted || status?.lastRun?.state === "running") return;
    const latest = await refreshStatus({ fetchRemote: true });
    if (!latest || (latest.state !== "available" && latest.state !== "build_required")) {
      return;
    }
    const confirmLines =
      latest.state === "build_required"
        ? [
            "Rebuild CFS app now?",
            "Git is already latest, but the running build is older.",
            "Project data will be backed up first.",
            "The app will rebuild and restart. Please avoid editing during the update.",
          ]
        : [
            "Update CFS app now?",
            "Project data will be backed up first.",
            "The app will rebuild and restart. Please avoid editing during the update.",
          ];
    const ok = window.confirm(confirmLines.join("\n"));
    if (!ok) return;
    const startedAt = new Date().toISOString();
    window.sessionStorage.setItem(UPDATE_SESSION_KEY, "1");
    setUpdateSessionActive(true);
    setApplyStarted(true);
    setStatus((current) => ({
      enabled: current?.enabled ?? true,
      state: current?.state ?? "available",
      message: "Update is running.",
      branch: current?.branch,
      upstream: current?.upstream,
      localSha: current?.localSha,
      remoteSha: current?.remoteSha,
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
      dirty: current?.dirty ?? false,
      checkedAt: startedAt,
      appDir: current?.appDir,
      gitPath: current?.gitPath,
      lastRun: {
        state: "running",
        currentStep: "queued",
        progress: 1,
        message: "Starting update process.",
        updatedAt: startedAt,
      },
    }));
    setBusy(true);
    try {
      const response = await fetch("/api/app-update/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        window.sessionStorage.removeItem(UPDATE_SESSION_KEY);
        setUpdateSessionActive(false);
        setApplyStarted(false);
        window.alert(payload?.error ?? "Update could not be started.");
        await refreshStatus();
        return;
      }
      await refreshStatus({ quiet: true });
    } catch {
      window.sessionStorage.removeItem(UPDATE_SESSION_KEY);
      setUpdateSessionActive(false);
      setApplyStarted(false);
      window.alert("Update could not be started.");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={`app-update-control app-update-control-${status?.state ?? "idle"}`} title={title}>
        <button
          type="button"
          className={`history-button app-update-button app-update-button-${status?.state ?? "idle"}${
            overlayVisible ? " is-running" : ""
          }`}
          onClick={() => void handleClick()}
          disabled={busy || overlayVisible}
        >
          {overlayVisible ? "Updating..." : statusLabel(status, busy)}
        </button>
        {message ? <span className="app-update-message">{message}</span> : null}
      </div>
      {overlayVisible ? (
        <div
          className={`app-update-overlay app-update-overlay-${status?.lastRun?.state ?? "running"}`}
          role="alertdialog"
          aria-modal="true"
          aria-live="assertive"
          aria-label="CFS app update progress"
        >
          <div className="app-update-overlay-card">
            <p className="app-update-overlay-kicker">CFS App Update</p>
            <h2>{overlayTitle(status)}</h2>
            <p>{overlayMessage(status, updateSessionActive)}</p>
            <div className="app-update-progress-meta">
              <span>{stepLabel}</span>
              <strong>{progress}%</strong>
            </div>
            <div
              className="app-update-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label={stepLabel}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            {status?.lastRun?.state === "completed" ? (
              <p className="app-update-overlay-note">Reloading automatically.</p>
            ) : null}
            {status?.lastRun?.state === "failed" ? (
              <div className="app-update-overlay-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    window.sessionStorage.removeItem(UPDATE_SESSION_KEY);
                    setUpdateSessionActive(false);
                    setApplyStarted(false);
                  }}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
