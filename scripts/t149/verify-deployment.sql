-- Read-only post-deployment inspection; do not print customer payloads/names.
select current_setting('server_version') as postgres_version;
select relname,relrowsecurity,pg_get_userbyid(relowner) as owner
 from pg_class where oid in ('public.cfs_projects'::regclass,'public.cfs_project_history'::regclass);
select role_name,table_name,has_table_privilege(role_name,'public.'||table_name,'INSERT,UPDATE,DELETE,TRUNCATE') as direct_write
 from unnest(array['anon','authenticated','service_role']) role_name
 cross join unnest(array['cfs_projects','cfs_workspace_trash','cfs_project_history']) table_name;
-- Exactly five rows. service_execute: true after deployment/recovery, false after stop.
-- exists/signature and anon/authenticated=false must hold in both states.
select signature,to_regprocedure(signature) is not null as function_exists,
 has_function_privilege('service_role',to_regprocedure(signature),'EXECUTE') as service_execute,
 has_function_privilege('anon',to_regprocedure(signature),'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',to_regprocedure(signature),'EXECUTE') as authenticated_execute
 from unnest(array[
 'public.save_cfs_project(text,uuid,text,text,jsonb,text)',
 'public.merge_cfs_projects(text,uuid,text,text,jsonb,jsonb,jsonb)',
 'public.rename_cfs_project(text,uuid,text,text,text,text,text)',
 'public.delete_cfs_project_to_trash(text,uuid,text,text,text,text)',
 'public.save_cfs_workspace_trash(text,uuid,text,text,jsonb,text)']) signature;
-- Inventory every overload. Legacy set5/merge6/trash5 remain exception-only stubs;
-- their EXECUTE ACL alone does not demonstrate that they can mutate data.
select proname,pg_get_function_identity_arguments(oid) as arguments,prosecdef as security_definer,
 has_function_privilege('service_role',oid,'EXECUTE') as service_execute,
 has_function_privilege('anon',oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',oid,'EXECUTE') as authenticated_execute
 from pg_proc where pronamespace='public'::regnamespace and proname in
 ('save_cfs_project','save_cfs_project_set','merge_cfs_projects','rename_cfs_project','delete_cfs_project_to_trash',
  'save_cfs_workspace_trash','read_cfs_projects','list_cfs_project_history','get_cfs_project_history','preview_cfs_project_restore',
  'cfs_capture_project_history','cfs_prune_project_history')
 order by proname,pg_get_function_identity_arguments(oid);
select tgname,tgenabled from pg_trigger where tgrelid='public.cfs_projects'::regclass and not tgisinternal;
select count(*) as history_rows,count(*) filter(where snapshot_sha256<>public.cfs_project_hash(snapshot)) as hash_mismatches
 from public.cfs_project_history;
select count(*) as retained_rows_older_90_days from public.cfs_project_history where created_at<clock_timestamp()-interval '90 days';
