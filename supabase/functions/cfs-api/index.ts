import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

type MembershipRole = "viewer" | "editor" | "admin";

interface Membership {
  id: string;
  auth_user_id: string | null;
  email: string;
  display_name: string;
  role: MembershipRole;
  active: boolean;
  rebind_required: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

interface AuthIdentity {
  provider?: string | null;
  identity_data?: Record<string, unknown> | null;
}

interface AuthenticatedUser {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: AuthIdentity[] | null;
}

const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const bootstrapAdminEmail = normalizeEmail(Deno.env.get("CFS_BOOTSTRAP_ADMIN_EMAIL") || "");
const allowedEmailDomains = new Set(
  (Deno.env.get("CFS_ALLOWED_EMAIL_DOMAINS") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const requiredAuthProvider = normalizeProvider(Deno.env.get("CFS_REQUIRED_AUTH_PROVIDER") || "azure");
const allowedEntraTenantIds = new Set(
  `${Deno.env.get("CFS_ENTRA_TENANT_ID") || ""},${Deno.env.get("CFS_ALLOWED_ENTRA_TENANT_IDS") || ""}`
    .split(",")
    .map((value) => normalizeTenantId(value))
    .filter(Boolean),
);
const leaseSeconds = clampNumber(Deno.env.get("CFS_COLLABORATION_LEASE_SECONDS"), 90, 30, 300);
const heartbeatMs = clampNumber(Deno.env.get("CFS_COLLABORATION_HEARTBEAT_MS"), 20_000, 5_000, 120_000);
const idleMs = clampNumber(Deno.env.get("CFS_COLLABORATION_IDLE_MS"), 15 * 60 * 1000, 60_000, 60 * 60 * 1000);
const workspaceStateId = "cfs-projects";
const projectScopePrefix = "project:";
const projectConflictMessage = "Project was updated by another user. Reload before saving.";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("CFS secure sharing Function configuration is incomplete.");
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function clampNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(Math.round(parsed), maximum));
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProvider(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/-/g, "_") : "";
}

function normalizeTenantId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function addProvider(providers: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => addProvider(providers, item));
    return;
  }
  const provider = normalizeProvider(value);
  if (provider) providers.add(provider);
}

function metadataSources(user: AuthenticatedUser): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  const appMetadata = asRecord(user.app_metadata);
  const userMetadata = asRecord(user.user_metadata);
  if (appMetadata) sources.push(appMetadata);
  if (userMetadata) sources.push(userMetadata);
  for (const identity of user.identities || []) {
    const identityData = asRecord(identity?.identity_data);
    if (identityData) sources.push(identityData);
  }
  return sources;
}

function authProviderSet(user: AuthenticatedUser): Set<string> {
  const providers = new Set<string>();
  const appMetadata = asRecord(user.app_metadata);
  addProvider(providers, appMetadata?.provider);
  addProvider(providers, appMetadata?.providers);
  for (const identity of user.identities || []) {
    addProvider(providers, identity?.provider);
    addProvider(providers, asRecord(identity?.identity_data)?.provider);
  }
  return providers;
}

function addTenantId(tenants: Set<string>, value: unknown): void {
  const tenantId = normalizeTenantId(value);
  if (tenantId) tenants.add(tenantId);
}

function tenantIdSet(user: AuthenticatedUser): Set<string> {
  const tenants = new Set<string>();
  for (const source of metadataSources(user)) {
    addTenantId(tenants, source.tid);
    addTenantId(tenants, source.tenant_id);
    addTenantId(tenants, source.tenantId);
    const issuer = stringValue(source.iss || source.issuer);
    const match = issuer.match(/(?:login\.microsoftonline\.com|sts\.windows\.net)\/([0-9a-f-]{32,36})/i);
    if (match) addTenantId(tenants, match[1]);
  }
  return tenants;
}

