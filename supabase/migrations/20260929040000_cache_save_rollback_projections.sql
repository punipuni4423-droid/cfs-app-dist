-- Reduce repeated expansion of large RoomType revision histories during saves.
-- Changes function implementation only: no data, grants, timeouts or save contract changes.
begin;
do $$ begin
  if current_user<>'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.cfs_rollback_content(jsonb)') is null
    or to_regprocedure('public.cfs_assert_no_rollback(jsonb,jsonb,uuid)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create or replace function public.cfs_assert_no_rollback(p_head jsonb,p_incoming jsonb,p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h public.cfs_project_history%rowtype; r jsonb; rev jsonb; candidate jsonb; before_projection jsonb; incoming_projection jsonb; head_content jsonb; incoming_content jsonb;
begin
  -- Build the history-free comparison payloads once. Room projections use only
  -- business fields/circuits; revision snapshots remain protected and available
  -- in the original payloads for the historical-source checks below.
  head_content:=public.cfs_rollback_content(p_head);
  incoming_content:=public.cfs_rollback_content(p_incoming);
  if head_content=incoming_content then return; end if;
  for h in select * from public.cfs_project_history where project_id=p_head->>'id' order by version desc limit 50 loop
    if public.cfs_rollback_content(h.snapshot)=incoming_content
      and exists(select 1 from public.cfs_project_history intervening where intervening.project_id=h.project_id
        and intervening.version>=h.version and intervening.actor_user_id is distinct from p_user_id)
      then raise exception 'CFS_ROLLBACK_SUSPECTED'; end if;
  end loop;
  select jsonb_object_agg(key,value) into before_projection from jsonb_each(head_content)
    where key=any(array['name','settings','remarks','locations','fixtures']);
  select jsonb_object_agg(key,value) into incoming_projection from jsonb_each(incoming_content)
    where key=any(array['name','settings','remarks','locations','fixtures']);
  if before_projection is distinct from incoming_projection then
    for rev in select value from jsonb_array_elements(coalesce(p_head->'commonRevisions','[]'::jsonb)) loop
      select jsonb_object_agg(key,value) into candidate from jsonb_each(rev->'snapshot')
        where key=any(array['name','settings','remarks','locations','fixtures']);
      if candidate=incoming_projection then raise exception 'CFS_ROLLBACK_SUSPECTED'; end if;
    end loop;
  end if;
  for r in select value from jsonb_array_elements(p_head->'roomTypes') loop
    before_projection:=public.cfs_room_projection(head_content,r->>'id');
    incoming_projection:=public.cfs_room_projection(incoming_content,r->>'id');
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

commit;

