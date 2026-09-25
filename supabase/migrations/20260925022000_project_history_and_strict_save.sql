-- T-149 stage 1. Deploy as postgres, atomically, after backup and write quiescence.
-- Old protocol-2 writers without explicit read-time base are intentionally rejected.
begin;
do $$ begin
  if current_user<>'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.merge_cfs_projects(text,uuid,text,text,jsonb,jsonb,jsonb)') is null
    or to_regprocedure('public.cfs_common_history_valid(jsonb)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create table if not exists public.cfs_project_history (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  version bigint not null check (version > 0),
  parent_version bigint,
  snapshot jsonb not null,
  snapshot_sha256 text not null,
  operation text not null,
  actor_user_id uuid,
  actor_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  restored_from jsonb,
  unique (project_id, version)
);
-- Deliberately no FK to projects/users: delete must not erase recovery evidence.
alter table public.cfs_project_history enable row level security;
create index if not exists cfs_project_history_project_version_idx
  on public.cfs_project_history(project_id, version desc);
revoke all on public.cfs_project_history from public, anon, authenticated, service_role;

create or replace function public.cfs_strip_transport(p_project jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select p_project - array['_cfsWriteProtocol','_cfsBaseVersion','_cfsBaseHash','_cfsOperation','_cfsRestoreSource'];
$$;

create or replace function public.cfs_project_hash(p_project jsonb) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(public.cfs_strip_transport(p_project)::text, 'UTF8')), 'hex');
$$;

