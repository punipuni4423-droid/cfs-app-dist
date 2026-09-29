-- Return project records without building a second full JSONB project collection.
-- Edge preserves the existing projects/bases response and rejects partial results.
begin;

do $$ begin
  if current_user <> 'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.cfs_assert_member(uuid,text[])') is null
    or to_regprocedure('public.cfs_project_hash(jsonb)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create function public.read_cfs_project_records(p_user_id uuid)
returns table(project_id text,payload jsonb,version bigint,payload_hash text,payload_updated_at text,
  row_position bigint,total_count bigint)
language plpgsql volatile security definer set search_path=public as $$
begin
  perform public.cfs_assert_member(p_user_id,array['viewer','editor','admin']);
  return query select p.id,p.payload,p.version,public.cfs_project_hash(p.payload),p.payload->>'updatedAt',
    row_number() over (order by p.updated_at desc,p.id),count(*) over ()
    from public.cfs_projects p where p.deleted_at is null order by p.updated_at desc,p.id;
end;
$$;
revoke all on function public.read_cfs_project_records(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_cfs_project_records(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
