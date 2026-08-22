-- Run in the Supabase SQL Editor (after supabase_onboarding.sql).

create table if not exists public.user_daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  date date not null,
  tokens_used integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

-- Migration: this table used to track messages_sent (a raw message count).
-- Replaced with tokens_used (total Groq prompt+completion tokens per day)
-- for a usage metric that actually reflects API cost. Safe to re-run against
-- a table already created by the block above (both guards are no-ops then).
alter table public.user_daily_usage
  add column if not exists tokens_used integer not null default 0;

alter table public.user_daily_usage
  drop column if exists messages_sent;

alter table public.user_daily_usage enable row level security;

create policy "Users can view their own daily usage"
  on public.user_daily_usage
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own daily usage"
  on public.user_daily_usage
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own daily usage"
  on public.user_daily_usage
  for update
  using (auth.uid() = user_id);