function requireApprovedIdentity(user: AuthenticatedUser): void {
  if (requiredAuthProvider && !authProviderSet(user).has(requiredAuthProvider)) {
    throw Object.assign(new Error("Use Microsoft Entra sign-in for CFS sharing."), { status: 403 });
  }
  if (allowedEntraTenantIds.size > 0) {
    const userTenants = tenantIdSet(user);
    const approved = [...userTenants].some((tenantId) => allowedEntraTenantIds.has(tenantId));
    if (!approved) throw Object.assign(new Error("Use an approved Microsoft work account."), { status: 403 });
  }
}

function normalizeIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(normalized)) {
    throw Object.assign(new Error(`${label} is invalid.`), { status: 400 });
  }
  return normalized;
}

function optionalProjectId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "";
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(normalized)) {
    throw Object.assign(new Error("Project ID is invalid."), { status: 400 });
  }
  return normalized;
}

function projectStateId(projectId: string): string {
  return projectId ? `${projectScopePrefix}${projectId}` : workspaceStateId;
}

function projectIdFromStateId(value: string): string | null {
  return value.startsWith(projectScopePrefix) ? value.slice(projectScopePrefix.length) : null;
}

function stateScope(body: Record<string, unknown>): { stateId: string; projectId: string } {
  const projectId = optionalProjectId(body.projectId);
  return { projectId, stateId: projectStateId(projectId) };
}

