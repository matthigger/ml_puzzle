# Earthquake

A tab of [ML Puzzles](../README.md): `where_start/` on the site (the folder,
URL and database project keep that name; the notebooks link to it).

Practice site for the DS4400 **Earthquake** puzzle
(`DS4400/problem_repo/puzz/puzz1/earthquake`). Students either type their
code in the page ("Type it here") or drop the `.py` / `.ipynb` files they
work on elsewhere, or a `.zip` of them ("Use my files"), and the page runs
their `estimate(x, t, speed)` on as many random earthquakes as they like.
Same layout, editor, runs table, post-mortem and leaderboard as the other
tabs.

- **The quakes.** `py/earthquake.py` is a verbatim copy of the puzzle's
  `earthquake.py`: keep the two identical
  (`diff py/earthquake.py <problem_repo>/puzz/puzz1/earthquake/earthquake.py`).
  Quake `i` of seed `s` is `Earthquake(seed=[s, i], n=..., spacing=...,
  noise_sd=...)`; the defaults (10 stations, 50 km spacing, 0.2 s noise)
  are the graded setup, and the Practice tab's Settings change them. The
  estimator gets `x` (n, 2) km, `t` (n,) s since the quake started and
  `speed` km/s (or only `x, t`, if it takes two arguments), and returns
  the epicenter `(x, y)`.
- **Scoring.** Each quake's score is `quake.evaluate(y_hat)`: mean squared
  error over both coordinates, km^2, half the squared miss. Runs and the
  board report its mean (lower wins, no bar), the median and 90th
  percentile miss (km) and the quakes missed by more than 10 km.
- **Practice tab.** Pick an estimator (every top-level function taking
  `(x, t, speed)` or `(x, t)` is listed), name the run, set quakes
  (default 200), seed and settings. Each row keeps its code. Clicking a row
  opens its post-mortem, on its worst quake: the code, a sortable table
  with a row per quake (miss, MSE, worst residual; "10+ km only" filters
  it), "Download results" (a tidy CSV, a row per quake: run, estimator,
  seed, settings, quake, truth, estimate, errors, so runs concatenate in
  pandas), and for the quake clicked: a map (stations, epicenter, estimate,
  optional delay circles of radius `speed * t_i`), a close-up, and each
  station's residual `||y_hat - x_i|| / speed - t_i`. Dragging the estimate
  on the map or close-up moves it and redraws the residuals. "Add
  baselines" runs "first station" and "stations' average".
- **Leaderboard tab.** Read only; every score is our own re-run. The
  Gerber-section board is closed: its entries were scored by an earlier
  version of the puzzle (an unknown start time), so they show only the
  columns that version shares with this one.

Python runs in the browser with [Pyodide](https://pyodide.org) 314.0.7 in a
module web worker (numpy preloaded; scipy etc. load on first import), so
Stop can kill an endless estimator. Plain HTML/CSS/JS: no build step.

## The puzzle's code

`py/runner.py` holds the site's glue around `earthquake.py`: the graded
setup (`OFFICIAL`), seeding (`sample`), the answer check, scoring and the
baselines. It loads the student's code, lists its estimators, runs them,
and replays one quake. Both import with plain Python, for testing.

## Leaderboard re-run

`verify/verify.py` re-runs each waiting entry on 2000 default quakes with a
fresh 53-bit seed, shown on the board once scored (the Practice tab with
that seed, 2000 quakes and default settings replays it exactly), in a
sandbox (`../shared/sandbox.py`: no network, no secrets, read-only system,
2 GB, 64 processes, 15 minutes) that gets each quake's stations, delays and
speed only (`verify/child.py`); the truth stays outside. Board: project
`where_start`, every entry ranked by lowest mean MSE.

Try it on one file, no database (from this folder; needs bubblewrap, see
`../shared/sandbox.py`):

```sh
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
| `py/runner.py` | seeding, scoring, baselines; load / run / replay the student's code |
| `py/earthquake.py` | the puzzle's quake simulator, verbatim |
| `verify/verify.py` | re-run waiting entries, write back their scores |
| `verify/child.py` | the student's side of a re-run, in the sandbox |

Shared with the other puzzles: `../shared/` (styles, Python worker handle,
leaderboard, config, site bar) and `../supabase/schema.sql`.
