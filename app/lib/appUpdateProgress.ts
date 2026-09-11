export type AppUpdateState = "current" | "available" | "build_required" | "blocked" | "not_configured" | "checking_failed";

export interface AppUpdateStatus {
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
    startedAt?: string;
    updatedAt?: string;
  };
}

const STATES = new Set(["current", "available", "build_required", "blocked", "not_configured", "checking_failed"]);
export function isAppUpdateStatus(value: unknown): value is AppUpdateStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.enabled !== "boolean" || typeof item.state !== "string" || !STATES.has(item.state)
    || typeof item.message !== "string" || typeof item.dirty !== "boolean"
    || typeof item.checkedAt !== "string" || !Number.isFinite(Date.parse(item.checkedAt))
    || typeof item.ahead !== "number" || !Number.isFinite(item.ahead)
    || typeof item.behind !== "number" || !Number.isFinite(item.behind)) return false;
  for (const key of ["branch", "upstream", "localSha", "remoteSha", "buildSha", "buildBuiltAt", "buildDistDir", "buildInfoPath", "appDir", "gitPath"]) {
    if (item[key] !== undefined && typeof item[key] !== "string") return false;
  }
  if (item.lastRun !== undefined) {
    if (!item.lastRun || typeof item.lastRun !== "object" || Array.isArray(item.lastRun)) return false;
    const run = item.lastRun as Record<string, unknown>;
    for (const key of ["state", "currentStep", "message", "startedAt", "updatedAt"]) {
      if (run[key] !== undefined && typeof run[key] !== "string") return false;
    }
    if (run.progress !== undefined && (typeof run.progress !== "number" || !Number.isFinite(run.progress) || run.progress < 0 || run.progress > 100)) return false;
  }
  return true;
}

// Only acknowledged work phases have estimates. Queued/unknown and network
// failures must never be inferred to mean that install/build has started.
export const UPDATE_STEP_SECONDS: Record<string, number> = {
  "git-check": 5, "git-fetch": 10, "git-pull": 8,
  "backup-data": 15, "npm-install": 180, build: 200, restart: 20,
};
const PHASES = Object.keys(UPDATE_STEP_SECONDS);

export function remainingUpdateEstimate(step: string | undefined, phaseElapsed: number, durations: Record<string, number>, connected: boolean, terminal: boolean): string {
  if (terminal) return "";
  if (!connected) return "完了までの目安: 通信回復待ち（残り時間は算出できません）";
  const index = step ? PHASES.indexOf(step) : -1;
  if (index < 0) return "完了までの目安: 算出待ち（更新処理の開始を確認しています）";
  const expected = (phase: string): number => {
    const learned = durations[phase];
    return Number.isFinite(learned) && learned >= 1 && learned <= 1800 ? learned : UPDATE_STEP_SECONDS[phase];
  };
  const current = expected(PHASES[index]);
  if (phaseElapsed > current * 2) return "完了までの目安: 算出待ち（この処理が通常より長くかかっています）";
  const remaining = Math.max(0, current - phaseElapsed) + PHASES.slice(index + 1).reduce((sum, phase) => sum + expected(phase), 0);
  const minimum = Math.max(1, Math.ceil(remaining * 0.5 / 60));
  const maximum = Math.max(minimum + 1, Math.ceil(remaining * 2 / 60));
  return `完了までの目安: 残り約${minimum}〜${maximum}分（PC・回線によって変わります）`;
}
