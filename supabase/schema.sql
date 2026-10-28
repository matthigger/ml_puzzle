-- Puzzle leaderboards: one database for every puzzle site of this kind
-- (students run Python in the browser, post their code, we re-run it).
-- Paste into the Supabase SQL editor once; it is safe to run again.
--
-- A project is a kind of puzzle (slice_crawl, ...); a board is one
-- leaderboard of it for one class: a term, a section. Each board has its own
-- code, which students need both to see the board and to post to it, so
-- boards stay apart. The pages never touch a table, and never post a score.
-- Rows live in the private schema, which the Data API doesn't expose. A page
-- calls:
--
--   leaderboard(project, code, token)  the board: {title, open, entries},
--                                      entries best first, mine = true on
--                                      the caller's own
--   post_entry(...)                    add or replace the caller's entry:
--                                      code only; it waits for a re-run
--   delete_entry(project, code, token) remove the caller's entry
--
-- and each project's re-run script, with the secret key, calls:
--
--   pending_entries(project)   entries waiting for a re-run, any board
--   set_result(...)            the re-run's score, or why it failed
--
-- A score is the project's own: metrics (jsonb, shown on its board),
-- qualifies (cleared the project's bar) and rank (lower is better among
-- those that qualify). An entry belongs to whoever holds its token: a random
-- string the page keeps in the browser. Only its sha256 is stored.
--
-- Afterwards, add each project once, then a board per class (it prints the
-- board's code: give it to the class, keep it out of the repo):
--
--   insert into private.projects (id, title) values ('slice_crawl', 'Slice Crawl')
--   on conflict (id) do nothing;
--   select private.new_board('slice_crawl', 'DS4400 Fall 2026');
--
-- Moderate in the Table Editor (schema "private"): entries.hidden takes an
-- entry down, entries.status = 'pending' re-runs it, boards.open = false
-- stops new posts (the board stays visible with its code).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- earlier drafts' functions and class-code table: gone, so no old
-- signature stays callable around the board codes
drop function if exists public.leaderboard(text);
drop function if exists public.leaderboard(text, text);
drop function if exists public.delete_entry(text);
drop function if exists public.delete_entry(text, text);
drop function if exists public.post_entry(text, text, text, double precision,
  double precision, integer, integer, integer, bigint, jsonb);
drop function if exists public.post_entry(text, text, text, text, text, jsonb);
drop function if exists public.pending_entries();
drop function if exists public.set_result(bigint, integer, text,
  double precision, double precision, integer, integer, integer, bigint, text);
drop table if exists private.config;
-- board codes come from pgcrypto (Supabase keeps it in "extensions")
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists private.projects (
  id text primary key check (id ~ '^[a-z0-9_]{1,40}$'),
  title text not null,
  created_at timestamptz not null default now()
);
alter table private.projects enable row level security;

create table if not exists private.boards (
  id bigint generated always as identity primary key,
  project text not null references private.projects (id),
  title text not null,
  code text not null check (char_length(code) >= 7),
  open boolean not null default true,
  created_at timestamptz not null default now(),
  constraint boards_project_code_key unique (project, code)
);
alter table private.boards enable row level security;
-- a code is unique within its project only, so one short test code can
-- open a board on every project (class boards keep new_board's 60 bits)
alter table private.boards drop constraint if exists boards_code_key;
alter table private.boards drop constraint if exists boards_code_check;
alter table private.boards
  add constraint boards_code_check check (char_length(code) >= 7);
do $$ begin
  alter table private.boards
    add constraint boards_project_code_key unique (project, code);
exception when duplicate_object or duplicate_table then null;
end $$;

create table if not exists private.entries (
  id bigint generated always as identity primary key,
  board bigint not null references private.boards (id),
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
  constraint entries_board_token unique (board, token_hash)
);
alter table private.entries enable row level security;
create index if not exists entries_pending
  on private.entries (updated_at) where status = 'pending';


create or replace function private.token_hash(token text) returns text
language sql immutable
set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex') $$;

-- a new board for project, with a fresh random code (returned), e.g.
-- slice-7kq9-fx2m-0hdw: 12 symbols from pgcrypto's CSPRNG, 5 bits each (60
-- bits), from 32 that can't be misread (no i, l, o, 1)
create or replace function private.new_board(project text, title text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  abc text := 'abcdefghjkmnpqrstuvwxyz023456789';
  raw bytea;
  new_code text;
begin
  loop
    raw := extensions.gen_random_bytes(12);
    new_code := split_part(project, '_', 1);
    for i in 0..11 loop
      if i % 4 = 0 then new_code := new_code || '-'; end if;
      new_code := new_code || substr(abc, 1 + (get_byte(raw, i) & 31), 1);
    end loop;
    exit when not exists (select 1 from private.boards b where b.code = new_code);
  end loop;
  insert into private.boards (project, title, code)
    values (new_board.project, new_board.title, new_code);
  return new_code;
end;
$$;

-- the board a project's code opens, or an error a student can act on
create or replace function private.board_for(project text, code text)
returns private.boards
language plpgsql stable
set search_path = ''
as $$
declare
  b private.boards;
begin
  select * into b from private.boards x
   where x.project = board_for.project and x.code = btrim(coalesce(board_for.code, ''));
  if b.id is null then
    raise exception 'That code doesn''t open a leaderboard.';
  end if;
  return b;
end;
$$;


create or replace function public.leaderboard(project text, code text,
                                              token text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b private.boards := private.board_for(project, code);
  hash text := private.token_hash(token);
begin
  return jsonb_build_object('title', b.title, 'open', b.open, 'entries',
    coalesce((
      -- a failed re-run is shown to its owner only, with the reason
      select jsonb_agg(jsonb_build_object(
               'name', e.name, 'method', e.method, 'status', e.status,
               'metrics', e.metrics, 'qualifies', e.qualifies,
               'error', case when e.token_hash = hash then e.error end,
               'updated_at', e.updated_at, 'mine', e.token_hash = hash)
             order by e.status = 'done' desc, e.qualifies desc nulls last,
                      e.rank asc nulls last, e.updated_at asc)
        from private.entries e
       where e.board = b.id and not e.hidden
         and (e.status <> 'failed' or e.token_hash = hash)), '[]'::jsonb));
end;
$$;


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
  b private.boards := private.board_for(project, code);
  hash text := private.token_hash(token);
  clean text := btrim(coalesce(name, ''));
  clean_method text := btrim(coalesce(method, ''));
  last_post timestamptz;
begin
  if not b.open then
    raise exception 'This leaderboard is closed.';
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
   where e.board = b.id and e.token_hash = hash;
  if last_post > now() - interval '20 seconds' then
    raise exception 'Posted a moment ago: wait 20 seconds between posts.';
  end if;
  if last_post is null and (select count(*) from private.entries e
                             where e.board = b.id) >= 2000 then
    raise exception 'The leaderboard is full.';
  end if;

  insert into private.entries as e
    (board, token_hash, name, method, entry_point, source)
  values
    (b.id, hash, clean, clean_method, post_entry.entry_point, post_entry.source)
  on conflict on constraint entries_board_token do update set
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


create or replace function public.delete_entry(project text, code text,
                                               token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b private.boards := private.board_for(project, code);
begin
  delete from private.entries e
   where e.board = b.id and e.token_hash = private.token_hash(token);
end;
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
    join private.boards b on b.id = e.board
   where b.project = pending_entries.project and e.status = 'pending'
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
-- the re-runs' two by the secret (service_role) key only; the private
-- helpers by neither.
revoke execute on function
  private.token_hash(text),
  private.new_board(text, text),
  private.board_for(text, text),
  public.leaderboard(text, text, text),
  public.post_entry(text, text, text, text, text, text, jsonb),
  public.delete_entry(text, text, text),
  public.pending_entries(text),
  public.set_result(bigint, integer, text, jsonb, boolean, double precision,
                    bigint, text)
  from public, anon, authenticated;
grant execute on function
  public.leaderboard(text, text, text),
  public.post_entry(text, text, text, text, text, text, jsonb),
  public.delete_entry(text, text, text)
  to anon, authenticated;
grant execute on function
  public.pending_entries(text),
  public.set_result(bigint, integer, text, jsonb, boolean, double precision,
                    bigint, text)
  to service_role;
