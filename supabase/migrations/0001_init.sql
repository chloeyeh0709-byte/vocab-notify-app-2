-- WordVault — schema for the push-notification backend
--
-- Design notes (see README.md for the full setup walkthrough):
--   * The browser app keeps every word/folder in IndexedDB and works fully
--     offline — that data never needs to live here.
--   * The only thing the server needs is a lightweight mirror of "when is each
--     word next due", so a scheduled job can decide when to send a push.
--   * Each device authenticates anonymously via Supabase Auth (no email/password
--     signup), which gives us a real `auth.uid()` to scope Row Level Security
--     with — important since the anon key ships inside public client code.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ── push_subscriptions ───────────────────────────────────────────────
-- One Web Push subscription per anonymous user (i.e. per device that enabled
-- notifications). `subscription` stores the PushSubscription JSON exactly as
-- the browser returns it (endpoint + p256dh/auth keys).
create table if not exists public.push_subscriptions (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  subscription jsonb not null,
  updated_at   timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "users manage their own push subscription"
  on public.push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── word_schedule ────────────────────────────────────────────────────
-- A trimmed-down mirror of each active word: just enough for the cron job to
-- compose a notification and know when to send it. `last_notified_for` records
-- which `next_review` value we already pushed about, so the client can safely
-- re-sync the same row many times without ever triggering a duplicate push —
-- only a genuine change to `next_review` (a new due time) will look "unsent".
create table if not exists public.word_schedule (
  id                text primary key,                              -- same id as the word in IndexedDB (w_...)
  user_id           uuid not null references auth.users (id) on delete cascade,
  english           text not null,
  chinese           text not null,
  stage             int not null default 0,
  next_review       timestamptz,                                   -- null once every stage is completed
  last_notified_for timestamptz,                                   -- next_review value we last sent a push for
  updated_at        timestamptz not null default now()
);

create index if not exists word_schedule_due_idx
  on public.word_schedule (next_review)
  where next_review is not null;

alter table public.word_schedule enable row level security;

create policy "users manage their own word schedule"
  on public.word_schedule
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Realtime / housekeeping ──────────────────────────────────────────
-- Nothing else to do here — the actual "check every minute and push" job is
-- registered via `cron.schedule(...)` from the SQL editor (README step 6),
-- not from this migration, because it needs your project's URL and a secret
-- that shouldn't be committed to a public repo.