function roleAllows(role: MembershipRole, required: MembershipRole): boolean {
  const rank: Record<MembershipRole, number> = { viewer: 0, editor: 1, admin: 2 };
  return rank[role] >= rank[required];
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function projectUpdatedAt(project: unknown): string {
  return stringValue(asRecord(project)?.updatedAt);
}

function projectConflictError(project: unknown = null): Error & {
  status: number;
  code: string;
  project?: unknown;
  serverUpdatedAt?: string;
} {
  return Object.assign(new Error(projectConflictMessage), {
    status: 409,
    code: "PROJECT_CONFLICT",
    project: project || undefined,
    serverUpdatedAt: projectUpdatedAt(project),
  });
}

function safeMessage(error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const value = [
    error instanceof Error ? error.message : "",
    typeof record?.message === "string" ? record.message : "",
    typeof record?.code === "string" ? record.code : "",
    typeof record?.details === "string" ? record.details : "",
  ].join(" ");
  if (/CFS_(LOCK_REQUIRED|LOCK_SCOPE_INVALID|LAST_ADMIN_REQUIRED|PROJECTS_ARRAY_REQUIRED|PROJECT_INVALID|PROJECT_DUPLICATE|PROJECT_CONFLICT|TRASH_OBJECT_REQUIRED)/.test(value)) {
    return value.includes("LOCK_REQUIRED")
      ? "Edit access expired or belongs to another user. Return to viewer mode."
      : value.includes("PROJECT_CONFLICT")
        ? "Project was updated by another user. Reload before saving."
      : value.includes("LAST_ADMIN_REQUIRED")
        ? "Register another active Admin before changing the last Admin."
        : "The shared CFS data was rejected because its structure is invalid.";
  }
  return "Secure CFS sharing request failed.";
}

function publicMembership(membership: Membership) {
  return {
    id: membership.id,
    email: membership.email,
    displayName: membership.display_name,
    role: membership.role,
    active: membership.active,
    createdAt: membership.created_at || null,
    updatedAt: membership.updated_at || null,
    lastSeenAt: membership.last_seen_at || null,
  };
}

async function authenticatedMembership(request: Request): Promise<Membership> {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw Object.assign(new Error("Sign in is required."), { status: 401 });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) throw Object.assign(new Error("Your sign-in session is no longer valid."), { status: 401 });

  const user = authData.user as AuthenticatedUser;
  requireApprovedIdentity(user);
  const email = normalizeEmail(user.email || "");
  if (!email) throw Object.assign(new Error("Your authenticated account does not include an email address."), { status: 403 });
  const domain = email.split("@")[1] || "";
  if (allowedEmailDomains.size > 0 && !allowedEmailDomains.has(domain)) {
    throw Object.assign(new Error("Use an approved company email address."), { status: 403 });
  }

  const select = "id,auth_user_id,email,display_name,role,active,rebind_required,created_at,updated_at,last_seen_at";
  const byId = await admin.from("cfs_memberships").select(select).eq("auth_user_id", user.id).maybeSingle<Membership>();
  if (byId.error) throw byId.error;
  let membership = byId.data;
  if (!membership) {
    const byEmail = await admin.from("cfs_memberships").select(select).eq("email", email).maybeSingle<Membership>();
    if (byEmail.error) throw byEmail.error;
    membership = byEmail.data;
  }

  if (bootstrapAdminEmail && email === bootstrapAdminEmail && membership?.role !== "admin") {
    const activeAdmins = await admin.from("cfs_memberships").select("id", { count: "exact", head: true }).eq("role", "admin").eq("active", true);
    if (activeAdmins.error) throw activeAdmins.error;
    if (!activeAdmins.count) {
      const displayName = String(user.user_metadata?.full_name || user.user_metadata?.name || email).slice(0, 120);
      const insert = membership
        ? await admin.from("cfs_memberships")
          .update({ auth_user_id: user.id, display_name: displayName, role: "admin", active: true, rebind_required: false, updated_at: new Date().toISOString() })
          .eq("id", membership.id).select(select).single<Membership>()
        : await admin.from("cfs_memberships")
          .insert({ auth_user_id: user.id, email, display_name: displayName, role: "admin", active: true, rebind_required: false })
          .select(select).single<Membership>();
      if (insert.error) throw insert.error;
      membership = insert.data;
    }
  }

  if (!membership || !membership.active) {
    throw Object.assign(new Error("This email address has not been added to CFS sharing yet."), { status: 403 });
  }
  if (membership.rebind_required || (membership.auth_user_id && membership.auth_user_id !== user.id)) {
    throw Object.assign(new Error("This email must be reactivated by an Admin before it can be used."), { status: 403 });
  }

  const displayName = membership.display_name || String(user.user_metadata?.full_name || user.user_metadata?.name || email).slice(0, 120);
  const update = await admin.from("cfs_memberships")
    .update({ auth_user_id: user.id, display_name: displayName, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", membership.id).select(select).single<Membership>();
  if (update.error) throw update.error;
  return update.data;
}

function requireRole(membership: Membership, role: MembershipRole): void {
  if (!roleAllows(membership.role, role)) {
    throw Object.assign(new Error(`${role[0].toUpperCase()}${role.slice(1)} access is required.`), { status: 403 });
  }
}

function mapLock(row: Record<string, unknown> | null) {
  if (!row) return null;
  const scopeId = String(row.state_id || row.stateId || workspaceStateId);
  return {
    scopeId,
    projectId: projectIdFromStateId(scopeId),
    userId: String(row.user_id || row.userId || ""),
    userName: String(row.user_name || row.userName || ""),
    sessionId: String(row.session_id || row.sessionId || ""),
    acquiredAt: String(row.acquired_at || row.acquiredAt || ""),
    heartbeatAt: String(row.heartbeat_at || row.heartbeatAt || ""),
    expiresAt: String(row.expires_at || row.expiresAt || ""),
  };
}

async function activeLocks() {
  const result = await admin.from("cfs_edit_locks")
    .select("state_id,user_id,user_name,session_id,acquired_at,heartbeat_at,expires_at")
    .gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: true });
  if (result.error) throw result.error;
  return (result.data || []).map((row) => mapLock(row as Record<string, unknown>)).filter(Boolean);
}

function lockForScope(locks: ReturnType<typeof mapLock>[], stateId: string) {
  const workspace = locks.find((lock) => lock?.scopeId === workspaceStateId) || null;
  if (workspace) return workspace;
  if (stateId === workspaceStateId) return null;
  return locks.find((lock) => lock?.scopeId === stateId) || null;
}

function ownedLockForScope(locks: ReturnType<typeof mapLock>[], stateId: string, membership: Membership, sessionId: string) {
  const exact = locks.find((lock) => lock?.scopeId === stateId && lock.userId === membership.auth_user_id && lock.sessionId === sessionId) || null;
  if (exact) return exact;
  return null;
}

