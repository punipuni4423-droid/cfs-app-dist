"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CollaborationEditorInfo,
  CollaborationLock,
  CollaborationMembership,
  CollaborationRole,
  CollaborationStatus,
  CollaborationUser,
} from "../types";
import type { CollaborationSaveIdentity } from "./storage";
import { getApiIdentity } from "./apiAccessClient";
import { finiteFetch, SaveProtocolError } from './projectSaveProtocol';

const USER_KEY = "cfs-collaboration-user-v1";
const SESSION_KEY = "cfs-collaboration-session-v1";
type CollaborationEditorDraft = Omit<CollaborationEditorInfo, "updatedAt">;
type SharingMode = "local" | "supabase";

interface SharingConfig {
  mode: SharingMode;
  url?: string;
  publishableKey?: string;
  error?: string;
}

interface CollaborationReleaseResponse {
  ok?: boolean;
  released?: boolean;
  status?: CollaborationStatus;
}

interface CollaborationClientState {
  enabled: boolean;
  mode: CollaborationStatus["mode"];
  sharingMode: SharingMode;
  authReady: boolean;
  authVerificationBlocked?: boolean;
  projectId: string;
  accessToken: string;
  user: CollaborationUser | null;
  role: CollaborationRole | null;
  sessionId: string;
  lock: CollaborationLock | null;
  locks: CollaborationLock[];
  lastUpdatedBy: CollaborationEditorInfo | null;
  lastUpdatedAt: string | null;
  busy: boolean;
  message: string;
  userDialogOpen: boolean;
  membersDialogOpen: boolean;
  members: CollaborationMembership[];
  leaseSeconds: number;
  heartbeatMs: number;
  idleMs: number;
}

export interface FinishEditingOptions {
  idle?: boolean;
  bypassGuard?: boolean;
}

export type CollaborationFinishGuard = (options: { idle: boolean }) => boolean | Promise<boolean>;
export type CollaborationEditStartRefresh = (status: CollaborationStatus) => boolean | void | Promise<boolean | void>;

export interface CollaborationController extends CollaborationClientState {
  canEdit: boolean;
  canCreateProject: boolean;
  isViewing: boolean;
  requiresSignIn: boolean;
  editIdentity: CollaborationSaveIdentity | undefined;
  projectCreateIdentity: CollaborationSaveIdentity | undefined;
  editorInfo: CollaborationEditorDraft | null;
  openUserDialog: () => void;
  closeUserDialog: () => void;
  saveUser: (profile: { displayName: string; email: string }) => Promise<void>;
  requestMicrosoftSignIn: (emailHint?: string) => Promise<void>;
  signOut: () => Promise<void>;
  openMembersDialog: () => Promise<void>;
  closeMembersDialog: () => void;
  saveMember: (member: { email: string; displayName: string; role: CollaborationRole; active: boolean }) => Promise<void>;
  startEditing: () => Promise<void>;
  forceReleaseLock: () => Promise<void>;
  finishEditing: (options?: FinishEditingOptions) => Promise<void>;
  setFinishGuard: (guard: CollaborationFinishGuard | null) => void;
  setEditStartRefresh: (refresh: CollaborationEditStartRefresh | null) => void;
  refreshStatus: () => Promise<void>;
  markActivity: () => void;
  resumeIdleAfterSave?: () => void;
  readOnlyMessage: () => void;
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

function loadStoredUser(): CollaborationUser | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_KEY) || "null") as CollaborationUser | null;
    if (!parsed?.id || !parsed.displayName) return null;
    return {
      id: getApiIdentity()?.userId || parsed.id,
      displayName: parsed.displayName,
      email: parsed.email || "",
      role: parsed.role,
      createdAt: parsed.createdAt || null,
      lastSeenAt: parsed.lastSeenAt || null,
    };
  } catch {
    return null;
  }
}

function saveStoredUser(user: CollaborationUser): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function ensureSessionId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  const prefix = getApiIdentity()?.sessionId;
  if (existing && (!prefix || existing.startsWith(`${prefix}:`))) return existing;
  const created = prefix ? `${prefix}:${newId('tab')}` : newId("session");
  window.sessionStorage.setItem(SESSION_KEY, created);
  return created;
}

function userFromMembership(membership: CollaborationMembership): CollaborationUser {
  return {
    id: membership.id,
    displayName: membership.displayName,
    email: membership.email,
    role: membership.role,
    createdAt: membership.createdAt,
    lastSeenAt: membership.lastSeenAt,
  };
}

function authUrlParams(): { hash: URLSearchParams; search: URLSearchParams } | null {
  if (typeof window === "undefined") return null;
  const current = new URL(window.location.href);
  return {
    hash: new URLSearchParams(current.hash.startsWith("#") ? current.hash.slice(1) : current.hash),
    search: current.searchParams,
  };
}

