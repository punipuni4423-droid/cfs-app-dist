import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CollaborationEditorInfo,
  CollaborationLock,
  CollaborationStatus,
  CollaborationUser,
} from "../types";
import { migrateProjectsPayload } from "./storage";

const DATA_DIR = path.join(process.cwd(), "data");
const COLLABORATION_FILE = path.join(DATA_DIR, "collaboration.json");
const COLLABORATION_LOCK_DIR = `${COLLABORATION_FILE}.lock`;
const COLLABORATION_LOCK_OWNER_FILE = path.join(COLLABORATION_LOCK_DIR, "owner.json");
const WORKSPACE_SCOPE_ID = "cfs-projects";
const PROJECT_SCOPE_PREFIX = "project:";
const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const STORE_LOCK_TIMEOUT_MS = 5_000;
const STORE_LOCK_STALE_MS = 30_000;

interface CollaborationStore {
  users: CollaborationUser[];
  lock: CollaborationLock | null;
  locks: CollaborationLock[];
  lastUpdatedBy: CollaborationEditorInfo | null;
}

interface CollaborationIdentity {
  userId: string;
  sessionId: string;
  projectId?: string;
}

interface CollaborationMutationResult {
  acquired: boolean;
  lock: CollaborationLock | null;
  status?: CollaborationStatus;
}

interface StoreLockOwner {
  token: string;
  createdAt: string;
  pid: number;
}

export interface CollaborationEditCheck {
  ok: boolean;
  editor: CollaborationEditorInfo | null;
  status: number;
  error: string;
}

let storeMutationQueue: Promise<void> = Promise.resolve();

function isCollaborationEnabled(): boolean {
  return process.env.CFS_COLLABORATION_ENABLED !== "false";
}

function leaseSeconds(): number {
  const value = Number(process.env.CFS_COLLABORATION_LEASE_SECONDS ?? DEFAULT_LEASE_SECONDS);
  return Number.isFinite(value) ? Math.max(30, Math.min(Math.round(value), 300)) : DEFAULT_LEASE_SECONDS;
}

function heartbeatMs(): number {
  const value = Number(process.env.CFS_COLLABORATION_HEARTBEAT_MS ?? DEFAULT_HEARTBEAT_MS);
  return Number.isFinite(value) ? Math.max(5_000, Math.min(Math.round(value), 120_000)) : DEFAULT_HEARTBEAT_MS;
}

function idleMs(): number {
  const value = Number(process.env.CFS_COLLABORATION_IDLE_MS ?? DEFAULT_IDLE_MS);
  return Number.isFinite(value) ? Math.max(60_000, Math.min(Math.round(value), 60 * 60 * 1000)) : DEFAULT_IDLE_MS;
}

function emptyStore(): CollaborationStore {
  return { users: [], lock: null, locks: [], lastUpdatedBy: null };
}

function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeId(value: unknown, label: string): string {
  const id = sanitizeString(value, 128);
  if (!id) throw new Error(`${label} is required.`);
  if (!/^[a-zA-Z0-9:_-]+$/.test(id)) throw new Error(`${label} contains unsupported characters.`);
  return id;
}

function normalizeOptionalProjectId(value: unknown): string {
  const id = sanitizeString(value, 128);
  if (!id) return "";
  if (!/^[a-zA-Z0-9:_-]+$/.test(id)) throw new Error("Project ID contains unsupported characters.");
  return id;
}

function scopeIdForProject(projectId = ""): string {
  return projectId ? `${PROJECT_SCOPE_PREFIX}${projectId}` : WORKSPACE_SCOPE_ID;
}

function projectIdFromScopeId(scopeId: string): string | null {
  return scopeId.startsWith(PROJECT_SCOPE_PREFIX) ? scopeId.slice(PROJECT_SCOPE_PREFIX.length) : null;
}

function identityScope(identity: Partial<CollaborationIdentity>): { scopeId: string; projectId: string } {
  const projectId = normalizeOptionalProjectId(identity.projectId);
  return { projectId, scopeId: scopeIdForProject(projectId) };
}

function mapLock(value: unknown): CollaborationLock | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const scopeId = typeof v.scopeId === "string" ? v.scopeId : typeof v.stateId === "string" ? v.stateId : "";
  if (!scopeId) return null;
  if (typeof v.userId !== "string") return null;
  if (typeof v.userName !== "string") return null;
  if (typeof v.sessionId !== "string") return null;
  if (typeof v.acquiredAt !== "string") return null;
  if (typeof v.heartbeatAt !== "string") return null;
  if (typeof v.expiresAt !== "string") return null;
  return {
    scopeId,
    projectId: typeof v.projectId === "string" ? v.projectId : projectIdFromScopeId(scopeId),
    userId: v.userId,
    userName: v.userName,
    sessionId: v.sessionId,
    acquiredAt: v.acquiredAt,
    heartbeatAt: v.heartbeatAt,
    expiresAt: v.expiresAt,
  };
}

