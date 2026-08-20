-- CFS admin force release for stuck edit locks (e.g. a lock held by a closed or
-- unreachable session on another machine). Admin gating happens in the cfs-api
-- Edge Function; this RPC stays service_role-only like the other lock RPCs.
-- Apply only after a JSON/API backup is recorded and the hosted Supabase change is approved.

create or replace function public.force_release_cfs_edit_lock(
  p_state_id text,
  p_user_id uuid,
  p_session_id text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_state_id !~ '^[A-Za-z0-9:_-]{1,160}$' or p_session_id !~ '^[A-Za-z0-9:_-]{1,160}$' then
    raise exception 'CFS_LOCK_INPUT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtext('cfs-project-locks'));
  -- Compare-and-delete against the caller's read snapshot: only the exact lock
  -- the admin saw is removed. If it expired and another user legitimately
  -- re-acquired the scope in the meantime, this deletes nothing.
  delete from public.cfs_edit_locks
    where state_id = p_state_id and user_id = p_user_id and session_id = p_session_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.force_release_cfs_edit_lock(text, uuid, text) from public, anon, authenticated;
grant execute on function public.force_release_cfs_edit_lock(text, uuid, text) to service_role;
