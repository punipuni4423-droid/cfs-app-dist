-- Source-only until the approved SQL -> Edge -> app deployment gate.
-- Protocol markers are transport metadata, never persisted in project exports.
create or replace function public.cfs_save_content(p_project jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select (p_project - 'updatedAt' - 'lastUpdatedBy' - 'lastSaveOperation' - '_cfsWriteProtocol') ||
    case when jsonb_typeof(p_project->'roomTypes') = 'array' then jsonb_build_object('roomTypes',
      coalesce((select jsonb_agg(value - 'updatedAt' order by ordinality)
        from jsonb_array_elements(p_project->'roomTypes') with ordinality), '[]'::jsonb)) else '{}'::jsonb end;
$$;

create or replace function public.cfs_common_history_valid(p_history jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare
  v_item jsonb;
  v_snapshot jsonb;
  v_ids text[] := '{}';
  v_revisions text[] := '{}';
begin
  if p_history is null then return true; end if;
  if jsonb_typeof(p_history) is distinct from 'array' then return false; end if;
  for v_item in select value from jsonb_array_elements(p_history) loop
    v_snapshot := v_item->'snapshot';
    if jsonb_typeof(v_item) is distinct from 'object'
      or jsonb_typeof(v_item->'id') is distinct from 'string' or trim(coalesce(v_item->>'id', '')) = ''
      or jsonb_typeof(v_item->'revision') is distinct from 'string' or (v_item->>'revision') !~ '^P[1-9][0-9]*$'
      or jsonb_typeof(v_item->'savedAt') is distinct from 'string' or trim(coalesce(v_item->>'savedAt', '')) = ''
      or jsonb_typeof(v_item->'savedBy') is distinct from 'string'
      or jsonb_typeof(v_item->'note') is distinct from 'string'
      or (v_item ? 'operationId' and jsonb_typeof(v_item->'operationId') is distinct from 'string')
      or jsonb_typeof(v_snapshot) is distinct from 'object'
      or jsonb_typeof(v_snapshot->'name') is distinct from 'string'
      or (v_snapshot ? 'settings' and jsonb_typeof(v_snapshot->'settings') is distinct from 'object')
      or (v_snapshot ? 'remarks' and jsonb_typeof(v_snapshot->'remarks') is distinct from 'array')
      or jsonb_typeof(v_snapshot->'locations') is distinct from 'array'
      or jsonb_typeof(v_snapshot->'fixtures') is distinct from 'array'
      then return false; end if;
    if (v_item->>'id') = any(v_ids) or (v_item->>'revision') = any(v_revisions) then return false; end if;
    v_ids := array_append(v_ids, v_item->>'id');
    v_revisions := array_append(v_revisions, v_item->>'revision');
    if exists (select 1 from jsonb_array_elements((v_snapshot->'locations') || (v_snapshot->'fixtures') || coalesce(v_snapshot->'remarks', '[]'::jsonb))
      where jsonb_typeof(value) is distinct from 'object') then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.save_cfs_project(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_project jsonb, p_expected_updated_at text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_name text;
  v_existing public.cfs_projects%rowtype;
  v_version bigint;
  v_create_only boolean := p_expected_updated_at = '__CFS_CREATE_ONLY__';
  v_restore boolean := p_expected_updated_at = '__CFS_RESTORE_FROM_TRASH__';
  v_project jsonb;
  v_time text;
  v_trash jsonb;
begin
  if p_project->'_cfsWriteProtocol' is distinct from '2'::jsonb then raise exception 'CFS_SAVE_PROTOCOL_REQUIRED'; end if;
  v_project := p_project - '_cfsWriteProtocol';
  if jsonb_typeof(v_project) is distinct from 'object' then raise exception 'CFS_PROJECT_INVALID'; end if;
  v_id := nullif(v_project->>'id', '');
  v_name := nullif(trim(coalesce(v_project->>'name', '')), '');
  if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or v_name is null then raise exception 'CFS_PROJECT_INVALID'; end if;
  if p_state_id is null or (p_state_id <> 'cfs-projects' and p_state_id <> ('project:' || v_id)) then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if not exists (select 1 from public.cfs_memberships where auth_user_id = p_user_id and active
    and not rebind_required and role in ('editor', 'admin')) then raise exception 'CFS_EDITOR_REQUIRED'; end if;
  if not coalesce(v_create_only, false) then
    perform 1 from public.cfs_edit_locks where state_id = p_state_id and user_id = p_user_id
      and session_id = p_session_id and expires_at > now() for share;
    if not found then raise exception 'CFS_LOCK_REQUIRED'; end if;
  end if;
  if coalesce(v_restore, false) then
    if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
    perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  end if;
  perform pg_advisory_xact_lock(hashtext('cfs-project:' || v_id));
  select * into v_existing from public.cfs_projects where id = v_id for update;
  if not public.cfs_common_history_valid(v_project->'commonRevisions')
    or not public.cfs_common_history_valid(v_existing.payload->'commonRevisions') then raise exception 'CFS_COMMON_HISTORY_PROTECTED'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(v_existing.payload->'commonRevisions', '[]'::jsonb)) old
    where not exists (select 1 from jsonb_array_elements(coalesce(v_project->'commonRevisions', '[]'::jsonb)) incoming where incoming = old))
    then raise exception 'CFS_COMMON_HISTORY_PROTECTED'; end if;
  if v_project ? 'lastSaveOperation' and (jsonb_typeof(v_project->'lastSaveOperation') is distinct from 'object'
    or jsonb_typeof(v_project#>'{lastSaveOperation,id}') is distinct from 'string' or coalesce(v_project#>>'{lastSaveOperation,id}', '') = ''
    or coalesce(v_project#>>'{lastSaveOperation,kind}', '') not in ('current','revision','idle')
    or jsonb_typeof(v_project#>'{lastSaveOperation,fingerprint}') is distinct from 'string'
    or coalesce(v_project#>>'{lastSaveOperation,fingerprint}', '') = '') then raise exception 'CFS_PROJECT_INVALID'; end if;
  -- A receipt never bypasses deletion, lease or membership checks.
  if v_existing.id is not null and v_existing.deleted_at is null and v_project ? 'lastSaveOperation'
    and v_existing.payload#>>'{lastSaveOperation,id}' = v_project#>>'{lastSaveOperation,id}' then
    if v_existing.payload->'lastSaveOperation' is distinct from v_project->'lastSaveOperation'
      or public.cfs_save_content(v_existing.payload) is distinct from public.cfs_save_content(v_project)
      then raise exception 'CFS_SAVE_OPERATION_CONFLICT'; end if;
    return jsonb_build_object('saved', true, 'projectId', v_id, 'version', v_existing.version, 'project', v_existing.payload);
  end if;
  if coalesce(v_restore, false) then
    if v_existing.id is not null and v_existing.deleted_at is null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
    perform pg_advisory_xact_lock(hashtext('cfs-workspace-trash'));
    select payload into v_trash from public.cfs_workspace_trash where id = 'cfs-trash' for update;
    -- A unique-name adjustment is permitted; all other business data and history must match the original.
    if not exists (select 1 from jsonb_array_elements(coalesce(v_trash->'projects', '[]'::jsonb)) item
      where item#>>'{project,id}' = v_id
        and (public.cfs_save_content(item->'project') - 'name') = (public.cfs_save_content(v_project) - 'name'))
      then raise exception 'CFS_PROJECT_RESTORE_REQUIRED'; end if;
  elsif coalesce(v_create_only, false) then
    if v_existing.id is not null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  elsif v_existing.id is null or v_existing.deleted_at is not null
    or nullif(trim(p_expected_updated_at), '') is null
    or v_existing.payload->>'updatedAt' is distinct from p_expected_updated_at then
    raise exception 'CFS_PROJECT_CONFLICT';
  end if;
  v_time := to_char(greatest(clock_timestamp(), coalesce((v_existing.payload->>'updatedAt')::timestamptz + interval '1 millisecond', clock_timestamp()))
    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_project := v_project || jsonb_build_object('updatedAt', v_time,
    'lastUpdatedBy', jsonb_build_object('userId', p_user_id, 'displayName', p_user_name, 'updatedAt', v_time));
  insert into public.cfs_projects(id, name, updated_at, payload, version, deleted_at, last_updated_by_user_id, last_updated_by_name, last_updated_at)
    values (v_id, left(v_name, 240), now(), v_project, 1, null, p_user_id, left(p_user_name, 120), now())
    on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at, payload = excluded.payload,
      version = public.cfs_projects.version + 1, deleted_at = null, last_updated_by_user_id = excluded.last_updated_by_user_id,
      last_updated_by_name = excluded.last_updated_by_name, last_updated_at = excluded.last_updated_at
    returning version into v_version;
  insert into public.cfs_revision_events(user_id, user_name, project_count, active_project_ids, operation)
    values (p_user_id, left(p_user_name, 120), 1, array[v_id], 'revision_save');
  return jsonb_build_object('saved', true, 'projectId', v_id, 'version', v_version, 'project', v_project);
end;
$$;

-- Old Edge code has no explicit restoration contract and must not revive rows.
create or replace function public.merge_cfs_projects(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_projects jsonb, p_expected_updated_ats jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'CFS_PROJECT_LIST_UPGRADE_REQUIRED';
end;
$$;

create or replace function public.merge_cfs_projects(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_projects jsonb, p_expected_updated_ats jsonb, p_restore_project_ids jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_project jsonb;
  v_id text;
  v_expected text;
  v_existing public.cfs_projects%rowtype;
  v_ids text[] := '{}';
  v_saved jsonb := '[]'::jsonb;
  v_result jsonb;
  v_restore boolean;
begin
  if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if jsonb_typeof(p_projects) is distinct from 'array' or jsonb_typeof(p_expected_updated_ats) is distinct from 'object'
    or jsonb_typeof(p_restore_project_ids) is distinct from 'array' then raise exception 'CFS_PROJECT_INVALID'; end if;
  if exists (select 1 from jsonb_array_elements(p_restore_project_ids) id where jsonb_typeof(id) <> 'string'
    or not exists (select 1 from jsonb_array_elements(p_projects) p where p->'id' = id)) then raise exception 'CFS_PROJECT_INVALID'; end if;
  if not exists (select 1 from public.cfs_memberships where auth_user_id = p_user_id and active
    and not rebind_required and role in ('editor', 'admin')) then raise exception 'CFS_EDITOR_REQUIRED'; end if;
  perform 1 from public.cfs_edit_locks where state_id = p_state_id and user_id = p_user_id
    and session_id = p_session_id and expires_at > now() for share;
  if not found then raise exception 'CFS_LOCK_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  for v_project in select value from jsonb_array_elements(p_projects) order by value->>'id' loop
    v_id := v_project->>'id';
    if v_project->'_cfsWriteProtocol' is distinct from '2'::jsonb then raise exception 'CFS_SAVE_PROTOCOL_REQUIRED'; end if;
    if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or not (p_expected_updated_ats ? v_id)
      or jsonb_typeof(p_expected_updated_ats->v_id) not in ('string','null') then raise exception 'CFS_PROJECT_INVALID'; end if;
    if v_id = any(v_ids) then raise exception 'CFS_PROJECT_DUPLICATE'; end if;
    v_ids := array_append(v_ids, v_id);
    perform pg_advisory_xact_lock(hashtext('cfs-project:' || v_id));
    select * into v_existing from public.cfs_projects where id = v_id for update;
    v_expected := p_expected_updated_ats->>v_id;
    v_restore := p_restore_project_ids ? v_id;
    -- Recognize an exact retry inside the single-project transaction, including create/restore retries.
    if v_existing.id is not null and v_existing.deleted_at is null and v_project ? 'lastSaveOperation'
      and v_existing.payload#>>'{lastSaveOperation,id}' = v_project#>>'{lastSaveOperation,id}' then
      v_expected := v_existing.payload->>'updatedAt';
    elsif v_restore then
      if v_expected is not null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
      v_expected := '__CFS_RESTORE_FROM_TRASH__';
    elsif v_existing.id is null then
      if v_expected is not null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
      v_expected := '__CFS_CREATE_ONLY__';
    elsif v_existing.deleted_at is not null then
      raise exception 'CFS_PROJECT_RESTORE_REQUIRED';
    elsif v_expected is null then
      raise exception 'CFS_PROJECT_CONFLICT';
    end if;
    v_result := public.save_cfs_project(p_state_id, p_user_id, p_session_id, p_user_name, v_project, v_expected);
    v_saved := v_saved || jsonb_build_array(v_result->'project');
  end loop;
  return jsonb_build_object('ok', true, 'projects', v_saved);
end;
$$;

revoke all on function public.cfs_save_content(jsonb) from public, anon, authenticated;
revoke all on function public.cfs_common_history_valid(jsonb) from public, anon, authenticated;
revoke all on function public.save_cfs_project(text, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.merge_cfs_projects(text, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.merge_cfs_projects(text, uuid, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_cfs_project(text, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.merge_cfs_projects(text, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.merge_cfs_projects(text, uuid, text, text, jsonb, jsonb, jsonb) to service_role;
