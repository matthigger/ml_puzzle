-- Puzzle leaderboards: one database for every puzzle site of this kind
-- (students run Python in the browser, post their code, we re-run it).
-- Paste into the Supabase SQL editor once; it is safe to run again.
--
-- The pages never touch a table, and never post a score. Rows live in the
-- private schema, which the Data API doesn't expose. A page calls:
--
--   post_entry(...)          add or replace the caller's entry in a
--                            project: code only (needs the class code); it
--                            waits for a re-run
--   leaderboard(project, t)  a project's visible entries, best first;
--                            mine = true on the caller's own
--   delete_entry(project, t) remove the caller's entry
--
-- and each project's re-run script, with the secret key, calls:
--
--   pending_entries(project) entries waiting for a re-run, with their code
--   set_result(...)          the re-run's score, or why it failed
--
-- A score is the project's own: metrics (jsonb, shown on its board),
-- qualifies (cleared the project's bar) and rank (lower is better among
-- those that qualify). An entry belongs to whoever holds its token: a
-- random string the page keeps in the browser. Only its sha256 is stored.
--
-- Afterwards, add each project and set the class code (keep it out of the
-- repo):
--
--   insert into private.projects (id, title) values ('slice_crawl', 'Slice Crawl')
--   on conflict (id) do nothing;
--   insert into private.config (key, value) values ('class_code', '...')
--   on conflict (key) do update set value = excluded.value;
--
-- A project's own code, if set ('class_code:slice_crawl'), overrides the
-- shared one. Moderate in the Table Editor (schema "private"): entries.hidden
-- takes an entry down, entries.status = 'pending' re-runs it, projects.open
-- = false stops new posts to a project.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.config (
  key text primary key,
  value text not null
);
alter table private.config enable row level security;

create table if not exists private.projects (
  id text primary key check (id ~ '^[a-z0-9_]{1,40}$'),
  title text not null,
  open boolean not null default true,
  created_at timestamptz not null default now()
);
alter table private.projects enable row level security;

create table if not exists private.entries (
  id bigint generated always as identity primary key,
  project text not null references private.projects (id),
  token_hash text not null,
  -- the student's name, and the run's name ("method") from their table
  name text not null,
  method text not null,
  -- the function to call in source: {main, helpers, mainName?, build}
  entry_point text not null,
  source jsonb not null,
  -- bumped by every post, so a re-run of older code is never saved
  version integer not null default 1,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed')),
  -- the re-run: null until done
  metrics jsonb,
  qualifies boolean,
  rank double precision,
  seed bigint,
  error text,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rerun_at timestamptz,
  constraint entries_project_token unique (project, token_hash)
);
alter table private.entries enable row level security;
create index if not exists entries_pending
  on private.entries (project, updated_at) where status = 'pending';


create or replace function private.token_hash(token text) returns text
language sql immutable
as $$ select encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex') $$;


create or replace function public.post_entry(
  project text,
  code text,
  token text,
  name text,
  method text,
  entry_point text,
  source jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hash text := private.token_hash(token);
  clean text := btrim(coalesce(name, ''));
  clean_method text := btrim(coalesce(method, ''));
  want text;
  last_post timestamptz;
begin
  if not exists (select 1 from private.projects p
                  where p.id = post_entry.project and p.open) then
    raise exception 'This leaderboard is closed.';
  end if;
  select coalesce(
    (select c.value from private.config c
      where c.key = 'class_code:' || post_entry.project),
    (select c.value from private.config c where c.key = 'class_code'))
    into want;
  if want is null or code is distinct from want then
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
  if coalesce(entry_point, '') !~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' then
    raise exception 'Bad function name.';
  end if;
  if jsonb_typeof(source -> 'main') is distinct from 'string' then
    raise exception 'No code.';
  end if;
  if octet_length(source::text) > 200000 then
    raise exception 'Code is limited to 200 KB.';
  end if;

  select e.updated_at into last_post from private.entries e
   where e.project = post_entry.project and e.token_hash = hash;
  if last_post > now() - interval '20 seconds' then
    raise exception 'Posted a moment ago: wait 20 seconds between posts.';
  end if;
  if last_post is null and (select count(*) from private.entries e
                             where e.project = post_entry.project) >= 2000 then
    raise exception 'The leaderboard is full.';
  end if;

  insert into private.entries as e
    (project, token_hash, name, method, entry_point, source)
  values
    (post_entry.project, hash, clean, clean_method, post_entry.entry_point,
     post_entry.source)
  on conflict on constraint entries_project_token do update set
    name = excluded.name,
    method = excluded.method,
    entry_point = excluded.entry_point,
    source = excluded.source,
    version = e.version + 1,
    status = 'pending',
    metrics = null, qualifies = null, rank = null, seed = null, error = null,
    updated_at = now(),
    rerun_at = null;
end;
$$;


create or replace function public.leaderboard(project text, token text default null)
returns table (
  name text,
  method text,
  status text,
  metrics jsonb,
  qualifies boolean,
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
    select e.*, e.token_hash = private.token_hash(token) as mine
      from private.entries e
     where e.project = leaderboard.project and not e.hidden
  )
  -- a failed re-run is shown to its owner only, with the reason
  select e.name, e.method, e.status, e.metrics, e.qualifies,
         case when e.mine then e.error end, e.updated_at, e.mine
    from e
   where e.status <> 'failed' or e.mine
   order by e.status = 'done' desc,
            e.qualifies desc nulls last,
            e.rank asc nulls last,
            e.updated_at asc;
$$;


create or replace function public.delete_entry(project text, token text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.entries e
   where e.project = delete_entry.project
     and e.token_hash = private.token_hash(token);
$$;


create or replace function public.pending_entries(project text)
returns table (id bigint, version integer, entry_point text, source jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.version, e.entry_point, e.source
    from private.entries e
   where e.project = pending_entries.project and e.status = 'pending'
     and not e.hidden
   order by e.updated_at;
$$;


create or replace function public.set_result(
  entry_id bigint,
  entry_version integer,
  status text,
  metrics jsonb,
  qualifies boolean,
  rank double precision,
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
    metrics = set_result.metrics,
    qualifies = set_result.qualifies,
    rank = set_result.rank,
    seed = set_result.seed,
    error = set_result.error,
    rerun_at = now()
   where e.id = entry_id and e.version = entry_version;
$$;


-- The pages' three functions are callable by the publishable (anon) key;
-- the re-runs' two by the secret (service_role) key only.
revoke execute on function
  private.token_hash(text),
  public.post_entry(text, text, text, text, text, text, jsonb),
  public.leaderboard(text, text),
  public.delete_entry(text, text),
  public.pending_entries(text),
  public.set_result(bigint, integer, text, jsonb, boolean, double precision,
                    bigint, text)
  from public, anon, authenticated;
grant execute on function
  public.post_entry(text, text, text, text, text, text, jsonb),
  public.leaderboard(text, text),
  public.delete_entry(text, text)
  to anon, authenticated;
grant execute on function
  public.pending_entries(text),
  public.set_result(bigint, integer, text, jsonb, boolean, double precision,
                    bigint, text)
  to service_role;