function mapUser(value: unknown): CollaborationUser | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id === "") return null;
  if (typeof v.displayName !== "string" || v.displayName === "") return null;
  return {
    id: v.id,
    displayName: v.displayName,
    email: typeof v.email === "string" ? v.email : "",
    createdAt: typeof v.createdAt === "string" ? v.createdAt : null,
    lastSeenAt: typeof v.lastSeenAt === "string" ? v.lastSeenAt : null,
  };
}

function mapEditor(value: unknown): CollaborationEditorInfo | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.userId !== "string" || v.userId === "") return null;
  if (typeof v.displayName !== "string" || v.displayName === "") return null;
  if (typeof v.updatedAt !== "string" || v.updatedAt === "") return null;
  return {
    userId: v.userId,
    displayName: v.displayName,
    updatedAt: v.updatedAt,
  };
}

function lockIsActive(lock: CollaborationLock | null, now = Date.now()): boolean {
  if (!lock) return false;
  const expiresAt = Date.parse(lock.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function sameLockOwner(lock: CollaborationLock, identity: CollaborationIdentity): boolean {
  return lock.userId === identity.userId && lock.sessionId === identity.sessionId;
}

function activeLocksFromStore(store: CollaborationStore, now = Date.now()): CollaborationLock[] {
  const locks = Array.isArray(store.locks) ? store.locks : [];
  const candidates = [
    ...locks,
    ...(store.lock && !locks.some((lock) => lock.scopeId === store.lock?.scopeId) ? [store.lock] : []),
  ];
  const byScope = new Map<string, CollaborationLock>();
  for (const lock of candidates) {
    if (lockIsActive(lock, now)) {
      byScope.set(lock.scopeId, lock);
    }
  }
  return [...byScope.values()];
}

function setActiveLocks(store: CollaborationStore, locks: CollaborationLock[]): void {
  store.locks = locks;
  store.lock = locks.find((lock) => lock.scopeId === WORKSPACE_SCOPE_ID) ?? null;
}

function workspaceLock(locks: ReadonlyArray<CollaborationLock>): CollaborationLock | null {
  return locks.find((lock) => lock.scopeId === WORKSPACE_SCOPE_ID) ?? null;
}

function exactScopeLock(locks: ReadonlyArray<CollaborationLock>, scopeId: string): CollaborationLock | null {
  return locks.find((lock) => lock.scopeId === scopeId) ?? null;
}

function coveringOwnedLock(
  locks: ReadonlyArray<CollaborationLock>,
  scopeId: string,
  identity: CollaborationIdentity,
): CollaborationLock | null {
  const exact = exactScopeLock(locks, scopeId);
  if (exact && sameLockOwner(exact, identity)) return exact;
  return null;
}

function conflictLockForScope(locks: ReadonlyArray<CollaborationLock>, scopeId: string): CollaborationLock | null {
  const workspace = workspaceLock(locks);
  if (workspace) return workspace;
  if (scopeId === WORKSPACE_SCOPE_ID) return locks[0] ?? null;
  return exactScopeLock(locks, scopeId);
}

function statusLockForScope(locks: ReadonlyArray<CollaborationLock>, scopeId: string): CollaborationLock | null {
  const workspace = workspaceLock(locks);
  if (workspace) return workspace;
  if (scopeId === WORKSPACE_SCOPE_ID) return null;
  return exactScopeLock(locks, scopeId);
}

async function readStoreUnlocked(): Promise<CollaborationStore> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const raw = await readFile(COLLABORATION_FILE, "utf8");
      if (raw.trim() === "") throw new SyntaxError("Collaboration store was empty while being written.");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const lock = mapLock(parsed.lock);
      const store = {
        users: Array.isArray(parsed.users)
          ? parsed.users.map(mapUser).filter((user): user is CollaborationUser => user !== null)
          : [],
        lock: lockIsActive(lock) ? lock : null,
        locks: Array.isArray(parsed.locks)
          ? parsed.locks.map(mapLock).filter((candidate): candidate is CollaborationLock => candidate !== null)
          : [],
        lastUpdatedBy: mapEditor(parsed.lastUpdatedBy),
      };
      setActiveLocks(store, activeLocksFromStore(store));
      return store;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyStore();
      lastError = error;
      if (!(error instanceof SyntaxError) || attempt === 11) break;
      await sleep(Math.min(250, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readStore(): Promise<CollaborationStore> {
  return withStoreFileLock(() => readStoreUnlocked());
}

async function writeStore(store: CollaborationStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  setActiveLocks(store, activeLocksFromStore(store));
  const tmpFile = `${COLLABORATION_FILE}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmpFile, COLLABORATION_FILE);
}

async function readStoreLockOwner(): Promise<StoreLockOwner | null> {
  try {
    const raw = await readFile(COLLABORATION_LOCK_OWNER_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreLockOwner>;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    if (typeof parsed.createdAt !== "string" || parsed.createdAt === "") return null;
    return {
      token: parsed.token,
      createdAt: parsed.createdAt,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
    };
  } catch {
    return null;
  }
}

async function acquireStoreFileLock(): Promise<string> {
  const startedAt = Date.now();
  await mkdir(DATA_DIR, { recursive: true });
  for (;;) {
    const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
    try {
      await mkdir(COLLABORATION_LOCK_DIR);
      try {
        await writeFile(
          COLLABORATION_LOCK_OWNER_FILE,
          `${JSON.stringify({ token, createdAt: new Date().toISOString(), pid: process.pid }, null, 2)}\n`,
          "utf8",
        );
        return token;
      } catch (error) {
        await rm(COLLABORATION_LOCK_DIR, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const elapsed = Date.now() - startedAt;
      if (elapsed > STORE_LOCK_TIMEOUT_MS) {
        try {
          const info = await stat(COLLABORATION_LOCK_DIR);
          if (Date.now() - info.mtimeMs > STORE_LOCK_STALE_MS) {
            const ownerBefore = await readStoreLockOwner();
            await sleep(25);
            const ownerAfter = await readStoreLockOwner();
            if (ownerBefore?.token && ownerAfter?.token && ownerBefore.token !== ownerAfter.token) {
              continue;
            }
            const stalePath = `${COLLABORATION_LOCK_DIR}.stale.${process.pid}.${Date.now()}.${randomUUID()}`;
            try {
              await rename(COLLABORATION_LOCK_DIR, stalePath);
              await rm(stalePath, { recursive: true, force: true });
              continue;
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
        throw new Error("Collaboration store is busy. Please try again.");
      }
      await sleep(20);
    }
  }
}

async function withStoreFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const token = await acquireStoreFileLock();
  try {
    return await operation();
  } finally {
    const owner = await readStoreLockOwner();
    if (owner?.token === token) {
      await rm(COLLABORATION_LOCK_DIR, { recursive: true, force: true });
    }
  }
}

async function withStoreMutation<T>(mutate: (store: CollaborationStore) => Promise<T>): Promise<T> {
  const run = storeMutationQueue.then(() =>
    withStoreFileLock(async () => {
      const store = await readStoreUnlocked();
      return mutate(store);
    }),
  );
  storeMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function statusFromStore(store: CollaborationStore, identity: Partial<CollaborationIdentity> = {}): CollaborationStatus {
  const scope = identityScope(identity);
  const locks = activeLocksFromStore(store);
  const currentIdentity: CollaborationIdentity = {
    userId: identity.userId ?? "",
    sessionId: identity.sessionId ?? "",
    projectId: scope.projectId,
  };
  const ownedLock =
    currentIdentity.userId && currentIdentity.sessionId
      ? coveringOwnedLock(locks, scope.scopeId, currentIdentity)
      : null;
  const lock = ownedLock ?? statusLockForScope(locks, scope.scopeId);
  const ownsLock = Boolean(ownedLock);
  return {
    enabled: true,
    mode: ownsLock ? "edit" : "view",
    ownsLock,
    scopeId: scope.scopeId,
    projectId: scope.projectId || null,
    lock,
    locks,
    lastUpdatedBy: store.lastUpdatedBy,
    leaseSeconds: leaseSeconds(),
    heartbeatMs: heartbeatMs(),
    idleMs: idleMs(),
  };
}

async function projectLastUpdatedAt(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  try {
    const raw = await readFile(path.join(DATA_DIR, "projects.json"), "utf8");
    const projects = migrateProjectsPayload(JSON.parse(raw));
    return projects.find((project) => project.id === projectId)?.updatedAt ?? null;
  } catch {
    return null;
  }
}

function registeredUser(store: CollaborationStore, userId: string): CollaborationUser {
  const id = normalizeId(userId, "User ID");
  const user = store.users.find((candidate) => candidate.id === id);
  if (!user) throw new Error("User is not registered.");
  return user;
}

export function collaborationIdentityFromRequest(request: Request): CollaborationIdentity {
  return {
    userId: sanitizeString(request.headers.get("x-cfs-user-id"), 128),
    sessionId: sanitizeString(request.headers.get("x-cfs-session-id"), 128),
    projectId: normalizeOptionalProjectId(request.headers.get("x-cfs-project-id")),
  };
}

export function requestRequiresCollaborationLock(request: Request): boolean {
  return request.headers.get("x-cfs-require-edit-lock") === "1";
}

export async function collaborationStatus(identity: Partial<CollaborationIdentity> = {}): Promise<CollaborationStatus> {
  const scope = identityScope(identity);
  if (!isCollaborationEnabled()) {
    return {
      enabled: false,
      mode: "local",
      ownsLock: true,
      scopeId: scope.scopeId,
      projectId: scope.projectId || null,
      lock: null,
      locks: [],
      lastUpdatedBy: null,
      lastUpdatedAt: await projectLastUpdatedAt(scope.projectId),
      leaseSeconds: leaseSeconds(),
      heartbeatMs: heartbeatMs(),
      idleMs: idleMs(),
    };
  }

  const store = await readStore();
  return {
    ...statusFromStore(store, identity),
    lastUpdatedAt: await projectLastUpdatedAt(scope.projectId),
  };
}

export async function registerCollaborationUser(body: unknown): Promise<CollaborationUser> {
  const source = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = normalizeId(source.userId, "User ID");
  const displayName = sanitizeString(source.displayName, 80);
  if (!displayName) throw new Error("Display name is required.");
  const email = sanitizeString(source.email, 160);
  const now = new Date().toISOString();
  return withStoreMutation(async (store) => {
    const existing = store.users.find((user) => user.id === id);
    const user: CollaborationUser = {
      id,
      displayName,
      email,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    };
    store.users = [user, ...store.users.filter((candidate) => candidate.id !== id)];
    await writeStore(store);
    return user;
  });
}

export async function acquireCollaborationLock(body: unknown): Promise<CollaborationMutationResult> {
  const source = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const userId = normalizeId(source.userId, "User ID");
  const sessionId = normalizeId(source.sessionId, "Session ID");
  const projectId = normalizeOptionalProjectId(source.projectId);
  const scopeId = scopeIdForProject(projectId);
  return withStoreMutation(async (store) => {
    const user = registeredUser(store, userId);
    const now = new Date();
    const activeLocks = activeLocksFromStore(store, now.getTime());
    const conflict = conflictLockForScope(
      activeLocks.filter((lock) => lock.userId !== userId || lock.sessionId !== sessionId),
      scopeId,
    );
    if (conflict) {
      return {
        acquired: false,
        lock: conflict,
        status: statusFromStore(store, { userId, sessionId, projectId }),
      };
    }
    const currentLock = activeLocks.find((lock) => lock.scopeId === scopeId && lock.userId === userId && lock.sessionId === sessionId) ?? null;
    const nextLock: CollaborationLock = {
      scopeId,
      projectId: projectId || null,
      userId,
      userName: user.displayName,
      sessionId,
      acquiredAt: currentLock?.acquiredAt ?? now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseSeconds() * 1000).toISOString(),
    };
    setActiveLocks(store, [
      nextLock,
      ...activeLocks.filter((lock) => lock.scopeId !== scopeId && (lock.userId !== userId || lock.sessionId !== sessionId)),
    ]);
    await writeStore(store);
    return {
      acquired: true,
      lock: nextLock,
      status: statusFromStore(store, { userId, sessionId, projectId }),
    };
  });
}

export async function heartbeatCollaborationLock(body: unknown): Promise<CollaborationMutationResult> {
  const source = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const userId = normalizeId(source.userId, "User ID");
  const sessionId = normalizeId(source.sessionId, "Session ID");
  const projectId = normalizeOptionalProjectId(source.projectId);
  const scopeId = scopeIdForProject(projectId);
  return withStoreMutation(async (store) => {
    const now = new Date();
    const activeLocks = activeLocksFromStore(store, now.getTime());
    const identity = { userId, sessionId, projectId };
    const lock = coveringOwnedLock(activeLocks, scopeId, identity);
    if (!lock) {
      const conflict = conflictLockForScope(activeLocks, scopeId);
      setActiveLocks(store, activeLocks);
      await writeStore(store);
      return { acquired: false, lock: conflict, status: statusFromStore(store, identity) };
    }
    const nextLock: CollaborationLock = {
      ...lock,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseSeconds() * 1000).toISOString(),
    };
    setActiveLocks(store, activeLocks.map((candidate) => (candidate.scopeId === lock.scopeId ? nextLock : candidate)));
    await writeStore(store);
    return { acquired: true, lock: nextLock, status: statusFromStore(store, identity) };
  });
}

export async function releaseCollaborationLock(body: unknown): Promise<boolean> {
  const source = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const userId = normalizeId(source.userId, "User ID");
  const sessionId = normalizeId(source.sessionId, "Session ID");
  const projectId = normalizeOptionalProjectId(source.projectId);
  const scopeId = scopeIdForProject(projectId);
  return withStoreMutation(async (store) => {
    const activeLocks = activeLocksFromStore(store);
    const lock = coveringOwnedLock(activeLocks, scopeId, { userId, sessionId, projectId });
    if (!lock) {
      setActiveLocks(store, activeLocks);
      await writeStore(store);
      return false;
    }
    setActiveLocks(store, activeLocks.filter((candidate) => candidate.scopeId !== lock.scopeId));
    await writeStore(store);
    return true;
  });
}

export async function forceReleaseCollaborationLock(body: unknown): Promise<{ released: boolean; lock: CollaborationLock | null }> {
  const source = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const userId = normalizeId(source.userId, "User ID");
  const projectId = normalizeOptionalProjectId(source.projectId);
  const scopeId = scopeIdForProject(projectId);
  return withStoreMutation(async (store) => {
    registeredUser(store, userId);
    const activeLocks = activeLocksFromStore(store);
    // statusLockForScope semantics: only the workspace lock or the exact-scope
    // lock may be targeted. Never fall back to an arbitrary project lock when
    // releasing the workspace scope (conflictLockForScope would do that, which
    // could evict an unrelated editor).
    const blocking = statusLockForScope(activeLocks, scopeId);
    if (!blocking) {
      setActiveLocks(store, activeLocks);
      await writeStore(store);
      return { released: false, lock: null };
    }
    setActiveLocks(store, activeLocks.filter((candidate) => candidate.scopeId !== blocking.scopeId));
    await writeStore(store);
    return { released: true, lock: blocking };
  });
}

export async function requireCollaborationEditLock(request: Request): Promise<CollaborationEditCheck> {
  if (!isCollaborationEnabled()) {
    return { ok: true, editor: null, status: 200, error: "" };
  }
  const identity = collaborationIdentityFromRequest(request);
  if (!identity.userId || !identity.sessionId) {
    return { ok: false, editor: null, status: 423, error: "View mode is active. Start editing before saving." };
  }
  const status = await collaborationStatus(identity);
  if (!status.ownsLock || !status.lock) {
    const owner = status.lock?.userName ? `${status.lock.userName} is editing. ` : "The edit lock is no longer active. ";
    return { ok: false, editor: null, status: 423, error: `${owner}Return to view mode before saving.` };
  }
  return {
    ok: true,
    editor: {
      userId: status.lock.userId,
      displayName: status.lock.userName,
      updatedAt: new Date().toISOString(),
    },
    status: 200,
    error: "",
  };
}

export async function requireCollaborationProjectCreate(request: Request): Promise<CollaborationEditCheck> {
  if (!isCollaborationEnabled()) {
    return { ok: true, editor: null, status: 200, error: "" };
  }
  const identity = collaborationIdentityFromRequest(request);
  if (!identity.userId || !identity.sessionId) {
    return { ok: false, editor: null, status: 423, error: "Sign in before creating a shared CFS project." };
  }
  const store = await readStore();
  const user = store.users.find((candidate) => candidate.id === identity.userId);
  if (!user) {
    return { ok: false, editor: null, status: 423, error: "Register your collaboration user before creating a project." };
  }
  return {
    ok: true,
    editor: {
      userId: user.id,
      displayName: user.displayName,
      updatedAt: new Date().toISOString(),
    },
    status: 200,
    error: "",
  };
}

export async function recordCollaborationSave(editor: CollaborationEditorInfo | null): Promise<CollaborationEditorInfo | null> {
  if (!editor) return null;
  return withStoreMutation(async (store) => {
    const next = { ...editor, updatedAt: new Date().toISOString() };
    store.lastUpdatedBy = next;
    await writeStore(store);
    return next;
  });
}
