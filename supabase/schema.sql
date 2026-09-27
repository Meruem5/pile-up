-- Runway schema. Paste into Supabase → SQL Editor and run once.
--
-- Security model: the publishable key in index.html is public by design, so
-- row-level security is the only thing between the internet and this data.
-- Every table has RLS on, and every policy goes through is_member(), which
-- checks the signed-in user's verified email against household_members.
-- Anyone can request a magic link and get a Supabase account; without a
-- household_members row they can read and write nothing.
--
-- Household membership, and any starting data, are NOT in this file (the
-- repo is public). Add them in the SQL editor — see README.md.

create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  email        text not null check (email = lower(email)),
  primary key (household_id, email)
);

create table if not exists public.assumptions (
  household_id uuid primary key references public.households(id) on delete cascade,
  capacity     numeric(14,2) not null default 0 check (capacity >= 0),
  liquid       numeric(14,2) not null default 0 check (liquid >= 0),
  return_pct   numeric(5,2)  not null default 5 check (return_pct between 0 and 20),
  fx           numeric(10,2) not null default 318 check (fx > 0),
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create table if not exists public.goals (
  household_id  uuid not null references public.households(id) on delete cascade,
  id            text not null check (id ~ '^[a-z0-9-]{1,64}$'),
  color         text not null check (color in ('blue','orange','orchid','aqua','rust','yellow','wine','indigo','magenta','green','violet','red')),
  name          text not null check (char_length(name) between 1 and 120),
  type          text not null check (type in ('purchase','reserve')),
  floor         boolean not null default false,
  target_amount numeric(14,2) not null default 0 check (target_amount >= 0),
  already_saved numeric(14,2) not null default 0 check (already_saved >= 0),
  target_date   date not null,
  notes         text not null default '' check (char_length(notes) <= 2000),
  updated_at    timestamptz not null default now(),
  updated_by    text,
  primary key (household_id, id)
);

-- security definer so the membership lookup isn't itself blocked by RLS.
create or replace function public.is_member(hh uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hh
      and m.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_member(uuid) from public;
grant execute on function public.is_member(uuid) to authenticated;

-- Stamp who changed what and when, server-side (clients can't fake it).
create or replace function public.stamp_update()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := lower(auth.jwt() ->> 'email');
  return new;
end;
$$;
drop trigger if exists goals_stamp on public.goals;
create trigger goals_stamp before insert or update on public.goals
  for each row execute function public.stamp_update();
drop trigger if exists assumptions_stamp on public.assumptions;
create trigger assumptions_stamp before insert or update on public.assumptions
  for each row execute function public.stamp_update();

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.assumptions       enable row level security;
alter table public.goals             enable row level security;

-- Nobody but the SQL editor (service role) creates households or members.
revoke all on public.households, public.household_members, public.assumptions, public.goals from anon;

drop policy if exists "members read household" on public.households;
create policy "members read household" on public.households
  for select to authenticated using (public.is_member(id));

drop policy if exists "read own membership" on public.household_members;
create policy "read own membership" on public.household_members
  for select to authenticated using (public.is_member(household_id));

drop policy if exists "members read assumptions" on public.assumptions;
create policy "members read assumptions" on public.assumptions
  for select to authenticated using (public.is_member(household_id));
drop policy if exists "members update assumptions" on public.assumptions;
create policy "members update assumptions" on public.assumptions
  for update to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

drop policy if exists "members read goals" on public.goals;
create policy "members read goals" on public.goals
  for select to authenticated using (public.is_member(household_id));
drop policy if exists "members insert goals" on public.goals;
create policy "members insert goals" on public.goals
  for insert to authenticated with check (public.is_member(household_id));
drop policy if exists "members update goals" on public.goals;
create policy "members update goals" on public.goals
  for update to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists "members delete goals" on public.goals;
create policy "members delete goals" on public.goals
  for delete to authenticated using (public.is_member(household_id));

-- Live updates when the other person edits. Realtime respects the RLS above.
do $$ begin
  alter publication supabase_realtime add table public.goals, public.assumptions;
exception when duplicate_object then null;
end $$;
