-- CFS secure sharing v0.1.
-- Apply only after a JSON/API backup is recorded and the hosted Supabase change is approved.
-- Browser clients receive no direct table grants; all authenticated operations use cfs-api.

alter table public.cfs_projects
  add column if not exists version bigint not null default 1,
  add column if not exists deleted_at timestamptz,
  add column if not exists last_updated_by_user_id uuid,
  add column if not exists last_updated_by_name text,
  add column if not exists last_updated_at timestamptz;

update public.cfs_projects
  set version = 1
  where version is null or version < 1;

create table if not exists public.cfs_memberships (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('viewer', 'editor', 'admin')) default 'viewer',
  active boolean not null default true,
  rebind_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.cfs_edit_locks (
  state_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_name text not null,
  session_id text not null,
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.cfs_workspace_trash (
  id text primary key check (id = 'cfs-trash'),
  version bigint not null default 1,
  payload jsonb not null default '{"projects":[],"roomTypes":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_name text
);

create table if not exists public.cfs_revision_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete restrict,
  user_name text not null,
  project_count integer not null,
  active_project_ids text[] not null default '{}',
  operation text not null check (operation in ('revision_save', 'trash_save'))
);

create index if not exists cfs_projects_active_updated_at_idx
  on public.cfs_projects (updated_at desc)
  where deleted_at is null;
create index if not exists cfs_edit_locks_expires_at_idx
  on public.cfs_edit_locks (expires_at);
create index if not exists cfs_revision_events_created_at_idx
  on public.cfs_revision_events (created_at desc);

alter table public.cfs_projects enable row level security;
alter table public.cfs_memberships enable row level security;
alter table public.cfs_edit_locks enable row level security;
alter table public.cfs_workspace_trash enable row level security;
alter table public.cfs_revision_events enable row level security;

revoke all on table public.cfs_projects from anon, authenticated;
revoke all on table public.cfs_memberships from anon, authenticated;
revoke all on table public.cfs_edit_locks from anon, authenticated;
revoke all on table public.cfs_workspace_trash from anon, authenticated;
revoke all on table public.cfs_revision_events from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.cfs_projects to service_role;
grant select, insert, update, delete on table public.cfs_memberships to service_role;
grant select, insert, update, delete on table public.cfs_edit_locks to service_role;
grant select, insert, update, delete on table public.cfs_workspace_trash to service_role;
grant select, insert, update, delete on table public.cfs_revision_events to service_role;

create or replace function public.acquire_cfs_edit_lock(
  p_state_id text,
  p_user_id uuid,
  p_user_name text,
  p_session_id text,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.cfs_edit_locks%rowtype;
  v_expires_at timestamptz := now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300)));
begin
  if p_state_id !~ '^[A-Za-z0-9:_-]{1,160}$' or p_session_id !~ '^[A-Za-z0-9:_-]{1,160}$' then
    raise exception 'CFS_LOCK_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_state_id));
  select * into v_current from public.cfs_edit_locks where state_id = p_state_id for update;
  if found and v_current.expires_at > now() and (v_current.user_id <> p_user_id or v_current.session_id <> p_session_id) then
    return jsonb_build_object(
      'acquired', false,
      'stateId', v_current.state_id,
      'userId', v_current.user_id,
      'userName', v_current.user_name,
      'sessionId', v_current.session_id,
      'acquiredAt', v_current.acquired_at,
      'heartbeatAt', v_current.heartbeat_at,
      'expiresAt', v_current.expires_at
    );
  end if;
  insert into public.cfs_edit_locks(state_id, user_id, user_name, session_id, acquired_at, heartbeat_at, expires_at)
  values (p_state_id, p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), p_session_id, now(), now(), v_expires_at)
  on conflict (state_id) do update set
    user_id = excluded.user_id,
    user_name = excluded.user_name,
    session_id = excluded.session_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at;
  return jsonb_build_object(
    'acquired', true,
    'stateId', p_state_id,
    'userId', p_user_id,
    'userName', left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120),
    'sessionId', p_session_id,
    'acquiredAt', now(),
    'heartbeatAt', now(),
    'expiresAt', v_expires_at
  );
end;
$$;

create or replace function public.heartbeat_cfs_edit_lock(
  p_state_id text,
  p_user_id uuid,
  p_session_id text,
  p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock public.cfs_edit_locks%rowtype;
  v_expires_at timestamptz := now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300)));
begin
  update public.cfs_edit_locks
    set heartbeat_at = now(), expires_at = v_expires_at
    where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id and expires_at > now()
    returning * into v_lock;
  if not found then
    select * into v_lock from public.cfs_edit_locks where state_id = p_state_id and expires_at > now();
    if not found then return jsonb_build_object('acquired', false); end if;
    return jsonb_build_object('acquired', false, 'stateId', v_lock.state_id, 'userId', v_lock.user_id, 'userName', v_lock.user_name, 'sessionId', v_lock.session_id, 'acquiredAt', v_lock.acquired_at, 'heartbeatAt', v_lock.heartbeat_at, 'expiresAt', v_lock.expires_at);
  end if;
  return jsonb_build_object('acquired', true, 'stateId', v_lock.state_id, 'userId', v_lock.user_id, 'userName', v_lock.user_name, 'sessionId', v_lock.session_id, 'acquiredAt', v_lock.acquired_at, 'heartbeatAt', v_lock.heartbeat_at, 'expiresAt', v_lock.expires_at);
end;
$$;

