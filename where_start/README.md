# Where Did It Start?

A tab of [ML Puzzles](../README.md): `where_start/` on the site.

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
  start time in 0..10 s and timing noise sd log-uniform in 0.1..0.4 s.
  Waves travel at 6 km/s. The estimator gets `stations` (12, 2) km and `arrivals` (12,) s
  and returns `(x, y, t0)`.
- **Scoring.** Error is `||p_hat - p||` in km. A hit is within 5 km; the
  bar is hits in 90% of quakes, then the lower mean error wins.
- **Practice tab.** Pick an estimator (every top-level function taking
  `(stations, arrivals)` is listed), name the run, set quakes (default
  200) and seed. Each row keeps its code. Clicking a row opens its
  post-mortem: the code, a sortable table with a row per quake (hit or
  miss, error, start-time error, noise, worst residual;
  "misses only" filters it), "Download results" (a tidy CSV, a row per
  quake: run, estimator, seed, quake, truth, estimate, errors, so runs
  concatenate in pandas), and for the quake clicked: a map (stations,
  epicenter, estimate, optional arrival circles), a close-up with the 5 km
  hit radius, and each station's residual at the estimate. Dragging the
  estimate on the map or close-up moves p-hat, refits t0-hat and redraws
  the residuals. "Add baselines" runs
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

## Leaderboard re-run

`verify/verify.py` re-runs each waiting entry on 2000 quakes with a fresh
53-bit seed, shown on the board once scored (the Practice tab with that
seed and 2000 quakes replays it exactly), in a Docker container (`verify/Dockerfile`: no network,
read-only disk, no secrets, 1 GB / 1 CPU, 15 minutes) that gets each
quake's stations and arrivals only (`verify/child.py`); the truth stays
outside. Board: project `where_start`, ranked when within 5 km in at least
90% of quakes, by lowest mean distance.

Try it on one file, no database (from this folder):

```sh
docker build -f verify/Dockerfile -t where-start-verify .
python3 verify/verify.py --local my_code.py --helper helpers.py
```

## Layout

| file | role |
|------|------|
| `index.html` | page, help text, controls |
| `puzzle.css` | its post-mortem plot styles |
| `js/puzzle.js` | its project id, bar and board columns |
| `js/app.js` | editor and files, runs table, post-mortem flow, CSV, posting, tabs |
| `js/worker.js` | module web worker: Pyodide, runs `py/runner.py` |
| `js/postmortem.js` | a run's quakes table, one quake's plot with the hidden truth |
| `py/runner.py` | load / run / replay the student's code |
| `py/where_start.py` | the quake simulator and `evaluate()` |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the container |
| `verify/Dockerfile` | the re-run container |

Shared with the other puzzles: `../shared/` (styles, Python worker handle,
leaderboard, config, site bar) and `../supabase/schema.sql`.