async function lastUpdatedBy() {
  const result = await admin.from("cfs_revision_events")
    .select("user_id,user_name,created_at").eq("operation", "revision_save").order("created_at", { ascending: false }).limit(1).maybeSingle<Record<string, unknown>>();
  if (result.error) throw result.error;
  if (!result.data) return null;
  return { userId: String(result.data.user_id || ""), displayName: String(result.data.user_name || "CFS user"), updatedAt: String(result.data.created_at || "") };
}

async function status(body: Record<string, unknown>, membership: Membership) {
  const sessionId = body.sessionId ? normalizeIdentifier(body.sessionId, "Session ID") : "";
  const scope = stateScope(body);
  let locks = await activeLocks();
  let ownedLock = sessionId ? ownedLockForScope(locks, scope.stateId, membership, sessionId) : null;
  const ownsLock = Boolean(ownedLock && roleAllows(membership.role, "editor"));
  if (ownedLock && sessionId && !roleAllows(membership.role, "editor")) {
    await admin.rpc("release_cfs_edit_lock", { p_state_id: ownedLock.scopeId, p_user_id: membership.auth_user_id, p_session_id: sessionId });
    locks = await activeLocks();
    ownedLock = null;
  }
  const lock = ownedLock || lockForScope(locks, scope.stateId);
  return {
    ok: true,
    enabled: true,
    mode: ownsLock ? "edit" : "view",
    ownsLock,
    scopeId: scope.stateId,
    projectId: scope.projectId || null,
    lock,
    locks,
    lastUpdatedBy: await lastUpdatedBy(),
    lastUpdatedAt: await projectLastUpdatedAt(scope.projectId),
    membership: publicMembership(membership),
    leaseSeconds,
    heartbeatMs,
    idleMs,
  };
}

async function assertLease(body: Record<string, unknown>, membership: Membership) {
  requireRole(membership, "editor");
  const sessionId = normalizeIdentifier(body.sessionId, "Session ID");
  const scope = stateScope(body);
  const lock = ownedLockForScope(await activeLocks(), scope.stateId, membership, sessionId);
  if (!lock) {
    throw Object.assign(new Error("Edit access expired or belongs to another user. Return to viewer mode."), { status: 423 });
  }
  return { sessionId, stateId: lock.scopeId, requestedStateId: scope.stateId, projectId: scope.projectId };
}

async function assertProjectCreateAccess(body: Record<string, unknown>, membership: Membership) {
  requireRole(membership, "editor");
  const sessionId = normalizeIdentifier(body.sessionId, "Session ID");
  const scope = stateScope(body);
  return { sessionId, stateId: scope.stateId, requestedStateId: scope.stateId, projectId: scope.projectId };
}

async function readProjects() {
  const result = await admin.from("cfs_projects").select("payload").is("deleted_at", null).order("updated_at", { ascending: false });
  if (result.error) throw result.error;
  return (result.data || []).map((row) => row.payload);
}

async function readProject(projectId: string): Promise<unknown | null> {
  const result = await admin
    .from("cfs_projects")
    .select("payload")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data?.payload ?? null;
}

async function projectLastUpdatedAt(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  return projectUpdatedAt(await readProject(projectId).catch(() => null)) || null;
}

function validatedProjects(value: unknown, membership: Membership) {
  if (!Array.isArray(value)) throw Object.assign(new Error("Projects must be an array."), { status: 400 });
  const now = new Date().toISOString();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw Object.assign(new Error("Project data is invalid."), { status: 400 });
    const project = candidate as Record<string, unknown>;
    normalizeIdentifier(project.id, "Project ID");
    if (typeof project.name !== "string" || !project.name.trim()) throw Object.assign(new Error("Project name is required."), { status: 400 });
    return {
      ...project,
      updatedAt: now,
      lastUpdatedBy: { userId: membership.auth_user_id, displayName: membership.display_name || membership.email, updatedAt: now },
    };
  });
}

function validatedProject(value: unknown, membership: Membership) {
  return validatedProjects([value], membership)[0];
}

