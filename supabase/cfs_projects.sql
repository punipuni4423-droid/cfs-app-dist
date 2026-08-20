create table if not exists public.cfs_projects (
  id text primary key,
  name text not null,
  updated_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.cfs_projects enable row level security;

create index if not exists cfs_projects_updated_at_idx
  on public.cfs_projects (updated_at desc);

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.cfs_projects to service_role;
