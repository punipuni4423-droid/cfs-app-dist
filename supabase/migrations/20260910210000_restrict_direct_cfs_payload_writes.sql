-- Require guarded save RPCs for writes to the business payload tables.
-- Requires 20260909120000, 20260909130000 and 20260910160000 first.
-- Limit this migration to the named payload tables; preserve other applications.
do $$ begin
  if current_user <> 'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.merge_cfs_projects(text,uuid,text,text,jsonb,jsonb,jsonb)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
  if position('CFS_SAVE_PROTOCOL_REQUIRED' in pg_get_functiondef('public.save_cfs_project(text,uuid,text,text,jsonb,text)'::regprocedure))=0
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
  if exists(select 1 from pg_attribute where attrelid in ('public.cfs_projects'::regclass,'public.cfs_workspace_trash'::regclass) and attacl is not null)
    then raise exception 'CFS_DEPLOY_COLUMN_GRANTS_CHANGED'; end if;
end $$;

revoke all privileges on table public.cfs_projects, public.cfs_workspace_trash from service_role;
grant select on table public.cfs_projects, public.cfs_workspace_trash to service_role;

do $$ declare v_table regclass; begin
  foreach v_table in array array['public.cfs_projects'::regclass,'public.cfs_workspace_trash'::regclass] loop
    if (select pg_get_userbyid(relowner) from pg_class where oid=v_table)<>'postgres'
      or not has_table_privilege('service_role',v_table,'SELECT')
      or has_table_privilege('service_role',v_table,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('service_role',v_table,'INSERT,UPDATE,REFERENCES')
      then raise exception 'CFS_DEPLOY_DIRECT_WRITER_NOT_BLOCKED'; end if;
  end loop;
end $$;
-- CFS membership/lock/event ACLs, other apps and all credentials remain unchanged.
