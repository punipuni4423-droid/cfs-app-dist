-- Cache revision lookups after validating IDs; preserve exact snapshot strings.
-- Equivalent to the reviewed private candidate; no permission or data changes.
begin;

do $$ begin
  if current_user<>'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.cfs_room_history_valid(jsonb)') is null
    or to_regprocedure('public.cfs_assert_room_history(jsonb,jsonb)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create or replace function public.cfs_assert_room_history(p_old jsonb,p_new jsonb) returns void
language plpgsql immutable set search_path = public as $$
declare r jsonb; incoming_rooms jsonb; incoming_revisions jsonb; rev jsonb;
begin
  if not public.cfs_room_history_valid(p_old) or not public.cfs_room_history_valid(p_new)
    then raise exception 'CFS_ROOM_HISTORY_PROTECTED'; end if;
  select coalesce(jsonb_object_agg(value->>'id',coalesce(value->'revisions','[]'::jsonb)),'{}'::jsonb)
    into incoming_rooms from jsonb_array_elements(p_new->'roomTypes');
  for r in select value from jsonb_array_elements(coalesce(p_old->'roomTypes','[]'::jsonb)) loop
    select coalesce(jsonb_object_agg(value->>'id',value->'snapshot'),'{}'::jsonb)
      into incoming_revisions from jsonb_array_elements(coalesce(incoming_rooms->(r->>'id'),'[]'::jsonb));
    for rev in select value from jsonb_array_elements(coalesce(r->'revisions','[]'::jsonb)) loop
      if incoming_revisions->(rev->>'id') is distinct from rev->'snapshot'
        then raise exception 'CFS_ROOM_HISTORY_PROTECTED'; end if;
    end loop;
  end loop;
end;
$$;

commit;
