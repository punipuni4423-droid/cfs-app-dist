-- Deploy before the matching Edge/app. Legacy snapshots cannot authorize deletes.
create or replace function public.save_cfs_project_set(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text, p_projects jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'CFS_PROJECT_LIST_UPGRADE_REQUIRED';
end;
$$;

create or replace function public.rename_cfs_project(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_project_id text, p_name text, p_expected_updated_at text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_existing public.cfs_projects%rowtype;
  v_project jsonb;
  v_time text;
begin
  if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if p_project_id is null or p_project_id !~ '^[A-Za-z0-9:_-]{1,160}$'
    or nullif(trim(p_name), '') is null or length(trim(p_name)) > 240 then raise exception 'CFS_PROJECT_INVALID'; end if;
  if not exists (select 1 from public.cfs_memberships where auth_user_id = p_user_id and active
    and not rebind_required and role in ('editor', 'admin')) then raise exception 'CFS_EDITOR_REQUIRED'; end if;
  perform 1 from public.cfs_edit_locks where state_id = p_state_id and user_id = p_user_id
    and session_id = p_session_id and expires_at > now() for share;
  if not found then raise exception 'CFS_LOCK_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  perform pg_advisory_xact_lock(hashtext('cfs-project:' || p_project_id));
  select * into v_existing from public.cfs_projects where id = p_project_id for update;
  if not found or v_existing.deleted_at is not null or nullif(trim(p_expected_updated_at), '') is null
    or v_existing.payload->>'updatedAt' is distinct from p_expected_updated_at then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  v_time := to_char(greatest(clock_timestamp(), (v_existing.payload->>'updatedAt')::timestamptz + interval '1 millisecond')
    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_project := v_existing.payload || jsonb_build_object('name', trim(p_name), 'updatedAt', v_time,
    'lastUpdatedBy', jsonb_build_object('userId', p_user_id, 'displayName', p_user_name, 'updatedAt', v_time));
  update public.cfs_projects set name = trim(p_name), payload = v_project, updated_at = now(), version = version + 1,
    last_updated_by_user_id = p_user_id, last_updated_by_name = left(p_user_name, 120), last_updated_at = now()
    where id = p_project_id;
  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
    values (p_user_id, left(p_user_name, 120), 1, array[p_project_id], 'revision_save');
  return jsonb_build_object('ok', true, 'project', v_project);
end;
$$;

create or replace function public.merge_cfs_projects(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_projects jsonb, p_expected_updated_ats jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_project jsonb;
  v_id text;
  v_expected text;
  v_existing public.cfs_projects%rowtype;
  v_ids text[] := '{}';
  v_saved jsonb := '[]'::jsonb;
  v_time text;
begin
  if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if jsonb_typeof(p_projects) is distinct from 'array' or jsonb_typeof(p_expected_updated_ats) is distinct from 'object'
    then raise exception 'CFS_PROJECT_INVALID'; end if;
  if not exists (select 1 from public.cfs_memberships where auth_user_id = p_user_id and active
    and not rebind_required and role in ('editor', 'admin')) then raise exception 'CFS_EDITOR_REQUIRED'; end if;
  perform 1 from public.cfs_edit_locks where state_id = p_state_id and user_id = p_user_id
    and session_id = p_session_id and expires_at > now() for share;
  if not found then raise exception 'CFS_LOCK_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  -- Sorted per-project locks also serialize with independent project creation/saves.
  for v_project in select value from jsonb_array_elements(p_projects) order by value->>'id' loop
    v_id := v_project->>'id';
    if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or nullif(trim(v_project->>'name'), '') is null
      or not (p_expected_updated_ats ? v_id) or jsonb_typeof(p_expected_updated_ats->v_id) not in ('string','null')
      then raise exception 'CFS_PROJECT_INVALID'; end if;
    if v_id = any(v_ids) then raise exception 'CFS_PROJECT_DUPLICATE'; end if;
    v_ids := array_append(v_ids, v_id);
    perform pg_advisory_xact_lock(hashtext('cfs-project:' || v_id));
    select * into v_existing from public.cfs_projects where id = v_id for update;
    v_expected := p_expected_updated_ats->>v_id;
    if found and v_existing.deleted_at is null then
      if v_expected is null or v_existing.payload->>'updatedAt' is distinct from v_expected then raise exception 'CFS_PROJECT_CONFLICT'; end if;
    elsif v_expected is not null then
      raise exception 'CFS_PROJECT_CONFLICT';
    end if;
    -- Null explicitly means create/restore. Existing live IDs always require CAS.
    v_time := to_char(greatest(clock_timestamp(), coalesce((v_existing.payload->>'updatedAt')::timestamptz + interval '1 millisecond', clock_timestamp()))
      at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_project := v_project || jsonb_build_object('updatedAt', v_time);
    perform public.save_cfs_project(p_state_id, p_user_id, p_session_id, p_user_name, v_project,
      case when v_existing.id is null then '__CFS_CREATE_ONLY__' else v_existing.payload->>'updatedAt' end);
    v_saved := v_saved || jsonb_build_array(v_project);
  end loop;
  return jsonb_build_object('ok', true, 'projects', v_saved);
end;
$$;

revoke all on function public.save_cfs_project_set(text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.rename_cfs_project(text, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.merge_cfs_projects(text, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_cfs_project_set(text, uuid, text, text, jsonb) to service_role;
grant execute on function public.rename_cfs_project(text, uuid, text, text, text, text, text) to service_role;
grant execute on function public.merge_cfs_projects(text, uuid, text, text, jsonb, jsonb) to service_role;
