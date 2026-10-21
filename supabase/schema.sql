-- Slice Crawl leaderboard: paste into the Supabase SQL editor once.
--
-- The page never touches a table. Entries live in the private schema, which
-- the Data API doesn't expose; the page calls three functions:
--
--   post_entry(...)        add or update the caller's entry (needs the
--                          class code)
--   leaderboard(token)     every visible entry, best first; mine = true on
--                          the caller's own
--   delete_entry(token)    remove the caller's entry
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
-- hidden = true to take an entry down, verified = true once you've re-run
-- its saved source yourself.

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
  name text not null,
  accuracy double precision not null,
  mean_slices double precision not null,
  median_slices integer not null,
  p90_slices integer not null,
  n_crawl integer not null,
  seed bigint not null,
  -- the code that produced the score, never shown on the page: for
  -- re-running an entry before marking it verified
  source jsonb not null,
  verified boolean not null default false,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.entries enable row level security;


create or replace function public.post_entry(
  code text,
  token text,
  name text,
  accuracy double precision,
  mean_slices double precision,
  median_slices integer,
  p90_slices integer,
  n_crawl integer,
  seed bigint,
  source jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hash text := encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
  clean text := btrim(coalesce(name, ''));
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
  if n_crawl <> 5000 then
    raise exception 'Leaderboard runs use 5000 crawls.';
  end if;
  if accuracy is null or accuracy not between 0 and 1
      or mean_slices is null or mean_slices < 0 then
    raise exception 'Bad score.';
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
    (token_hash, name, accuracy, mean_slices, median_slices, p90_slices,
     n_crawl, seed, source)
  values
    (hash, clean, post_entry.accuracy, post_entry.mean_slices,
     post_entry.median_slices, post_entry.p90_slices, post_entry.n_crawl,
     post_entry.seed, post_entry.source)
  on conflict (token_hash) do update set
    name = excluded.name,
    accuracy = excluded.accuracy,
    mean_slices = excluded.mean_slices,
    median_slices = excluded.median_slices,
    p90_slices = excluded.p90_slices,
    n_crawl = excluded.n_crawl,
    seed = excluded.seed,
    source = excluded.source,
    verified = false,
    updated_at = now();
end;
$$;


create or replace function public.leaderboard(token text default null)
returns table (
  name text,
  accuracy double precision,
  mean_slices double precision,
  median_slices integer,
  p90_slices integer,
  verified boolean,
  updated_at timestamptz,
  mine boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.name, e.accuracy, e.mean_slices, e.median_slices, e.p90_slices,
         e.verified, e.updated_at,
         e.token_hash = encode(sha256(convert_to(coalesce(token, ''),
                                                 'UTF8')), 'hex')
    from private.entries e
   where not e.hidden
   order by e.accuracy >= 0.95 desc,
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


-- These three functions are the page's whole API: callable by the
-- publishable (anon) key, and by nothing through PUBLIC.
revoke execute on function
  public.post_entry(text, text, text, double precision, double precision,
                    integer, integer, integer, bigint, jsonb),
  public.leaderboard(text),
  public.delete_entry(text)
  from public;
grant execute on function
  public.post_entry(text, text, text, double precision, double precision,
                    integer, integer, integer, bigint, jsonb),
  public.leaderboard(text),
  public.delete_entry(text)
  to anon, authenticated;
