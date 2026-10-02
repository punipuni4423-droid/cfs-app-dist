-- Room Type deletion is an explicit transaction, never an exception in normal save.
begin;
do $$ begin
  if current_user <> 'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.cfs_assert_save_lease(text,uuid,text)') is null
    or to_regprocedure('public.cfs_project_hash(jsonb)') is null
    or to_regclass('public.cfs_project_history') is null then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create or replace function public.delete_cfs_room_type_to_trash(
  p_state_id text, p_user_id uuid, p_session_id text, p_user_name text,
  p_project_id text, p_room_type_id text, p_operation_id text, p_base jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_existing public.cfs_projects%rowtype; v_existing_trash public.cfs_workspace_trash%rowtype;
  v_room jsonb; v_project jsonb; v_trash jsonb; v_time text; v_version bigint; v_trash_version bigint;
begin
  if p_state_id is null or p_state_id not in ('cfs-projects','project:'||p_project_id) then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if p_project_id is null or p_project_id !~ '^[A-Za-z0-9:_-]{1,160}$'
    or p_room_type_id is null or p_room_type_id !~ '^[A-Za-z0-9:_-]{1,160}$'
    or p_operation_id is null or p_operation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then raise exception 'CFS_PROJECT_INVALID'; end if;
  if jsonb_typeof(p_base) is distinct from 'object' or jsonb_typeof(p_base->'version') is distinct from 'number'
    or coalesce(p_base->>'version','') !~ '^[1-9][0-9]*$' or coalesce(p_base->>'hash','') !~ '^[a-f0-9]{64}$'
    or nullif(p_base->>'updatedAt','') is null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  perform public.cfs_assert_member(p_user_id,array['editor','admin']);
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  perform pg_advisory_xact_lock(hashtext('cfs-project:'||p_project_id));
  select * into v_existing from public.cfs_projects where id=p_project_id for update;
  perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id);
  if v_existing.id is null or v_existing.deleted_at is not null
    or v_existing.version::text is distinct from p_base->>'version'
    or public.cfs_project_hash(v_existing.payload) is distinct from p_base->>'hash'
    or v_existing.payload->>'updatedAt' is distinct from p_base->>'updatedAt' then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  if jsonb_typeof(v_existing.payload->'roomTypes') is distinct from 'array' then raise exception 'CFS_PROJECT_INVALID'; end if;
  if (select count(*) from jsonb_array_elements(v_existing.payload->'roomTypes') r where r->>'id'=p_room_type_id) <> 1
    then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  select value into v_room from jsonb_array_elements(v_existing.payload->'roomTypes') where value->>'id'=p_room_type_id;
  perform pg_advisory_xact_lock(hashtext('cfs-workspace-trash'));
  select * into v_existing_trash from public.cfs_workspace_trash where id='cfs-trash' for update;
  v_trash:=coalesce(v_existing_trash.payload,'{"projects":[],"roomTypes":[]}'::jsonb);
  if jsonb_typeof(v_trash->'projects') is distinct from 'array' or jsonb_typeof(v_trash->'roomTypes') is distinct from 'array'
    then raise exception 'CFS_TRASH_OBJECT_REQUIRED'; end if;
  if exists(select 1 from jsonb_array_elements((v_trash->'projects')||(v_trash->'roomTypes')) r where r->>'id'=p_operation_id)
    then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  v_time:=to_char(greatest(clock_timestamp(),(v_existing.payload->>'updatedAt')::timestamptz+interval '1 millisecond')
    at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_trash:=jsonb_set(v_trash,'{roomTypes}',jsonb_build_array(jsonb_build_object('id',p_operation_id,'deletedAt',v_time,
    'projectId',p_project_id,'projectName',v_existing.payload->>'name','roomType',v_room))||(v_trash->'roomTypes'));
  if octet_length(v_trash::text)>=10485760 then raise exception 'CFS_TRASH_TOO_LARGE'; end if;
  v_project:=jsonb_set(v_existing.payload-'lastSaveOperation','{roomTypes}',
    (select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb)
      from jsonb_array_elements(v_existing.payload->'roomTypes') with ordinality where value->>'id' is distinct from p_room_type_id))
    ||jsonb_build_object('updatedAt',v_time,'lastUpdatedBy',jsonb_build_object('userId',p_user_id,'displayName',p_user_name,'updatedAt',v_time));
  -- Recheck the lease after all blocking locks and capacity/hash work.
  perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id);
  insert into public.cfs_workspace_trash(id,version,payload,updated_at,updated_by_user_id,updated_by_name)
    values('cfs-trash',1,v_trash,clock_timestamp(),p_user_id,left(coalesce(nullif(trim(p_user_name),''),'CFS user'),120))
    on conflict(id) do update set version=public.cfs_workspace_trash.version+1,payload=excluded.payload,
      updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id,updated_by_name=excluded.updated_by_name returning version into v_trash_version;
  perform set_config('cfs.history_operation','room-type-delete',true);
  perform set_config('cfs.history_restore_source','',true);
  update public.cfs_projects set payload=v_project,version=version+1,updated_at=clock_timestamp(),
    last_updated_by_user_id=p_user_id,last_updated_by_name=left(coalesce(nullif(trim(p_user_name),''),'CFS user'),120),last_updated_at=clock_timestamp()
    where id=p_project_id returning version into v_version;
  perform set_config('cfs.history_operation','',true);
  insert into public.cfs_revision_events(user_id,user_name,project_count,active_project_ids,operation)
    values(p_user_id,left(coalesce(nullif(trim(p_user_name),''),'CFS user'),120),1,array[p_project_id],'trash_save');
  -- Keep the mutation receipt small. Clients confirm raw project/Trash with GET.
  return jsonb_build_object('ok',true,'operationId',p_operation_id,'projectId',p_project_id,
    'base',jsonb_build_object('version',v_version,'hash',public.cfs_project_hash(v_project),'updatedAt',v_time),
    'updatedAt',v_trash_version::text);
end;
$$;
revoke all on function public.delete_cfs_room_type_to_trash(text,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.delete_cfs_room_type_to_trash(text,uuid,text,text,text,text,text,jsonb) to service_role;
commit;
