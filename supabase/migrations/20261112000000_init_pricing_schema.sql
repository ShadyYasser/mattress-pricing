-- Mattress pricing: schema, RLS and RPCs.
-- Roles: owner (edits everything) and viewer (reads the computed sale price list only).

-- Members: who can use the site and with which role.
create table public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null check (role in ('owner','viewer')),
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);

-- Full pricing data (components, mattresses, settings). Owner only.
create table public.pricing_state (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  rev int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Computed sale/offer price list (no costs). Owner writes, members read.
create table public.price_list (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.members enable row level security;
alter table public.pricing_state enable row level security;
alter table public.price_list enable row level security;

create or replace function public.my_role()
returns text
language sql stable security definer set search_path = ''
as $$ select role from public.members where user_id = auth.uid() $$;

revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;

-- members: see own row; owner sees all. Writes only through RPCs below.
create policy members_select on public.members for select to authenticated
  using (user_id = (select auth.uid()) or (select public.my_role()) = 'owner');

create policy state_select on public.pricing_state for select to authenticated
  using ((select public.my_role()) = 'owner');
create policy state_insert on public.pricing_state for insert to authenticated
  with check ((select public.my_role()) = 'owner');
create policy state_update on public.pricing_state for update to authenticated
  using ((select public.my_role()) = 'owner') with check ((select public.my_role()) = 'owner');

create policy list_select on public.price_list for select to authenticated
  using ((select public.my_role()) in ('owner','viewer'));
create policy list_insert on public.price_list for insert to authenticated
  with check ((select public.my_role()) = 'owner');
create policy list_update on public.price_list for update to authenticated
  using ((select public.my_role()) = 'owner') with check ((select public.my_role()) = 'owner');

revoke all on public.members, public.pricing_state, public.price_list from anon;
revoke insert, update, delete on public.members from authenticated;
grant select on public.members to authenticated;
grant select, insert, update on public.pricing_state, public.price_list to authenticated;

-- Internal helper: create a confirmed email/password user.
create or replace function public._create_auth_user(p_email text, p_password text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := gen_random_uuid(); e text := lower(trim(p_email));
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  if length(p_password) < 8 then raise exception 'weak_password'; end if;
  if exists (select 1 from auth.users where lower(email) = e) then raise exception 'email_exists'; end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true),
    'email', uid::text, now(), now(), now());
  return uid;
end $$;
revoke all on function public._create_auth_user(text, text) from public, anon, authenticated;

-- Owner adds a viewer (sees sale prices only).
create or replace function public.create_viewer(p_email text, p_password text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare uid uuid;
begin
  if public.my_role() is distinct from 'owner' then raise exception 'not_owner'; end if;
  uid := public._create_auth_user(p_email, p_password);
  insert into public.members (user_id, email, role, must_change_password) values (uid, lower(trim(p_email)), 'viewer', true);
  return uid;
end $$;

-- Owner removes a viewer.
create or replace function public.delete_member(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if public.my_role() is distinct from 'owner' then raise exception 'not_owner'; end if;
  if p_user_id = auth.uid() then raise exception 'cannot_delete_self'; end if;
  if (select role from public.members where user_id = p_user_id) is distinct from 'viewer' then raise exception 'not_viewer'; end if;
  delete from auth.users where id = p_user_id;
end $$;

-- Owner resets a viewer's password.
create or replace function public.reset_member_password(p_user_id uuid, p_password text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if public.my_role() is distinct from 'owner' then raise exception 'not_owner'; end if;
  if (select role from public.members where user_id = p_user_id) is distinct from 'viewer' then raise exception 'not_viewer'; end if;
  if length(p_password) < 8 then raise exception 'weak_password'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_user_id;
  update public.members set must_change_password = true where user_id = p_user_id;
end $$;

-- Called by a user after changing their own password.
create or replace function public.password_changed()
returns void
language sql security definer set search_path = ''
as $$ update public.members set must_change_password = false where user_id = auth.uid() $$;

revoke all on function public.create_viewer(text, text), public.delete_member(uuid),
  public.reset_member_password(uuid, text), public.password_changed() from public, anon;
grant execute on function public.create_viewer(text, text), public.delete_member(uuid),
  public.reset_member_password(uuid, text), public.password_changed() to authenticated;

-- Keeps the free project from pausing (called by a scheduled GitHub Action).
create or replace function public.keepalive()
returns int language sql stable set search_path = '' as $$ select 1 $$;
revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;