function clearAuthUrlParams(): void {
  if (typeof window === "undefined") return;
  const current = new URL(window.location.href);
  const hashParams = new URLSearchParams(current.hash.startsWith("#") ? current.hash.slice(1) : current.hash);
  const searchParams = current.searchParams;
  const hasAuthHash =
    hashParams.has("access_token") ||
    hashParams.has("refresh_token") ||
    hashParams.has("provider_token") ||
    hashParams.has("error") ||
    hashParams.has("error_description");
  const hasAuthSearch =
    searchParams.has("code") ||
    searchParams.has("error") ||
    searchParams.has("error_description");
  if (!hasAuthHash && !hasAuthSearch) return;
  searchParams.delete("code");
  searchParams.delete("error");
  searchParams.delete("error_description");
  current.hash = "";
  current.search = searchParams.toString();
  window.history.replaceState(null, document.title, current.pathname + current.search);
}

async function restoreSupabaseSessionFromUrl(supabase: SupabaseClient): Promise<string> {
  const params = authUrlParams();
  if (!params) return "";
  const accessToken = params.hash.get("access_token") || "";
  const refreshToken = params.hash.get("refresh_token") || "";
  const code = params.search.get("code") || "";
  const hasAuthResult =
    Boolean(accessToken || refreshToken || code) ||
    params.hash.has("error") ||
    params.hash.has("error_description") ||
    params.search.has("error") ||
    params.search.has("error_description");
  if (!hasAuthResult) return "";

  try {
    if (accessToken && refreshToken) {
      const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (error) throw error;
      return data.session?.access_token || accessToken;
    }
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return data.session?.access_token || "";
    }
    return "";
  } finally {
    clearAuthUrlParams();
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `Request failed: ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload as T;
}

const TRANSIENT_LOCK_CHECK_MESSAGE = "Checking edit lock.";
const COLLABORATION_FETCH_TIMEOUT_MS = 15_000;

// Lock/status requests must not hang forever: a stalled request would leave
// busy=true, which freezes the status poll and pins the transient message.
function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return finiteFetch(String(input), init, COLLABORATION_FETCH_TIMEOUT_MS);
}

// A status refresh without an explicit message must not preserve the transient
// "Checking edit lock." forever; replace it with the actual shared-edit state.
function resolveStatusMessage(status: CollaborationStatus, currentMessage: string): string {
  if (currentMessage !== TRANSIENT_LOCK_CHECK_MESSAGE) return currentMessage;
  if (status.mode === "edit") return "Editing resumed.";
  if (status.lock) {
    const owner = status.lock.userName || "Another user";
    return `${owner} is editing. The lock auto-releases after inactivity.`;
  }
  return "";
}

function normalizeProjectId(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z0-9:_-]{0,128}$/.test(trimmed) ? trimmed : "";
}

export function useCollaboration(projectId = ""): CollaborationController {
  const scopedProjectId = normalizeProjectId(projectId);
  const [state, setState] = useState<CollaborationClientState>({
    enabled: false,
    mode: "local",
    sharingMode: "local",
    authReady: false,
    authVerificationBlocked: false,
    projectId: scopedProjectId,
    accessToken: "",
    user: null,
    role: null,
    sessionId: "",
    lock: null,
    locks: [],
    lastUpdatedBy: null,
    lastUpdatedAt: null,
    busy: false,
    message: "",
    userDialogOpen: false,
    membersDialogOpen: false,
    members: [],
    leaseSeconds: 90,
    heartbeatMs: 20_000,
    idleMs: 15 * 60 * 1000,
  });
  const stateRef = useRef(state);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const lastActivityAtRef = useRef(Date.now());
  const lastHeartbeatAtRef = useRef(0);
  const heartbeatInFlightRef = useRef(false);
  const finishingRef = useRef(false);
  const releasingRef = useRef(false);
  const idleBlockedRef = useRef(false);
  const transitionRef = useRef(0);
  const authGenerationRef = useRef(0);
  const finishGuardRef = useRef<CollaborationFinishGuard | null>(null);
  const editStartRefreshRef = useRef<CollaborationEditStartRefresh | null>(null);
  const startEditingAfterRegistrationRef = useRef(false);
  const projectIdRef = useRef(scopedProjectId);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const authHeaders = useCallback((token = stateRef.current.accessToken): HeadersInit => {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const identityBody = useCallback(() => ({
    userId: stateRef.current.user?.id || "",
    sessionId: stateRef.current.sessionId || "",
    projectId: projectIdRef.current,
  }), []);

  const applyStatus = useCallback((status: CollaborationStatus, message?: string): void => {
    setState((current) => {
      const membership = status.membership;
      const user = membership ? userFromMembership(membership) : current.user;
      return {
        ...current,
        enabled: Boolean(status.enabled),
        mode: current.authVerificationBlocked ? 'view' : status.mode,
        projectId: status.projectId || projectIdRef.current,
        lock: status.lock,
        locks: status.locks || [],
        user,
        role: membership?.role || current.role,
        lastUpdatedBy: status.lastUpdatedBy || current.lastUpdatedBy,
        lastUpdatedAt: status.lastUpdatedAt !== undefined ? status.lastUpdatedAt : current.lastUpdatedAt,
        leaseSeconds: Number(status.leaseSeconds) || current.leaseSeconds,
        heartbeatMs: Number(status.heartbeatMs) || current.heartbeatMs,
        idleMs: Number(status.idleMs) || current.idleMs,
        message: message ?? resolveStatusMessage(status, current.message),
      };
    });
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    const transition = transitionRef.current;
    if (current.sharingMode === "supabase" && !current.accessToken) return;
    const { userId, sessionId, projectId } = identityBody();
    const query = new URLSearchParams({ userId, sessionId, projectId });
    const response = await fetchWithTimeout(`/api/collaboration/status?${query}`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    const status = await parseJsonResponse<CollaborationStatus>(response);
    if (transition === transitionRef.current && !releasingRef.current) applyStatus(status);
  }, [applyStatus, authHeaders, identityBody]);

  const releaseEditingLock = useCallback(async (): Promise<CollaborationStatus | null> => {
    const response = await fetchWithTimeout("/api/collaboration/lock/release", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(identityBody()),
    });
    const payload = await parseJsonResponse<CollaborationReleaseResponse>(response);
    return payload.status ?? null;
  }, [authHeaders, identityBody]);

  const runEditStartRefresh = useCallback(async (status: CollaborationStatus): Promise<boolean> => {
    const transition = transitionRef.current;
    const refresh = editStartRefreshRef.current;
    if (!refresh) return true;
    setState((current) => ({ ...current, message: "Refreshing latest shared data." }));
    try {
      const result = await refresh(status);
      if (transition !== transitionRef.current) return false;
      if (result === false) throw new Error("Latest shared data could not be loaded.");
      return true;
    } catch (error) {
      if (transition !== transitionRef.current) return false;
      const message = error instanceof Error
        ? `Latest shared data could not be loaded: ${error.message}. Edit mode was not started.`
        : "Latest shared data could not be loaded. Edit mode was not started.";
      try {
        const releaseStatus = await releaseEditingLock();
        if (transition !== transitionRef.current) return false;
        if (releaseStatus) {
          applyStatus(releaseStatus, message);
        } else {
          setState((current) => ({ ...current, mode: "view", lock: null, message }));
        }
      } catch {
        setState((current) => ({ ...current, mode: "view", message: `${message} The edit lock could not be released immediately and will expire automatically.` }));
      }
      return false;
    }
  }, [applyStatus, releaseEditingLock]);

  useEffect(() => {
    const previousProjectId = projectIdRef.current;
    if (previousProjectId !== scopedProjectId) { transitionRef.current++; idleBlockedRef.current = false; }
    const current = stateRef.current;
    if (
      previousProjectId !== scopedProjectId &&
      current.enabled &&
      current.mode === "edit" &&
      current.user &&
      current.sessionId
    ) {
      void fetch("/api/collaboration/lock/release", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(current.accessToken) },
        body: JSON.stringify({
          userId: current.user.id,
          sessionId: current.sessionId,
          projectId: previousProjectId,
        }),
      }).catch(() => undefined);
    }
    projectIdRef.current = scopedProjectId;
    lastHeartbeatAtRef.current = 0;
    setState((currentState) => ({
      ...currentState,
      projectId: scopedProjectId,
      mode: currentState.mode === "local" ? currentState.mode : "view",
      lock: null,
      message: currentState.authReady ? "Checking edit lock." : currentState.message,
    }));
  }, [authHeaders, scopedProjectId]);

  useEffect(() => {
    if (!state.authReady) return;
    void refreshStatus().catch(() => {
      // Do not leave the transient lock-check message pinned when the status
      // request fails; the 20s poll retries and clears this automatically.
      setState((current) =>
        current.message === TRANSIENT_LOCK_CHECK_MESSAGE
          ? { ...current, message: "Shared edit status could not be read. Retrying automatically." }
          : current,
      );
    });
  }, [refreshStatus, scopedProjectId, state.authReady]);

  const hydrateSecureSession = useCallback(async (token: string, sessionId: string): Promise<void> => {
    const authGeneration = ++authGenerationRef.current;
    if (!token) {
      transitionRef.current++; idleBlockedRef.current = true;
      setState((current) => ({
        ...current,
        enabled: true,
        sharingMode: "supabase",
        authReady: true,
        projectId: projectIdRef.current,
        accessToken: "",
        authVerificationBlocked: true,
        user: null,
        role: null,
        mode: "view",
        lock: null,
        locks: [],
        message: "Sign in with your Microsoft account. An Admin must add your email address before access is granted.",
      }));
      return;
    }
    try {
      const authResponse = await fetchWithTimeout("/api/collaboration/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: "{}",
      });
      const authPayload = await parseJsonResponse<{ membership: CollaborationMembership }>(authResponse);
      if (authGeneration !== authGenerationRef.current) return;
      if (stateRef.current.user?.id !== userFromMembership(authPayload.membership).id) transitionRef.current++;
      const transition = transitionRef.current;
      let status: CollaborationStatus | null = null;
      let statusError = "";
      try {
        const statusResponse = await fetchWithTimeout(`/api/collaboration/status?${new URLSearchParams({ sessionId, projectId: projectIdRef.current })}`, {
          cache: "no-store",
          headers: authHeaders(token),
        });
        status = await parseJsonResponse<CollaborationStatus>(statusResponse);
      } catch (error) {
        statusError = error instanceof Error ? error.message : "Could not read shared edit status.";
      }
      const user = userFromMembership(authPayload.membership);
      if (authGeneration !== authGenerationRef.current) return;
      if (transition !== transitionRef.current || releasingRef.current) status = null;
      setState((current) => ({
        ...current,
        enabled: true,
        sharingMode: "supabase",
        authReady: true,
        projectId: status?.projectId || projectIdRef.current,
        accessToken: token,
        authVerificationBlocked: false,
        user,
        role: authPayload.membership.role,
        mode: status?.mode || (current.user?.id === user.id ? current.mode : 'view'),
        lock: status?.lock || (current.user?.id === user.id ? current.lock : null),
        locks: status?.locks || [],
        lastUpdatedBy: status?.lastUpdatedBy || current.lastUpdatedBy,
        lastUpdatedAt: status?.lastUpdatedAt !== undefined ? status.lastUpdatedAt : current.lastUpdatedAt,
        leaseSeconds: Number(status?.leaseSeconds) || current.leaseSeconds,
        heartbeatMs: Number(status?.heartbeatMs) || current.heartbeatMs,
        idleMs: Number(status?.idleMs) || current.idleMs,
        message: status
          ? status.mode === "edit" ? "Editing resumed." : "Signed in. Start editing when you are ready."
          : `Signed in. Shared edit status could not be read${statusError ? `: ${statusError}` : "."}`,
      }));
    } catch (error) {
      // Supabase fires an auth event on every token refresh, and this hydrate
      // runs each time. A transient network failure here must not clear the
      // signed-in user: that flips requiresSignIn, which reloads all projects
      // and silently discards unsaved local edits. Only a real server-side
      // rejection (4xx with a message) signs the user out.
      if (authGeneration !== authGenerationRef.current) return;
      const transient =
        error instanceof TypeError || error instanceof SaveProtocolError ||
        (error instanceof Error && Number((error as Error & { status?: number }).status) >= 500) ||
        (error instanceof DOMException && error.name === "AbortError");
      transitionRef.current++; idleBlockedRef.current = true;
      setState((current) => {
        const keepSignedIn = transient && Boolean(current.user);
        return {
          ...current,
          enabled: true,
          sharingMode: "supabase",
          authReady: true,
          projectId: projectIdRef.current,
          accessToken: keepSignedIn ? current.accessToken : '',
          authVerificationBlocked: true,
          user: keepSignedIn ? current.user : null,
          role: keepSignedIn ? current.role : null,
          mode: "view",
          lock: keepSignedIn ? current.lock : null,
          locks: keepSignedIn ? current.locks : [],
          message: keepSignedIn
            ? "Your account could not be verified. Previous authentication and drafts are retained, and you are back in viewer mode. Sign in again."
            : error instanceof Error
              ? error.message
              : "Could not verify this CFS account.",
        };
      });
    }
  }, [authHeaders]);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    const sessionId = ensureSessionId();
    const start = async (): Promise<void> => {
      try {
        const configResponse = await fetch("/api/sharing/config", { cache: "no-store" });
        const config = await parseJsonResponse<SharingConfig>(configResponse);
        if (!mounted) return;
        if (config.mode !== "supabase") {
          const user = loadStoredUser();
          if (user && getApiIdentity()) {
            const registration = await fetch('/api/collaboration/users/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: user.id, displayName: user.displayName, email: user.email }) });
            if (!registration.ok) throw new Error('The user connection could not be verified.');
            saveStoredUser(user);
          }
          setState((current) => ({ ...current, sharingMode: "local", authReady: true, projectId: projectIdRef.current, sessionId, user }));
          const response = await fetch(`/api/collaboration/status?${new URLSearchParams({ userId: user?.id || "", sessionId, projectId: projectIdRef.current })}`, { cache: "no-store" });
          const status = await parseJsonResponse<CollaborationStatus>(response);
          if (mounted) applyStatus(status, status.enabled ? "Started in view mode." : "");
          return;
        }
        if (!config.url || !config.publishableKey) throw new Error(config.error || "Secure sharing configuration is incomplete.");
        const supabase = createClient(config.url, config.publishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        supabaseRef.current = supabase;
        setState((current) => ({ ...current, sharingMode: "supabase", projectId: projectIdRef.current, sessionId }));
        const restoredToken = await restoreSupabaseSessionFromUrl(supabase);
        const { data: sessionData } = await supabase.auth.getSession();
        if (mounted) await hydrateSecureSession(sessionData.session?.access_token || restoredToken || "", sessionId);
        const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
          void hydrateSecureSession(nextSession?.access_token || "", sessionId);
        });
        unsubscribe = () => listener.subscription.unsubscribe();
      } catch (error) {
        if (!mounted) return;
        setState((current) => ({
          ...current,
          enabled: true,
          sharingMode: "supabase",
          authReady: true,
          projectId: projectIdRef.current,
          sessionId,
          locks: [],
          message: error instanceof Error ? error.message : "Could not initialize secure sharing.",
        }));
      }
    };
    void start();
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [applyStatus, hydrateSecureSession]);

  const openUserDialog = useCallback((): void => {
    startEditingAfterRegistrationRef.current = false;
    setState((current) => ({ ...current, userDialogOpen: true }));
  }, []);

  const closeUserDialog = useCallback((): void => {
    startEditingAfterRegistrationRef.current = false;
    setState((current) => ({ ...current, userDialogOpen: false }));
  }, []);

  const saveUser = useCallback(async (profile: { displayName: string; email: string }): Promise<void> => {
    if (stateRef.current.sharingMode === "supabase") {
      await Promise.resolve();
      return;
    }
    const displayName = profile.displayName.trim();
    if (!displayName) {
      window.alert("Enter a display name.");
      return;
    }
    setState((current) => ({ ...current, busy: true, message: "Registering user." }));
    try {
      const existing = stateRef.current.user;
      const response = await fetch("/api/collaboration/users/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: getApiIdentity()?.userId || existing?.id || newId("user"), displayName, email: profile.email.trim() }),
      });
      const payload = await parseJsonResponse<{ ok: boolean; user: CollaborationUser }>(response);
      const shouldStartEditing = startEditingAfterRegistrationRef.current;
      startEditingAfterRegistrationRef.current = false;
      saveStoredUser(payload.user);
      setState((current) => ({
        ...current,
        user: payload.user,
        userDialogOpen: false,
        busy: shouldStartEditing,
        message: shouldStartEditing ? "Checking edit lock." : "User registration completed. Start editing to make changes.",
      }));
      if (!shouldStartEditing) {
        await refreshStatus();
        return;
      }

      const sessionId = stateRef.current.sessionId;
      if (!sessionId) {
        setState((current) => ({ ...current, busy: false, message: "User registration completed. Start editing to make changes." }));
        return;
      }

      try {
        const lockResponse = await fetchWithTimeout("/api/collaboration/lock/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ userId: payload.user.id, sessionId, projectId: projectIdRef.current }),
        });
        const lockPayload = await parseJsonResponse<{ acquired: boolean; lock: CollaborationLock | null; status: CollaborationStatus }>(lockResponse);
        if (!lockPayload.acquired) {
          const owner = lockPayload.lock?.userName || lockPayload.status?.lock?.userName || "Another user";
          applyStatus(lockPayload.status, `${owner} is editing. Stay in view mode.`);
          return;
        }
        const refreshed = await runEditStartRefresh(lockPayload.status);
        if (!refreshed) return;
        lastActivityAtRef.current = Date.now();
        lastHeartbeatAtRef.current = Date.now();
        applyStatus(lockPayload.status, "Editing started.");
      } catch (lockError) {
        setState((current) => ({
          ...current,
          message: lockError instanceof Error
            ? `User registration completed, but edit mode could not start: ${lockError.message}`
            : "User registration completed, but edit mode could not start.",
        }));
      } finally {
        setState((current) => ({ ...current, busy: false }));
      }
    } catch (error) {
      startEditingAfterRegistrationRef.current = false;
      setState((current) => ({ ...current, busy: false, message: "User registration failed." }));
      window.alert(error instanceof Error ? error.message : "User registration failed.");
    }
  }, [applyStatus, authHeaders, refreshStatus, runEditStartRefresh]);

  const requestMicrosoftSignIn = useCallback(async (emailHint = ""): Promise<void> => {
    const normalizedHint = emailHint.trim().toLowerCase();
    if (normalizedHint && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedHint)) {
      window.alert("Enter a valid email address.");
      return;
    }
    const supabase = supabaseRef.current;
    if (!supabase) {
      window.alert("Secure sign-in is not ready yet.");
      return;
    }
    setState((current) => ({ ...current, busy: true, message: "Redirecting to Microsoft sign-in." }));
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "azure",
        options: {
          redirectTo: window.location.origin,
          scopes: "openid email profile",
          ...(normalizedHint ? { queryParams: { login_hint: normalizedHint } } : {}),
        },
      });
      if (error) throw error;
      setState((current) => ({
        ...current,
        busy: false,
        userDialogOpen: false,
        message: "Redirecting to Microsoft sign-in.",
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Could not start Microsoft sign-in.";
      setState((current) => ({
        ...current,
        busy: false,
        message: errorMessage,
      }));
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    authGenerationRef.current++; transitionRef.current++; idleBlockedRef.current = true;
    try {
      if (stateRef.current.mode === "edit") {
        await releaseEditingLock().catch(() => undefined);
      }
      await supabaseRef.current?.auth.signOut();
    } finally {
      setState((current) => ({ ...current, mode: "view", accessToken: "", user: null, role: null, lock: null, locks: [], members: [], message: "Signed out." }));
    }
  }, [releaseEditingLock]);

  const openMembersDialog = useCallback(async (): Promise<void> => {
    if (stateRef.current.role !== "admin") return;
    setState((current) => ({ ...current, busy: true, membersDialogOpen: true, message: "Loading members." }));
    try {
      const response = await fetch("/api/collaboration/members", { cache: "no-store", headers: authHeaders() });
      const payload = await parseJsonResponse<{ members: CollaborationMembership[] }>(response);
      setState((current) => ({ ...current, busy: false, members: payload.members, message: "" }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, message: error instanceof Error ? error.message : "Could not load members." }));
    }
  }, [authHeaders]);

  const closeMembersDialog = useCallback((): void => {
    setState((current) => ({ ...current, membersDialogOpen: false }));
  }, []);

  const saveMember = useCallback(async (member: { email: string; displayName: string; role: CollaborationRole; active: boolean }): Promise<void> => {
    if (stateRef.current.role !== "admin") return;
    setState((current) => ({ ...current, busy: true }));
    try {
      const response = await fetch("/api/collaboration/members", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(member),
      });
      await parseJsonResponse(response);
      await openMembersDialog();
      await refreshStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the member.";
      setState((current) => ({ ...current, busy: false, message }));
      throw error instanceof Error ? error : new Error(message);
    }
  }, [authHeaders, openMembersDialog, refreshStatus]);

  const startEditing = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (current.authVerificationBlocked) { setState(next => ({ ...next, message: 'Your account needs verification. Sign in again.' })); return; }
    if (current.busy || finishingRef.current) return;
    const transition = ++transitionRef.current;
    idleBlockedRef.current = false;
    if (!current.user) {
      startEditingAfterRegistrationRef.current = true;
      setState((next) => ({ ...next, userDialogOpen: true }));
      return;
    }
    if (current.sharingMode === "supabase" && !roleAllowsClient(current.role, "editor")) {
      setState((next) => ({ ...next, message: "An Editor or Admin role is required to edit shared CFS projects." }));
      return;
    }
    setState((next) => ({ ...next, busy: true, message: "Checking edit lock." }));
    try {
      const response = await fetchWithTimeout("/api/collaboration/lock/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(identityBody()),
      });
      const payload = await parseJsonResponse<{ acquired: boolean; lock: CollaborationLock | null; status: CollaborationStatus }>(response);
      if (transition !== transitionRef.current) return;
      if (!payload.acquired) {
        const owner = payload.lock?.userName || payload.status?.lock?.userName || "Another user";
        applyStatus(payload.status, `${owner} is editing. Stay in view mode.`);
        return;
      }
      const refreshed = await runEditStartRefresh(payload.status);
      if (!refreshed || transition !== transitionRef.current) return;
      lastActivityAtRef.current = Date.now();
      lastHeartbeatAtRef.current = Date.now();
      applyStatus(payload.status, "Editing started.");
    } catch (error) {
      if (transition !== transitionRef.current) return;
      setState((next) => ({ ...next, message: error instanceof Error ? error.message : "Could not start editing." }));
    } finally {
      if (transition === transitionRef.current) setState((next) => ({ ...next, busy: false }));
    }
  }, [applyStatus, authHeaders, identityBody, runEditStartRefresh]);

  const forceReleaseLock = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (!current.lock || current.mode === "edit") return;
    if (current.sharingMode === "supabase" && current.role !== "admin") {
      setState((next) => ({ ...next, message: "An Admin role is required to force-release an edit lock." }));
      return;
    }
    setState((next) => ({ ...next, busy: true, message: "Releasing the edit lock." }));
    try {
      const response = await fetchWithTimeout("/api/collaboration/lock/force-release", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(identityBody()),
      });
      const payload = await parseJsonResponse<{ released: boolean; releasedLock?: CollaborationLock | null; status?: CollaborationStatus }>(response);
      const ownerName = payload.releasedLock?.userName || "the previous editor";
      if (payload.status) {
        applyStatus(
          payload.status,
          payload.released
            ? `Edit lock held by ${ownerName} was force-released. Start editing when you are ready.`
            : "No blocking edit lock was found.",
        );
        return;
      }
      await refreshStatus();
    } catch (error) {
      setState((next) => ({ ...next, message: error instanceof Error ? error.message : "Could not force-release the edit lock." }));
    } finally {
      setState((next) => ({ ...next, busy: false }));
    }
  }, [applyStatus, authHeaders, identityBody, refreshStatus]);

  const setFinishGuard = useCallback((guard: CollaborationFinishGuard | null): void => {
    finishGuardRef.current = guard;
  }, []);

  const setEditStartRefresh = useCallback((refresh: CollaborationEditStartRefresh | null): void => {
    editStartRefreshRef.current = refresh;
  }, []);

  const finishEditing = useCallback(async (options: FinishEditingOptions = {}): Promise<void> => {
    if (!stateRef.current.enabled || stateRef.current.mode !== "edit") return;
    if (finishingRef.current || (options.idle && idleBlockedRef.current)) return;
    finishingRef.current = true;
    if (!options.idle) idleBlockedRef.current = false;
    const transition = transitionRef.current;
    try {
    if (!options.bypassGuard && finishGuardRef.current) {
      try {
        if (!(await finishGuardRef.current({ idle: Boolean(options.idle) }))) { idleBlockedRef.current = true; return; }
      } catch {
        idleBlockedRef.current = true;
        setState((current) => ({ ...current, message: "Could not confirm the revision state. Continue editing and try again." }));
        return;
      }
    }
    if (transition !== transitionRef.current || stateRef.current.mode !== 'edit') return;
    releasingRef.current = true;
    transitionRef.current++;
    const releaseTransition = transitionRef.current;
    setState((current) => ({ ...current, busy: true }));
    let releaseFailed = false;
    let releaseStatus: CollaborationStatus | null = null;
    const releaseMessage = options.idle ? "Returned to view mode after inactivity." : "Returned to view mode.";
    try {
      releaseStatus = await releaseEditingLock();
    } catch {
      releaseFailed = true;
    } finally {
      if (releaseTransition !== transitionRef.current) return;
      const finishMessage = releaseFailed ? "Editing release could not be confirmed. The lock will expire automatically." : releaseMessage;
      if (!releaseFailed && releaseStatus) {
        applyStatus(releaseStatus, finishMessage);
        setState((current) => ({ ...current, busy: false, message: finishMessage }));
        return;
      }
      setState((current) => ({
        ...current,
        busy: false,
        mode: "view",
        lock: null,
        message: finishMessage,
      }));
      if (!releaseFailed) await refreshStatus().catch(() => undefined);
    }
    } finally { finishingRef.current = false; releasingRef.current = false; }
  }, [applyStatus, refreshStatus, releaseEditingLock]);

  const markActivity = useCallback((): void => {
    if (!stateRef.current.enabled || stateRef.current.mode !== "edit") return;
    lastActivityAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const events = ["pointerdown", "keydown", "input", "change"];
    events.forEach((eventName) => window.addEventListener(eventName, markActivity, true));
    return () => events.forEach((eventName) => window.removeEventListener(eventName, markActivity, true));
  }, [markActivity]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = stateRef.current;
      if (!current.enabled || releasingRef.current || (current.sharingMode === "supabase" && !current.user)) return;
      const now = Date.now();
      if (current.mode === "edit") {
        if (!current.busy && !finishingRef.current && !idleBlockedRef.current && now - lastActivityAtRef.current >= current.idleMs) {
          void finishEditing({ idle: true });
        }
        if (now - lastHeartbeatAtRef.current < current.heartbeatMs || heartbeatInFlightRef.current) return;
        heartbeatInFlightRef.current = true;
        const transition = transitionRef.current;
        void fetchWithTimeout("/api/collaboration/lock/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(identityBody()),
        })
          .then((response) => parseJsonResponse<{ acquired: boolean; lock: CollaborationLock | null; status?: CollaborationStatus }>(response))
          .then((payload) => {
            if (transition !== transitionRef.current || releasingRef.current) return;
            if (!payload.acquired) {
              transitionRef.current++;
              idleBlockedRef.current = true;
              if (payload.status) {
                applyStatus(payload.status, "Edit lock expired. Returned to view mode.");
              } else {
                setState((next) => ({ ...next, mode: "view", lock: payload.lock, message: "Edit lock expired. Returned to view mode." }));
              }
              return;
            }
            lastHeartbeatAtRef.current = Date.now();
            if (payload.status) {
              applyStatus(payload.status);
            } else {
              setState((next) => ({ ...next, lock: payload.lock || next.lock }));
            }
          })
          .catch(() => {
            if (transition !== transitionRef.current || releasingRef.current) return;
            transitionRef.current++; idleBlockedRef.current = true;
            setState((next) => ({ ...next, mode: "view", message: "Could not refresh edit lock. Returned to view mode. Unsaved changes remain on this device." }));
          })
          .finally(() => { heartbeatInFlightRef.current = false; });
        return;
      }
      if (now - lastHeartbeatAtRef.current >= current.heartbeatMs) {
        lastHeartbeatAtRef.current = now;
        void refreshStatus().catch(() => undefined);
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [applyStatus, authHeaders, finishEditing, identityBody, refreshStatus]);

  useEffect(() => {
    const release = (): void => {
      const current = stateRef.current;
      if (!current.enabled || current.mode !== "edit" || current.sharingMode === "supabase") return;
      const body = new Blob([JSON.stringify(identityBody())], { type: "application/json" });
      navigator.sendBeacon?.("/api/collaboration/lock/release", body);
    };
    window.addEventListener("beforeunload", release);
    return () => window.removeEventListener("beforeunload", release);
  }, [identityBody]);

  const canEdit = !state.authVerificationBlocked && (!state.enabled || (!releasingRef.current && state.mode === "edit" && (state.sharingMode !== "supabase" || roleAllowsClient(state.role, "editor"))));
  const requiresSignIn = state.sharingMode === "supabase" && (!state.accessToken || !state.user);
  const canCreateProject =
    !state.authVerificationBlocked && (!state.enabled ||
    Boolean(
      state.user &&
        state.sessionId &&
        (state.sharingMode !== "supabase" || (state.accessToken && roleAllowsClient(state.role, "editor"))),
    ));
  const editIdentity = useMemo<CollaborationSaveIdentity | undefined>(() => {
    if (state.authVerificationBlocked || !state.enabled || state.mode !== "edit" || !state.user || !state.sessionId) return undefined;
    return {
      userId: state.user.id,
      sessionId: state.sessionId,
      projectId: state.projectId || undefined,
      requireLock: true,
      accessToken: state.sharingMode === "supabase" ? state.accessToken : undefined,
    };
  }, [state.authVerificationBlocked, state.accessToken, state.enabled, state.mode, state.projectId, state.sessionId, state.sharingMode, state.user]);
  const projectCreateIdentity = useMemo<CollaborationSaveIdentity | undefined>(() => {
    if (state.authVerificationBlocked || !state.enabled || !state.user || !state.sessionId) return undefined;
    if (state.sharingMode === "supabase" && (!state.accessToken || !roleAllowsClient(state.role, "editor"))) return undefined;
    return {
      userId: state.user.id,
      sessionId: state.sessionId,
      requireLock: false,
      accessToken: state.sharingMode === "supabase" ? state.accessToken : undefined,
    };
  }, [state.authVerificationBlocked, state.accessToken, state.enabled, state.role, state.sessionId, state.sharingMode, state.user]);
  const editorInfo = useMemo<CollaborationEditorDraft | null>(() => {
    if (!state.user) return null;
    return { userId: state.user.id, displayName: state.user.displayName };
  }, [state.user]);
  const readOnlyMessage = useCallback((): void => {
    if (!stateRef.current.enabled) return;
    if (stateRef.current.sharingMode === "supabase" && !stateRef.current.user) {
      setState((current) => ({ ...current, message: "Sign in with your Microsoft account first." }));
      return;
    }
    const lock = stateRef.current.lock;
    const ownerText = lock?.userName ? `${lock.userName} is editing. ` : "";
    setState((current) => ({ ...current, message: `${ownerText}Start editing to change shared CFS data.` }));
  }, []);

  return {
    ...state,
    canEdit,
    canCreateProject,
    isViewing: state.enabled && !canEdit,
    requiresSignIn,
    editIdentity,
    projectCreateIdentity,
    editorInfo,
    openUserDialog,
    closeUserDialog,
    saveUser,
    requestMicrosoftSignIn,
    signOut,
    openMembersDialog,
    closeMembersDialog,
    saveMember,
    startEditing,
    forceReleaseLock,
    finishEditing,
    setFinishGuard,
    setEditStartRefresh,
    refreshStatus,
    markActivity,
    resumeIdleAfterSave: () => { idleBlockedRef.current = false; lastActivityAtRef.current = Date.now(); },
    readOnlyMessage,
  };
}

function roleAllowsClient(role: CollaborationRole | null, required: CollaborationRole): boolean {
  const rank: Record<CollaborationRole, number> = { viewer: 0, editor: 1, admin: 2 };
  return role !== null && rank[role] >= rank[required];
}