async function saveProjects(body: Record<string, unknown>, membership: Membership) {
  const { sessionId, stateId } = await assertLease({ ...body, projectId: "" }, membership);
  const projects = validatedProjects(body.projects, membership);
  const saved = await admin.rpc("save_cfs_project_set", {
    p_state_id: stateId,
    p_user_id: membership.auth_user_id,
    p_session_id: sessionId,
    p_user_name: membership.display_name || membership.email,
    p_projects: projects,
  });
  if (saved.error) throw saved.error;
  return { ok: true, projects, lastUpdatedBy: { userId: membership.auth_user_id, displayName: membership.display_name || membership.email, updatedAt: new Date().toISOString() }, result: saved.data };
}

async function saveProject(body: Record<string, unknown>, membership: Membership) {
  const project = validatedProject(body.project, membership);
  const projectId = optionalProjectId(project.id);
  if (!projectId) throw Object.assign(new Error("Project ID is invalid."), { status: 400 });
  const createOnly = body.createOnly === true;
  const { sessionId, stateId, requestedStateId } = createOnly
    ? await assertProjectCreateAccess({ ...body, projectId }, membership)
    : await assertLease({ ...body, projectId }, membership);
  if (requestedStateId !== projectStateId(projectId)) {
    throw Object.assign(new Error("Project lock scope is invalid."), { status: 400 });
  }
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt.trim() : "";
  const forceOverwrite = !createOnly && body.forceOverwrite === true;
  const forceOverwriteUpdatedAt = typeof body.forceOverwriteUpdatedAt === "string" ? body.forceOverwriteUpdatedAt.trim() : "";
  if (!createOnly && !expectedUpdatedAt && !forceOverwrite) {
    throw Object.assign(new Error("Project save requires an update token. Reload before saving."), { status: 409 });
  }
  let expectedForRpc = createOnly ? "__CFS_CREATE_ONLY__" : expectedUpdatedAt;
  if (forceOverwrite) {
    const currentProject = await readProject(projectId);
    if (!currentProject || !forceOverwriteUpdatedAt || projectUpdatedAt(currentProject) !== forceOverwriteUpdatedAt) {
      throw projectConflictError(currentProject);
    }
    expectedForRpc = forceOverwriteUpdatedAt;
  }
  const saved = await admin.rpc("save_cfs_project", {
    p_state_id: stateId,
    p_user_id: membership.auth_user_id,
    p_session_id: sessionId,
    p_user_name: membership.display_name || membership.email,
    p_project: project,
    p_expected_updated_at: expectedForRpc,
  });
  if (saved.error) {
    const message = [saved.error.message, saved.error.code, saved.error.details].filter(Boolean).join(" ");
    if (message.includes("CFS_PROJECT_CONFLICT")) {
      throw projectConflictError(await readProject(projectId).catch(() => null));
    }
    throw saved.error;
  }
  return {
    ok: true,
    project,
    lastUpdatedBy: { userId: membership.auth_user_id, displayName: membership.display_name || membership.email, updatedAt: new Date().toISOString() },
    result: saved.data,
  };
}

function emptyTrash() {
  return { projects: [], roomTypes: [] };
}

