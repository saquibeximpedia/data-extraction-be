-- Run once in the Supabase SQL editor (safe to run again).
-- Only the service role reads and writes these tables (the extraction service, and the web app's
-- server routes): row level security is on with no policies, so the browser's anon key cannot touch them.

create table if not exists runs (
  id uuid primary key,
  trigger text not null,
  status text not null,
  params jsonb not null default '{}',
  stats jsonb not null,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists runs_started_at_idx on runs (started_at desc);

-- One row per country.
-- kind 'api':    the extraction service has an extractor for it; `extractor` is what the service
--                publishes about it on start-up, `data` holds admins' overrides (name, links, lag...)
-- kind 'manual': a download-only country added by an admin; `data` holds all of it
create table if not exists country_config (
  code text primary key,
  kind text not null check (kind in ('api', 'manual')),
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table country_config add column if not exists extractor jsonb;
alter table country_config add column if not exists extractor_synced_at timestamptz;

-- 'extracting' once an extraction starts for the month, 'completed' when a user marks it
create table if not exists month_status (
  country_code text not null,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status text not null check (status in ('extracting', 'completed')),
  marked_by text not null,
  marked_at timestamptz not null default now(),
  primary key (country_code, period)
);

-- Links anyone can open to download chosen files (/s/<id> in the web app), optionally behind a password.
-- id is the random token in the link; files is a snapshot [{ path, name, size }] taken when the link is made.
create table if not exists file_shares (
  id text primary key,
  title text,
  files jsonb not null,
  password_hash text,
  expires_at timestamptz,
  download_count integer not null default 0,
  last_download_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists file_shares_created_at_idx on file_shares (created_at desc);

-- Who uploaded each stored file (Storage itself doesn't keep it), keyed by its bucket path
create table if not exists file_meta (
  path text primary key,
  uploaded_by text,
  updated_at timestamptz not null default now()
);
alter table file_meta drop column if exists classification;

alter table runs enable row level security;
alter table file_meta enable row level security;
alter table country_config enable row level security;
alter table month_status enable row level security;
alter table file_shares enable row level security;

-- Make the API see the new tables straight away
notify pgrst, 'reload schema';