create or replace function public.release_cfs_edit_lock(
  p_state_id text,
  p_user_id uuid,
  p_session_id text
) returns boolean
language sql
security definer
set search_path = public
as $$
  delete from public.cfs_edit_locks
  where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id
  returning true;
$$;

create or replace function public.save_cfs_project_set(
  p_state_id text,
  p_user_id uuid,
  p_session_id text,
  p_user_name text,
  p_projects jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project jsonb;
  v_id text;
  v_name text;
  v_ids text[] := array[]::text[];
  v_count integer := 0;
begin
  if jsonb_typeof(p_projects) <> 'array' then raise exception 'CFS_PROJECTS_ARRAY_REQUIRED'; end if;
  if not exists (
    select 1 from public.cfs_edit_locks
    where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id and expires_at > now()
  ) then raise exception 'CFS_LOCK_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext(p_state_id));
  for v_project in select value from jsonb_array_elements(p_projects)
  loop
    v_id := nullif(v_project->>'id', '');
    v_name := nullif(trim(coalesce(v_project->>'name', '')), '');
    if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or v_name is null then
      raise exception 'CFS_PROJECT_INVALID';
    end if;
    if v_id = any(v_ids) then raise exception 'CFS_PROJECT_DUPLICATE'; end if;
    v_ids := array_append(v_ids, v_id);
    insert into public.cfs_projects(id, name, updated_at, payload, version, deleted_at, last_updated_by_user_id, last_updated_by_name, last_updated_at)
    values (v_id, left(v_name, 240), now(), v_project, 1, null, p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), now())
    on conflict (id) do update set
      name = excluded.name,
      updated_at = excluded.updated_at,
      payload = excluded.payload,
      version = public.cfs_projects.version + 1,
      deleted_at = null,
      last_updated_by_user_id = excluded.last_updated_by_user_id,
      last_updated_by_name = excluded.last_updated_by_name,
      last_updated_at = excluded.last_updated_at;
    v_count := v_count + 1;
  end loop;
  update public.cfs_projects
    set deleted_at = now(), updated_at = now(), version = version + 1,
      last_updated_by_user_id = p_user_id,
      last_updated_by_name = left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120),
      last_updated_at = now()
    where deleted_at is null and not (id = any(v_ids));
  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
  values (p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), v_count, v_ids, 'revision_save');
  return jsonb_build_object('saved', true, 'projectCount', v_count, 'projectIds', v_ids);
end;
$$;

create or replace function public.save_cfs_workspace_trash(
  p_state_id text,
  p_user_id uuid,
  p_session_id text,
  p_user_name text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_version bigint;
begin
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'CFS_TRASH_OBJECT_REQUIRED'; end if;
  if not exists (
    select 1 from public.cfs_edit_locks
    where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id and expires_at > now()
  ) then raise exception 'CFS_LOCK_REQUIRED'; end if;
  insert into public.cfs_workspace_trash(id, version, payload, updated_at, updated_by_user_id, updated_by_name)
  values ('cfs-trash', 1, p_payload, now(), p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120))
  on conflict (id) do update set
    version = public.cfs_workspace_trash.version + 1,
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_by_name = excluded.updated_by_name
  returning version into v_version;
  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
  values (p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), 0, '{}', 'trash_save');
  return jsonb_build_object('saved', true, 'version', v_version);
end;
$$;

create or replace function public.upsert_cfs_membership(
  p_email text,
  p_display_name text,
  p_role text,
  p_active boolean
) returns public.cfs_memberships
language plpgsql
security definer
set search_path = public
as $$
declare v_existing public.cfs_memberships%rowtype;
declare v_active_admin_count integer;
declare v_result public.cfs_memberships%rowtype;
begin
  if lower(trim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'CFS_EMAIL_INVALID'; end if;
  if p_role not in ('viewer', 'editor', 'admin') then raise exception 'CFS_ROLE_INVALID'; end if;
  select * into v_existing from public.cfs_memberships where email = lower(trim(p_email)) for update;
  if found and v_existing.role = 'admin' and v_existing.active and (p_role <> 'admin' or not p_active) then
    select count(*) into v_active_admin_count from public.cfs_memberships where role = 'admin' and active and id <> v_existing.id;
    if v_active_admin_count = 0 then raise exception 'CFS_LAST_ADMIN_REQUIRED'; end if;
  end if;
  insert into public.cfs_memberships(email, display_name, role, active, updated_at)
  values (lower(trim(p_email)), left(coalesce(nullif(trim(p_display_name), ''), lower(trim(p_email))), 120), p_role, coalesce(p_active, true), now())
  on conflict (email) do update set
    display_name = excluded.display_name,
    role = excluded.role,
    active = excluded.active,
    updated_at = excluded.updated_at
  returning * into v_result;
  return v_result;
end;
$$;

revoke all on function public.acquire_cfs_edit_lock(text, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_cfs_edit_lock(text, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_cfs_edit_lock(text, uuid, text) from public, anon, authenticated;
revoke all on function public.save_cfs_project_set(text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.save_cfs_workspace_trash(text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.upsert_cfs_membership(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.acquire_cfs_edit_lock(text, uuid, text, text, integer) to service_role;
grant execute on function public.heartbeat_cfs_edit_lock(text, uuid, text, integer) to service_role;
grant execute on function public.release_cfs_edit_lock(text, uuid, text) to service_role;
grant execute on function public.save_cfs_project_set(text, uuid, text, text, jsonb) to service_role;
grant execute on function public.save_cfs_workspace_trash(text, uuid, text, text, jsonb) to service_role;
grant execute on function public.upsert_cfs_membership(text, text, text, boolean) to service_role;
