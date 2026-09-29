-- Build rollback comparison content without copying revision history first.
-- Preserve all business keys, array order, and the legacy malformed-input behavior.
-- No data, permissions, timeout, or save protocol changes.
begin;

do $$ begin
  if current_user<>'postgres' then raise exception 'CFS_DEPLOY_EXPECTS_POSTGRES_OWNER'; end if;
  if to_regprocedure('public.cfs_rollback_content(jsonb)') is null
    or to_regprocedure('public.cfs_save_content(jsonb)') is null
    then raise exception 'CFS_DEPLOY_SAVE_CONTRACT_REQUIRED'; end if;
end $$;

create or replace function public.cfs_rollback_content(p_project jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(p_project)='object' and jsonb_typeof(p_project->'roomTypes')='array' then
      (p_project - array['_cfsWriteProtocol','_cfsBaseVersion','_cfsBaseHash','_cfsOperation','_cfsRestoreSource',
                         'updatedAt','lastUpdatedBy','lastSaveOperation','commonRevisions','roomTypes']) ||
      jsonb_build_object('roomTypes',coalesce((
        select jsonb_agg(case when jsonb_typeof(value)='object'
          then value - array['updatedAt','revisions','revision']
          else value - 'updatedAt' - 'revisions' - 'revision' end order by ordinality)
        from jsonb_array_elements(p_project->'roomTypes') with ordinality
      ),'[]'::jsonb))
    else
      (public.cfs_save_content(p_project) - 'commonRevisions') ||
      case when jsonb_typeof(p_project->'roomTypes') = 'array' then jsonb_build_object('roomTypes',
        coalesce((select jsonb_agg(value - 'updatedAt' - 'revisions' - 'revision' order by ordinality)
          from jsonb_array_elements(p_project->'roomTypes') with ordinality), '[]'::jsonb)) else '{}'::jsonb end
    end;
$$;

commit;
