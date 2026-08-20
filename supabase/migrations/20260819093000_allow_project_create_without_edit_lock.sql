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
  v_create_only boolean;
begin
  if jsonb_typeof(p_project) <> 'object' then raise exception 'CFS_PROJECT_INVALID'; end if;
  v_id := nullif(p_project->>'id', '');
  v_name := nullif(trim(coalesce(p_project->>'name', '')), '');
  v_create_only := trim(coalesce(p_expected_updated_at, '')) = '__CFS_CREATE_ONLY__';
  if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or v_name is null then
    raise exception 'CFS_PROJECT_INVALID';
  end if;
  if p_state_id <> 'cfs-projects' and p_state_id <> ('project:' || v_id) then
    raise exception 'CFS_LOCK_SCOPE_INVALID';
  end if;
  if not v_create_only and not exists (
    select 1 from public.cfs_edit_locks
    where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id and expires_at > now()
  ) then raise exception 'CFS_LOCK_REQUIRED'; end if;

  perform pg_advisory_xact_lock(hashtext('cfs-project:' || v_id));
  select * into v_existing from public.cfs_projects where id = v_id for update;
  if found and v_create_only then
    raise exception 'CFS_PROJECT_CONFLICT';
  end if;
  if found and nullif(trim(coalesce(p_expected_updated_at, '')), '') is not null
    and not v_create_only
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

revoke all on function public.save_cfs_project(text, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_cfs_project(text, uuid, text, text, jsonb, text) to service_role;
