-- Slice Crawl leaderboard: paste into the Supabase SQL editor once.
--
-- The page never touches a table, and never posts a score. Entries live in
-- the private schema, which the Data API doesn't expose. The page calls:
--
--   post_entry(...)        add or replace the caller's entry: code only
--                          (needs the class code); it waits for a re-run
--   leaderboard(token)     every visible entry, re-run scores best first;
--                          mine = true on the caller's own
--   delete_entry(token)    remove the caller's entry
--
-- and verify/verify.py, with the secret key, calls:
--
--   pending_entries()      entries waiting for a re-run, with their code
--   set_result(...)        the re-run's score, or why it failed
--
-- An entry belongs to whoever holds its token: a random string the page
-- makes once and keeps in the browser. Only its sha256 is stored.
--
-- Afterwards, set the class code (keep it out of this repo):
--
--   insert into private.config (key, value) values ('class_code', '...')
--   on conflict (key) do update set value = excluded.value;
--
-- Moderate in the Table Editor (schema "private", table "entries"): set
-- hidden = true to take an entry down; status = 'pending' re-runs it.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.config (
  key text primary key,
  value text not null
);
alter table private.config enable row level security;

create table if not exists private.entries (
  id bigint generated always as identity primary key,
  token_hash text not null unique,
  -- the student's name, and the run's name ("method") from their table
  name text not null,
  method text not null,
  -- the estimator to call in source: {main, helpers, build}
  estimator text not null,
  source jsonb not null,
  -- bumped by every post, so a re-run of older code is never saved
  version integer not null default 1,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed')),
  -- the re-run: null until done
  accuracy double precision,
  mean_slices double precision,
  median_slices integer,
  p90_slices integer,
  n_crawl integer,
  seed bigint,
  error text,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rerun_at timestamptz
);
alter table private.entries enable row level security;


create or replace function public.post_entry(
  code text,
  token text,
  name text,
  method text,
  estimator text,
  source jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hash text := encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
  clean text := btrim(coalesce(name, ''));
  clean_method text := btrim(coalesce(method, ''));
  last_post timestamptz;
begin
  if code is distinct from
      (select c.value from private.config c where c.key = 'class_code') then
    raise exception 'That class code is not right.';
  end if;
  if char_length(coalesce(token, '')) < 32 then
    raise exception 'Bad entry token.';
  end if;
  if char_length(clean) not between 1 and 40 then
    raise exception 'Names are 1 to 40 characters.';
  end if;
  if char_length(clean_method) not between 1 and 60 then
    raise exception 'Run names are 1 to 60 characters.';
  end if;
  if coalesce(estimator, '') !~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' then
    raise exception 'Bad estimator name.';
  end if;
  if jsonb_typeof(source -> 'main') is distinct from 'string' then
    raise exception 'No code.';
  end if;
  if octet_length(source::text) > 200000 then
    raise exception 'Code is limited to 200 KB.';
  end if;

  select e.updated_at into last_post
    from private.entries e where e.token_hash = hash;
  if last_post > now() - interval '20 seconds' then
    raise exception 'Posted a moment ago: wait 20 seconds between posts.';
  end if;
  if last_post is null and (select count(*) from private.entries) >= 2000 then
    raise exception 'The leaderboard is full.';
  end if;

  insert into private.entries as e
    (token_hash, name, method, estimator, source)
  values
    (hash, clean, clean_method, post_entry.estimator, post_entry.source)
  on conflict (token_hash) do update set
    name = excluded.name,
    method = excluded.method,
    estimator = excluded.estimator,
    source = excluded.source,
    version = e.version + 1,
    status = 'pending',
    accuracy = null, mean_slices = null, median_slices = null,
    p90_slices = null, n_crawl = null, seed = null, error = null,
    updated_at = now(),
    rerun_at = null;
end;
$$;


create or replace function public.leaderboard(token text default null)
returns table (
  name text,
  method text,
  status text,
  accuracy double precision,
  mean_slices double precision,
  median_slices integer,
  p90_slices integer,
  error text,
  updated_at timestamptz,
  mine boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with e as (
    select e.*,
           e.token_hash = encode(sha256(convert_to(coalesce(token, ''),
                                                   'UTF8')), 'hex') as mine
      from private.entries e
     where not e.hidden
  )
  -- a failed re-run is shown to its owner only, with the reason
  select e.name, e.method, e.status, e.accuracy, e.mean_slices,
         e.median_slices, e.p90_slices,
         case when e.mine then e.error end,
         e.updated_at, e.mine
    from e
   where e.status <> 'failed' or e.mine
   order by e.status = 'done' desc,
            e.accuracy >= 0.95 desc,
            case when e.accuracy >= 0.95 then e.mean_slices end asc,
            e.accuracy desc,
            e.updated_at asc;
$$;


create or replace function public.delete_entry(token text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.entries e
   where e.token_hash = encode(sha256(convert_to(coalesce(token, ''),
                                                 'UTF8')), 'hex');
$$;


create or replace function public.pending_entries()
returns table (id bigint, version integer, estimator text, source jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.version, e.estimator, e.source
    from private.entries e
   where e.status = 'pending' and not e.hidden
   order by e.updated_at;
$$;


create or replace function public.set_result(
  entry_id bigint,
  entry_version integer,
  status text,
  accuracy double precision,
  mean_slices double precision,
  median_slices integer,
  p90_slices integer,
  n_crawl integer,
  seed bigint,
  error text
) returns void
language sql
security definer
set search_path = ''
as $$
  -- a post since the re-run started bumped the version: keep it pending
  update private.entries e set
    status = set_result.status,
    accuracy = set_result.accuracy,
    mean_slices = set_result.mean_slices,
    median_slices = set_result.median_slices,
    p90_slices = set_result.p90_slices,
    n_crawl = set_result.n_crawl,
    seed = set_result.seed,
    error = set_result.error,
    rerun_at = now()
   where e.id = entry_id and e.version = entry_version;
$$;


-- The page's three functions are callable by the publishable (anon) key;
-- the re-run's two by the secret (service_role) key only.
revoke execute on function
  public.post_entry(text, text, text, text, text, jsonb),
  public.leaderboard(text),
  public.delete_entry(text),
  public.pending_entries(),
  public.set_result(bigint, integer, text, double precision,
                    double precision, integer, integer, integer, bigint, text)
  from public, anon, authenticated;
grant execute on function
  public.post_entry(text, text, text, text, text, jsonb),
  public.leaderboard(text),
  public.delete_entry(text)
  to anon, authenticated;
grant execute on function
  public.pending_entries(),
  public.set_result(bigint, integer, text, double precision,
                    double precision, integer, integer, integer, bigint, text)
  to service_role;
