-- Project deletion and its recoverable trash copy commit together.
-- Hosted application requires the normal approved migration/deployment gate.
create or replace function public.save_cfs_workspace_trash(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_payload jsonb, p_expected_updated_at text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_existing public.cfs_workspace_trash%rowtype;
  v_version bigint;
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(p_payload->'projects') is distinct from 'array'
    or jsonb_typeof(p_payload->'roomTypes') is distinct from 'array' then
    raise exception 'CFS_TRASH_OBJECT_REQUIRED';
  end if;
  if not exists (select 1 from public.cfs_memberships where auth_user_id = p_user_id
    and active and not rebind_required and role in ('editor', 'admin')) then
    raise exception 'CFS_EDITOR_REQUIRED';
  end if;
  perform 1 from public.cfs_edit_locks where state_id = p_state_id and user_id = p_user_id
    and session_id = p_session_id and expires_at > now() for share;
  if not found then raise exception 'CFS_LOCK_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('cfs-workspace-trash'));
  select * into v_existing from public.cfs_workspace_trash where id = 'cfs-trash' for update;
  if p_expected_updated_at is distinct from coalesce(v_existing.version::text, '') then
    raise exception 'CFS_TRASH_CONFLICT';
  end if;
  -- Conservative UTF-8 size, including jsonb's separator spaces.
  if octet_length(p_payload::text) >= 10485760 then raise exception 'CFS_TRASH_TOO_LARGE'; end if;
  insert into public.cfs_workspace_trash(id, version, payload, updated_at, updated_by_user_id, updated_by_name)
  values ('cfs-trash', 1, p_payload, now(), p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120))
  on conflict (id) do update set version = public.cfs_workspace_trash.version + 1,
    payload = excluded.payload, updated_at = excluded.updated_at,
    updated_by_user_id = excluded.updated_by_user_id, updated_by_name = excluded.updated_by_name
  returning version into v_version;
  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
  values (p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), 0, '{}', 'trash_save');
  return jsonb_build_object('saved', true, 'version', v_version, 'updatedAt', v_version::text);
end;
$$;

-- An old client must reload/upgrade, never silently overwrite a new deletion.
create or replace function public.save_cfs_workspace_trash(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'CFS_TRASH_CONFLICT';
end;
$$;

create or replace function public.delete_cfs_project_to_trash(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_project_id text, p_expected_updated_at text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_project public.cfs_projects%rowtype;
  v_existing public.cfs_workspace_trash%rowtype;
  v_trash jsonb;
  v_version bigint;
  v_projects jsonb;
begin
  if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if p_project_id is null or p_project_id !~ '^[A-Za-z0-9:_-]{1,160}$' then raise exception 'CFS_PROJECT_INVALID'; end if;
  if nullif(trim(p_expected_updated_at), '') is null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  if not exists (select 1 from public.cfs_memberships where auth_user_id = p_user_id
    and active and not rebind_required and role in ('editor', 'admin')) then
    raise exception 'CFS_EDITOR_REQUIRED';
  end if;
  perform 1 from public.cfs_edit_locks where state_id = 'cfs-projects' and user_id = p_user_id
    and session_id = p_session_id and expires_at > now() for share;
  if not found then raise exception 'CFS_LOCK_REQUIRED'; end if;
  -- Same write serialization keys as legacy set/single-project saves.
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  perform pg_advisory_xact_lock(hashtext('cfs-project:' || p_project_id));
  select * into v_project from public.cfs_projects where id = p_project_id for update;
  if not found or v_project.deleted_at is not null
    or coalesce(v_project.payload->>'updatedAt', '') <> p_expected_updated_at then
    raise exception 'CFS_PROJECT_CONFLICT';
  end if;
  perform pg_advisory_xact_lock(hashtext('cfs-workspace-trash'));
  select * into v_existing from public.cfs_workspace_trash where id = 'cfs-trash' for update;
  v_trash := coalesce(v_existing.payload, '{"projects":[],"roomTypes":[]}'::jsonb);
  if jsonb_typeof(v_trash->'projects') is distinct from 'array'
    or jsonb_typeof(v_trash->'roomTypes') is distinct from 'array' then raise exception 'CFS_TRASH_OBJECT_REQUIRED'; end if;
  v_trash := jsonb_set(v_trash, '{projects}', (v_trash->'projects') || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text, 'deletedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'project', v_project.payload)));
  if octet_length(v_trash::text) >= 10485760 then raise exception 'CFS_TRASH_TOO_LARGE'; end if;
  insert into public.cfs_workspace_trash(id, version, payload, updated_at, updated_by_user_id, updated_by_name)
  values ('cfs-trash', 1, v_trash, now(), p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120))
  on conflict (id) do update set version = public.cfs_workspace_trash.version + 1,
    payload = excluded.payload, updated_at = excluded.updated_at,
    updated_by_user_id = excluded.updated_by_user_id, updated_by_name = excluded.updated_by_name
  returning version into v_version;
  update public.cfs_projects set deleted_at = now(), updated_at = now(), version = version + 1,
    last_updated_by_user_id = p_user_id,
    last_updated_by_name = left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), last_updated_at = now()
    where id = p_project_id;
  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
  values (p_user_id, left(coalesce(nullif(trim(p_user_name), ''), 'CFS user'), 120), 1, array[p_project_id], 'trash_save');
  select coalesce(jsonb_agg(payload order by updated_at desc, id), '[]'::jsonb) into v_projects
    from public.cfs_projects where deleted_at is null;
  return jsonb_build_object('ok', true, 'projects', v_projects, 'trash', v_trash, 'updatedAt', v_version::text);
end;
$$;

revoke all on function public.save_cfs_workspace_trash(text, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.save_cfs_workspace_trash(text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.delete_cfs_project_to_trash(text, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_cfs_workspace_trash(text, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.save_cfs_workspace_trash(text, uuid, text, text, jsonb) to service_role;
grant execute on function public.delete_cfs_project_to_trash(text, uuid, text, text, text, text) to service_role;