create or replace function public.cfs_save_content(p_project jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select (public.cfs_strip_transport(p_project) - 'updatedAt' - 'lastUpdatedBy' - 'lastSaveOperation') ||
    case when jsonb_typeof(p_project->'roomTypes') = 'array' then jsonb_build_object('roomTypes',
      coalesce((select jsonb_agg(value - 'updatedAt' order by ordinality)
        from jsonb_array_elements(p_project->'roomTypes') with ordinality), '[]'::jsonb)) else '{}'::jsonb end;
$$;

create or replace function public.cfs_rollback_content(p_project jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select (public.cfs_save_content(p_project) - 'commonRevisions') ||
    case when jsonb_typeof(p_project->'roomTypes') = 'array' then jsonb_build_object('roomTypes',
      coalesce((select jsonb_agg(value - 'updatedAt' - 'revisions' - 'revision' order by ordinality)
        from jsonb_array_elements(p_project->'roomTypes') with ordinality), '[]'::jsonb)) else '{}'::jsonb end;
$$;

create or replace function public.cfs_assert_member(p_user_id uuid, p_roles text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.cfs_memberships where auth_user_id = p_user_id and active
    and not rebind_required and role = any(p_roles) for share;
  if not found then raise exception 'CFS_PERMISSION_DENIED'; end if;
end;
$$;

create or replace function public.cfs_assert_save_lease(p_state_id text, p_user_id uuid, p_session_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v_lock public.cfs_edit_locks%rowtype;
begin
  perform public.cfs_assert_member(p_user_id, array['editor','admin']);
  select * into v_lock from public.cfs_edit_locks where state_id = p_state_id for share;
  -- clock_timestamp is evaluated AFTER any wait for the row/share lock.
  if not found or v_lock.user_id is distinct from p_user_id or v_lock.session_id is distinct from p_session_id
    or v_lock.expires_at <= clock_timestamp() then raise exception 'CFS_LOCK_REQUIRED'; end if;
end;
$$;

create or replace function public.cfs_room_history_valid(p_project jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare r jsonb; rev jsonb; ids text[] := '{}'; revision_ids text[];
begin
  if p_project is null then return true; end if;
  if jsonb_typeof(p_project->'roomTypes') is distinct from 'array' then return false; end if;
  for r in select value from jsonb_array_elements(p_project->'roomTypes') loop
    if jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'id') is distinct from 'string'
      or coalesce(r->>'id','') = '' or r->>'id' = any(ids)
      or (r ? 'revisions' and jsonb_typeof(r->'revisions') is distinct from 'array') then return false; end if;
    ids := array_append(ids,r->>'id'); revision_ids := '{}';
    for rev in select value from jsonb_array_elements(coalesce(r->'revisions','[]'::jsonb)) loop
      if jsonb_typeof(rev) is distinct from 'object' or jsonb_typeof(rev->'id') is distinct from 'string'
        or coalesce(rev->>'id','') = '' or rev->>'id' = any(revision_ids)
        or jsonb_typeof(rev->'snapshot') is distinct from 'string' then return false; end if;
      revision_ids := array_append(revision_ids,rev->>'id');
    end loop;
  end loop;
  return true;
end;
$$;

create or replace function public.cfs_assert_room_history(p_old jsonb,p_new jsonb) returns void
language plpgsql immutable set search_path = public as $$
declare r jsonb; incoming jsonb; rev jsonb;
begin
  if not public.cfs_room_history_valid(p_old) or not public.cfs_room_history_valid(p_new)
    then raise exception 'CFS_ROOM_HISTORY_PROTECTED'; end if;
  for r in select value from jsonb_array_elements(coalesce(p_old->'roomTypes','[]'::jsonb)) loop
    select value into incoming from jsonb_array_elements(p_new->'roomTypes') where value->>'id'=r->>'id';
    for rev in select value from jsonb_array_elements(coalesce(r->'revisions','[]'::jsonb)) loop
      if incoming is null or not exists (
        select 1 from jsonb_array_elements(coalesce(incoming->'revisions','[]'::jsonb)) n
          where n->'id'=rev->'id' and n->'snapshot'=rev->'snapshot') then raise exception 'CFS_ROOM_HISTORY_PROTECTED'; end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.cfs_prune_project_history(p_project_id text) returns void
language sql security definer set search_path = public as $$
  delete from public.cfs_project_history h where h.project_id=p_project_id
    and h.created_at < clock_timestamp() - interval '90 days'
    and h.id not in (select newest.id from public.cfs_project_history newest
      where newest.project_id=p_project_id order by newest.version desc limit 50);
$$;

create or replace function public.cfs_capture_project_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_operation text; v_actor uuid; v_name text; v_source jsonb;
begin
  -- actor/created_at identify the operation that retired OLD, not its original save.
  v_operation := nullif(current_setting('cfs.history_operation',true),'');
  if tg_op='UPDATE' then
    if new.version <= old.version then raise exception 'CFS_HISTORY_VERSION_REQUIRED'; end if;
    v_actor:=new.last_updated_by_user_id; v_name:=new.last_updated_by_name;
    v_operation:=coalesce(v_operation,case when new.deleted_at is not null and old.deleted_at is null then 'delete'
      when new.deleted_at is null and old.deleted_at is not null then 'trash-restore'
      when new.name is distinct from old.name then 'rename' else 'current' end);
  else
    v_actor:=nullif(current_setting('cfs.history_actor',true),'')::uuid;
    v_name:=nullif(current_setting('cfs.history_actor_name',true),'');
    v_operation:=coalesce(v_operation,'delete');
  end if;
  v_source:=nullif(current_setting('cfs.history_restore_source',true),'')::jsonb;
  insert into public.cfs_project_history(project_id,version,parent_version,snapshot,snapshot_sha256,operation,actor_user_id,actor_name,restored_from)
    values(old.id,old.version,case when old.version>1 then old.version-1 end,old.payload,
      public.cfs_project_hash(old.payload),v_operation,v_actor,coalesce(v_name,'Database maintenance'),v_source);
  perform public.cfs_prune_project_history(old.id);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists cfs_project_history_before_write on public.cfs_projects;
create trigger cfs_project_history_before_write before update or delete on public.cfs_projects
  for each row execute function public.cfs_capture_project_history();

create or replace function public.read_cfs_projects(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  perform public.cfs_assert_member(p_user_id,array['viewer','editor','admin']);
  -- Both payload and opaque base are aggregated from the SAME statement snapshot.
  select jsonb_build_object('projects',coalesce(jsonb_agg(payload order by updated_at desc,id),'[]'::jsonb),
    'bases',coalesce(jsonb_object_agg(id,jsonb_build_object('version',version,'hash',public.cfs_project_hash(payload),
      'updatedAt',payload->>'updatedAt')),'{}'::jsonb)) into v_result
    from public.cfs_projects where deleted_at is null;
  return v_result;
end;
$$;

create or replace function public.cfs_history_item(p_history public.cfs_project_history) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id',p_history.id,'version',p_history.version,'parentVersion',p_history.parent_version,
    'snapshotSha256',p_history.snapshot_sha256,'operation',p_history.operation,'actorUserId',p_history.actor_user_id,
    'actorName',p_history.actor_name,'createdAt',p_history.created_at,'restoredFrom',p_history.restored_from);
$$;

create or replace function public.list_cfs_project_history(p_user_id uuid,p_project_id text,p_limit int default 50,p_before_version bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_limit int:=greatest(1,least(coalesce(p_limit,50),100));
begin
  perform public.cfs_assert_member(p_user_id,array['admin']);
  if not exists(select 1 from public.cfs_projects where id=p_project_id and deleted_at is null) then raise exception 'CFS_PROJECT_NOT_FOUND'; end if;
  select jsonb_build_object('items',coalesce(jsonb_agg(public.cfs_history_item(h) order by h.version desc),'[]'::jsonb),
    'nextBeforeVersion',case when count(*)=v_limit then min(h.version) else null end) into v_result
    from (select h.* from public.cfs_project_history h where h.project_id=p_project_id
      and (p_before_version is null or h.version<p_before_version) order by h.version desc limit v_limit) h;
  return v_result;
end;
$$;

-- Only 13 room business fields and scoped circuits participate in partial-rollback detection.
create or replace function public.cfs_room_projection(p_project jsonb,p_room_id text) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('room',coalesce((select jsonb_object_agg(key,value) from jsonb_each(r)
    where key=any(array['rows','dryContacts','deviceAssignments','hvacAssignments','hvacSeasons','curtainAssignments',
      'cfsRowDisplay','backlightLevels','scenes','roomScenes','switches','pduDeviceCounts','inspectionMarks'])),'{}'::jsonb),
    'circuits',case when jsonb_typeof(r->'circuitIds')='array' then coalesce((select jsonb_agg(c order by ordinality)
      from jsonb_array_elements(coalesce(p_project->'circuits','[]'::jsonb)) with ordinality x(c,ordinality)
      where r->'circuitIds' ? (c->>'id')),'[]'::jsonb) else coalesce(p_project->'circuits','[]'::jsonb) end)
    from jsonb_array_elements(coalesce(p_project->'roomTypes','[]'::jsonb)) r where r->>'id'=p_room_id;
$$;

create or replace function public.cfs_room_restore_candidate(p_head jsonb,p_room_id text,p_revision_id text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare r jsonb; rev jsonb; snap jsonb; k text; restored jsonb; circuits jsonb; remaining jsonb; c jsonb; replacement jsonb;
begin
  select value into r from jsonb_array_elements(p_head->'roomTypes') where value->>'id'=p_room_id;
  if r is null then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  select value into rev from jsonb_array_elements(coalesce(r->'revisions','[]'::jsonb)) where value->>'id'=p_revision_id;
  if rev is null or jsonb_typeof(rev->'snapshot') is distinct from 'string' then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  begin snap:=(rev->>'snapshot')::jsonb; exception when others then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end;
  if jsonb_typeof(snap) is distinct from 'object' then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  restored:=r || jsonb_build_object('revision',rev->'revision');
  foreach k in array array['rows','dryContacts','deviceAssignments','hvacAssignments','hvacSeasons','curtainAssignments',
    'cfsRowDisplay','backlightLevels','scenes','roomScenes','switches','pduDeviceCounts','inspectionMarks'] loop
    -- Existing legacy fields may be absent; preserve current field instead of inventing data.
    if snap ? k and snap->k <> 'null'::jsonb then
      if (k='cfsRowDisplay' and jsonb_typeof(snap->k)<>'object') or
        (k<>'cfsRowDisplay' and jsonb_typeof(snap->k)<>'array') then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
      restored:=jsonb_set(restored,array[k],snap->k);
    end if;
  end loop;
  circuits:=coalesce(p_head->'circuits','[]'::jsonb);
  if snap ? 'circuits' and snap->'circuits'<>'null'::jsonb then
    if jsonb_typeof(snap->'circuits')<>'array' then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
    if exists(select 1 from jsonb_array_elements(snap->'circuits') a where jsonb_typeof(a)<>'object'
      or jsonb_typeof(a->'id') is distinct from 'string' or a->>'id'='')
      or (select count(*)<>count(distinct a->>'id') from jsonb_array_elements(snap->'circuits') a)
      then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
    if jsonb_typeof(r->'circuitIds')='array' then
      -- Refuse a historical scoped ID colliding with a circuit owned by another scope.
      if exists(select 1 from jsonb_array_elements(circuits) a join jsonb_array_elements(snap->'circuits') b on a->'id'=b->'id'
        where not (r->'circuitIds' ? (a->>'id'))) then raise exception 'CFS_RESTORE_REFERENCE_CONFLICT'; end if;
      remaining:=snap->'circuits'; circuits:='[]';
      for c in select value from jsonb_array_elements(coalesce(p_head->'circuits','[]'::jsonb)) loop
        if r->'circuitIds' ? (c->>'id') then
          select value into replacement from jsonb_array_elements(remaining) where value->'id'=c->'id';
          if replacement is not null then circuits:=circuits||jsonb_build_array(replacement); end if;
          select coalesce(jsonb_agg(value),'[]'::jsonb) into remaining from jsonb_array_elements(remaining) where value->'id'<>c->'id';
        else circuits:=circuits||jsonb_build_array(c); end if;
      end loop;
      circuits:=circuits||remaining;
      restored:=jsonb_set(restored,'{circuitIds}',coalesce((select jsonb_agg(value->'id') from jsonb_array_elements(snap->'circuits')),'[]'::jsonb));
    else circuits:=snap->'circuits'; end if;
  end if;
  return p_head || jsonb_build_object('circuits',circuits,'roomTypes',
    (select jsonb_agg(case when value->>'id'=p_room_id then restored else value end order by ordinality)
      from jsonb_array_elements(p_head->'roomTypes') with ordinality));
end;
$$;

create or replace function public.cfs_restore_candidate(p_head jsonb,p_source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare candidate jsonb; snap jsonb; r jsonb; current_room jsonb; rooms jsonb:='[]';
begin
  if jsonb_typeof(p_source) is distinct from 'object' then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  if p_source->>'kind'='room-type-revision' then
    -- The legacy UI derives these missing fields from other settings. Do not invent
    -- replacements in the database; incomplete legacy sources need manual review.
    begin
      select (rev->>'snapshot')::jsonb into snap from jsonb_array_elements(p_head->'roomTypes') room,
        lateral jsonb_array_elements(coalesce(room->'revisions','[]'::jsonb)) rev
        where room->>'id'=p_source->>'roomTypeId' and rev->>'id'=p_source->>'revisionId';
    exception when others then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end;
    if snap is null or not (snap ?& array['dryContacts','curtainAssignments','cfsRowDisplay','backlightLevels'])
      then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
    return public.cfs_room_restore_candidate(p_head,p_source->>'roomTypeId',p_source->>'revisionId');
  elsif p_source->>'kind'='history' then
    select h.snapshot into candidate from public.cfs_project_history h
      where h.project_id=p_head->>'id' and h.id::text=p_source->>'id';
    if candidate is null then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
    if not public.cfs_room_history_valid(candidate) then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
    if exists(select 1 from jsonb_array_elements(p_head->'roomTypes') cur
      where jsonb_array_length(coalesce(cur->'revisions','[]'::jsonb))>0
        and not exists(select 1 from jsonb_array_elements(candidate->'roomTypes') old where old->'id'=cur->'id'))
      then raise exception 'CFS_RESTORE_HISTORY_PROTECTED'; end if;
    for r in select value from jsonb_array_elements(candidate->'roomTypes') loop
      select value into current_room from jsonb_array_elements(p_head->'roomTypes') where value->'id'=r->'id';
      if current_room is not null then r:=r||jsonb_build_object('revisions',coalesce(current_room->'revisions','[]'::jsonb)); end if;
      rooms:=rooms||jsonb_build_array(r);
    end loop;
    candidate:=candidate||jsonb_build_object('roomTypes',rooms);
    if p_head ? 'commonRevisions' then candidate:=candidate||jsonb_build_object('commonRevisions',p_head->'commonRevisions');
    else candidate:=candidate-'commonRevisions'; end if;
    return candidate;
  elsif p_source->>'kind'='common-revision' then
    select value->'snapshot' into snap from jsonb_array_elements(coalesce(p_head->'commonRevisions','[]'::jsonb)) where value->>'id'=p_source->>'id';
    if snap is null or jsonb_typeof(snap) is distinct from 'object' then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
    -- Same references as commonRestoreProblem: circuits, assignments, Scene and Room Scene.
    if exists(select 1 from jsonb_array_elements(coalesce(p_head->'circuits','[]'::jsonb)) c where
      (coalesce(c->>'area','')<>'' and not exists(select 1 from jsonb_array_elements(snap->'locations') l where l->'id'=c->'area'))
      or (exists(select 1 from jsonb_array_elements(p_head->'fixtures') f where f->'fixture'=c->'fixture') and
        not exists(select 1 from jsonb_array_elements(snap->'fixtures') f where f->'fixture'=c->'fixture')))
      or exists(select 1 from jsonb_array_elements(p_head->'roomTypes') rt,
        lateral jsonb_array_elements(coalesce(rt->'deviceAssignments','[]'::jsonb)) a
        where coalesce(a->>'area','')<>'' and not exists(select 1 from jsonb_array_elements(snap->'locations') l where l->'id'=a->'area'))
      or exists(select 1 from jsonb_array_elements(p_head->'roomTypes') rt,
        lateral jsonb_array_elements(coalesce(rt->'scenes','[]'::jsonb)) s
        where not exists(select 1 from jsonb_array_elements(snap->'locations') l where l->'id'=s->'areaId'))
      or exists(select 1 from jsonb_array_elements(p_head->'roomTypes') rt,
        lateral jsonb_array_elements(coalesce(rt->'roomScenes','[]'::jsonb)) rs,
        lateral jsonb_array_elements(coalesce(rs->'areaSceneSelections','[]'::jsonb)) s
        where not exists(select 1 from jsonb_array_elements(snap->'locations') l where l->'id'=s->'areaId'))
      then raise exception 'CFS_RESTORE_REFERENCE_CONFLICT'; end if;
    return (p_head-array['name','settings','remarks','locations','fixtures'])||
      (select jsonb_object_agg(key,value) from jsonb_each(snap) where key=any(array['name','settings','remarks','locations','fixtures']));
  else raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
end;
$$;

create or replace function public.preview_cfs_project_restore(p_user_id uuid,p_project_id text,p_source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare head public.cfs_projects%rowtype;
begin
  perform public.cfs_assert_member(p_user_id,case when p_source->>'kind'='history' then array['admin'] else array['editor','admin'] end);
  select * into head from public.cfs_projects where id=p_project_id and deleted_at is null;
  if not found then raise exception 'CFS_PROJECT_NOT_FOUND'; end if;
  return jsonb_build_object('project',public.cfs_restore_candidate(head.payload,p_source),'restoreSource',p_source,
    'base',jsonb_build_object('version',head.version,'hash',public.cfs_project_hash(head.payload),'updatedAt',head.payload->>'updatedAt'));
end;
$$;

create or replace function public.get_cfs_project_history(p_user_id uuid,p_project_id text,p_history_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare head public.cfs_projects%rowtype; h public.cfs_project_history%rowtype; candidate jsonb; reason text; source jsonb;
begin
  perform public.cfs_assert_member(p_user_id,array['admin']);
  select * into head from public.cfs_projects where id=p_project_id and deleted_at is null;
  if not found then raise exception 'CFS_PROJECT_NOT_FOUND'; end if;
  select * into h from public.cfs_project_history where project_id=p_project_id and id=p_history_id;
  if not found then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  source:=jsonb_build_object('kind','history','id',p_history_id);
  begin candidate:=public.cfs_restore_candidate(head.payload,source);
    exception when others then reason:=SQLERRM; candidate:=null; end;
  return jsonb_build_object('item',public.cfs_history_item(h),'snapshot',h.snapshot,'project',candidate,'restoreSource',source,
    'base',jsonb_build_object('version',head.version,'hash',public.cfs_project_hash(head.payload),'updatedAt',head.payload->>'updatedAt'))
    ||case when reason is null then '{}'::jsonb else jsonb_build_object('restoreBlockedReason',reason) end;
end;
$$;

create or replace function public.cfs_assert_no_rollback(p_head jsonb,p_incoming jsonb,p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h public.cfs_project_history%rowtype; r jsonb; rev jsonb; candidate jsonb; before_projection jsonb; incoming_projection jsonb;
begin
  if public.cfs_rollback_content(p_head)=public.cfs_rollback_content(p_incoming) then return; end if;
  for h in select * from public.cfs_project_history where project_id=p_head->>'id' order by version desc limit 50 loop
    if public.cfs_rollback_content(h.snapshot)=public.cfs_rollback_content(p_incoming)
      and exists(select 1 from public.cfs_project_history intervening where intervening.project_id=h.project_id
        and intervening.version>=h.version and intervening.actor_user_id is distinct from p_user_id)
      then raise exception 'CFS_ROLLBACK_SUSPECTED'; end if;
  end loop;
  select jsonb_object_agg(key,value) into before_projection from jsonb_each(p_head)
    where key=any(array['name','settings','remarks','locations','fixtures']);
  select jsonb_object_agg(key,value) into incoming_projection from jsonb_each(p_incoming)
    where key=any(array['name','settings','remarks','locations','fixtures']);
  if before_projection is distinct from incoming_projection then
    for rev in select value from jsonb_array_elements(coalesce(p_head->'commonRevisions','[]'::jsonb)) loop
      select jsonb_object_agg(key,value) into candidate from jsonb_each(rev->'snapshot')
        where key=any(array['name','settings','remarks','locations','fixtures']);
      if candidate=incoming_projection then raise exception 'CFS_ROLLBACK_SUSPECTED'; end if;
    end loop;
  end if;
  for r in select value from jsonb_array_elements(p_head->'roomTypes') loop
    before_projection:=public.cfs_room_projection(p_head,r->>'id');
    incoming_projection:=public.cfs_room_projection(p_incoming,r->>'id');
    if incoming_projection is null or incoming_projection=before_projection then continue; end if;
    for rev in select value from jsonb_array_elements(coalesce(r->'revisions','[]'::jsonb)) loop
      begin
        candidate:=public.cfs_room_restore_candidate(p_head,r->>'id',rev->>'id');
      exception when sqlstate 'P0001' then
        -- An incomparable historical source must not disable unrelated current
        -- editing. Explicit preview/restore still rejects these same sources.
        if SQLERRM in ('CFS_RESTORE_SOURCE_INVALID','CFS_RESTORE_REFERENCE_CONFLICT') then continue; else raise; end if;
      end;
      if public.cfs_room_projection(candidate,r->>'id')=incoming_projection then
        -- Legacy savedAt/savedBy are editable, not trusted provenance. Conservative
        -- refusal also applies to the original actor until explicit source preview.
        raise exception 'CFS_ROLLBACK_SUSPECTED';
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.save_cfs_project(
  p_state_id text,p_user_id uuid,p_session_id text,p_user_name text,p_project jsonb,p_expected_updated_at text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id text; v_name text; v_existing public.cfs_projects%rowtype; v_version bigint;
  v_create_only boolean:=coalesce(p_expected_updated_at='__CFS_CREATE_ONLY__',false);
  v_restore boolean:=coalesce(p_expected_updated_at='__CFS_RESTORE_FROM_TRASH__',false);
  v_project jsonb; v_time text; v_trash jsonb; v_source jsonb:=nullif(p_project->'_cfsRestoreSource','null'::jsonb); v_operation text;
begin
  if p_project->'_cfsWriteProtocol' is distinct from '2'::jsonb then raise exception 'CFS_SAVE_PROTOCOL_REQUIRED'; end if;
  v_project:=public.cfs_strip_transport(p_project);
  if jsonb_typeof(v_project) is distinct from 'object' then raise exception 'CFS_PROJECT_INVALID'; end if;
  v_id:=nullif(v_project->>'id',''); v_name:=nullif(trim(coalesce(v_project->>'name','')),'');
  if v_id is null or v_id !~ '^[A-Za-z0-9:_-]{1,160}$' or v_name is null then raise exception 'CFS_PROJECT_INVALID'; end if;
  if p_state_id is null or (p_state_id<>'cfs-projects' and p_state_id<>('project:'||v_id)) then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  perform public.cfs_assert_member(p_user_id,array['editor','admin']);
  if v_restore and p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if p_state_id='cfs-projects' then perform pg_advisory_xact_lock(hashtext('cfs-projects')); end if;
  perform pg_advisory_xact_lock(hashtext('cfs-project:'||v_id));
  select * into v_existing from public.cfs_projects where id=v_id for update;
  -- Only genuinely new rows retain the legacy create-without-lease exception.
  if not (v_create_only and v_existing.id is null) then perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id); end if;
  if v_existing.id is not null and v_existing.deleted_at is not null and not v_restore then raise exception 'CFS_PROJECT_RESTORE_REQUIRED'; end if;
  if v_project ? 'lastSaveOperation' and (jsonb_typeof(v_project->'lastSaveOperation') is distinct from 'object'
    or jsonb_typeof(v_project#>'{lastSaveOperation,id}') is distinct from 'string' or coalesce(v_project#>>'{lastSaveOperation,id}','')=''
    or coalesce(v_project#>>'{lastSaveOperation,kind}','') not in ('current','revision','idle')
    or jsonb_typeof(v_project#>'{lastSaveOperation,fingerprint}') is distinct from 'string'
    or coalesce(v_project#>>'{lastSaveOperation,fingerprint}','')='') then raise exception 'CFS_PROJECT_INVALID'; end if;
  -- Preserve existing exact head receipt, after permission/lease/deleted checks but BEFORE stale base.
  if v_existing.id is not null and v_existing.deleted_at is null and v_project ? 'lastSaveOperation'
    and v_existing.payload#>>'{lastSaveOperation,id}'=v_project#>>'{lastSaveOperation,id}' then
    if v_existing.payload->'lastSaveOperation' is distinct from v_project->'lastSaveOperation'
      or public.cfs_save_content(v_existing.payload) is distinct from public.cfs_save_content(v_project)
      then raise exception 'CFS_SAVE_OPERATION_CONFLICT'; end if;
    return jsonb_build_object('saved',true,'projectId',v_id,'version',v_existing.version,'project',v_existing.payload,
      'base',jsonb_build_object('version',v_existing.version,'hash',public.cfs_project_hash(v_existing.payload),'updatedAt',v_existing.payload->>'updatedAt'));
  end if;
  if not public.cfs_common_history_valid(v_project->'commonRevisions')
    or not public.cfs_common_history_valid(v_existing.payload->'commonRevisions') then raise exception 'CFS_COMMON_HISTORY_PROTECTED'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(v_existing.payload->'commonRevisions','[]'::jsonb)) old
    where not exists(select 1 from jsonb_array_elements(coalesce(v_project->'commonRevisions','[]'::jsonb)) incoming where incoming=old))
    then raise exception 'CFS_COMMON_HISTORY_PROTECTED'; end if;
  perform public.cfs_assert_room_history(v_existing.payload,v_project);
  if v_restore then
    if v_existing.id is not null and v_existing.deleted_at is null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
    perform pg_advisory_xact_lock(hashtext('cfs-workspace-trash'));
    select payload into v_trash from public.cfs_workspace_trash where id='cfs-trash' for update;
    if not exists(select 1 from jsonb_array_elements(coalesce(v_trash->'projects','[]'::jsonb)) item
      where item#>>'{project,id}'=v_id and (public.cfs_save_content(item->'project')-'name')=(public.cfs_save_content(v_project)-'name'))
      then raise exception 'CFS_PROJECT_RESTORE_REQUIRED'; end if;
    if v_source is not null then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  elsif v_create_only then
    if v_existing.id is not null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
    if v_source is not null then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  else
    if v_existing.id is null or jsonb_typeof(p_project->'_cfsBaseVersion') is distinct from 'number'
      or p_project->>'_cfsBaseVersion' is distinct from v_existing.version::text
      or jsonb_typeof(p_project->'_cfsBaseHash') is distinct from 'string'
      or p_project->>'_cfsBaseHash' is distinct from public.cfs_project_hash(v_existing.payload)
      or nullif(trim(p_expected_updated_at),'') is null or v_existing.payload->>'updatedAt' is distinct from p_expected_updated_at
      then raise exception 'CFS_STALE_BASE'; end if;
    if v_source is not null then
      if v_source->>'kind'='history' then perform public.cfs_assert_member(p_user_id,array['admin']); end if;
      if public.cfs_save_content(public.cfs_restore_candidate(v_existing.payload,v_source)) is distinct from public.cfs_save_content(v_project)
        then raise exception 'CFS_RESTORE_SOURCE_MISMATCH'; end if;
    else perform public.cfs_assert_no_rollback(v_existing.payload,v_project,p_user_id); end if;
  end if;
  v_operation:=coalesce(p_project->>'_cfsOperation',v_project#>>'{lastSaveOperation,kind}','current');
  if v_operation not in ('current','revision','idle','import','restore','trash-restore') then raise exception 'CFS_PROJECT_INVALID'; end if;
  if v_source is not null then v_operation:='restore'; elsif v_restore then v_operation:='trash-restore';
  elsif v_operation in ('restore','trash-restore') then raise exception 'CFS_RESTORE_SOURCE_INVALID'; end if;
  -- Recheck expiration after advisory/project/trash locks and expensive source/hash checks.
  if not (v_create_only and v_existing.id is null) then perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id); end if;
  v_time:=to_char(greatest(clock_timestamp(),coalesce((v_existing.payload->>'updatedAt')::timestamptz+interval '1 millisecond',clock_timestamp()))
    at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_project:=v_project||jsonb_build_object('updatedAt',v_time,'lastUpdatedBy',jsonb_build_object('userId',p_user_id,'displayName',p_user_name,'updatedAt',v_time));
  perform set_config('cfs.history_operation',v_operation,true);
  perform set_config('cfs.history_restore_source',coalesce(v_source::text,''),true);
  insert into public.cfs_projects(id,name,updated_at,payload,version,deleted_at,last_updated_by_user_id,last_updated_by_name,last_updated_at)
    values(v_id,left(v_name,240),clock_timestamp(),v_project,1,null,p_user_id,left(p_user_name,120),clock_timestamp())
    on conflict(id) do update set name=excluded.name,updated_at=excluded.updated_at,payload=excluded.payload,
      version=public.cfs_projects.version+1,deleted_at=null,last_updated_by_user_id=excluded.last_updated_by_user_id,
      last_updated_by_name=excluded.last_updated_by_name,last_updated_at=excluded.last_updated_at returning version into v_version;
  perform set_config('cfs.history_operation','',true); perform set_config('cfs.history_restore_source','',true);
  insert into public.cfs_revision_events(user_id,user_name,project_count,active_project_ids,operation)
    values(p_user_id,left(p_user_name,120),1,array[v_id],'revision_save');
  return jsonb_build_object('saved',true,'projectId',v_id,'version',v_version,'project',v_project,
    'base',jsonb_build_object('version',v_version,'hash',public.cfs_project_hash(v_project),'updatedAt',v_time));
end;
$$;

-- The existing seven-argument merge already delegates to save and never manufactures bases.
-- Narrow name/delete commands retain their updatedAt CAS because they do not accept a
-- replacement payload. Harden their lease timing and capture their complete OLD row.
create or replace function public.rename_cfs_project(
  p_state_id text,p_user_id uuid,p_session_id text,p_user_name text,
  p_project_id text,p_name text,p_expected_updated_at text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_existing public.cfs_projects%rowtype; v_project jsonb; v_time text;
begin
  if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if p_project_id is null or p_project_id !~ '^[A-Za-z0-9:_-]{1,160}$'
    or nullif(trim(p_name),'') is null or length(trim(p_name))>240 then raise exception 'CFS_PROJECT_INVALID'; end if;
  perform public.cfs_assert_member(p_user_id,array['editor','admin']);
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  perform pg_advisory_xact_lock(hashtext('cfs-project:'||p_project_id));
  select * into v_existing from public.cfs_projects where id=p_project_id for update;
  perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id);
  if v_existing.id is null or v_existing.deleted_at is not null or nullif(trim(p_expected_updated_at),'') is null
    or v_existing.payload->>'updatedAt' is distinct from p_expected_updated_at then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  v_time:=to_char(greatest(clock_timestamp(),(v_existing.payload->>'updatedAt')::timestamptz+interval '1 millisecond')
    at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_project:=v_existing.payload||jsonb_build_object('name',trim(p_name),'updatedAt',v_time,
    'lastUpdatedBy',jsonb_build_object('userId',p_user_id,'displayName',p_user_name,'updatedAt',v_time));
  perform set_config('cfs.history_operation','rename',true); perform set_config('cfs.history_restore_source','',true);
  update public.cfs_projects set name=trim(p_name),payload=v_project,updated_at=clock_timestamp(),version=version+1,
    last_updated_by_user_id=p_user_id,last_updated_by_name=left(p_user_name,120),last_updated_at=clock_timestamp() where id=p_project_id;
  perform set_config('cfs.history_operation','',true);
  insert into public.cfs_revision_events(user_id,user_name,project_count,active_project_ids,operation)
    values(p_user_id,left(p_user_name,120),1,array[p_project_id],'revision_save');
  return jsonb_build_object('ok',true,'project',v_project);
end;
$$;

create or replace function public.delete_cfs_project_to_trash(
  p_state_id text,p_user_id uuid,p_session_id text,p_user_name text,p_project_id text,p_expected_updated_at text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_project public.cfs_projects%rowtype; v_existing public.cfs_workspace_trash%rowtype;
  v_trash jsonb; v_version bigint; v_projects jsonb;
begin
  if p_state_id is distinct from 'cfs-projects' then raise exception 'CFS_LOCK_SCOPE_INVALID'; end if;
  if p_project_id is null or p_project_id !~ '^[A-Za-z0-9:_-]{1,160}$' then raise exception 'CFS_PROJECT_INVALID'; end if;
  if nullif(trim(p_expected_updated_at),'') is null then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  perform public.cfs_assert_member(p_user_id,array['editor','admin']);
  perform pg_advisory_xact_lock(hashtext('cfs-projects'));
  perform pg_advisory_xact_lock(hashtext('cfs-project:'||p_project_id));
  select * into v_project from public.cfs_projects where id=p_project_id for update;
  perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id);
  if v_project.id is null or v_project.deleted_at is not null
    or v_project.payload->>'updatedAt' is distinct from p_expected_updated_at then raise exception 'CFS_PROJECT_CONFLICT'; end if;
  perform pg_advisory_xact_lock(hashtext('cfs-workspace-trash'));
  select * into v_existing from public.cfs_workspace_trash where id='cfs-trash' for update;
  v_trash:=coalesce(v_existing.payload,'{"projects":[],"roomTypes":[]}'::jsonb);
  if jsonb_typeof(v_trash->'projects') is distinct from 'array' or jsonb_typeof(v_trash->'roomTypes') is distinct from 'array'
    then raise exception 'CFS_TRASH_OBJECT_REQUIRED'; end if;
  v_trash:=jsonb_set(v_trash,'{projects}',(v_trash->'projects')||jsonb_build_array(jsonb_build_object(
    'id',gen_random_uuid()::text,'deletedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'project',v_project.payload)));
  if octet_length(v_trash::text)>=10485760 then raise exception 'CFS_TRASH_TOO_LARGE'; end if;
  perform public.cfs_assert_save_lease(p_state_id,p_user_id,p_session_id);
  insert into public.cfs_workspace_trash(id,version,payload,updated_at,updated_by_user_id,updated_by_name)
    values('cfs-trash',1,v_trash,clock_timestamp(),p_user_id,left(coalesce(nullif(trim(p_user_name),''),'CFS user'),120))
    on conflict(id) do update set version=public.cfs_workspace_trash.version+1,payload=excluded.payload,
      updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id,updated_by_name=excluded.updated_by_name returning version into v_version;
  perform set_config('cfs.history_operation','delete',true); perform set_config('cfs.history_restore_source','',true);
  update public.cfs_projects set deleted_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1,
    last_updated_by_user_id=p_user_id,last_updated_by_name=left(coalesce(nullif(trim(p_user_name),''),'CFS user'),120),
    last_updated_at=clock_timestamp() where id=p_project_id;
  perform set_config('cfs.history_operation','',true);
  insert into public.cfs_revision_events(user_id,user_name,project_count,active_project_ids,operation)
    values(p_user_id,left(coalesce(nullif(trim(p_user_name),''),'CFS user'),120),1,array[p_project_id],'trash_save');
  select coalesce(jsonb_agg(payload order by updated_at desc,id),'[]'::jsonb) into v_projects from public.cfs_projects where deleted_at is null;
  return jsonb_build_object('ok',true,'projects',v_projects,'trash',v_trash,'updatedAt',v_version::text);
end;
$$;

-- Helpers are owner-only. Public entry points are server-only, never browser RPCs.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array['cfs_strip_transport','cfs_project_hash','cfs_save_content',
      'cfs_rollback_content','cfs_assert_member','cfs_assert_save_lease','cfs_room_history_valid','cfs_assert_room_history',
      'cfs_prune_project_history','cfs_capture_project_history','cfs_history_item','cfs_room_projection',
      'cfs_room_restore_candidate','cfs_restore_candidate','cfs_assert_no_rollback','read_cfs_projects',
      'list_cfs_project_history','get_cfs_project_history','preview_cfs_project_restore','save_cfs_project']) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.signature);
  end loop;
end $$;
grant execute on function public.read_cfs_projects(uuid),public.list_cfs_project_history(uuid,text,int,bigint),
  public.get_cfs_project_history(uuid,text,uuid),public.preview_cfs_project_restore(uuid,text,jsonb),
  public.save_cfs_project(text,uuid,text,text,jsonb,text) to service_role;
grant execute on function public.merge_cfs_projects(text,uuid,text,text,jsonb,jsonb,jsonb),
  public.rename_cfs_project(text,uuid,text,text,text,text,text),
  public.delete_cfs_project_to_trash(text,uuid,text,text,text,text) to service_role;
-- Restore the existing CAS Trash entry point after emergency-write-stop.sql.
grant execute on function public.save_cfs_workspace_trash(text,uuid,text,text,jsonb,text) to service_role;
-- Preserve prior 20260910210000 revocation; service_role bypasses RLS.
revoke insert,update,delete,truncate,references,trigger on public.cfs_projects,public.cfs_workspace_trash from public,anon,authenticated,service_role;
grant select on public.cfs_projects,public.cfs_workspace_trash to service_role;
commit;
