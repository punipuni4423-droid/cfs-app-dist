-- Master-only stop for subsequent service_role project/history/Trash body RPC writes.
-- Drain in-flight writes before taking a stable backup; this does not cancel them.
-- Read/preview, auth/membership/lease APIs and owner maintenance remain available.
begin;
revoke execute on function public.save_cfs_project(text,uuid,text,text,jsonb,text),
 public.merge_cfs_projects(text,uuid,text,text,jsonb,jsonb,jsonb),
 public.rename_cfs_project(text,uuid,text,text,text,text,text),
 public.delete_cfs_project_to_trash(text,uuid,text,text,text,text),
 public.save_cfs_workspace_trash(text,uuid,text,text,jsonb,text)
 from service_role;
commit;