async function readTrash() {
  const result = await admin.from("cfs_workspace_trash").select("payload").eq("id", "cfs-trash").maybeSingle<{ payload: unknown }>();
  if (result.error) throw result.error;
  return result.data?.payload || emptyTrash();
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function trashArray(value: unknown, key: "projects" | "roomTypes"): Record<string, unknown>[] {
  const record = asRecord(value);
  const array = Array.isArray(record?.[key]) ? record[key] as unknown[] : [];
  return array.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function validateProjectScopedTrashUpdate(current: unknown, next: unknown, projectId: string): string {
  if (!projectId) return "";
  const currentProjects = trashArray(current, "projects");
  const nextProjects = trashArray(next, "projects");
  if (stableJson(currentProjects) !== stableJson(nextProjects)) {
    return "Project-scoped trash saves cannot change trashed projects.";
  }
  const currentRoomTypes = trashArray(current, "roomTypes");
  const nextRoomTypes = trashArray(next, "roomTypes");
  const nextById = new Map(nextRoomTypes.map((item) => [String(item.id || ""), item]));
  const currentById = new Map(currentRoomTypes.map((item) => [String(item.id || ""), item]));
  for (const item of currentRoomTypes) {
    if (String(item.projectId || "") === projectId) continue;
    const nextItem = nextById.get(String(item.id || ""));
    if (!nextItem || stableJson(nextItem) !== stableJson(item)) {
      return "Project-scoped trash saves cannot change other projects.";
    }
  }
  for (const item of nextRoomTypes) {
    if (currentById.has(String(item.id || ""))) continue;
    if (String(item.projectId || "") !== projectId) {
      return "Project-scoped trash saves cannot add other projects.";
    }
  }
  return "";
}

async function saveTrash(body: Record<string, unknown>, membership: Membership) {
  const { sessionId, stateId, projectId } = await assertLease(body, membership);
  const trash = body.trash;
  if (!trash || typeof trash !== "object" || Array.isArray(trash)) throw Object.assign(new Error("Trash data is invalid."), { status: 400 });
  if (projectId) {
    const validationError = validateProjectScopedTrashUpdate(await readTrash(), trash, projectId);
    if (validationError) throw Object.assign(new Error(validationError), { status: 400 });
  }
  const saved = await admin.rpc("save_cfs_workspace_trash", {
    p_state_id: stateId,
    p_user_id: membership.auth_user_id,
    p_session_id: sessionId,
    p_user_name: membership.display_name || membership.email,
    p_payload: trash,
  });
  if (saved.error) throw saved.error;
  return { ok: true, trash, result: saved.data };
}

async function memberList(membership: Membership) {
  requireRole(membership, "admin");
  const result = await admin.from("cfs_memberships")
    .select("id,auth_user_id,email,display_name,role,active,rebind_required,created_at,updated_at,last_seen_at").order("email");
  if (result.error) throw result.error;
  return { ok: true, members: (result.data || []).map((row) => publicMembership(row as Membership)) };
}

async function memberUpsert(body: Record<string, unknown>, membership: Membership) {
  requireRole(membership, "admin");
  const email = normalizeEmail(String(body.email || ""));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("A valid email address is required."), { status: 400 });
  const role = String(body.role || "viewer") as MembershipRole;
  if (!(["viewer", "editor", "admin"] as string[]).includes(role)) throw Object.assign(new Error("Role is invalid."), { status: 400 });
  const saved = await admin.rpc("upsert_cfs_membership", {
    p_email: email,
    p_display_name: String(body.displayName || email).trim().slice(0, 120),
    p_role: role,
    p_active: body.active !== false,
  });
  if (saved.error) {
    const message = [saved.error.message, saved.error.code, saved.error.details].filter(Boolean).join(" ");
    if (message.includes("CFS_LAST_ADMIN_REQUIRED")) {
      throw Object.assign(new Error("Register another active Admin before changing the last Admin."), { status: 409 });
    }
    if (message.includes("CFS_EMAIL_INVALID")) {
      throw Object.assign(new Error("A valid email address is required."), { status: 400 });
    }
    if (message.includes("CFS_ROLE_INVALID")) {
      throw Object.assign(new Error("Role is invalid."), { status: 400 });
    }
    throw saved.error;
  }
  const member = Array.isArray(saved.data) ? saved.data[0] : saved.data;
  if (!member) throw Object.assign(new Error("The member could not be saved."), { status: 500 });
  return { ok: true, member: publicMembership(member as Membership) };
}

async function handleAction(action: string, body: Record<string, unknown>, membership: Membership) {
  if (action === "auth.me") return { ok: true, membership: publicMembership(membership) };
  if (action === "status") return status(body, membership);
  if (action === "projects.read") return { ok: true, projects: await readProjects() };
  if (action === "projects.save") return saveProjects(body, membership);
  if (action === "project.save") return saveProject(body, membership);
  if (action === "trash.read") return { ok: true, trash: await readTrash() };
  if (action === "trash.save") return saveTrash(body, membership);
  if (action === "members.list") return memberList(membership);
  if (action === "members.upsert") return memberUpsert(body, membership);
  if (action === "lock.acquire") {
    requireRole(membership, "editor");
    const sessionId = normalizeIdentifier(body.sessionId, "Session ID");
    const scope = stateScope(body);
    const result = await admin.rpc("acquire_cfs_edit_lock", { p_state_id: scope.stateId, p_user_id: membership.auth_user_id, p_user_name: membership.display_name || membership.email, p_session_id: sessionId, p_lease_seconds: leaseSeconds });
    if (result.error) throw result.error;
    const lock = mapLock(result.data as Record<string, unknown>);
    return { ok: true, acquired: Boolean((result.data as Record<string, unknown>)?.acquired), lock, status: await status({ sessionId, projectId: scope.projectId }, membership) };
  }
  if (action === "lock.heartbeat") {
    requireRole(membership, "editor");
    const sessionId = normalizeIdentifier(body.sessionId, "Session ID");
    const scope = stateScope(body);
    const ownedLock = ownedLockForScope(await activeLocks(), scope.stateId, membership, sessionId);
    const result = await admin.rpc("heartbeat_cfs_edit_lock", { p_state_id: ownedLock?.scopeId || scope.stateId, p_user_id: membership.auth_user_id, p_session_id: sessionId, p_lease_seconds: leaseSeconds });
    if (result.error) throw result.error;
    const record = result.data as Record<string, unknown>;
    return { ok: true, acquired: Boolean(record?.acquired), lock: mapLock(record), status: await status({ sessionId, projectId: scope.projectId }, membership) };
  }
  if (action === "lock.release") {
    requireRole(membership, "editor");
    const sessionId = normalizeIdentifier(body.sessionId, "Session ID");
    const scope = stateScope(body);
    const ownedLock = ownedLockForScope(await activeLocks(), scope.stateId, membership, sessionId);
    const result = await admin.rpc("release_cfs_edit_lock", { p_state_id: ownedLock?.scopeId || scope.stateId, p_user_id: membership.auth_user_id, p_session_id: sessionId });
    if (result.error) throw result.error;
    return { ok: true, released: Boolean(result.data), status: await status({ sessionId, projectId: scope.projectId }, membership) };
  }
  if (action === "lock.forceRelease") {
    // Admin-only recovery for a lock held by an unreachable session (e.g. a
    // browser left open on another machine). Removes only the lock that blocks
    // the requested scope; the single-editor guarantee itself is unchanged.
    requireRole(membership, "admin");
    const sessionId = body.sessionId ? normalizeIdentifier(body.sessionId, "Session ID") : "";
    const scope = stateScope(body);
    const blockingLock = lockForScope(await activeLocks(), scope.stateId);
    if (!blockingLock) {
      return { ok: true, released: false, status: await status({ sessionId, projectId: scope.projectId }, membership) };
    }
    // Compare-and-delete: pass the read snapshot's owner so a lock that expired
    // and was legitimately re-acquired between this read and the RPC call is
    // never deleted (mirrors release/heartbeat owner matching).
    const result = await admin.rpc("force_release_cfs_edit_lock", {
      p_state_id: blockingLock.scopeId,
      p_user_id: blockingLock.userId,
      p_session_id: blockingLock.sessionId,
    });
    if (result.error) throw result.error;
    return {
      ok: true,
      released: Boolean(result.data),
      releasedLock: blockingLock,
      status: await status({ sessionId, projectId: scope.projectId }, membership),
    };
  }
  throw Object.assign(new Error("Unknown CFS secure sharing action."), { status: 404 });
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") return json(405, { ok: false, error: "Method not allowed." });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { ok: false, error: "Request body must be a JSON object." });
    const membership = await authenticatedMembership(request);
    const result = await handleAction(String((body as Record<string, unknown>).action || ""), body as Record<string, unknown>, membership);
    return json(200, result);
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 500;
    const message = status >= 500 ? safeMessage(error) : String((error as Error)?.message || "Request failed.");
    const publicError = error as { code?: unknown; project?: unknown; serverUpdatedAt?: unknown };
    const body: Record<string, unknown> = { ok: false, error: message };
    if (typeof publicError.code === "string") body.code = publicError.code;
    if (publicError.project !== undefined) body.project = publicError.project;
    if (typeof publicError.serverUpdatedAt === "string") body.serverUpdatedAt = publicError.serverUpdatedAt;
    return json(status, body);
  }
});
