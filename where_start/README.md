# where_start

Practice site for the DS4400 **Where Did It Start?** puzzle
(`DS4400/problem_repo/puzz/puzz_where_start`). Students either type their
code in the page ("Type it here") or drop the `.py` / `.ipynb` files they
work on elsewhere, or a `.zip` of them ("Use my files"), and the page runs
their `estimate(stations, arrivals)` on as many random earthquakes as they
like. It is the slice_crawl site (`teach/tools/slice_crawl`) with the
puzzle swapped: same layout, editor, runs table, post-mortem and
leaderboard.

- **The quakes.** `py/where_start.py` draws each one from a seed: 12
  stations uniform over a 200 km square, an epicenter uniform over it, a
  start time in 0..10 s, timing noise sd log-uniform in 0.1..0.4 s, and 0
  to 3 broken clocks (off by 5 to 10 s, either sign). Waves travel at
  6 km/s. The estimator gets `stations` (12, 2) km and `arrivals` (12,) s
  and returns `(x, y, t0)`.
- **Scoring.** Error is `||p_hat - p||` in km. A hit is within 5 km; the
  bar is hits in 90% of quakes, then the lower mean error wins.
- **Practice tab.** Pick an estimator (every top-level function taking
  `(stations, arrivals)` is listed), name the run, set quakes (default
  200) and seed. Each row keeps its code. Clicking a row opens its
  post-mortem: the code, a sortable table with a row per quake (hit or
  miss, error, start-time error, broken clocks, noise, worst residual;
  "misses only" filters it), "Download results" (a tidy CSV, a row per
  quake: run, estimator, seed, quake, truth, estimate, errors, so runs
  concatenate in pandas), and for the quake clicked: a map (stations,
  broken clocks in red, epicenter, estimate, optional arrival circles), a
  close-up with the 5 km hit radius, and each station's residual at the
  estimate (a broken clock's true offset marked). "Add baselines" runs
  "first to hear it" and "first three".
- **Leaderboard tab.** Read only; every score is our own re-run.

Python runs in the browser with [Pyodide](https://pyodide.org) 314.0.7 in a
module web worker (numpy preloaded; scipy etc. load on first import), so
Stop can kill an endless estimator. Plain HTML/CSS/JS: no build step.

## The puzzle's code

`py/where_start.py` is the site's quake simulator (the puzzle itself uses
the fixed `stations.csv` / `arrival.csv`). `py/runner.py` loads the
student's code, lists its estimators, runs them (same quakes as
`evaluate()` for a seed), and replays one quake. Both import with plain
Python, for testing.

## Leaderboard setup (once)

The database is the one slice_crawl uses (see its `supabase/schema.sql`
and README): this site's entries are project `where_start`.

1. Add the project and a board per class; `new_board` prints the board's
   code (keep it out of this repo, put it in the assignment):

   ```sql
   insert into private.projects (id, title)
   values ('where_start', 'Where Did It Start?') on conflict (id) do nothing;
   select private.new_board('where_start', 'DS4400 Fall 2026');
   ```

2. `js/config.js` already holds the shared project URL and publishable
   key.
3. Add repo secrets `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (never in
   `js/`); without them the re-run Action does nothing.

`verify/verify.py` re-runs each waiting entry on 2000 quakes with a seed
drawn there and never shown. The student's code runs in a Docker container
(`verify/Dockerfile`: no network, read-only disk, no secrets, 1 GB / 1 CPU,
15 minute limit) that gets each quake's stations and arrivals only
(`verify/child.py`); the truth stays outside. Try it on one file:

```sh
docker build -f verify/Dockerfile -t where-start-verify .
python3 verify/verify.py --local my_code.py --helper helpers.py
```

## Run locally

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Publish on GitHub Pages

```sh
gh repo create matthigger/where_start --public --source . --push
gh api -X POST repos/matthigger/where_start/pages -f build_type=workflow
```

The site then lives at <https://matthigger.github.io/where_start/>.

## Layout

| file | role |
|------|------|
| `index.html` | page, help text, controls |
| `style.css` | layout, tables, dialog, quake plot |
| `js/app.js` | editor and files, runs table, post-mortem flow, CSV, posting, tabs |
| `js/py.js` | the page's handle on the Python worker (call, stop) |
| `js/worker.js` | module web worker: Pyodide, runs `py/runner.py` |
| `js/postmortem.js` | a run's quakes table, and one quake's plot with the hidden truth |
| `js/board.js` | leaderboard calls (Supabase RPC) and table |
| `js/config.js` | Supabase project URL, publishable key, project id |
| `js/version.js` | build stamp, overwritten at deploy |
| `py/runner.py` | load / run / replay the student's code |
| `py/where_start.py` | the quake simulator and `evaluate()` |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the container |
| `verify/Dockerfile` | the re-run container |
| `.github/workflows/pages.yml` | Pages deploy |
| `.github/workflows/verify.yml` | re-run every 10 minutes |
