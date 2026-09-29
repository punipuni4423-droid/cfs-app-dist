-- Avoid PostgREST's scalar JSON extraction for large project responses.
-- Existing RPCs remain authoritative and available to existing callers.
begin;

do $$ begin
  if current_user<>'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.read_cfs_projects(uuid)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create function public.read_cfs_projects_rows(p_user_id uuid) returns setof jsonb
language plpgsql volatile security invoker set search_path = public as $$
begin
  return next public.read_cfs_projects(p_user_id);
  return;
end;
$$;

revoke all on function public.read_cfs_projects_rows(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_cfs_projects_rows(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
