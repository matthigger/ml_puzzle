# ML Puzzles

Practice site for the DS4400 puzzles, one tab per puzzle: students run
their own Python on as many random instances of the puzzle as they like,
see the hidden truth for each one, and post their code to a class
leaderboard that we re-run ourselves.

| tab | folder | students write |
|-----|--------|----------------|
| Slice Crawl | [`slice_crawl/`](slice_crawl/README.md) | `estimate(crawl)`: the best shop, tasting few slices |
| Where Did It Start? | [`where_start/`](where_start/README.md) | `estimate(stations, arrivals)`: the epicenter |
| Ghost on the Circuit | [`ghost_circuit/`](ghost_circuit/README.md) | `estimate(x, y)`: the devices on the circuit |

Each puzzle page has the same parts: the code (typed, or dropped `.py` /
`.ipynb` / `.zip` files), a run on N seeded instances, a sortable runs
table, and a post-mortem: a table with a row per instance, a plot of the
one clicked, and its results as CSV. Python runs in the browser with
[Pyodide](https://pyodide.org) 314.0.7 (Python 3.14) in a module web
worker, so Stop can kill an endless loop. Plain HTML/CSS/JS: no build step.

## Layout

| path | role |
|------|------|
| `index.html` | sends visitors to the first tab |
| `shared/config.js` | the tabs (`CONFIG.puzzles`), Supabase URL and publishable key |
| `shared/nav.js` | the site bar, a tab per puzzle |
| `shared/style.css` | every page's look; a puzzle's plot styles are its `puzzle.css` |
| `shared/py.js` | a page's handle on its Python worker (call, stop) |
| `shared/board.js` | leaderboard calls (Supabase RPC) and table, per `js/puzzle.js` |
| `shared/version.js` | build stamp, overwritten at deploy |
| `<puzzle>/` | a puzzle's page, simulator, runner and re-run (its README) |
| `supabase/schema.sql` | the leaderboard database every puzzle shares |
| `.github/workflows/pages.yml` | Pages deploy on every push to `main` |
| `.github/workflows/verify.yml` | re-run waiting entries every 10 minutes, a job per puzzle |

## Leaderboard

The page posts code, never a score: each puzzle's `verify/verify.py`
re-runs a waiting entry in a locked-down Docker container on fresh
instances with a secret seed, and writes back the score the board shows.
One Supabase database serves every puzzle: a **project** per puzzle, a
**board** per class (a term or section) with its own code, which students
need both to see the board and to post to it.

Setup, once:

1. In the Supabase SQL editor, run `supabase/schema.sql` (safe to re-run).
2. Per puzzle, add its project, then a board per class. `new_board`
   prints the board's code: put it in the assignment, keep it out of this
   repo.

   ```sql
   insert into private.projects (id, title) values ('slice_crawl', 'Slice Crawl')
   on conflict (id) do nothing;
   select private.new_board('slice_crawl', 'DS4400 Fall 2026');
   ```

3. `shared/config.js` holds the project URL and **publishable** key
   (`sb_publishable_...`), public by design: it can only call the page's
   three functions.
4. Repo secrets for the re-run (a secret key, `sb_secret_...`; never in
   `shared/` or any page):

   ```sh
   gh secret set SUPABASE_URL
   gh secret set SUPABASE_SECRET_KEY
   ```

   Without them `verify.yml` does nothing. GitHub disables scheduled
   Actions after 60 days without a push; "Run workflow" on the Actions tab
   re-runs by hand.

Moderating, in the Table Editor (schema `private`): in `entries`,
`hidden = true` takes an entry down and `status = 'pending'` re-runs it;
each entry keeps its code (`source`) and the seed it was re-run on. In
`boards`, `open = false` closes a board to new entries (it stays visible
with its code). What's left to trust: a student can post under someone
else's name, or code they didn't write; a board's code only keeps
strangers out.

## Run locally

```sh
python3 -m http.server 8000   # from this folder, then visit http://localhost:8000
```

Opening a page as a file won't work: the worker needs http. `#practice`
and `#leaderboard` link straight to a puzzle's tab.

## Publish

`pages.yml` deploys every push to `main` to
<https://matthigger.github.io/ml_puzzle/>, stamping `shared/version.js`
with the commit and build time for the footer ("local copy" locally).
All github.io sites share one origin, so each puzzle's localStorage keys
start with its id.

## Adding a puzzle

Copy a puzzle folder, then change its simulator (`py/`), runner, page,
`postmortem.js`, `puzzle.css`, `js/puzzle.js` and `verify/`; add it to
`CONFIG.puzzles` and to the matrix in `verify.yml` (its image is
`<id with dashes>-verify`), and add its project and a board in the
database.
