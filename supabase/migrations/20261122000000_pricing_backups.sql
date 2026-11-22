-- Snapshots of pricing_state taken before bulk changes (owner can read them).
create table public.pricing_backups (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  note text,
  data jsonb not null
);
alter table public.pricing_backups enable row level security;
revoke all on public.pricing_backups from anon;
grant select on public.pricing_backups to authenticated;
create policy backups_select on public.pricing_backups for select to authenticated
  using ((select public.my_role()) = 'owner');
