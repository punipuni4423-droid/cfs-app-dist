-- CFS project-scoped edit locks.
-- Apply only after a JSON/API backup is recorded and the hosted Supabase change is approved.

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
  v_lock public.cfs_edit_locks%rowtype;
  v_expires_at timestamptz := now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300)));
begin
  if p_state_id !~ '^[A-Za-z0-9:_-]{1,160}$' or p_session_id !~ '^[A-Za-z0-9:_-]{1,160}$' then
    raise exception 'CFS_LOCK_INPUT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtext('cfs-project-locks'));
  delete from public.cfs_edit_locks where expires_at <= now();

  select * into v_current
    from public.cfs_edit_locks
    where expires_at > now()
      and (p_state_id = 'cfs-projects' or state_id = 'cfs-projects' or state_id = p_state_id)
      and (user_id <> p_user_id or session_id <> p_session_id)
    order by case when state_id = 'cfs-projects' then 0 else 1 end, expires_at asc
    limit 1
    for update;

  if found then
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

  delete from public.cfs_edit_locks
    where user_id = p_user_id and session_id = p_session_id and state_id <> p_state_id;

  insert into public.cfs_edit_locks(state_id, user_id, user_name, session_id, acquired_at, heartbeat_at, expires_at)
  values (p_state_id, p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), p_session_id, now(), now(), v_expires_at)
  on conflict (state_id) do update set
    user_id = excluded.user_id,
    user_name = excluded.user_name,
    session_id = excluded.session_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  returning * into v_lock;

  return jsonb_build_object(
    'acquired', true,
    'stateId', v_lock.state_id,
    'userId', v_lock.user_id,
    'userName', v_lock.user_name,
    'sessionId', v_lock.session_id,
    'acquiredAt', v_lock.acquired_at,
    'heartbeatAt', v_lock.heartbeat_at,
    'expiresAt', v_lock.expires_at
  );
end;
$$;

create or replace function public.save_cfs_project(
  p_state_id text,
  p_user_id uuid,
  p_session_id text,
  p_user_name text,
  p_project jsonb,
  p_expected_updated_at text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_name text;
  v_existing public.cfs_projects%rowtype;
  v_version bigint;
begin
  if jsonb_typeof(p_project) <> 'object' then raise exception 'CFS_PROJECT_INVALID'; end if;
  v_id := nullif(p_project->>'id', '');
  v_name := nullif(trim(coalesce(p_project->>'name', '')), '');
  if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or v_name is null then
    raise exception 'CFS_PROJECT_INVALID';
  end if;
  if p_state_id <> 'cfs-projects' and p_state_id <> ('project:' || v_id) then
    raise exception 'CFS_LOCK_SCOPE_INVALID';
  end if;
  if not exists (
    select 1 from public.cfs_edit_locks
    where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id and expires_at > now()
  ) then raise exception 'CFS_LOCK_REQUIRED'; end if;

  perform pg_advisory_xact_lock(hashtext('cfs-project:' || v_id));
  select * into v_existing from public.cfs_projects where id = v_id for update;
  if found and nullif(trim(coalesce(p_expected_updated_at, '')), '') is not null
    and coalesce(v_existing.payload->>'updatedAt', '') <> trim(p_expected_updated_at) then
    raise exception 'CFS_PROJECT_CONFLICT';
  end if;

  insert into public.cfs_projects(id, name, updated_at, payload, version, deleted_at, last_updated_by_user_id, last_updated_by_name, last_updated_at)
  values (v_id, left(v_name, 240), now(), p_project, 1, null, p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), now())
  on conflict (id) do update set
    name = excluded.name,
    updated_at = excluded.updated_at,
    payload = excluded.payload,
    version = public.cfs_projects.version + 1,
    deleted_at = null,
    last_updated_by_user_id = excluded.last_updated_by_user_id,
    last_updated_by_name = excluded.last_updated_by_name,
    last_updated_at = excluded.last_updated_at
  returning version into v_version;

  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
  values (p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), 1, array[v_id], 'revision_save');

  return jsonb_build_object('saved', true, 'projectId', v_id, 'version', v_version);
end;
$$;

revoke all on function public.acquire_cfs_edit_lock(text, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.save_cfs_project(text, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.acquire_cfs_edit_lock(text, uuid, text, text, integer) to service_role;
grant execute on function public.save_cfs_project(text, uuid, text, text, jsonb, text) to service_role;
