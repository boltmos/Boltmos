-- Run in the Supabase SQL Editor.

-- 1. Fix conversation_history: user_id currently references auth.users(id),
--    but no real auth accounts exist yet (TEST_USER_ID is a placeholder),
--    so every insert has been silently failing since it was added. Drop the
--    FK for now; re-add it once real Supabase Auth accounts replace
--    TEST_USER_ID in backend/main.py.
alter table public.conversation_history
  drop constraint conversation_history_user_id_fkey;

-- 2. New table: one profile per user, collected once via the onboarding
--    form and used to skip that form on every later launch.
create table public.user_profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  name text not null,
  primary_goal text not null,
  created_at timestamptz not null default now()
);

alter table public.user_profile enable row level security;

create policy "Users can view their own profile"
  on public.user_profile
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own profile"
  on public.user_profile
  for insert
  with check (auth.uid() = user_id);
