-- Runway migration 002: people, goal ownership, status, shared-goal splits.
-- Run once in Supabase → SQL Editor, AFTER schema.sql (and after your seed,
-- if you've run it). Safe to run again. Run it BEFORE merging the app change
-- that needs it: the new page reads these columns and won't load without them.
--
-- Everything is in USD. assumptions.capacity and assumptions.fx are no longer
-- read by the app (capacity is now per person); they're left in place so the
-- previous version of the page keeps working until the new one is deployed.

-- ---------- People ----------
alter table public.household_members
  add column if not exists id           uuid not null default gen_random_uuid(),
  add column if not exists display_name text,
  add column if not exists capacity     numeric(14,2) not null default 0;

do $$ begin
  alter table public.household_members add constraint household_members_id_key unique (id);
exception when duplicate_table or duplicate_object then null; end $$;
do $$ begin
  alter table public.household_members add constraint household_members_hh_id_key unique (household_id, id);
exception when duplicate_table or duplicate_object then null; end $$;
do $$ begin
  alter table public.household_members add constraint household_members_capacity_check check (capacity >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.household_members add constraint household_members_display_name_check
    check (display_name is null or char_length(display_name) between 1 and 40);
exception when duplicate_object then null; end $$;

-- Each person sets their own name and capacity — nobody else's, and nothing else.
revoke update on public.household_members from authenticated;
grant update (display_name, capacity) on public.household_members to authenticated;
drop policy if exists "update own member row" on public.household_members;
create policy "update own member row" on public.household_members
  for update to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- ---------- Household default split ----------
alter table public.households
  add column if not exists split_rule text not null default 'equal';
do $$ begin
  alter table public.households add constraint households_split_rule_check check (split_rule in ('equal','capacity'));
exception when duplicate_object then null; end $$;

revoke update on public.households from authenticated;
grant update (split_rule) on public.households to authenticated;
drop policy if exists "members update split rule" on public.households;
create policy "members update split rule" on public.households
  for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

-- ---------- Goals: owner, status, split ----------
-- owner null = shared goal. visibility is used by the privacy change (PR B);
-- until then every goal is 'shared' and RLS is unchanged.
alter table public.goals
  add column if not exists owner        uuid,
  add column if not exists status       text not null default 'active',
  add column if not exists split_mode   text not null default 'default',
  add column if not exists split_member uuid,
  add column if not exists split_pct    numeric(5,2),
  add column if not exists visibility   text not null default 'shared';

do $$ begin
  alter table public.goals add constraint goals_status_check check (status in ('active','paused','done'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.goals add constraint goals_split_mode_check check (split_mode in ('default','equal','capacity','custom'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.goals add constraint goals_split_pct_check check (split_pct is null or split_pct between 0 and 100);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.goals add constraint goals_visibility_check check (visibility in ('shared','private'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.goals add constraint goals_private_needs_owner check (visibility = 'shared' or owner is not null);
exception when duplicate_object then null; end $$;
-- Owner and split member must belong to the goal's own household.
do $$ begin
  alter table public.goals add constraint goals_owner_fkey foreign key (household_id, owner)
    references public.household_members (household_id, id) on delete set null (owner);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.goals add constraint goals_split_member_fkey foreign key (household_id, split_member)
    references public.household_members (household_id, id) on delete set null (split_member);
exception when duplicate_object then null; end $$;

-- ---------- Live updates for the new shared state ----------
do $$ begin
  alter publication supabase_realtime add table public.household_members;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.households;
exception when duplicate_object then null; end $$;
